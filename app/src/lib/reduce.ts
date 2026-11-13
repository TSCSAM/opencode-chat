import type { Message, Part } from "./types"

// رویدادهای فشرده‌سازی فقط sessionID را در delta/ended/failed دارند؛ inputID
// تنها در started و به‌صورت اختیاری می‌آید. برای همین کلید را همیشه با
// sessionID می‌سازیم تا حباب started و delta/ended به هم وصل شوند.
function compactionKey(d: any) {
  return String(d.sessionID ?? d.inputID ?? "compaction")
}

function messageFor(list: Message[], id: string, created: number): Message {
  const i = list.findIndex((m) => m.id === id)
  if (i === -1) {
    const msg: Message = { id, type: "assistant", content: [], time: { created } }
    list.push(msg)
    return msg
  }
  const next: Message = { ...list[i], content: [...(list[i].content ?? [])] }
  list[i] = next
  return next
}

function textPart(msg: Message, ordinal: number, type: "text" | "reasoning"): Part {
  const content = msg.content!
  const i = content.findIndex((c) => c.type === type && c.__ordinal === ordinal)
  if (i === -1) {
    const part: Part = { type, text: "", __ordinal: ordinal }
    content.push(part)
    return part
  }
  const next = { ...content[i] }
  content[i] = next
  return next
}

function toolPart(msg: Message, id: string, name?: string): Part {
  const content = msg.content!
  const i = content.findIndex((c) => c.type === "tool" && c.id === id)
  if (i === -1) {
    const part: Part = {
      type: "tool",
      id,
      name: name ?? "tool",
      state: { status: "running", input: {} },
      time: { created: Date.now() },
    }
    content.push(part)
    return part
  }
  const next = { ...content[i], state: { ...(content[i].state ?? {}) } }
  content[i] = next
  return next
}

function normalizeToolState(state: any) {
  if (!state || typeof state !== "object") return { status: "running", input: {} }
  // state.input در حالت streaming یک رشتهٔ JSON نیمه‌کاره است، نه آبجکت.
  if (typeof state.input === "string") return { ...state, input: {}, inputRaw: state.input }
  if (!state.input || typeof state.input !== "object") return { ...state, input: {} }
  return state
}

function encodedPart(part: any, ordinals: { text: number; reasoning: number }): Part | null {
  if (!part || typeof part !== "object") return null
  if (part.type === "text") {
    return { type: "text", text: typeof part.text === "string" ? part.text : "", __ordinal: ordinals.text++ }
  }
  if (part.type === "reasoning") {
    return { type: "reasoning", text: typeof part.text === "string" ? part.text : "", __ordinal: ordinals.reasoning++ }
  }
  if (part.type === "tool") {
    return { type: "tool", id: part.id, name: part.name, state: normalizeToolState(part.state), time: part.time }
  }
  return null
}

export type ReduceResult = {
  messages: Message[]
  busy?: boolean
  done?: boolean
  error?: string
  renamed?: { id: string; title: string }
}

type Translate = (text: string) => string

export function reduce(prev: Message[], ev: any, t: Translate = (text) => text): ReduceResult {
  const d = ev.data ?? {}
  const created = ev.created ?? Date.now()
  const list = [...prev]
  const type = String(ev.type ?? "")

  switch (type) {
    case "session.inbox.enqueued": {
      const item = d.item
      const text = item?.payload?.text
      if (item?.type === "user" && (typeof text === "string" || item?.payload?.files) && !list.some((m) => m.id === d.inboxID)) {
        list.push({ id: d.inboxID, type: "user", text, files: item?.payload?.files ?? undefined, time: { created } })
      }
      return { messages: list }
    }

    case "session.inbox.cancelled":
      return { messages: list.filter((m) => m.id !== d.inboxID) }

    case "session.text.started":
    case "session.text.delta":
    case "session.reasoning.started":
    case "session.reasoning.delta": {
      const kind = type.includes("reasoning") ? "reasoning" : "text"
      const msg = messageFor(list, d.assistantMessageID, created)
      const part = textPart(msg, Number(d.ordinal ?? 0), kind)
      if (typeof d.delta === "string") part.text = (part.text ?? "") + d.delta
      return { messages: list }
    }

    case "session.text.ended":
    case "session.reasoning.ended": {
      const kind = type.includes("reasoning") ? "reasoning" : "text"
      const msg = messageFor(list, d.assistantMessageID, created)
      const part = textPart(msg, Number(d.ordinal ?? 0), kind)
      if (typeof d.text === "string") part.text = d.text
      return { messages: list }
    }

    case "session.message.content.updated": {
      const msg = messageFor(list, d.messageID, created)
      const ordinals = { text: 0, reasoning: 0 }
      msg.content = (Array.isArray(d.content) ? d.content : [])
        .map((part: any) => encodedPart(part, ordinals))
        .filter((part: Part | null): part is Part => part !== null)
      return { messages: list }
    }

    case "session.step.started": {
      const msg = messageFor(list, d.assistantMessageID, created)
      if (typeof d.agent === "string") msg.agent = d.agent
      if (d.model && typeof d.model === "object") msg.model = d.model
      return { messages: list }
    }

    case "session.step.streamed": {
      const msg = messageFor(list, d.assistantMessageID, created)
      msg.time = { ...(msg.time ?? {}), streamed: created }
      return { messages: list }
    }

    case "session.step.ended": {
      const msg = messageFor(list, d.assistantMessageID, created)
      msg.finish = d.finish
      if (d.cost != null) msg.cost = d.cost
      if (d.tokens != null) msg.tokens = d.tokens
      msg.time = { ...(msg.time ?? {}), completed: created }
      return { messages: list }
    }

    case "session.step.failed": {
      const msg = messageFor(list, d.assistantMessageID, created)
      msg.error = d.error
      msg.finish = d.finish ?? "error"
      if (d.cost != null) msg.cost = d.cost
      if (d.tokens != null) msg.tokens = d.tokens
      msg.time = { ...(msg.time ?? {}), completed: created }
      return { messages: list }
    }

    case "session.tool.input.started": {
      const msg = messageFor(list, d.assistantMessageID, created)
      toolPart(msg, d.id, d.name)
      return { messages: list }
    }

    case "session.tool.input.delta": {
      const msg = messageFor(list, d.assistantMessageID, created)
      const part = toolPart(msg, d.id)
      const raw = String(part.state?.inputRaw ?? "") + String(d.delta ?? "")
      const nextState: any = { ...(part.state ?? {}), inputRaw: raw }
      try {
        const parsed = JSON.parse(raw)
        if (parsed && typeof parsed === "object") nextState.input = parsed
      } catch {}
      part.state = nextState
      return { messages: list }
    }

    case "session.tool.input.ended": {
      const msg = messageFor(list, d.assistantMessageID, created)
      const part = toolPart(msg, d.id)
      const nextState: any = { ...(part.state ?? {}) }
      try {
        const parsed = JSON.parse(String(d.text ?? ""))
        if (parsed && typeof parsed === "object") nextState.input = parsed
      } catch {}
      delete nextState.inputRaw
      part.state = nextState
      return { messages: list }
    }

    case "session.tool.progress": {
      const msg = messageFor(list, d.assistantMessageID, created)
      const part = toolPart(msg, d.id)
      part.state = {
        ...(part.state ?? {}),
        metadata: { ...(part.state?.metadata ?? {}), ...(d.metadata ?? {}) },
      }
      return { messages: list }
    }

    case "session.tool.called": {
      const msg = messageFor(list, d.assistantMessageID, created)
      const part = toolPart(msg, d.id)
      part.state = { ...(part.state ?? {}), status: "running", input: d.input ?? part.state?.input ?? {} }
      return { messages: list }
    }

    case "session.tool.success": {
      const msg = messageFor(list, d.assistantMessageID, created)
      const part = toolPart(msg, d.id)
      part.state = {
        status: "completed",
        input: part.state?.input ?? {},
        content: d.content ?? [],
        metadata: d.metadata,
      }
      return { messages: list }
    }

    case "session.tool.failed": {
      const msg = messageFor(list, d.assistantMessageID, created)
      const part = toolPart(msg, d.id)
      part.state = {
        status: "error",
        input: part.state?.input ?? {},
        error: d.error,
        content: d.content ?? [],
        metadata: d.metadata,
      }
      return { messages: list }
    }

    case "session.execution.started":
      return { messages: prev, busy: true }

    case "session.retry.scheduled":
      return { messages: prev, busy: true }

    case "session.execution.succeeded":
      return { messages: prev, busy: false, done: true }

    case "session.execution.failed":
      return {
        messages: prev,
        busy: false,
        done: true,
        error: d.error?.message ?? d.message ?? t("Request execution failed"),
      }

    case "session.execution.interrupted":
      return { messages: prev, busy: false, done: true }

    case "session.compaction.started": {
      const key = compactionKey(d)
      const list: Message[] = [...prev]
      const msg: Message = {
        id: `comp:${key}`,
        type: "assistant",
        content: [{ type: "compaction", status: "running", text: "", id: "compaction" }],
        time: { created: created || Date.now() },
      }
      const i = list.findIndex((m) => m.id === msg.id)
      if (i >= 0) list[i] = msg
      else list.push(msg)
      return { messages: list, busy: true }
    }

    case "session.compaction.delta": {
      const key = compactionKey(d)
      const list = [...prev]
      const i = list.findIndex((m) => m.id === `comp:${key}`)
      if (i === -1) {
        const msg: Message = {
          id: `comp:${key}`,
          type: "assistant",
          content: [{ type: "compaction", status: "running", text: String(d.text ?? ""), id: "compaction" }],
          time: { created: created || Date.now() },
        }
        list.push(msg)
        return { messages: list, busy: true }
      }
      const before = list[i]
      const parts = (before.content ?? []).map((p) =>
        p.type === "compaction" ? { ...p, status: "running" as const, text: (p.text ?? "") + String(d.text ?? "") } : p,
      )
      list[i] = { ...before, content: parts }
      return { messages: list }
    }

    case "session.compaction.ended": {
      const key = compactionKey(d)
      const list = [...prev]
      const i = list.findIndex((m) => m.id === `comp:${key}`)
      if (i >= 0) {
        const before = list[i]
        const parts = (before.content ?? []).map((p) =>
          p.type === "compaction" ? { ...p, status: "completed" as const, text: String(d.text ?? p.text ?? "") } : p,
        )
        list[i] = { ...before, content: parts }
      }
      return { messages: list, busy: false, done: true }
    }

    case "session.compaction.failed": {
      const key = compactionKey(d)
      const list = [...prev]
      const i = list.findIndex((m) => m.id === `comp:${key}`)
      const why = d.error?.message ?? d.error?.name ?? d.error ?? t("Compaction failed")
      if (i >= 0) {
        const before = list[i]
        const parts = (before.content ?? []).map((p) =>
          p.type === "compaction" ? { ...p, status: "failed" as const, error: String(why) } : p,
        )
        list[i] = { ...before, content: parts }
      }
      return {
        messages: list,
        busy: false,
        error: typeof why === "string" ? `${t("Compaction failed")}: ${why}` : t("Compaction failed"),
      }
    }

    case "session.renamed":
      return { messages: prev, renamed: { id: d.sessionID, title: d.title } }

    default:
      return { messages: prev }
  }
}
