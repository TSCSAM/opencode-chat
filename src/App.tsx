import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { appPost, del, get, patch, post } from "./api"
import { connectEvents } from "./events"
import { reduce } from "./reduce"
import type { AgentInfo, Attachment, CommandInfo, Message, ModelInfo, ModelRef, Part, PermissionRequest, PromptFile, SessionInfo, SkillInfo, MenuItem } from "./types"
import { Markdown } from "./Markdown"
import { ToolCard } from "./ToolCard"
import { Composer } from "./Composer"
import { Sidebar } from "./Sidebar"
import { Owl } from "./Owl"
import { ModelPicker } from "./ModelPicker"
import { AgentPicker } from "./AgentPicker"
import { Settings } from "./Settings"
import { UpdatePanel } from "./Update"
import { QuestionCard } from "./QuestionCard"
import type { EngineForm } from "./types"

async function dirExists(dir: string) {
  try {
    const res = await fetch(`/oc/api/location?location%5Bdirectory%5D=${encodeURIComponent(dir)}`)
    return res.ok
  } catch {
    return false
  }
}

function cleanDir(raw: string) {
  return raw
    .trim()
    .replace(/^["']+|["']+$/g, "")
    .replace(/[\\/]+$/, "")
}

const SUGGESTIONS = [
  "این پروژه را بررسی کن و ساختارش را کوتاه توضیح بده",
  "یک صفحه فرود فارسی و RTL برای سرویس VPN بساز",
  "باگ‌های TypeScript را پیدا کن و درست کن",
]

function folder(directory?: string) {
  if (!directory) return ""
  return directory.split(/[\\/]/).filter(Boolean).pop() ?? directory
}

function Typing() {
  return (
    <div className="typing" aria-label="در حال نوشتن">
      <span />
      <span />
      <span />
    </div>
  )
}

function AssistantBody({ message, live }: { message: Message; live: boolean }) {
  const parts = message.content ?? (message.text?.trim() ? [{ type: "text", text: message.text }] : [])
  const reasoning = parts.filter((p) => p.type === "reasoning" && p.text?.trim())
  const visible = parts.filter((p) => p.type !== "reasoning" && (p.type === "tool" || p.text?.trim()))
  const empty = visible.length === 0 && reasoning.length === 0

  return (
    <>
      {reasoning.length > 0 && (
        <details className="reasoning">
          <summary>استدلال</summary>
          <div className="reasoning-body">
            {reasoning.map((r, i) => (
              <p key={i} dir="auto">
                {r.text}
              </p>
            ))}
          </div>
        </details>
      )}

      {parts.map((p, i) => {
        if (p.type === "reasoning") return null
        if (p.type === "tool") return <ToolCard key={p.id ?? i} part={p} />
        if (p.type === "compaction") return <CompactionStrip key={p.id ?? i} part={p} />
        return p.text?.trim() ? <Markdown key={i} text={p.text} /> : null
      })}

      {empty && live && <Typing />}

      {message.error && (
        <div className="msg-error">{message.error?.message ?? message.error?.name ?? "خطا در پاسخ مدل"}</div>
      )}
    </>
  )
}

function AssistantGroup({ messages, busy }: { messages: Message[]; busy: boolean }) {
  return (
    <div className="row assistant">
      <div className="avatar" aria-hidden>
        <Owl size={22} />
      </div>
      <div className="msg-body">
        {messages.map((m, i) => (
          <AssistantBody key={m.id} message={m} live={busy && i === messages.length - 1} />
        ))}
      </div>
    </div>
  )
}

function CompactionStrip({ part }: { part: Part }) {
  if (part.status === "failed") {
    return (
      <div className="compaction failed" dir="auto">
        <span className="compaction-icon" aria-hidden>
          🗜
        </span>
        فشرده‌سازی ناموفق بود{part.error ? ` — ${part.error}` : ""}
      </div>
    )
  }
  const running = part.status !== "completed"
  return (
    <div className={`compaction ${running ? "running" : ""}`} dir="auto">
      <div className="compaction-head">
        <span className="compaction-icon" aria-hidden>
          🗜
        </span>
        {running ? "در حال فشرده‌سازی زمینه…" : "زمینه فشرده شد"}
      </div>
      {part.text?.trim() ? <Markdown text={part.text} /> : running && <Typing />}
    </div>
  )
}

function PermissionCard({ request, onReply }: { request: PermissionRequest; onReply: (r: PermissionRequest, decision: string) => void }) {
  return (
    <div className="perm">
      <div className="perm-head">
        <span className="perm-shield">!</span> اجازه‌ی اجرا لازم است
      </div>
      <div className="perm-action" dir="auto">
        {request.action}
      </div>
      {request.resources?.length > 0 && (
        <pre className="perm-res" dir="ltr">
          {request.resources.join("\n")}
        </pre>
      )}
      {request.message && (
        <div className="perm-msg" dir="auto">
          {request.message}
        </div>
      )}
      <div className="perm-actions">
        <button type="button" className="allow" onClick={() => onReply(request, "once")}>
          اجازه بده
        </button>
        {request.save && request.save.length > 0 && (
          <button type="button" onClick={() => onReply(request, "always")}>
            همیشه اجازه بده
          </button>
        )}
        <button type="button" className="deny" onClick={() => onReply(request, "reject")}>
          رد کن
        </button>
      </div>
    </div>
  )
}

function groupMessages(list: Message[]): Group[] {
  const groups: Group[] = []
  for (const message of list) {
    if (message.type === "user") {
      groups.push({ kind: "user", message })
      continue
    }
    const last = groups[groups.length - 1]
    if (last && last.kind === "assistant") last.messages.push(message)
    else groups.push({ kind: "assistant", messages: [message] })
  }
  return groups
}

type Group = { kind: "user"; message: Message } | { kind: "assistant"; messages: Message[] }

function fmtTok(n?: number) {
  if (!n || n <= 0) return "0"
  if (n < 1000) return String(n)
  if (n < 1e6) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k"
  return (n / 1e6).toFixed(2).replace(/\.00$/, "").replace(/\.0$/, "") + "M"
}

function fmtFull(n?: number) {
  return Math.round(n ?? 0).toLocaleString("en-US")
}

function fmtCost(n?: number) {
  if (n == null || n <= 0) return "0"
  return n >= 1 ? "$" + n.toFixed(2) : "$" + String(n.toPrecision(2))
}

function UsageChip({
  messages,
  models,
  sessionCost,
  sessionTokens,
}: {
  messages: Message[]
  models: ModelInfo[]
  sessionCost?: number
  sessionTokens?: any
}) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", down)
    return () => document.removeEventListener("mousedown", down)
  }, [open])

  const last = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.type === "assistant" && m.tokens?.input != null) return m
    }
    return null
  }, [messages])

  if (!last?.tokens) return null

  const t = last.tokens
  const used = (t.input ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0)
  const limit = models.find(
    (m) => m.providerID === last.model?.providerID && (m.modelID ?? m.id) === last.model?.id,
  )?.limit?.context
  const pct = limit && limit > 0 ? (used / limit) * 100 : null
  const pctLabel = pct == null ? "—" : pct < 10 ? pct.toFixed(1) : Math.round(pct).toString()

  return (
    <div className="model-anchor" ref={box}>
      <button
        type="button"
        className={`chip usage chip-btn ${pct != null && pct > 80 ? "usage-hot" : ""}`}
        onClick={() => setOpen((v) => !v)}
        title="مصرف توکن و زمینه"
      >
        <span className="chip-label" dir="ltr">
          {pct != null ? `${pctLabel}% · ` : ""}
          {fmtTok(used)}
          {limit ? `/${fmtTok(limit)}` : ""}
        </span>
        <span className="chip-caret">▾</span>
      </button>

      {open && (
        <div className="model-pop usage-pop" role="dialog" aria-label="مصرف توکن">
          <div className="usage-row">
            <span>زمینه‌ی در حال استفاده</span>
            <code dir="ltr">{fmtFull(used)} tok</code>
          </div>
          {limit && (
            <div className="usage-row">
              <span>پنجره‌ی مدل</span>
              <code dir="ltr">{fmtFull(limit)} tok</code>
            </div>
          )}
          {pct != null && (
            <div className="usage-row">
              <span>سهم استفاده</span>
              <code dir="ltr">{pctLabel}%</code>
            </div>
          )}
          <div className="usage-sep" />
          <div className="usage-row">
            <span>ورودی آخرین پاسخ</span>
            <code dir="ltr">{fmtFull(t.input)}</code>
          </div>
          <div className="usage-row">
            <span>خوانده از کش</span>
            <code dir="ltr">{fmtFull(t.cache?.read)}</code>
          </div>
          <div className="usage-row">
            <span>نوشته در کش</span>
            <code dir="ltr">{fmtFull(t.cache?.write)}</code>
          </div>
          <div className="usage-row">
            <span>خروجی</span>
            <code dir="ltr">{fmtFull(t.output)}</code>
          </div>
          <div className="usage-row">
            <span>استدلال</span>
            <code dir="ltr">{fmtFull(t.reasoning)}</code>
          </div>
          <div className="usage-sep" />
          {sessionTokens && (
            <>
              <div className="usage-row head">
                <span>مجموع این گفت‌وگو</span>
              </div>
              <div className="usage-row">
                <span>توکن‌ها (ورودی+کش+خروجی+استدلال)</span>
                <code dir="ltr">{fmtFull((sessionTokens.input ?? 0) + (sessionTokens.output ?? 0) + (sessionTokens.reasoning ?? 0) + (sessionTokens.cache?.read ?? 0) + (sessionTokens.cache?.write ?? 0))}</code>
              </div>
            </>
          )}
          {sessionCost != null && (
            <div className="usage-row">
              <span>هزینه‌ی گفت‌وگو</span>
              <code dir="ltr">{fmtCost(sessionCost)}</code>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function App() {
  const [config, setConfig] = useState<{ directory: string; version?: string } | null>(null)
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [busy, setBusy] = useState(false)
  const [connected, setConnected] = useState(false)
  const [perms, setPerms] = useState<PermissionRequest[]>([])
  const [forms, setForms] = useState<EngineForm[]>([])
  const [error, setError] = useState<string | null>(null)
  const [menu, setMenu] = useState(false)
  const [workdir, setWorkdir] = useState("")
  const [models, setModels] = useState<ModelInfo[]>([])
  const [model, setModel] = useState<ModelRef | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [agent, setAgent] = useState<string | null>(null)
  const [agentOpen, setAgentOpen] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const contextCache = useRef<any[] | null>(null)
  const [commands, setCommands] = useState<CommandInfo[]>([])
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [updateOpen, setUpdateOpen] = useState(false)
  const [updateAvailable, setUpdateAvailable] = useState<string | null>(null)
  const [running, setRunning] = useState<Record<string, boolean>>({})
  const [serverDown, setServerDown] = useState(false)

  const activeRef = useRef<string | null>(null)
  const busyRef = useRef(false)
  const pendingSkill = useRef<string | null>(null)
  const messagesRef = useRef<Message[]>([])
  const atBottom = useRef(true)
  const scroller = useRef<HTMLDivElement>(null)

  const apply = useCallback((next: Message[]) => {
    messagesRef.current = next
    setMessages(next)
  }, [])

  const loadMessages = useCallback(
    async (id: string) => {
      try {
        const res = await get<{ data: Message[] }>(`/api/session/${id}/message?limit=200&order=desc`)
        if (activeRef.current !== id) return
        contextCache.current = null
        const list = (res.data ?? []).map((m: any): Message =>
          m?.type === "compaction"
            ? {
                ...m,
                type: "assistant",
                content: [
                  {
                    type: "compaction",
                    id: "compaction",
                    status: m.status ?? "completed",
                    text: typeof m.summary === "string" ? m.summary : "",
                    error:
                      m.error?.message ?? m.error ?? undefined,
                  },
                ],
              }
            : m,
        )
        apply([...list].reverse())
        setHasMore(list.length >= 200)
      } catch (e: any) {
        setError(e.message)
      }
    },
    [apply],
  )

  const loadOlder = useCallback(async () => {
    const id = activeRef.current
    if (!id || loadingOlder) return
    setLoadingOlder(true)
    try {
      let full = contextCache.current
      if (!full) {
        const res = await get<{ data: any[] }>(`/api/session/${id}/context`).catch(() => null)
        if (activeRef.current !== id) return
        full = res?.data ?? []
        contextCache.current = full
      }
      const loaded = messagesRef.current.length
      const olderAll = full.slice(0, Math.max(0, full.length - loaded))
      const batch = olderAll.slice(-50)
      if (batch.length > 0) {
        const el = scroller.current
        const prevHeight = el?.scrollHeight ?? 0
        const prevTop = el?.scrollTop ?? 0
        const mapped: Message[] = batch.map((m) => ({
          id: String(m.id ?? ""),
          type: m.type === "user" ? "user" : "assistant",
          text: typeof m.text === "string" ? m.text : undefined,
          time: m.time,
        }))
        apply([...mapped, ...messagesRef.current])
        requestAnimationFrame(() => {
          const el2 = scroller.current
          if (el2) el2.scrollTop = el2.scrollHeight - prevHeight + prevTop
        })
      }
      setHasMore(olderAll.length > batch.length)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoadingOlder(false)
    }
  }, [apply, loadingOlder])

  const refreshPerms = useCallback(async () => {
    try {
      const res = await get<{ data: PermissionRequest[] }>("/api/permission/request")
      const id = activeRef.current
      setPerms((res.data ?? []).filter((p) => !id || p.sessionID === id))
} catch {}
  }, [])

  const refreshForms = useCallback(async () => {
    const id = activeRef.current
    if (!id) return
    try {
      const res = await get<{ data: EngineForm[] }>(`/api/session/${id}/form`)
      const list = res.data ?? []
      const pendings = await Promise.all(
        list.map(async (f) => {
          try {
            const det = await get<{ data: EngineForm }>(`/api/session/${id}/form/${f.id}`)
            return det.data?.state?.status === "pending" ? (det.data ?? f) : null
          } catch {
            return null
          }
        }),
      )
      setForms(pendings.filter(Boolean) as EngineForm[])
} catch {}
  }, [])

  const refreshSessions = useCallback(
    async (autoselect = false) => {
      try {
        const res = await get<{ data: SessionInfo[] }>("/api/session?limit=50")
        const list = res.data ?? []
        setSessions(list)
        if (autoselect && !activeRef.current && list[0]) {
          activeRef.current = list[0].id
          setActiveId(list[0].id)
          await loadMessages(list[0].id)
        }
      } catch (e: any) {
        setError(e.message)
      }
    },
    [loadMessages],
  )

  const select = useCallback(
    async (id: string) => {
      if (activeRef.current === id) {
        setMenu(false)
        return
      }
      activeRef.current = id
      setActiveId(id)
      setBusy(false)
      setPerms([])
      setForms([])
      setMenu(false)
      atBottom.current = true
      apply([])
      await loadMessages(id)
      void refreshPerms()
      void refreshForms()
    },
    [apply, loadMessages, refreshPerms, refreshForms],
  )

  const changeWorkdir = useCallback(async (raw: string) => {
    const dir = cleanDir(raw)
    if (!dir) return false
    if (!(await dirExists(dir))) {
      setError(`پوشه پیدا نشد: ${dir}`)
      return false
    }
    setWorkdir(dir)
    localStorage.setItem("oc-workdir", dir)
    return true
  }, [])

  const applyModel = useCallback(async (ref: ModelRef) => {
    setModel(ref)
    setPickerOpen(false)
    localStorage.setItem("oc-model", JSON.stringify(ref))
    const id = activeRef.current
    if (!id) return
    try {
      await post(`/api/session/${id}/model`, { model: ref })
      setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, model: ref } : s)))
    } catch (e: any) {
      setError(e.message)
    }
  }, [])

  const applyAgent = useCallback(async (id: string | null) => {    setAgent(id)
    setAgentOpen(false)
    localStorage.setItem("oc-agent", id ?? "")
    const sid = activeRef.current
    if (!sid) return
    try {
      if (id) await post(`/api/session/${sid}/agent`, { agent: id })
      setSessions((prev) => prev.map((s) => (s.id === sid ? { ...s, agent: id ?? undefined } : s)))
    } catch (e: any) {
      setError(e.message)
    }
  }, [])

  const renameSession = useCallback(async (id: string, title: string) => {
    const clean = title.trim()
    if (!clean) return
    try {
      await patch(`/api/session/${id}`, { title: clean })
      setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, title: clean } : s)))
    } catch (e: any) {
      setError(e.message)
    }
  }, [])

  const deleteSession = useCallback(
    async (id: string) => {
      try {
        if (busyRef.current && activeRef.current === id) {
          await post(`/api/session/${id}/interrupt`).catch(() => null)
        }
        await del(`/api/session/${id}`)
        setSessions((prev) => prev.filter((s) => s.id !== id))
        if (activeRef.current === id) {
          activeRef.current = null
          setActiveId(null)
          setBusy(false)
          setPerms([])
          apply([])
          await refreshSessions(true)
        }
      } catch (e: any) {
        setError(e.message)
      }
    },
    [apply, refreshSessions],
  )

  const createSession = useCallback(async () => {
    try {
      const fallback = config?.directory
      let directory = workdir || fallback
      if (directory && directory !== fallback && !(await dirExists(directory))) {
        localStorage.removeItem("oc-workdir")
        setWorkdir(fallback ?? "")
        setError(`پوشه «${directory}» پیدا نشد؛ از «${fallback}» استفاده می‌کنم.`)
        directory = fallback
      }

      const payload: any = {}
      if (directory) payload.location = { directory }
      if (model) payload.model = model
      if (agent) payload.agent = agent

      const res = await post<any>("/api/session", payload)
      const raw: Partial<SessionInfo> = res?.data ?? res ?? {}
      if (!raw.id) throw new Error("ساخت گفت‌وگو ناموفق بود")
      const now = Date.now()
      const session: SessionInfo = {
        id: raw.id!,
        title: raw.title,
        projectID: raw.projectID,
        agent: raw.agent,
        model: raw.model ?? model ?? undefined,
        cost: raw.cost,
        tokens: raw.tokens,
        location: raw.location ?? (directory ? { directory } : undefined),
        time: raw.time ?? { created: now, updated: now },
      }
      activeRef.current = session.id
      setActiveId(session.id)
      apply([])
      setPerms([])
      setForms([])
      setSessions((prev) => [session, ...prev.filter((s) => s.id !== session.id)])
      return session.id
    } catch (e: any) {
      setError(e.message)
      return null
    }
  }, [apply, workdir, config?.directory, model, agent])

  const handleEvent = (ev: any) => {
    const type = String(ev.type ?? "")
    const data = ev.data ?? {}
    if (type === "server.connected") return

    if (type.includes("permission")) void refreshPerms()
    if (type === "form.created" && data.form?.sessionID === activeRef.current) {
      const f = data.form
      setForms((prev) => [...prev.filter((x) => x.id !== f.id), f])
    }
    if (type === "form.replied" || type === "form.cancelled") {
      setForms((prev) => prev.filter((x) => x.id !== data.id))
    }
    if (type === "installation.update-available" && typeof data.version === "string") {
      setUpdateAvailable(data.version)
    }
    if (type === "session.usage.recorded" || type === "session.usage.updated") {
      void refreshSessions()
    }
    if (type === "session.renamed") {
      setSessions((prev) => prev.map((s) => (s.id === data.sessionID ? { ...s, title: data.title } : s)))
    }
    if (type === "session.created" || type === "session.renamed" || type.startsWith("session.execution")) {
      void refreshSessions()
    }

    const id = data.sessionID
    if (!id || id !== activeRef.current) return

    const result = reduce(messagesRef.current, ev)
    if (result.messages !== messagesRef.current) apply(result.messages)
    if (result.busy !== undefined) setBusy(result.busy)
    if (result.error) setError(result.error)
    if (result.done) {
      void loadMessages(id)
      void refreshPerms()
    }
  }

  const handlerRef = useRef(handleEvent)
  useEffect(() => {
    handlerRef.current = handleEvent
  })
  useEffect(() => {
    busyRef.current = busy
  })

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const cfg = await fetch("/__config").then((r) => r.json())
        if (!alive) return
        setConfig(cfg)

        if (localStorage.getItem("oc-launch") !== cfg.directory) {
          localStorage.setItem("oc-launch", cfg.directory)
          localStorage.removeItem("oc-workdir")
        }

        const savedDir = localStorage.getItem("oc-workdir")
        if (savedDir) {
          const clean = cleanDir(savedDir)
          if (clean && (clean === cfg.directory || (await dirExists(clean)))) {
            setWorkdir(clean)
            if (clean !== savedDir) localStorage.setItem("oc-workdir", clean)
          } else {
            localStorage.removeItem("oc-workdir")
            setWorkdir(cfg.directory)
            setError(`پوشه‌ی ذخیره‌شده پیدا نشد؛ از «${cfg.directory}» استفاده می‌کنم.`)
          }
        } else {
          setWorkdir(cfg.directory)
        }

        const savedModel = localStorage.getItem("oc-model")
        if (savedModel) {
          try {
            setModel(JSON.parse(savedModel))
} catch {}
        }
        setAgent(localStorage.getItem("oc-agent") || null)
} catch {}

      const available = await get<{ data: ModelInfo[] }>("/api/model").catch(() => null)
      if (alive && available) {
        const seen = new Set<string>()
        const unique: ModelInfo[] = []
        for (const m of available.data ?? []) {
          const key = `${m.providerID}/${m.modelID ?? m.id}`
          if (seen.has(key)) continue
          seen.add(key)
          unique.push(m)
        }
        setModels(unique)
      }

      const agentList = await get<{ data: AgentInfo[] }>("/api/agent").catch(() => null)
      if (alive && agentList) setAgents(agentList.data ?? [])

      const cmdList = await get<{ data: CommandInfo[] }>("/api/command").catch(() => null)
      if (alive && cmdList) setCommands(cmdList.data ?? [])

      const skillList = await get<{ data: SkillInfo[] }>("/api/skill").catch(() => null)
      if (alive && skillList) setSkills(skillList.data ?? [])

      await refreshSessions(true)
    })()
    const disconnect = connectEvents((ev) => handlerRef.current(ev), setConnected)
    return () => {
      alive = false
      disconnect()
    }
  }, [refreshSessions])

  useEffect(() => {
    const session = sessions.find((s) => s.id === activeId)
    if (session?.model) setModel(session.model)
    setAgent(session?.agent ?? null)
  }, [activeId])

  useEffect(() => {
    if (!error) return
    const timer = window.setTimeout(() => setError(null), 7000)
    return () => window.clearTimeout(timer)
  }, [error])

  useEffect(() => {
    const el = scroller.current
    if (!el || !atBottom.current) return
    el.scrollTop = el.scrollHeight
  }, [messages, busy])

  const active = sessions.find((s) => s.id === activeId) ?? null

  const slashItems = useMemo<MenuItem[]>(() => {
    const items: MenuItem[] = [
      { id: "builtin:new", label: "new", hint: "گفت‌وگوی جدید", group: "دستورها" },
      { id: "builtin:sessions", label: "sessions", hint: "همه‌ی گفت‌وگوها", group: "دستورها" },
      { id: "builtin:model", label: "model", hint: "انتخاب مدل", group: "دستورها" },
      { id: "builtin:agent", label: "agent", hint: "انتخاب ایجنت", group: "دستورها" },
      { id: "builtin:compact", label: "compact", hint: "فشرده‌سازی نشست جاری", group: "دستورها" },
      { id: "builtin:undo", label: "undo", hint: "پس‌گرفتن آخرین پیام و پاسخش", group: "دستورها" },
      { id: "builtin:export", label: "export", hint: "کپی گفت‌وگو در کلیپ‌بورد", group: "دستورها" },
      { id: "builtin:interrupt", label: "interrupt", hint: "توقف اجرای جاری", group: "دستورها" },
      { id: "builtin:settings", label: "settings", hint: "تنظیمات OpenCode", group: "دستورها" },
      { id: "builtin:update", label: "update", hint: "به‌روزرسانی موتور", group: "دستورها" },
    ]
    for (const c of commands) {
      items.push({ id: `custom:${c.name}`, label: c.name, hint: c.description ?? "", group: "سفارشی" })
    }
    for (const s of skills) {
      items.push({ id: `skill:${s.id}`, label: s.id, hint: s.description ?? "", group: "مهارت‌ها" })
    }
    return items
  }, [commands, skills])

  const send = async (text: string, attachments: Attachment[] = [], promptFiles: PromptFile[] = []) => {
    const queued = busyRef.current
    const skill = pendingSkill.current
    let id = activeRef.current
    if (!id) {
      id = await createSession()
      if (!id) return
    }
    setBusy(true)
    atBottom.current = true
    const body: Record<string, any> = queued ? { text, delivery: "queue" } : { text }
    if (skill) {
      pendingSkill.current = null
      body.skills = [{ id: skill }]
    }
    if (attachments.length > 0) {
      const uploaded: PromptFile[] = []
      for (const a of attachments) {
        try {
          const res = await appPost<{ ok?: boolean; path?: string; error?: string }>("/app/upload", { name: a.name, dataUrl: a.dataUrl })
          if (!res?.ok || !res.path) throw new Error(res?.error ?? "آپلود تصویر ناموفق بود")
          uploaded.push({ uri: "file:///" + res.path.replace(/^\\+/, "").replace(/\\/g, "/"), name: a.name })
        } catch (e: any) {
          setError(`${a.name}: ${e.message}`)
        }
      }
      if (uploaded.length > 0) body.files = [...promptFiles, ...uploaded]
    } else if (promptFiles.length > 0) {
      body.files = promptFiles
    }
    try {
      await post(`/api/session/${id}/prompt`, body)
    } catch (e: any) {
      if (!queued) setBusy(false)
      setError(e.message)
    }
  }

  const stop = async () => {
    const id = activeRef.current
    if (!id) return
    try {
      await post(`/api/session/${id}/interrupt`)
} catch {}
    setBusy(false)
  }

  const runSlash = useCallback(
    async (id: string) => {
      const sid = activeRef.current
      switch (id) {
        case "builtin:new":
          void createSession()
          return
        case "builtin:sessions":
          setMenu(true)
          return
        case "builtin:model":
          setPickerOpen(true)
          return
        case "builtin:agent":
          setAgentOpen(true)
          return
        case "builtin:settings":
          setSettingsOpen(true)
          return
        case "builtin:update":
          setUpdateOpen(true)
          return
        case "builtin:interrupt":
          void stop()
          return
        case "builtin:compact": {
          if (!sid) {
            setError("اول یک گفت‌وگو بساز")
            return
          }
          try {
            await post(`/api/session/${sid}/compact`, {})
            setBusy(true)
          } catch (e: any) {
            setError(e.message)
          }
          return
        }
        case "builtin:undo": {
          if (!sid) {
            setError("اول یک گفت‌وگو بساز")
            return
          }
          const list = messagesRef.current
          const lastUser = [...list].reverse().find((m) => m.type === "user")
          if (!lastUser) {
            setError("چیزی برای پس‌گرفتن نیست")
            return
          }
          try {
            await post(`/api/session/${sid}/revert/stage`, { messageID: lastUser.id, files: false })
            await post(`/api/session/${sid}/revert/commit`, {})
            await loadMessages(sid)
            setError("آخرین پیام و پاسخش پس گرفته شد")
          } catch (e: any) {
            setError(e.message)
          }
          return
        }
        case "builtin:export": {
          const list = messagesRef.current
          if (list.length === 0) {
            setError("چیزی برای خروجی گرفتن نیست")
            return
          }
          const title = sessions.find((s) => s.id === sid)?.title ?? list.find((m) => m.type === "user")?.text ?? "گفت‌وگو"
          const lines: string[] = [`# ${title}`, ""]
          for (const m of list) {
            if (m.type === "user") {
              lines.push("## کاربر", "")
              if (m.text) lines.push(m.text, "")
              if (m.files?.length) lines.push(...m.files.map((f) => `- فایل: ${f.name ?? f.uri}`), "")
            } else if (m.type === "assistant") {
              const text = (m.content ?? [])
                .map((p) => (p.type === "compaction" ? (p.text ?? "") : p.type === "text" ? (p.text ?? "") : ""))
                .filter((t) => t.trim())
                .join("\n\n")
              if (text.trim()) lines.push("## دستیار", "", text, "")
            }
          }
          const md = lines.join("\n")
          const date = new Date().toISOString().slice(0, 10).replaceAll("-", "")
          try {
            await navigator.clipboard.writeText(md)
            setError("گفت‌وگو در کلیپ‌بورد کپی شد (Markdown)")
          } catch {
            const blob = new Blob([md], { type: "text/markdown;charset=utf-8" })
            const a = document.createElement("a")
            a.href = URL.createObjectURL(blob)
            a.download = `opencode-chat-${date}.md`
            a.click()
            URL.revokeObjectURL(a.href)
            setError("فایل مارک‌داون گفت‌وگو دانلود شد")
          }
          return
        }
      }
      if (id.startsWith("custom:")) {
        const name = id.slice(8)
        if (!sid) {
          setError("اول یک گفت‌وگو بساز")
          return
        }
        try {
          await post(`/api/session/${sid}/command`, { name, text: "" })
        } catch (e: any) {
          setError(e.message)
        }
        return
      }
      if (id.startsWith("skill:")) {
        const skillId = id.slice(6)
        pendingSkill.current = skillId
        setError(`مهارت «${skillId}» برای پیام بعدی فعال شد`)
        return
      }
    },
    [createSession, stop, sessions, loadMessages],
  )

  const reply = async (request: PermissionRequest, decision: string) => {
    setPerms((prev) => prev.filter((p) => p.id !== request.id))
    try {
      await post(`/api/session/${request.sessionID}/permission/${request.id}/reply`, { decision })
    } catch (e: any) {
      setError(e.message)
    }
  }

  const replyForm = async (form: EngineForm, answer: Record<string, any>) => {
    setForms((prev) => prev.filter((x) => x.id !== form.id))
    try {
      await post(`/api/session/${form.sessionID}/form/${form.id}/reply`, { answer })
    } catch (e: any) {
      setError(e.message)
    }
  }

  const cancelForm = async (form: EngineForm) => {
    setForms((prev) => prev.filter((x) => x.id !== form.id))
    try {
      await del(`/api/session/${form.sessionID}/form/${form.id}`)
    } catch (e: any) {
      setError(e.message)
    }
  }

  const visible = messages.filter((m) => m.type === "user" || m.type === "assistant")
  const groups = groupMessages(visible)
  const lastAssistant = [...visible].reverse().find((m) => m.type === "assistant")
  const showTyping = busy && (!lastAssistant || Boolean(lastAssistant.time?.completed))

  const currentModel = models.find((m) => m.providerID === model?.providerID && (m.modelID ?? m.id) === model?.id)
  const modelLabel = `${currentModel?.name ?? model?.id ?? "انتخاب مدل"}${model?.variant ? ` · ${model.variant}` : ""}`
  const agentLabel = agents.find((a) => a.id === agent)?.name ?? (agent ?? "ایجنت پیش‌فرض")
  const folderLabel = folder(active?.location?.directory) || folder(workdir) || folder(config?.directory)

  return (
    <div className={`app ${menu ? "menu-open" : ""}`} data-session={activeId ?? ""}>
      <Sidebar
        sessions={sessions}
        activeId={activeId}
        connected={connected}
        version={config?.version}
        workdir={workdir || config?.directory || ""}
        onWorkdir={changeWorkdir}
        onSelect={select}
        onNew={createSession}
        onRename={renameSession}
        onDelete={deleteSession}
        updateAvailable={updateAvailable}
        onUpdate={() => setUpdateOpen(true)}
      />

      <main className="chat">
        <header className="chat-head">
          <button type="button" className="hamburger" onClick={() => setMenu((v) => !v)} aria-label="گفت‌وگوها">
            ☰
          </button>
          <div className="chat-title">
            <h1>{active?.title || "گفت‌وگوی جدید"}</h1>
            <div className="chat-sub">
              <span className="chip" dir="auto">
                {folderLabel}
              </span>
              <div className="model-anchor">
                <button
                  type="button"
                  className={`chip model chip-btn ${pickerOpen ? "open" : ""}`}
                  onClick={() => setPickerOpen((v) => !v)}
                  title="انتخاب مدل"
                >
                  <span className="chip-label" dir="auto">
                    {modelLabel}
                  </span>
                  <span className="chip-caret">▾</span>
                </button>
                {pickerOpen && (
                  <ModelPicker
                    models={models}
                    value={model}
                    onPick={applyModel}
                    onClose={() => setPickerOpen(false)}
                  />
                )}
              </div>
              {agents.filter((a) => a.mode !== "subagent" && !a.hidden).length > 0 && (
                <div className="model-anchor">
                  <button
                    type="button"
                    className={`chip agent chip-btn ${agentOpen ? "open" : ""}`}
                    onClick={() => setAgentOpen((v) => !v)}
                    title="انتخاب ایجنت"
                  >
                    <span className="chip-label" dir="auto">
                      {agentLabel}
                    </span>
                    <span className="chip-caret">▾</span>
                  </button>
                  {agentOpen && (
                    <AgentPicker
                      agents={agents}
                      value={agent}
                      onPick={applyAgent}
                      onClose={() => setAgentOpen(false)}
                    />
                  )}
                </div>
              )}
              {perms.length > 0 && <span className="chip warn">{perms.length} در انتظار تأیید</span>}
              {active && (
                <UsageChip messages={messages} models={models} sessionCost={active.cost} sessionTokens={active.tokens} />
              )}
            </div>
          </div>
        </header>

        <div
          className="thread"
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget
            atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90
          }}
        >
          {visible.length > 0 && hasMore && (
            <div className="load-older-wrap" key="load-older">
              <button type="button" className="load-older" onClick={loadOlder} disabled={loadingOlder}>
                {loadingOlder ? "در حال بارگذاری…" : "پیام‌های قدیمی‌تر"}
              </button>
            </div>
          )}

          {visible.length > 0 && <div className="thread-filler" key="filler" aria-hidden />}

          {visible.length === 0 && (
            <div className="welcome" key="welcome">
              <div className="welcome-mark">
                <Owl size={34} />
              </div>
              <h2>از کجا شروع کنیم؟</h2>
              <p>همان موتور OpenCode، این بار با چیدمان درست فارسی.</p>
              <div className="suggestions">
                {SUGGESTIONS.map((s) => (
                  <button key={s} type="button" onClick={() => send(s)}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {groups.map((g) =>
            g.kind === "user" ? (
              <div className="row user" key={g.message.id}>
                <div className="bubble" dir="auto">
                  {g.message.text}
                  {(g.message.files?.length ?? 0) > 0 && (
                    <span className="user-files">
                      {(g.message.files ?? []).map((f: any, i: number) => {
                        const short = String(f.name ?? "").split(/[\\/]/).pop() || f.name
                        return (
                          <span key={i} className="user-file" dir="ltr">
                            📷 {short}
                          </span>
                        )
                      })}
                    </span>
                  )}
                </div>
              </div>
            ) : (
              <AssistantGroup key={g.messages[0].id} messages={g.messages} busy={busy} />
            ),
          )}

          {showTyping && (
            <div className="row assistant" key="typing">
              <div className="avatar" aria-hidden>
                <Owl size={22} />
              </div>
              <div className="msg-body">
                <Typing />
              </div>
            </div>
          )}
        </div>

        {(perms.length > 0 || forms.length > 0) && (
          <div className="pending" key="pending">
            {forms.map((f) => (
              <QuestionCard key={f.id} form={f} onReply={replyForm} onCancel={cancelForm} />
            ))}
            {perms.map((p) => (
              <PermissionCard key={p.id} request={p} onReply={reply} />
            ))}
          </div>
        )}

        <Composer
          busy={busy}
          disabled={!config}
          onSend={send}
          onStop={stop}
          placeholder="پیام خود را بنویسید…"
          slashItems={slashItems}
          onSlashPick={(id) => void runSlash(id)}
          workdir={workdir}
        />
      </main>

      {error && (
        <div className="toast" onClick={() => setError(null)} role="alert">
          {error}
          <span>×</span>
        </div>
      )}

      {settingsOpen && <Settings onClose={() => setSettingsOpen(false)} />}

      {updateOpen && (
        <div className="settings-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setUpdateOpen(false) }}>
          <UpdatePanel
            version={config?.version}
            available={updateAvailable}
            onClose={() => setUpdateOpen(false)}
            onDone={() => setUpdateAvailable(null)}
          />
        </div>
      )}
    </div>
  )
}
