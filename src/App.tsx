import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { appGet, appPost, del, get, patch, post } from "./api"
import { connectEvents } from "./events"
import { reduce } from "./reduce"
import type { AgentInfo, Attachment, CommandInfo, Message, ModelInfo, ModelRef, Part, PermissionRequest, PromptFile, SessionInfo, SkillInfo, MenuItem, UpdateCheck } from "./types"
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

// مسیر باید مطلق باشد. موتور OpenCode مسیرهای نسبی مثل «C:» یا «.» را در
// GET /api/location با 200 می‌پذیرد، ولی Session.create آن‌ها را رد می‌کند و
// پاسخ 500 با بدنهٔ خالی می‌دهد. پس به ok بودن پاسخ اعتماد نمی‌کنیم.
function isAbsoluteDir(dir: string) {
  // Windows: «C:\…» یا UNC «\\server\share»؛ POSIX: «/…».
  return /^[A-Za-z]:[\\/]/.test(dir) || /^\\\\[^\\]/.test(dir) || dir.startsWith("/")
}

async function dirExists(dir: string) {
  if (!isAbsoluteDir(dir)) return false
  try {
    const res = await fetch(`/oc/api/location?location%5Bdirectory%5D=${encodeURIComponent(dir)}`)
    if (!res.ok) return false
    const body = await res.json().catch(() => null)
    // مسیر نرمال‌شدهٔ خود موتور را معیار می‌گیریم: «C:» را به «C:.» تبدیل می‌کند.
    return typeof body?.directory === "string" && isAbsoluteDir(body.directory)
  } catch {
    return false
  }
}

function cleanDir(raw: string) {
  const trimmed = raw.trim().replace(/^["']+|["']+$/g, "")
  let dir = trimmed.replace(/[\\/]+$/, "")
  // «C:» یعنی «پوشهٔ جاری درایو»؛ به ریشهٔ درایو تبدیل می‌شود تا مطلق بماند.
  if (/^[A-Za-z]:$/.test(dir)) dir += "\\"
  // ریشهٔ POSIX («/») نباید با حذف اسلش آخر خالی شود.
  if (!dir && trimmed.startsWith("/")) dir = "/"
  return dir
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

function filesOfMessage(message: Message): PromptFile[] {
  return (message.files ?? []).flatMap((file: any) => {
    const uri =
      typeof file?.uri === "string"
        ? file.uri
        : typeof file?.source?.uri === "string"
          ? file.source.uri
          : ""
    return uri ? [{ uri, name: typeof file.name === "string" ? file.name : undefined }] : []
  })
}

type EditDraft = {
  sessionId: string
  messageId: string
  text: string
  originalText: string
  files: PromptFile[]
  originalFiles: PromptFile[]
  agents?: any[]
  skills?: any[]
  reverted: boolean
  saving: boolean
}

function MessageEditor({
  draft,
  saving,
  recovery,
  onChange,
  onSave,
  onCancel,
  onRestore,
}: {
  draft: EditDraft
  saving: boolean
  recovery: boolean
  onChange: (text: string) => void
  onSave: () => void
  onCancel: () => void
  onRestore: () => void
}) {
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    const end = el.value.length
    el.setSelectionRange(end, end)
  }, [])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = Math.min(el.scrollHeight, 260) + "px"
  }, [draft.text])

  const canSave = !saving && (draft.text.trim() !== "" || draft.files.length > 0)
  const canRestore = saving === false && (draft.originalText.trim() !== "" || draft.originalFiles.length > 0)

  return (
    <div className={`edit-bubble ${recovery ? "recovery" : ""}`}>
      <div className="edit-head">
        <span>{recovery ? "ارسال ویرایش نیمه‌کاره" : "ویرایش آخرین پیام"}</span>
        <span className="edit-kind">{recovery ? "پیام اصلی حذف شده" : "فقط آخرین پیام"}</span>
      </div>
      <textarea
        ref={ref}
        dir="auto"
        rows={2}
        aria-label="متن ویرایش‌شدهٔ پیام"
        value={draft.text}
        disabled={saving}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && !saving) {
            e.preventDefault()
            if (!recovery) onCancel()
            return
          }
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            if (canSave) onSave()
          }
        }}
      />
      {draft.files.length > 0 && (
        <div className="user-files edit-files">
          {draft.files.map((file, i) => {
            const short = String(file.name ?? file.uri).split(/[\\/]/).pop() || file.name || file.uri
            return (
              <span key={i} className="user-file" dir="ltr">
                📎 {short}
              </span>
            )
          })}
        </div>
      )}
      <div className={`edit-note ${recovery ? "warn" : ""}`}>
        {recovery
          ? "پیام قبلی حذف شده و نسخهٔ جدید هنوز ارسال نشده است. متن ویرایش‌شده یا نسخهٔ اصلی را دوباره بفرست."
          : "پاسخ‌های بعد از این پیام حذف می‌شوند و متن ویرایش‌شده دوباره ارسال می‌شود."}
      </div>
      <div className="edit-actions">
        {recovery ? (
          <button type="button" onClick={onRestore} disabled={!canRestore}>
            بازگرداندن پیام اصلی
          </button>
        ) : (
          <button type="button" onClick={onCancel} disabled={saving}>
            انصراف
          </button>
        )}
        <button type="button" className="edit-save" onClick={onSave} disabled={!canSave}>
          {saving ? "در حال ارسال…" : recovery ? "ارسال دوباره" : "ذخیره و ارسال"}
        </button>
      </div>
      <div className="edit-hint">
        Enter ذخیره · Shift+Enter خط جدید{recovery ? "" : " · Esc انصراف"}
      </div>
    </div>
  )
}

type Group = { kind: "user"; message: Message } | { kind: "assistant"; messages: Message[] }

type RetryAction = {
  reason?: string
  provider?: string
  title?: string
  message?: string
  label?: string
  link?: string
}

type RetryInfo = {
  attempt?: number
  message: string
  action?: RetryAction
}

function RetryBanner({ info }: { info: RetryInfo }) {
  const action = info.action
  const link =
    typeof action?.link === "string" && /^https?:\/\//i.test(action.link) ? action.link : null
  return (
    <div className="retry-card" role="status" aria-live="polite">
      <div className="retry-head">
        <span className="retry-dot" aria-hidden />
        تلاش مجدد خودکار
        {info.attempt ? ` · تلاش ${info.attempt}` : ""}
      </div>
      <div className="retry-msg" dir="auto">
        {info.message}
      </div>
      {action && (action.title || action.label || action.message) && (
        <div className="retry-action" dir="auto">
          {action.title && <strong>{action.title}</strong>}
          {action.message && <span>{action.message}</span>}
          {!action.message && action.label && <span>{action.label}</span>}
          {link && (
            <a href={link} target="_blank" rel="noreferrer noopener">
              {action.label ?? "باز کردن لینک"}
            </a>
          )}
        </div>
      )}
    </div>
  )
}

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
    (m) => m.providerID === last.model?.providerID && m.id === last.model?.id,
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
  const [retry, setRetry] = useState<RetryInfo | null>(null)
  const [edit, setEdit] = useState<EditDraft | null>(null)
  const [connected, setConnected] = useState(false)
  const [perms, setPerms] = useState<PermissionRequest[]>([])
  const [forms, setForms] = useState<EngineForm[]>([])
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
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
  const [updateCheck, setUpdateCheck] = useState<UpdateCheck | null>(null)
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const [running, setRunning] = useState<Record<string, boolean>>({})
  const [serverDown, setServerDown] = useState(false)

  const activeRef = useRef<string | null>(null)
  const busyRef = useRef(false)
  const pendingSkill = useRef<string | null>(null)
  const messagesRef = useRef<Message[]>([])
  const olderCursor = useRef<string | null>(null)
  const agentDefaults = useRef<Record<string, string>>({})
  const atBottom = useRef(true)
  const scroller = useRef<HTMLDivElement>(null)

  const apply = useCallback((next: Message[]) => {
    messagesRef.current = next
    setMessages(next)
  }, [])

  // وضعیت «در حال اجرا» فقط از رویدادها قابل اعتماد نیست: اگر کاربر وسط اجرا
  // جلسه عوض کند یا اتصال SSE دوباره برقرار شود، رویداد started را از دست
  // می‌دهد. این تابع وضعیت واقعی را از خود موتور می‌پرسد.
  const refreshActive = useCallback(async () => {
    const id = activeRef.current
    if (!id) return
    try {
      const res = await get<{ data: Record<string, { type?: string }> }>("/api/session/active")
      if (activeRef.current !== id) return
      const running = res.data?.[id]?.type === "running"
      setBusy(running)
      busyRef.current = running
      if (!running) setRetry(null)
    } catch {}
  }, [])

  const refreshModels = useCallback(async () => {
    const available = await get<{ data: ModelInfo[] }>("/api/model").catch(() => null)
    if (!available) return
    const seen = new Set<string>()
    const unique: ModelInfo[] = []
    for (const m of available.data ?? []) {
      // id یکتای هر ورودی مدل است؛ modelID ممکن است بین چند نسخه (مثل fast)
      // مشترک باشد و اگر بر اساس modelID حذف تکراری کنیم، مدل‌های واقعی گم می‌شوند.
      const key = `${m.providerID}/${m.id}`
      if (seen.has(key)) continue
      seen.add(key)
      unique.push(m)
    }
    setModels(unique)
  }, [])

  const refreshAgents = useCallback(async () => {
    const res = await get<{ data: AgentInfo[] }>("/api/agent").catch(() => null)
    if (res) setAgents(res.data ?? [])
  }, [])

  const refreshCommands = useCallback(async () => {
    const res = await get<{ data: CommandInfo[] }>("/api/command").catch(() => null)
    if (res) setCommands(res.data ?? [])
  }, [])

  const refreshSkills = useCallback(async () => {
    const res = await get<{ data: SkillInfo[] }>("/api/skill").catch(() => null)
    if (res) setSkills(res.data ?? [])
  }, [])

  const refreshConfig = useCallback(async () => {
    try {
      const cfg = await fetch("/__config").then((r) => r.json())
      if (cfg?.directory) setConfig(cfg)
    } catch {}
  }, [])

  const checkUpdate = useCallback(async (force = false) => {
    setCheckingUpdate(true)
    try {
      const res = await appGet<UpdateCheck>(`/app/update/check${force ? "?force=1" : ""}`)
      setUpdateCheck(res)
      if (res.current && res.current !== "?") setConfig((prev) => (prev ? { ...prev, version: res.current } : prev))
      if (res.available && res.latest) setUpdateAvailable(res.latest)
      else if (res.latest) setUpdateAvailable(null)
    } catch (e: any) {
      setUpdateCheck({ error: e.message, checkedAt: Date.now() })
    } finally {
      setCheckingUpdate(false)
    }
  }, [])

  const loadMessages = useCallback(
    async (id: string) => {
      olderCursor.current = null
      contextCache.current = null
      setHasMore(false)
      try {
        const res = await get<{
          data: Message[]
          cursor?: { previous?: string | null; next?: string | null }
        }>(`/api/session/${id}/message?limit=200&order=desc`)
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
        olderCursor.current = res.cursor?.previous ?? res.cursor?.next ?? null
        setHasMore(Boolean(olderCursor.current) || list.length >= 200)
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
      const loadedIds = new Set(messagesRef.current.map((m) => m.id))
      const oldestLoaded = messagesRef.current[0]?.time?.created

      const prepend = (batch: Message[], hasMore: boolean) => {
        if (batch.length === 0) {
          setHasMore(hasMore)
          return
        }
        const el = scroller.current
        const prevHeight = el?.scrollHeight ?? 0
        const prevTop = el?.scrollTop ?? 0
        apply([...batch, ...messagesRef.current])
        requestAnimationFrame(() => {
          const el2 = scroller.current
          if (el2) el2.scrollTop = el2.scrollHeight - prevHeight + prevTop
        })
        setHasMore(hasMore)
      }

      // اول cursor واقعی API را امتحان می‌کنیم. اگر پاسخ شامل پیام تکراری یا
      // جدیدتر از قدیمی‌ترین پیام بارگذاری‌شده بود (یعنی جهت صفحه اشتباه است)
      // آن را دور می‌ریزیم و از /context استفاده می‌کنیم.
      if (olderCursor.current) {
        const cursor = olderCursor.current
        try {
          const res = await get<{
            data: Message[]
            cursor?: { previous?: string | null; next?: string | null }
          }>(`/api/session/${id}/message?limit=50&order=desc&cursor=${encodeURIComponent(cursor)}`)
          if (activeRef.current !== id) return
          const rows = res.data ?? []
          const valid =
            rows.length > 0 &&
            rows.every((m) => !loadedIds.has(m.id)) &&
            (oldestLoaded == null ||
              rows.every((m) => typeof m.time?.created !== "number" || m.time.created <= oldestLoaded))
          if (valid) {
            olderCursor.current = res.cursor?.previous ?? res.cursor?.next ?? null
            prepend([...rows].reverse(), Boolean(olderCursor.current) || rows.length >= 50)
            return
          }
          olderCursor.current = null
        } catch {
          olderCursor.current = null
        }
      }

      let full = contextCache.current
      if (!full) {
        const res = await get<{ data: any[] }>(`/api/session/${id}/context`).catch(() => null)
        if (activeRef.current !== id) return
        full = res?.data ?? []
        contextCache.current = full
      }
      const olderAll = full.filter((m) => {
        if (loadedIds.has(String(m.id ?? ""))) return false
        if (oldestLoaded == null || typeof m.time?.created !== "number") return true
        return m.time.created <= oldestLoaded
      })
      const batch = olderAll.slice(-50)
      const mapped: Message[] = batch.map((m) => ({
        id: String(m.id ?? ""),
        type: m.type === "user" ? "user" : "assistant",
        text: typeof m.text === "string" ? m.text : undefined,
        time: m.time,
      }))
      prepend(mapped, olderAll.length > batch.length)
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
      // ممکن است کاربر وسط این درخواست‌ها نشست را عوض کرده باشد؛ نتیجهٔ نشست
      // قبلی نباید روی نشست جدید بنشیند.
      if (activeRef.current !== id) return
      setForms(pendings.filter(Boolean) as EngineForm[])
    } catch {}
  }, [])

  const refreshSessions = useCallback(
    async (autoselect = false) => {
      try {
        const res = await get<{ data: SessionInfo[] }>("/api/session?limit=50")
        const list = res.data ?? []
        setSessions(list)
        // ایجنت اولیه هر جلسه را نگه می‌داریم تا «پیش‌فرض» در انتخابگر واقعاً
        // همان مقدار اولیه را برگرداند، نه اینکه هیچ درخواستی به موتور نفرستد.
        for (const s of list) {
          if (s.agent && agentDefaults.current[s.id] === undefined) agentDefaults.current[s.id] = s.agent
        }
        if (autoselect && !activeRef.current && list[0]) {
          activeRef.current = list[0].id
          setActiveId(list[0].id)
          atBottom.current = true
          await loadMessages(list[0].id)
          await refreshActive()
        }
      } catch (e: any) {
        setError(e.message)
      }
    },
    [loadMessages, refreshActive],
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
      busyRef.current = false
      setRetry(null)
      setHasMore(false)
      contextCache.current = null
      olderCursor.current = null
      setPerms([])
      setForms([])
      setMenu(false)
      atBottom.current = true
      apply([])
      await loadMessages(id)
      void refreshPerms()
      void refreshForms()
      void refreshActive()
    },
    [apply, loadMessages, refreshPerms, refreshForms, refreshActive],
  )

  const changeWorkdir = useCallback(async (raw: string) => {
    const dir = cleanDir(raw)
    if (!dir) return false
    // مسیر نسبی هرگز نباید ذخیره شود؛ موتور آن را در Session.create رد می‌کند.
    if (!isAbsoluteDir(dir)) {
      setError(`مسیر باید کامل باشد (مثلاً C:\\Projects\\my-app): ${dir}`)
      return false
    }
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

  const applyAgent = useCallback(
    async (id: string | null) => {
      const sid = activeRef.current
      // انتخاب «پیش‌فرض» باید واقعاً ایجنت را به مقدار اولیه برگرداند؛ فرستادن
      // null یا هیچ درخواستی، ایجنت فعلی موتور را دست‌نخورده باقی می‌گذارد.
      const fallback = sid ? agentDefaults.current[sid] : undefined
      const engineDefault = agents.find((a) => a.mode === "primary" && !a.hidden)?.id
      const target = sid ? (id ?? fallback ?? engineDefault ?? null) : id
      if (sid && !target) {
        setAgentOpen(false)
        setError("ایجنت پیش‌فرض این جلسه مشخص نیست؛ یک ایجنت انتخاب کن")
        return
      }
      setAgent(target)
      setAgentOpen(false)
      localStorage.setItem("oc-agent", target ?? "")
      if (!sid || !target) return
      try {
        await post(`/api/session/${sid}/agent`, { agent: target })
        setSessions((prev) => prev.map((s) => (s.id === sid ? { ...s, agent: target } : s)))
      } catch (e: any) {
        setError(e.message)
      }
    },
    [agents],
  )

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
          busyRef.current = false
          setRetry(null)
          setHasMore(false)
          contextCache.current = null
          olderCursor.current = null
          setPerms([])
          setForms([])
          atBottom.current = true
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
      // اگر مقدار ذخیره‌شده نسبی باشد (مثل «C:» یا «.»)، حتی یک بار هم به موتور
      // فرستاده نمی‌شود؛ Session.create با 500 و بدنهٔ خالی پاسخ می‌دهد.
      if (directory && !isAbsoluteDir(directory)) {
        localStorage.removeItem("oc-workdir")
        setWorkdir(fallback ?? "")
        setError(
          `مسیر ذخیره‌شده معتبر نیست («${directory}»)؛ از «${fallback ?? "پوشه پیش‌فرض"}» استفاده می‌کنم.`,
        )
        directory = fallback
      }
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
      setBusy(false)
      busyRef.current = false
      setRetry(null)
      setHasMore(false)
      contextCache.current = null
      olderCursor.current = null
      atBottom.current = true
      apply([])
      setPerms([])
      setForms([])
      if (session.agent || agent) agentDefaults.current[session.id] = session.agent ?? agent!
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
    if (type === "server.connected") {
      // ممکن است بین قطع و وصل SSE چند رویداد از دست رفته باشد؛ وضعیت را از
      // موتور دوباره می‌خوانیم تا نه پیام گم شود و نه دکمه‌ها در حالت اشتباه بمانند.
      void refreshSessions()
      void refreshConfig()
      void refreshModels()
      void refreshAgents()
      void refreshCommands()
      void refreshSkills()
      void checkUpdate(true)
      const current = activeRef.current
      if (current) {
        void loadMessages(current)
        void refreshPerms()
        void refreshForms()
        void refreshActive()
      }
      return
    }

    if (type === "session.status" && data.sessionID === activeRef.current) {
      const status = data.status?.type
      const running = status === "busy" || status === "retry"
      setBusy(running)
      busyRef.current = running
      if (status === "retry") {
        setRetry({
          message: String(data.status.message ?? "اتصال به ارائه‌دهنده ناموفق بود؛ تلاش مجدد انجام می‌شود…"),
          attempt: typeof data.status.attempt === "number" ? data.status.attempt : undefined,
          action:
            data.status.action && typeof data.status.action === "object"
              ? (data.status.action as RetryAction)
              : undefined,
        })
      } else {
        setRetry(null)
      }
      if (!running) void loadMessages(data.sessionID)
    }
    if (type === "session.idle" && data.sessionID === activeRef.current) {
      setBusy(false)
      busyRef.current = false
      setRetry(null)
      void loadMessages(data.sessionID)
    }
    if (type === "session.agent.selected" && data.sessionID === activeRef.current && typeof data.agent === "string") {
      setAgent(data.agent)
      setSessions((prev) => prev.map((s) => (s.id === data.sessionID ? { ...s, agent: data.agent } : s)))
    }
    if (type === "session.model.selected" && data.sessionID === activeRef.current && data.model) {
      setModel(data.model)
      setSessions((prev) => prev.map((s) => (s.id === data.sessionID ? { ...s, model: data.model } : s)))
    }
    if (
      type === "model.updated" ||
      type === "models-dev.refreshed" ||
      type === "provider.updated" ||
      type === "credential.updated" ||
      type === "credential.switched" ||
      type === "integration.updated"
    ) {
      void refreshModels()
    }
    if (type === "agent.updated") void refreshAgents()
    if (type === "command.updated") void refreshCommands()
    if (type === "skill.updated") void refreshSkills()
    if (type === "config.updated") {
      void refreshConfig()
      void refreshModels()
      void refreshAgents()
      void refreshCommands()
      void refreshSkills()
      void refreshSessions()
    }
    if (type === "installation.updated") {
      void refreshModels()
      void refreshAgents()
      void refreshCommands()
      void refreshSkills()
      void refreshSessions()
      if (typeof data.version === "string") {
        setConfig((prev) => (prev ? { ...prev, version: data.version } : prev))
        setUpdateAvailable(null)
        void checkUpdate(true)
      }
    }

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
      setUpdateCheck((prev) => ({
        ...(prev ?? {}),
        latest: data.version,
        available: true,
        checkedAt: Date.now(),
      }))
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
    if (result.busy !== undefined) {
      setBusy(result.busy)
      busyRef.current = result.busy
      if (!result.busy) setRetry(null)
    }
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
        void checkUpdate()

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
          const key = `${m.providerID}/${m.id}`
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
  }, [refreshSessions, checkUpdate])

  // علاوه بر رویدادهای SSE، وقتی کاربر به پنجره برمی‌گردد یا هر چند دقیقه،
  // مدل‌ها و وضعیت آپدیت را دوباره می‌خوانیم تا لیست هیچ‌وقت کهنه نماند.
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState !== "visible") return
      void refreshModels()
      void checkUpdate()
    }
    window.addEventListener("focus", refresh)
    const timer = window.setInterval(refresh, 5 * 60_000)
    return () => {
      window.removeEventListener("focus", refresh)
      window.clearInterval(timer)
    }
  }, [refreshModels, checkUpdate])

  useEffect(() => {
    const session = sessions.find((s) => s.id === activeId)
    if (session?.model) setModel(session.model)
    setAgent(session?.agent ?? null)
    setEdit(null)
  }, [activeId])

  useEffect(() => {
    if (!error) return
    const timer = window.setTimeout(() => setError(null), 7000)
    return () => window.clearTimeout(timer)
  }, [error])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), 7000)
    return () => window.clearTimeout(timer)
  }, [notice])

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
      if (!id) return false
    }
    setBusy(true)
    busyRef.current = true
    setRetry(null)
    atBottom.current = true
    const body: Record<string, any> = queued ? { text, delivery: "queue" } : { text }
    if (skill) {
      pendingSkill.current = null
      body.skills = [{ id: skill }]
    }
    // اگر آپلود یکی از تصاویر شکست بخورد، کل ارسال متوقف می‌شود تا متن و
    // پیوست‌ها در Composer بمانند و کاربر بتواند دوباره تلاش کند.
    const uploaded: PromptFile[] = []
    let uploadFailed = false
    if (attachments.length > 0) {
      for (const a of attachments) {
        try {
          const res = await appPost<{ ok?: boolean; path?: string; error?: string }>("/app/upload", { name: a.name, dataUrl: a.dataUrl })
          if (!res?.ok || !res.path) throw new Error(res?.error ?? "آپلود تصویر ناموفق بود")
          uploaded.push({ uri: "file:///" + res.path.replace(/^\\+/, "").replace(/\\/g, "/"), name: a.name })
        } catch (e: any) {
          setError(`${a.name}: ${e.message}`)
          uploadFailed = true
          break
        }
      }
    }
    if (uploadFailed) {
      // اگر تصویری آپلود نشود، پیام بدون آن ارسال نمی‌شود؛ متن و پیوست‌ها در
      // Composer می‌مانند تا کاربر دوباره تلاش کند.
      if (!queued) {
        setBusy(false)
        busyRef.current = false
      }
      return false
    }
    if (promptFiles.length > 0 || uploaded.length > 0) {
      body.files = [...promptFiles, ...uploaded]
    }
    try {
      await post(`/api/session/${id}/prompt`, body)
      return true
    } catch (e: any) {
      if (!queued) {
        setBusy(false)
        busyRef.current = false
      }
      setError(e.message)
      return false
    }
  }

  const stop = async () => {
    const id = activeRef.current
    if (!id) return
    try {
      await post(`/api/session/${id}/interrupt`)
    } catch {}
    setBusy(false)
    busyRef.current = false
    setRetry(null)
  }

  const beginEdit = (message: Message) => {
    const sid = activeRef.current
    if (!sid || message.type !== "user" || edit) return
    if (busyRef.current) {
      setError("تا پایان پاسخ فعلی نمی‌توانی پیام را ویرایش کنی")
      return
    }
    if (perms.length > 0 || forms.length > 0) {
      setError("اول درخواست‌های در انتظار را پاسخ بده")
      return
    }
    const lastUser = [...messagesRef.current].reverse().find((m) => m.type === "user")
    if (!lastUser || lastUser.id !== message.id) {
      setError("فقط آخرین پیام گفت‌وگو قابل ویرایش است")
      return
    }
    const files = filesOfMessage(message)
    setError(null)
    setNotice(null)
    setEdit({
      sessionId: sid,
      messageId: message.id,
      text: message.text ?? "",
      originalText: message.text ?? "",
      files,
      originalFiles: files,
      agents: Array.isArray((message as any).agents) && (message as any).agents.length > 0 ? (message as any).agents : undefined,
      skills: Array.isArray((message as any).skills) && (message as any).skills.length > 0 ? (message as any).skills : undefined,
      reverted: false,
      saving: false,
    })
    requestAnimationFrame(() => {
      const el = scroller.current
      if (el) el.scrollTop = el.scrollHeight
    })
  }

  const cancelEdit = () => {
    if (edit?.saving) return
    setEdit(null)
  }

  const saveEdit = async () => {
    const draft = edit
    if (!draft || draft.saving) return
    if (busyRef.current) {
      setError("تا پایان پاسخ فعلی نمی‌توان پیام را ویرایش کرد")
      return
    }
    const sid = activeRef.current
    if (!sid || sid !== draft.sessionId) {
      setError("نشست عوض شده است؛ ویرایش لغو شد")
      setEdit(null)
      return
    }
    const text = draft.text.trim()
    if (text === "" && draft.files.length === 0) {
      setError("متن پیام خالی است")
      return
    }
    if (!draft.reverted) {
      const lastUser = [...messagesRef.current].reverse().find((m) => m.type === "user")
      if (!lastUser || lastUser.id !== draft.messageId) {
        setError("فقط آخرین پیام گفت‌وگو قابل ویرایش است")
        setEdit(null)
        return
      }
    }

    setError(null)
    setNotice(null)
    setEdit({ ...draft, saving: true })
    let reverted = draft.reverted

    try {
      if (!reverted) {
        await post(`/api/session/${sid}/revert/stage`, { messageID: draft.messageId, files: false })
        try {
          await post(`/api/session/${sid}/revert/commit`, {})
        } catch (e) {
          // اگر commit شکست خورد، boundary مرحله‌بندی‌شده را پاک می‌کنیم تا
          // نشست در وضعیت revert نیمه‌کاره نماند.
          await del(`/api/session/${sid}/revert`).catch(() => null)
          throw e
        }
        reverted = true
        setEdit((prev) => (prev ? { ...prev, reverted: true, saving: true } : prev))
        await loadMessages(sid)
        if (activeRef.current !== sid) {
          setEdit(null)
          return
        }
      }

      setBusy(true)
      busyRef.current = true
      setRetry(null)
      atBottom.current = true
      const body: Record<string, any> = { text }
      if (draft.files.length > 0) body.files = draft.files
      if (draft.agents?.length) body.agents = draft.agents
      if (draft.skills?.length) body.skills = draft.skills
      try {
        await post(`/api/session/${sid}/prompt`, body)
      } catch (e) {
        setBusy(false)
        busyRef.current = false
        throw e
      }
      setEdit(null)
      setNotice("پیام ویرایش شد و دوباره ارسال شد")
      void loadMessages(sid).catch((e: any) => setError(e.message))
    } catch (e: any) {
      setError(`ویرایش پیام ناموفق بود: ${e.message}`)
      setEdit((prev) => (prev ? { ...prev, saving: false, reverted } : prev))
    }
  }

  const restoreEdit = async () => {
    const draft = edit
    if (!draft || draft.saving || !draft.reverted) return
    if (busyRef.current) {
      setError("تا پایان پاسخ فعلی نمی‌توان پیام را بازگرداند")
      return
    }
    const sid = activeRef.current
    if (!sid || sid !== draft.sessionId) {
      setError("نشست عوض شده است؛ بازگردانی لغو شد")
      setEdit(null)
      return
    }
    if (draft.originalText.trim() === "" && draft.originalFiles.length === 0) {
      setError("نسخهٔ اصلی پیام چیزی برای ارسال ندارد")
      return
    }

    setError(null)
    setNotice(null)
    setEdit({ ...draft, saving: true })
    setBusy(true)
    busyRef.current = true
    setRetry(null)
    atBottom.current = true
    try {
      const body: Record<string, any> = { text: draft.originalText }
      if (draft.originalFiles.length > 0) body.files = draft.originalFiles
      if (draft.agents?.length) body.agents = draft.agents
      if (draft.skills?.length) body.skills = draft.skills
      await post(`/api/session/${sid}/prompt`, body)
      setEdit(null)
      setNotice("پیام اصلی دوباره ارسال شد")
      void loadMessages(sid).catch((e: any) => setError(e.message))
    } catch (e: any) {
      setBusy(false)
      busyRef.current = false
      setEdit((prev) => (prev ? { ...prev, saving: false } : prev))
      setError(`بازگردانی پیام ناموفق بود: ${e.message}`)
    }
  }

  // خروجی گرفتن باید کل تاریخچه را داشته باشد؛ messagesRef فقط ۲۰۰ پیام آخر
  // را نگه می‌دارد. /context نسخهٔ کامل را می‌دهد (بدون tool callها).
  const collectAllMessages = useCallback(async (id: string): Promise<Message[]> => {
    const res = await get<{ data: any[] }>(`/api/session/${id}/context`).catch(() => null)
    const rows = res?.data ?? []
    if (rows.length === 0) return messagesRef.current
    return rows.map((m: any): Message => {
      if (m?.type === "compaction") {
        return {
          id: String(m.id ?? `comp:${id}`),
          type: "assistant",
          content: [
            {
              type: "compaction",
              id: "compaction",
              status: m.status ?? "completed",
              text: typeof m.summary === "string" ? m.summary : "",
              error: m.error?.message ?? m.error,
            },
          ],
          time: m.time,
        }
      }
      if (m?.type === "user") {
        return {
          id: String(m.id ?? ""),
          type: "user",
          text: typeof m.text === "string" ? m.text : undefined,
          files: Array.isArray(m.files)
            ? m.files.map((f: any) => ({ uri: f?.source?.uri ?? "", name: f?.name }))
            : undefined,
          time: m.time,
        }
      }
      if (m?.type === "assistant") {
        return {
          id: String(m.id ?? ""),
          type: "assistant",
          content: Array.isArray(m.content) ? m.content : [],
          time: m.time,
          model: m.model,
          error: m.error,
          tokens: m.tokens,
          cost: m.cost,
        }
      }
      return {
        id: String(m.id ?? ""),
        type: String(m.type ?? "assistant"),
        text: typeof m.text === "string" ? m.text : undefined,
        time: m.time,
      }
    })
  }, [])

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
          void refreshModels()
          setPickerOpen(true)
          return
        case "builtin:agent":
          void refreshAgents()
          setAgentOpen(true)
          return
        case "builtin:settings":
          setSettingsOpen(true)
          return
        case "builtin:update":
          void checkUpdate(true)
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
            setError(null)
            setNotice("آخرین پیام و پاسخش پس گرفته شد")
          } catch (e: any) {
            setError(e.message)
          }
          return
        }
        case "builtin:export": {
          if (!sid) {
            setError("اول یک گفت‌وگو بساز")
            return
          }
          const list = await collectAllMessages(sid)
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
            setError(null)
            setNotice("گفت‌وگو در کلیپ‌بورد کپی شد (Markdown)")
          } catch {
            const blob = new Blob([md], { type: "text/markdown;charset=utf-8" })
            const url = URL.createObjectURL(blob)
            const a = document.createElement("a")
            a.href = url
            a.download = `opencode-chat-${date}.md`
            a.style.display = "none"
            document.body.appendChild(a)
            a.click()
            a.remove()
            // بعضی مرورگرها اگر URL بلافاصله آزاد شود دانلود را نیمه‌کاره
            // رها می‌کنند؛ چند ثانیه بعد آزادش می‌کنیم.
            window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
            setError(null)
            setNotice("فایل مارک‌داون گفت‌وگو دانلود شد")
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
        setError(null)
        setNotice(`مهارت «${skillId}» برای پیام بعدی فعال شد`)
        return
      }
    },
    [createSession, stop, sessions, loadMessages, collectAllMessages, refreshModels, refreshAgents, checkUpdate],
  )

  const reply = async (request: PermissionRequest, decision: string) => {
    setPerms((prev) => prev.filter((p) => p.id !== request.id))
    try {
      await post(`/api/session/${request.sessionID}/permission/${request.id}/reply`, { decision })
    } catch (e: any) {
      setError(e.message)
      if (activeRef.current === request.sessionID) {
        setPerms((prev) => (prev.some((p) => p.id === request.id) ? prev : [request, ...prev]))
      }
    }
  }

  const replyForm = async (form: EngineForm, answer: Record<string, any>) => {
    setForms((prev) => prev.filter((x) => x.id !== form.id))
    try {
      await post(`/api/session/${form.sessionID}/form/${form.id}/reply`, { answer })
    } catch (e: any) {
      setError(e.message)
      if (activeRef.current === form.sessionID) {
        setForms((prev) => (prev.some((x) => x.id === form.id) ? prev : [form, ...prev]))
      }
    }
  }

  const cancelForm = async (form: EngineForm) => {
    setForms((prev) => prev.filter((x) => x.id !== form.id))
    try {
      await del(`/api/session/${form.sessionID}/form/${form.id}`)
    } catch (e: any) {
      setError(e.message)
      if (activeRef.current === form.sessionID) {
        setForms((prev) => (prev.some((x) => x.id === form.id) ? prev : [form, ...prev]))
      }
    }
  }

  const visible = messages.filter((m) => m.type === "user" || m.type === "assistant")
  const groups = groupMessages(visible)
  const lastAssistant = [...visible].reverse().find((m) => m.type === "assistant")
  const lastUserId = [...visible].reverse().find((m) => m.type === "user")?.id ?? null
  const showTyping = busy && (!lastAssistant || Boolean(lastAssistant.time?.completed))
  const editBlockedTitle = edit
    ? "یک ویرایش باز است"
    : busy
      ? "تا پایان پاسخ فعلی صبر کن"
      : perms.length > 0 || forms.length > 0
        ? "اول درخواست‌های در انتظار را پاسخ بده"
        : "ویرایش آخرین پیام"

  const currentModel = models.find((m) => m.providerID === model?.providerID && m.id === model?.id)
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
        onUpdate={() => {
          void checkUpdate(true)
          setUpdateOpen(true)
        }}
        onSettings={() => setSettingsOpen(true)}
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
                  onClick={() => {
                    if (!pickerOpen) void refreshModels()
                    setPickerOpen((v) => !v)
                  }}
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
                {edit && edit.messageId === g.message.id && !edit.reverted ? (
                  <MessageEditor
                    draft={edit}
                    saving={edit.saving}
                    recovery={false}
                    onChange={(text) => setEdit((prev) => (prev ? { ...prev, text } : prev))}
                    onSave={() => void saveEdit()}
                    onCancel={cancelEdit}
                    onRestore={() => void restoreEdit()}
                  />
                ) : (
                  <div className="user-stack">
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
                    {g.message.id === lastUserId && (
                      <button
                        type="button"
                        className="msg-edit"
                        disabled={Boolean(edit) || busy || perms.length > 0 || forms.length > 0}
                        title={editBlockedTitle}
                        aria-label="ویرایش آخرین پیام"
                        onClick={() => beginEdit(g.message)}
                      >
                        <span aria-hidden>✎</span> ویرایش
                      </button>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <AssistantGroup key={g.messages[0].id} messages={g.messages} busy={busy} />
            ),
          )}

          {edit?.reverted && (
            <div className="row user" key="edit-recovery">
              <MessageEditor
                draft={edit}
                saving={edit.saving}
                recovery
                onChange={(text) => setEdit((prev) => (prev ? { ...prev, text } : prev))}
                onSave={() => void saveEdit()}
                onCancel={cancelEdit}
                onRestore={() => void restoreEdit()}
              />
            </div>
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

        {(retry || perms.length > 0 || forms.length > 0) && (
          <div className="pending" key="pending">
            {retry && <RetryBanner info={retry} />}
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
          disabled={!config || Boolean(edit)}
          onSend={send}
          onStop={stop}
          placeholder={edit ? "در حال ویرایش آخرین پیام…" : "پیام خود را بنویسید…"}
          slashItems={slashItems}
          onSlashPick={(id) => void runSlash(id)}
          workdir={active?.location?.directory || workdir || config?.directory || ""}
        />
      </main>

      {error ? (
        <div className="toast" onClick={() => setError(null)} role="alert">
          {error}
          <span>×</span>
        </div>
      ) : notice ? (
        <div className="toast toast-ok" onClick={() => setNotice(null)} role="status">
          {notice}
          <span>×</span>
        </div>
      ) : null}

      {settingsOpen && (
        <Settings
          onClose={() => setSettingsOpen(false)}
          onChanged={() => {
            void refreshModels()
            void refreshAgents()
            void refreshSessions()
            void checkUpdate(true)
          }}
        />
      )}

      {updateOpen && (
        <div className="settings-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setUpdateOpen(false) }}>
          <UpdatePanel
            version={config?.version}
            available={updateAvailable}
            check={updateCheck}
            checking={checkingUpdate}
            onCheck={() => void checkUpdate(true)}
            onClose={() => setUpdateOpen(false)}
            onDone={() => {
              setUpdateAvailable(null)
              void checkUpdate(true)
            }}
          />
        </div>
      )}
    </div>
  )
}
