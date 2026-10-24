import type { Message, Part } from "./types"

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

export type ReduceResult = {
  messages: Message[]
  busy?: boolean
  done?: boolean
  error?: string
  renamed?: { id: string; title: string }
}

export function reduce(prev: Message[], ev: any): ReduceResult {
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

    case "session.tool.input.started": {
      const msg = messageFor(list, d.assistantMessageID, created)
      toolPart(msg, d.id, d.name)
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

    case "session.tool.error": {
      const msg = messageFor(list, d.assistantMessageID, created)
      const part = toolPart(msg, d.id)
      part.state = {
        status: "error",
        input: part.state?.input ?? {},
        content: d.content ?? [{ type: "text", text: d.error ?? "خطای ابزار" }],
        metadata: d.metadata,
      }
      return { messages: list }
    }

    case "session.execution.started":
      return { messages: prev, busy: true }

    case "session.execution.succeeded":
      return { messages: prev, busy: false, done: true }

    case "session.execution.failed":
      return {
        messages: prev,
        busy: false,
        done: true,
        error: d.error?.message ?? d.message ?? "اجرای درخواست ناموفق بود",
      }

    case "session.execution.interrupted":
      return { messages: prev, busy: false, done: true }

    case "session.compaction.started": {
      const key = String(d.inputID ?? d.sessionID ?? "compaction")
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
      const key = String(d.inputID ?? d.sessionID ?? "compaction")
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
      const key = String(d.inputID ?? d.sessionID ?? "compaction")
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
      const key = String(d.inputID ?? d.sessionID ?? "compaction")
      const list = [...prev]
      const i = list.findIndex((m) => m.id === `comp:${key}`)
      const why = d.error?.message ?? d.error?.name ?? d.error ?? "فشرده‌سازی ناموفق بود"
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
        error: typeof why === "string" ? `فشرده‌سازی ناموفق بود: ${why}` : "فشرده‌سازی ناموفق بود",
      }
    }

    case "session.renamed":
      return { messages: prev, renamed: { id: d.sessionID, title: d.title } }

    default:
      return { messages: prev }
  }
}
