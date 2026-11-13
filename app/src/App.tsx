import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { appGet, appPost, del, get, patch, post } from "./lib/api"
import { connectEvents } from "./lib/events"
import { reduce } from "./lib/reduce"
import type { AgentInfo, Attachment, CommandInfo, Message, ModelInfo, ModelRef, Part, PermissionRequest, PromptFile, SessionInfo, SkillInfo, MenuItem, UpdateCheck } from "./lib/types"
import { Markdown } from "./components/Markdown"
import { ToolCard } from "./components/ToolCard"
import { Composer } from "./components/Composer"
import { Sidebar } from "./components/Sidebar"
import { Owl } from "./components/Owl"
import { ModelPicker } from "./components/ModelPicker"
import { AgentPicker } from "./components/AgentPicker"
import { QuestionCard } from "./components/QuestionCard"
import { Projects, type AddProjectsResult } from "./components/Projects"
import {
  PERMISSION_STORAGE_KEY,
  loadPermissionMode,
  modeFromRuleset,
  rulesForMode,
  type PermissionMode,
} from "./lib/permissions"
import { applyModelLimits, loadModelLimitCatalog } from "./lib/modelLimits"
import type { EngineForm } from "./lib/types"
import type { RelayState } from "./components/Relays"
import { useI18n } from "./lib/i18n"
import { ImageEditor, ImageEditorProvider } from "./components/ImageEditor"

// پنل‌های سنگین فقط وقتی باز می‌شوند بارگذاری می‌شوند تا باندل اولیه کوچک بماند.
const Settings = lazy(() => import("./components/Settings").then((m) => ({ default: m.Settings })))
const Relays = lazy(() => import("./components/Relays").then((m) => ({ default: m.Relays })))
const UpdatePanel = lazy(() => import("./components/Update").then((m) => ({ default: m.UpdatePanel })))

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
  let dir = trimmed
  // مسیرهایی که با escape دوباره‌نویسی شده‌اند («C:\\Project») یک‌بار جمع می‌شوند.
  // پیشوند UNC («\\\\server\\share») باید دست‌نخورده بماند.
  if (/^\\{2,}/.test(dir)) dir = "\\\\" + dir.replace(/^\\+/, "").replace(/\\{2,}/g, "\\")
  else if (/^[A-Za-z]:/.test(dir)) dir = dir.replace(/\\{2,}/g, "\\")
  dir = dir.replace(/[\\/]+$/, "")
  // «C:» یعنی «پوشهٔ جاری درایو»؛ به ریشهٔ درایو تبدیل می‌شود تا مطلق بماند.
  if (/^[A-Za-z]:$/.test(dir)) dir += "\\"
  // ریشهٔ POSIX («/») نباید با حذف اسلش آخر خالی شود.
  if (!dir && trimmed.startsWith("/")) dir = "/"
  return dir
}

function sameDir(a?: string, b?: string) {
  if (!a || !b) return false
  return a.replace(/[\\/]+$/, "").toLowerCase() === b.replace(/[\\/]+$/, "").toLowerCase()
}

const PROJECTS_STORAGE_KEY = "oc-projects"

function loadProjects(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(PROJECTS_STORAGE_KEY) ?? "[]")
    if (!Array.isArray(raw)) return []
    const seen = new Set<string>()
    const rows: string[] = []
    for (const item of raw) {
      if (typeof item !== "string") continue
      const dir = cleanDir(item)
      if (!dir || !isAbsoluteDir(dir)) continue
      const key = dir.replace(/[\\/]+$/, "").toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      rows.push(dir)
    }
    return rows
  } catch {
    return []
  }
}

function saveProjects(list: string[]) {
  try {
    const seen = new Set<string>()
    const rows: string[] = []
    for (const item of list) {
      const dir = cleanDir(item)
      if (!dir || !isAbsoluteDir(dir)) continue
      const key = dir.replace(/[\\/]+$/, "").toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      rows.push(dir)
    }
    localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(rows))
  } catch {}
}

// هر پیشنهاد یک کارت بنتو است: آیکون دسته + عنوان + توضیح کوتاه.
// آرایه فقط ظاهری است؛ منطق ارسال (send) دست‌نخورده باقی مانده.
const SUGGESTIONS: { text: string; icon: string; title: string; hint: string }[] = [
  {
    text: "Inspect this project and briefly explain its structure",
    icon: "🗂",
    title: "Inspect project",
    hint: "Summarize the code structure and architecture",
  },
  {
    text: "Build a Persian RTL landing page for a VPN service",
    icon: "✦",
    title: "RTL landing page",
    hint: "Persian landing page for a VPN service",
  },
  {
    text: "Find and fix TypeScript bugs",
    icon: "⌁",
    title: "Fix TS bugs",
    hint: "Find and fix TypeScript errors",
  },
]

function folder(directory?: string) {
  if (!directory) return ""
  return directory.split(/[\\/]/).filter(Boolean).pop() ?? directory
}

const Typing = memo(function Typing() {
  const { t } = useI18n()
  return (
    <div className="typing" aria-label={t("Typing")}>
      <span />
      <span />
      <span />
    </div>
  )
})

const AssistantBody = memo(function AssistantBody({ message, live }: { message: Message; live: boolean }) {
  const { t } = useI18n()
  const parts = message.content ?? (message.text?.trim() ? [{ type: "text", text: message.text }] : [])
  const reasoning = parts.filter((p) => p.type === "reasoning" && p.text?.trim())
  const visible = parts.filter((p) => p.type !== "reasoning" && (p.type === "tool" || p.text?.trim()))
  // استدلال به‌تنهایی «محتوای قابل مشاهده» نیست: تا وقتی متن یا ابزاری نرسیده،
  // باید نشانگر زنده بماند تا کاربر فکر کند اجرا متوقف شده است.
  const empty = visible.length === 0

  return (
    <>
      {reasoning.length > 0 && (
        <details className="reasoning">
          <summary>
            {t("Reasoning")}
            {live && empty && <span className="live-dot" aria-label={t("Thinking")} />}
          </summary>
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
        <div className="msg-error">{message.error?.message ?? message.error?.name ?? t("Model response error")}</div>
      )}
    </>
  )
})

const AssistantGroup = memo(
  function AssistantGroup({ messages, live }: { messages: Message[]; live: boolean }) {
    return (
      <div className="row assistant">
        <div className="avatar" aria-hidden>
          <Owl size={22} />
        </div>
        <div className="msg-body">
          {messages.map((m, i) => (
            <AssistantBody key={m.id} message={m} live={live && i === messages.length - 1} />
          ))}
        </div>
      </div>
    )
  },
  (prev, next) =>
    prev.live === next.live &&
    prev.messages.length === next.messages.length &&
    prev.messages.every((m, i) => m === next.messages[i]),
)

function CompactionStrip({ part }: { part: Part }) {
  const { t } = useI18n()
  if (part.status === "failed") {
    return (
      <div className="compaction failed" dir="auto">
        <span className="compaction-icon" aria-hidden>
          🗜
        </span>
        {t("Compaction failed")}{part.error ? ` — ${part.error}` : ""}
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
        {running ? t("Compacting context…") : t("Context compacted")}
      </div>
      {part.text?.trim() ? <Markdown text={part.text} /> : running && <Typing />}
    </div>
  )
}

const PermissionCard = memo(function PermissionCard({ request, onReply }: { request: PermissionRequest; onReply: (r: PermissionRequest, decision: string) => void }) {
  const { t } = useI18n()
  return (
    <div className="perm">
      <div className="perm-head">
        <span className="perm-shield">!</span> {t("Permission required")}
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
          {t("Allow")}
        </button>
        {request.save && request.save.length > 0 && (
          <button type="button" onClick={() => onReply(request, "always")}>
            {t("Always allow")}
          </button>
        )}
        <button type="button" className="deny" onClick={() => onReply(request, "reject")}>
          {t("Deny")}
        </button>
      </div>
    </div>
  )
})

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
  const { t } = useI18n()
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
        <span>{recovery ? t("Send unfinished edit") : t("Edit last message")}</span>
        <span className="edit-kind">{recovery ? t("Original message was deleted") : t("Last message only")}</span>
      </div>
      <textarea
        ref={ref}
        dir="auto"
        rows={2}
        aria-label={t("Edited message text")}
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
          ? t("The previous message was deleted and the new version has not been sent yet. Send the edited text or the original again.")
          : t("Replies after this message will be deleted and the edited text will be sent again.")}
      </div>
      <div className="edit-actions">
        {recovery ? (
          <button type="button" onClick={onRestore} disabled={!canRestore}>
            {t("Restore original message")}
          </button>
        ) : (
          <button type="button" onClick={onCancel} disabled={saving}>
            {t("Cancel")}
          </button>
        )}
        <button type="button" className="edit-save" onClick={onSave} disabled={!canSave}>
          {saving ? t("Sending…") : recovery ? t("Send again") : t("Save and send")}
        </button>
      </div>
      <div className="edit-hint">
        {t("Enter to save · Shift+Enter for a new line")}{recovery ? "" : ` · ${t("Esc to cancel")}`}
      </div>
    </div>
  )
}

type Group = { kind: "user"; message: Message } | { kind: "assistant"; messages: Message[] }

// پیامی که با delivery=queue در موتور ثبت شده و هنوز تحویل داده نشده است.
type QueuedPrompt = {
  inboxID: string
  sessionID: string
  text: string
  files: { name?: string; uri?: string }[]
  created: number
}

// فقط رویدادهای مربوط به خودِ اجرا «فعالیت» حساب می‌شوند. رویدادهایی مثل
// session.usage.recorded یا session.renamed ممکن است بعد از پایان اجرا هم
// برسند و نباید پنجرهٔ سکوت ۲٫۵ ثانیه‌ای را بی‌پایان تازه کنند.
function queuedPromptFrom(item: any, sessionID: string): QueuedPrompt | null {
  if (!item || item.type !== "user" || item.delivery !== "queue") return null
  const inboxID = String(item.inboxID ?? item.id ?? "")
  if (!inboxID) return null
  const payload = item.payload ?? {}
  const files = Array.isArray(payload.files)
    ? payload.files.map((f: any) => ({ uri: typeof f?.uri === "string" ? f.uri : undefined, name: typeof f?.name === "string" ? f.name : undefined }))
    : []
  return {
    inboxID,
    sessionID: String(item.sessionID ?? sessionID),
    text: typeof payload.text === "string" ? payload.text : "",
    files,
    created: Number(item.time?.created ?? Date.now()),
  }
}

function isExecutionEvent(type: string) {
  return (
    type === "session.status" ||
    type === "session.idle" ||
    type === "session.retry.scheduled" ||
    /^session\.(execution|text|reasoning|step|tool|compaction|inbox)\./.test(type)
  )
}

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
  const { t, num } = useI18n()
  const action = info.action
  const link =
    typeof action?.link === "string" && /^https?:\/\//i.test(action.link) ? action.link : null
  return (
    <div className="retry-card" role="status" aria-live="polite">
      <div className="retry-head">
        <span className="retry-dot" aria-hidden />
        {t("Automatic retry")}
        {info.attempt ? ` · ${t("Attempt {n}", { n: num(info.attempt) })}` : ""}
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
              {action.label ?? t("Open link")}
            </a>
          )}
        </div>
      )}
    </div>
  )
}

const QueuedPrompts = memo(function QueuedPrompts({
  items,
  onSendNow,
  onCancel,
}: {
  items: QueuedPrompt[]
  onSendNow: (item: QueuedPrompt) => void
  onCancel: (item: QueuedPrompt) => void
}) {
  const { t, num } = useI18n()
  if (items.length === 0) return null
  return (
    <div className="queued-panel" role="status" aria-live="polite">
      <div className="queued-head">
        <span className="queued-icon" aria-hidden>
          ⏳
        </span>
        <strong>
          {items.length === 1 ? t("Message waiting") : t("{n} messages waiting", { n: num(items.length) })}
        </strong>
        <span className="queued-note">{t("Sent automatically when the current response finishes.")}</span>
      </div>
      <div className="queued-list">
        {items.map((item) => (
          <div className="queued-item" key={item.inboxID}>
            <span className="queued-text" dir="auto">
              {item.text.trim() || t("Queued message")}
            </span>
            {item.files.length > 0 && (
              <span className="queued-files" dir="ltr" title={item.files.map((f) => f.name ?? f.uri ?? "").join("\n")}>
                📎 {num(item.files.length)}
              </span>
            )}
            <span className="queued-actions">
              <button type="button" className="queued-now" onClick={() => onSendNow(item)}>
                {t("Send now")}
              </button>
              <button type="button" className="queued-cancel" onClick={() => onCancel(item)}>
                {t("Cancel")}
              </button>
            </span>
          </div>
        ))}
      </div>
    </div>
  )
})

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

const ConnectionStatusChip = memo(function ConnectionStatusChip({
  state,
  connected,
  onOpenRelays,
  onRefresh,
}: {
  state: RelayState | null
  connected: boolean
  onOpenRelays: () => void
  onRefresh: () => void
}) {
  const { t, num } = useI18n()
  const [open, setOpen] = useState(false)
  const [testing, setTesting] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", down)
    return () => document.removeEventListener("mousedown", down)
  }, [open])

  const now = Date.now()
  const enabledRelays = (state?.relays ?? []).filter((r) => r.enabled !== false)
  const healthyRelays = enabledRelays.filter(
    (r) =>
      r.status !== "unreachable" &&
      r.status !== "auth_error" &&
      (r.cooldownUntil || 0) <= now &&
      (r.exhaustedUntil || 0) <= now,
  )
  const exhaustedRelays = enabledRelays.filter(
    (r) => r.status === "exhausted" || (r.exhaustedUntil || 0) > now || (r.cooldownUntil || 0) > now,
  )
  const activeRelay =
    healthyRelays.find((r) => r.id === state?.activeId) ??
    healthyRelays[0] ??
    enabledRelays.find((r) => r.id === state?.activeId) ??
    enabledRelays[0] ??
    null
  const route = state?.lastRouteInfo
  const tunnel = state?.psiphon
  const tunnelRunning = tunnel?.config.enabled ? tunnel.running : 0
  const tunnelLive = tunnel?.config.enabled ? tunnel.live : 0
  const activeTunnelRegion =
    tunnel?.regions.find((r) => r.state === "ready" && r.exitIp)?.region ||
    tunnel?.regions.find((r) => r.state === "ready")?.region ||
    ""
  const activeTunnelStatus = tunnel?.regions.find((r) => r.region === activeTunnelRegion)

  let mode: "relay" | "direct" | "blocked" | "warn" = "direct"
  let label = t("Direct connection (Direct)")
  let subLabel = connected ? t("Connected") : t("Disconnected")

  if (!connected) {
    mode = "blocked"
    label = t("Server connection lost")
    subLabel = t("Offline")
  } else if (route?.blocked) {
    mode = "blocked"
    label = route.status === 429 ? t("Blocked / rate limited (429)") : t("Error / blocked")
    subLabel = route.mode === "direct" ? t("Direct connection") : route.relayName || t("Relay")
  } else if (state?.enabled && (enabledRelays.length > 0 || tunnelRunning > 0)) {
    const healthyRoutes = healthyRelays.length + tunnelLive
    const totalRoutes = enabledRelays.length + tunnelRunning
    if (healthyRoutes > 0) {
      mode = "relay"
      const tunnelRoute = route?.mode === "relay" && (route.platform === "psiphon" || route.relayId?.startsWith("psiphon:"))
      const currentName =
        (route?.mode === "relay" && route.relayName) ||
        activeRelay?.name ||
        (tunnelRoute
          ? t("Local tunnel ({region})", { region: route?.region || activeTunnelRegion })
          : t("Cloud relay"))
      const currentIp =
        (route?.mode === "relay" && route.egress) || activeRelay?.lastEgress || ""
      label = state.rotate && totalRoutes > 1
        ? t("Rotating relay ({healthy}/{total} active)", { healthy: num(healthyRoutes), total: num(totalRoutes) })
        : t("Connected to relay: {name}", { name: currentName })
      subLabel = currentIp ? `IP: ${currentIp}` : t("Connected")
    } else if (tunnelRunning > 0) {
      mode = "warn"
      label = t("Tunnel connecting…")
      subLabel = t("Waiting for a ready exit")
    } else if (state.allowDirect) {
      mode = "warn"
      label = t("Relays blocked (429) · direct connection")
      subLabel = "Fallback Direct"
    } else {
      mode = "blocked"
      label = t("All relays blocked (429)")
      subLabel = t("No healthy relay")
    }
  } else {
    mode = "direct"
    label = t("Direct connection (Direct)")
    subLabel = state?.enabled ? t("No active relay") : t("Relay off")
  }

  const testActive = async () => {
    if (!activeRelay || testing) return
    setTesting(true)
    try {
      await appPost("/app/relays/test", { id: activeRelay.id })
    } catch {}
    onRefresh()
    setTesting(false)
  }

  return (
    <div className="model-anchor" ref={box}>
      <button
        type="button"
        className={`chip conn-status-chip chip-btn mode-${mode} ${open ? "open" : ""}`}
        onClick={() => {
          onRefresh()
          setOpen((v) => !v)
        }}
        title={t("Connection and relay status")}
      >
        <span className={`conn-status-dot mode-${mode}`} />
        <span className="chip-label" dir="auto">
          {label}
        </span>
        {subLabel && (
          <span className="conn-status-sub" dir="ltr">
            {subLabel}
          </span>
        )}
        <span className="chip-caret">▾</span>
      </button>

      {open && (
        <div className="model-pop conn-status-pop" role="dialog" aria-label={t("Connection and relay status")}>
          <div className="conn-pop-head">
            <strong>{t("Connection and relay status")}</strong>
            <span className={`conn-pop-badge mode-${mode}`}>
              {mode === "relay"
                ? t("Connected via relay")
                : mode === "direct"
                  ? t("Direct connection")
                  : mode === "warn"
                    ? t("Fallback to direct")
                    : t("Blocked / rate limited")}
            </span>
          </div>

          <div className="usage-row">
            <span>{t("OpenCode engine connection")}</span>
            <code className={connected ? "conn-ok" : "conn-err"}>
              {connected ? t("Online (Online)") : t("Offline (Offline)")}
            </code>
          </div>
          <div className="usage-row">
            <span>{t("Current routing mode")}</span>
            <code dir="auto">
              {state?.enabled && (enabledRelays.length > 0 || tunnelRunning > 0)
                ? state.rotate
                  ? t("Automatic relay rotation")
                  : tunnelRunning > 0 && enabledRelays.length > 0
                    ? t("Cloud relay and local tunnel")
                    : tunnelRunning > 0
                      ? t("Local tunnel")
                      : t("Cloud relay active")
                : t("Direct connection (Direct Connection)")}
            </code>
          </div>
          <div className="usage-row">
            <span>{t("Healthy routes")}</span>
            <code dir="ltr">
              {num(healthyRelays.length + tunnelLive)} / {num(enabledRelays.length + tunnelRunning)} (
              {t("Total: {n}", { n: num((state?.relays.length ?? 0) + (tunnel?.regions.length ?? 0)) })})
            </code>
          </div>
          {exhaustedRelays.length > 0 && (
            <div className="usage-row">
              <span>{t("Relays cooling down / 429")}</span>
              <code className="conn-warn" dir="ltr">
                {t("{n} relay(s)", { n: num(exhaustedRelays.length) })}
              </code>
            </div>
          )}

          {activeRelay && (
            <>
              <div className="usage-sep" />
              <div className="usage-row head">
                <span>{t("Current active relay")}</span>
              </div>
              <div className="usage-row">
                <span>{t("Name and platform")}</span>
                <code dir="ltr">
                  {activeRelay.name} ({activeRelay.platform})
                </code>
              </div>
              <div className="usage-row">
                <span>{t("Egress IP")}</span>
                <code dir="ltr">{activeRelay.lastEgress || t("Unknown")}</code>
              </div>
              {activeRelay.latency != null && (
                <div className="usage-row">
                  <span>{t("Relay ping")}</span>
                  <code dir="ltr">{activeRelay.latency} ms</code>
                </div>
              )}
              <div className="usage-row">
                <span>{t("Swapped IPs (429)")}</span>
                <code dir="ltr">{num(activeRelay.spentCount || 0)}</code>
              </div>
            </>
          )}

          {tunnelLive > 0 && activeTunnelRegion && (
            <>
              <div className="usage-sep" />
              <div className="usage-row head">
                <span>{t("Local tunnel route")}</span>
              </div>
              <div className="usage-row">
                <span>{t("Ready regions")}</span>
                <code dir="ltr">
                  {num(tunnelLive)} / {num(tunnelRunning)}
                </code>
              </div>
              <div className="usage-row">
                <span>{t("Active tunnel region")}</span>
                <code dir="ltr">{activeTunnelRegion}</code>
              </div>
              <div className="usage-row">
                <span>{t("Egress IP")}</span>
                <code dir="ltr">{activeTunnelStatus?.exitIp || t("Unknown")}</code>
              </div>
              {activeTunnelStatus?.latency != null && activeTunnelStatus.latency > 0 && (
                <div className="usage-row">
                  <span>{t("Relay ping")}</span>
                  <code dir="ltr">{activeTunnelStatus.latency} ms</code>
                </div>
              )}
              <div className="usage-row">
                <span>{t("Address renewals")}</span>
                <code dir="ltr">
                  {num(activeTunnelStatus?.renewals || 0)} / {num(tunnel?.maxRenewals || 3)}
                </code>
              </div>
            </>
          )}

          {route && route.time > 0 && (
            <>
              <div className="usage-sep" />
              <div className="usage-row head">
                <span>{t("Last outgoing request")}</span>
              </div>
              <div className="usage-row">
                <span>{t("Route")}</span>
                <code dir="auto">
                  {route.mode === "relay"
                    ? t("Relay ({name})", { name: route.relayName || route.platform })
                    : route.mode === "direct"
                      ? t("Direct connection (Direct)")
                      : t("Blocked")}
                </code>
              </div>
              {route.status > 0 && (
                <div className="usage-row">
                  <span>{t("Response status code")}</span>
                  <code
                    dir="ltr"
                    className={
                      route.status >= 200 && route.status < 300
                        ? "conn-ok"
                        : route.status === 429 || route.status === 403
                          ? "conn-err"
                          : "conn-warn"
                    }
                  >
                    HTTP {route.status}
                  </code>
                </div>
              )}
              {route.blocked && route.blockedReason && (
                <div className="conn-pop-alert">{route.blockedReason}</div>
              )}
            </>
          )}

          <div className="conn-pop-actions">
            {activeRelay && (
              <button
                type="button"
                className="conn-pop-btn"
                onClick={() => void testActive()}
                disabled={testing}
              >
                {testing ? t("Testing…") : t("Test relay ping")}
              </button>
            )}
            <button
              type="button"
              className="conn-pop-btn primary"
              onClick={() => {
                setOpen(false)
                onOpenRelays()
              }}
            >
              {t("Manage relays")}
            </button>
          </div>
        </div>
      )}
    </div>
  )
})

const UsageChip = memo(function UsageChip({
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
  const { t } = useI18n()
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

  const tokens = last.tokens
  const used = (tokens.input ?? 0) + (tokens.cache?.read ?? 0) + (tokens.cache?.write ?? 0)
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
        title={t("Token and context usage")}
      >
        <span className="chip-label" dir="ltr">
          {pct != null ? `${pctLabel}% · ` : ""}
          {fmtTok(used)}
          {limit ? `/${fmtTok(limit)}` : ""}
        </span>
        <span className="chip-caret">▾</span>
      </button>

      {open && (
        <div className="model-pop usage-pop" role="dialog" aria-label={t("Token usage")}>
          <div className="usage-row">
            <span>{t("Context in use")}</span>
            <code dir="ltr">{fmtFull(used)} tok</code>
          </div>
          {limit && (
            <div className="usage-row">
              <span>{t("Model window")}</span>
              <code dir="ltr">{fmtFull(limit)} tok</code>
            </div>
          )}
          {pct != null && (
            <div className="usage-row">
              <span>{t("Usage share")}</span>
              <code dir="ltr">{pctLabel}%</code>
            </div>
          )}
          <div className="usage-sep" />
          <div className="usage-row">
            <span>{t("Last response input")}</span>
            <code dir="ltr">{fmtFull(tokens.input)}</code>
          </div>
          <div className="usage-row">
            <span>{t("Read from cache")}</span>
            <code dir="ltr">{fmtFull(tokens.cache?.read)}</code>
          </div>
          <div className="usage-row">
            <span>{t("Written to cache")}</span>
            <code dir="ltr">{fmtFull(tokens.cache?.write)}</code>
          </div>
          <div className="usage-row">
            <span>{t("Output")}</span>
            <code dir="ltr">{fmtFull(tokens.output)}</code>
          </div>
          <div className="usage-row">
            <span>{t("Reasoning")}</span>
            <code dir="ltr">{fmtFull(tokens.reasoning)}</code>
          </div>
          <div className="usage-sep" />
          {sessionTokens && (
            <>
              <div className="usage-row head">
                <span>{t("This conversation total")}</span>
              </div>
              <div className="usage-row">
                <span>{t("Tokens (input+cache+output+reasoning)")}</span>
                <code dir="ltr">{fmtFull((sessionTokens.input ?? 0) + (sessionTokens.output ?? 0) + (sessionTokens.reasoning ?? 0) + (sessionTokens.cache?.read ?? 0) + (sessionTokens.cache?.write ?? 0))}</code>
              </div>
            </>
          )}
          {sessionCost != null && (
            <div className="usage-row">
              <span>{t("Conversation cost")}</span>
              <code dir="ltr">{fmtCost(sessionCost)}</code>
            </div>
          )}
        </div>
      )}
    </div>
  )
})

export default function App() {
  const { t, num } = useI18n()
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
  const [queuedPrompts, setQueuedPrompts] = useState<QueuedPrompt[]>([])
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [menu, setMenu] = useState(false)
  const [workdir, setWorkdir] = useState("")
  const [projects, setProjects] = useState<string[]>(loadProjects)
  const [projectsOpen, setProjectsOpen] = useState(false)
  const [permission, setPermission] = useState<PermissionMode>(loadPermissionMode)
  const [permissionBusy, setPermissionBusy] = useState(false)
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
  const [page, setPage] = useState<"chat" | "relays">("chat")
  const [relayState, setRelayState] = useState<RelayState | null>(null)
  const [updateOpen, setUpdateOpen] = useState(false)
  const [updateAvailable, setUpdateAvailable] = useState<string | null>(null)
  const [updateCheck, setUpdateCheck] = useState<UpdateCheck | null>(null)
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const [running, setRunning] = useState<Record<string, boolean>>({})
  const [serverDown, setServerDown] = useState(false)
  const [exiting, setExiting] = useState(false)
  const [exited, setExited] = useState(false)
  const [editingMessageImage, setEditingMessageImage] = useState<{ src: string; name?: string } | null>(null)
  const composerAddImage = useRef<((image: Attachment) => void) | null>(null)

  const activeRef = useRef<string | null>(null)
  const busyRef = useRef(false)
  const pendingSkill = useRef<string | null>(null)
  const messagesRef = useRef<Message[]>([])
  const sessionsRef = useRef<SessionInfo[]>([])
  const olderCursor = useRef<string | null>(null)
  const agentDefaults = useRef<Record<string, string>>({})
  const atBottom = useRef(true)
  const scroller = useRef<HTMLDivElement>(null)
  const bottomMark = useRef<HTMLDivElement>(null)
  const scrollFrame = useRef<number | null>(null)
  const pendingEvents = useRef<any[]>([])
  const eventSeq = useRef(0)
  const lastActiveEventAt = useRef(0)
  const stopRequestedAt = useRef(0)
  const flushTimer = useRef<number | null>(null)
  const sessionsRefreshTimer = useRef<number | null>(null)

  const apply = useCallback((next: Message[]) => {
    messagesRef.current = next
    setMessages(next)
  }, [])

  // رویدادهای پیام در یک بازهٔ کوتاه جمع می‌شوند تا هر توکن یک رندر کامل نسازد.
  const clearPending = useCallback(() => {
    pendingEvents.current = []
    if (flushTimer.current !== null) {
      window.clearTimeout(flushTimer.current)
      flushTimer.current = null
    }
  }, [])

  // وضعیت «در حال اجرا» فقط از رویدادها قابل اعتماد نیست: اگر کاربر وسط اجرا
  // جلسه عوض کند، اتصال SSE دوباره برقرار شود یا رویداد شروعِ پیام صف‌شده گم
  // شود، دکمهٔ توقف و نشانگر «در حال کار» اشتباه می‌شوند. این تابع وضعیت واقعی
  // را از خود موتور می‌پرسد؛ تعریفش بعد از loadMessages می‌آید.

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
    // ظرفیت کانتکس/خروجیِ ثبت‌شده در «model-limits.json» روی دادهٔ موتور اعمال
    // می‌شود تا پنجرهٔ مدل همان عددی باشد که سازندهٔ مدل اعلام کرده است.
    setModels(applyModelLimits(unique))
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

  const refreshRelayState = useCallback(async () => {
    try {
      const res = await appGet<RelayState & { state?: RelayState }>("/app/relays")
      const next = res?.state ?? res
      if (next && Array.isArray(next.relays)) setRelayState(next)
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
      // شمارهٔ ترتیب را پیش از درخواست می‌گیریم؛ رویدادهایی که در فاصلهٔ
      // درخواست تا رسیدن پاسخ می‌رسند به‌طور قطع در snapshot نیستند (مثلاً
      // شروع اجرای پیام صف‌شده) و باید بعد از نشستن snapshot دوباره اعمال شوند.
      const snapshotSeq = eventSeq.current
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
        pendingEvents.current = pendingEvents.current.filter((ev) => Number(ev?.__seq ?? 0) > snapshotSeq)
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
    const id = activeRef.current
    try {
      // The location-less endpoint only sees requests from the engine's default
      // folder. A session in another project must use its own permission list,
      // otherwise approval cards for that project never appear.
      const res = id
        ? await get<{ data: PermissionRequest[] }>(`/api/session/${id}/permission`)
        : await get<{ data: PermissionRequest[] }>("/api/permission/request")
      setPerms(res.data ?? [])
    } catch {}
  }, [])

  const removeQueuedPrompt = useCallback((inboxID: string) => {
    setQueuedPrompts((prev) => prev.filter((item) => item.inboxID !== inboxID))
  }, [])

  const mergeQueuedPrompt = useCallback((item: QueuedPrompt) => {
    setQueuedPrompts((prev) => {
      const next = prev.filter((row) => row.inboxID !== item.inboxID)
      next.push(item)
      next.sort((a, b) => a.created - b.created)
      return next
    })
  }, [])

  // صندوق ورودی موتور منبع حقیقت است؛ با قطع/وصل دوبارهٔ SSE یا بعد از
  // رویداد از دست رفته، کارت انتظار را با آن هم‌تراز می‌کنیم.
  const refreshQueued = useCallback(async (sessionID?: string | null) => {
    const id = sessionID ?? activeRef.current
    if (!id) {
      setQueuedPrompts([])
      return
    }
    try {
      const res = await get<{ data: any[] }>(`/api/session/${id}/inbox`)
      if (activeRef.current !== id) return
      const items = (res.data ?? [])
        .map((item) => queuedPromptFrom(item, id))
        .filter((item): item is QueuedPrompt => item !== null)
        .sort((a, b) => a.created - b.created)
      setQueuedPrompts(items)
    } catch {
      // اگر موتور در دسترس نیست، کارت فعلی را نگه می‌داریم تا با یک خطای
      // گذرای شبکه ناپدید نشود.
    }
  }, [])

  const sendQueuedNow = useCallback(
    async (item: QueuedPrompt) => {
      removeQueuedPrompt(item.inboxID)
      stopRequestedAt.current = 0
      setBusy(true)
      busyRef.current = true
      setRetry(null)
      atBottom.current = true
      try {
        await patch(`/api/session/${item.sessionID}/inbox/${encodeURIComponent(item.inboxID)}`, {
          delivery: "steer",
        })
      } catch (e: any) {
        setError(t("Could not send the queued message: {error}", { error: e.message }))
        void refreshQueued(item.sessionID)
      }
    },
    [removeQueuedPrompt, refreshQueued, t],
  )

  const cancelQueued = useCallback(
    async (item: QueuedPrompt) => {
      removeQueuedPrompt(item.inboxID)
      try {
        await del(`/api/session/${item.sessionID}/inbox/${encodeURIComponent(item.inboxID)}`)
      } catch (e: any) {
        setError(t("Could not cancel the queued message: {error}", { error: e.message }))
        void refreshQueued(item.sessionID)
      }
    },
    [removeQueuedPrompt, refreshQueued, t],
  )

  // وضعیت «در حال اجرا» فقط از رویدادها قابل اعتماد نیست: اگر کاربر وسط اجرا
  // جلسه عوض کند، اتصال SSE دوباره برقرار شود یا رویداد شروعِ پیام صف‌شده گم
  // شود، دکمهٔ توقف و نشانگر «در حال کار» اشتباه می‌شوند. این تابع وضعیت واقعی
  // را از خود موتور می‌پرسد و در صورت نیاز پیام‌ها را دوباره می‌گیرد.
  const refreshActive = useCallback(async () => {
    const id = activeRef.current
    if (!id) return
    try {
      const res = await get<{ data: Record<string, { type?: string }> }>("/api/session/active")
      if (activeRef.current !== id) return
      const running = res.data?.[id]?.type === "running"
      const was = busyRef.current
      if (running) {
        // اگر کاربر همین حالا توقف را زده، ممکن است پاسخ active هنوز کهنه
        // باشد؛ چند لحظه وضعیت «در حال اجرا» را برنگردان.
        if (Date.now() - stopRequestedAt.current < 2000) return
        if (!was) {
          setBusy(true)
          busyRef.current = true
          // اگر رویداد شروع گم شده باشد، بدنهٔ پاسخ باید از موتور ساخته شود.
          void loadMessages(id)
          void refreshQueued(id)
        }
        return
      }
      // «idle» را فقط وقتی می‌پذیریم که جریان رویدادها ساکت شده باشد؛ وگرنه
      // ممکن است در فاصلهٔ بین دو step باشیم و اجرا هنوز ادامه داشته باشد.
      if (was && Date.now() - lastActiveEventAt.current < 2500) return
      if (was) {
        setBusy(false)
        busyRef.current = false
        setRetry(null)
        void loadMessages(id)
        void refreshRelayState()
        void refreshPerms()
        void refreshQueued(id)
      }
    } catch {}
  }, [loadMessages, refreshRelayState, refreshPerms, refreshQueued])

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

  // رویدادهای مصرف توکن ممکن است پشت سر هم برسند؛ لیست گفت‌وگوها را حداکثر
  // هر ۱٫۲ ثانیه یک‌بار تازه می‌کنیم تا هر توکن باعث درخواست شبکه و رندر نشود.
  const scheduleSessionsRefresh = useCallback(() => {
    if (sessionsRefreshTimer.current !== null) return
    sessionsRefreshTimer.current = window.setTimeout(() => {
      sessionsRefreshTimer.current = null
      void refreshSessions()
    }, 1200)
  }, [refreshSessions])

  const select = useCallback(
    async (id: string) => {
      setPage("chat")
      clearPending()
      if (activeRef.current === id) {
        setMenu(false)
        return
      }
      activeRef.current = id
      setActiveId(id)
      const info = sessionsRef.current.find((s) => s.id === id)
      if (info) {
        setPermission(modeFromRuleset(info.permissions))
        // The active project follows the chat that is open, so new chats and
        // the sidebar project badge always match the visible conversation.
        const dir = info.location?.directory
        if (dir) {
          setWorkdir(dir)
          localStorage.setItem("oc-workdir", dir)
          setProjects((prev) => (prev.some((p) => sameDir(p, dir)) ? prev : [dir, ...prev]))
        }
      }
      stopRequestedAt.current = 0
      setBusy(false)
      busyRef.current = false
      setRetry(null)
      setHasMore(false)
      contextCache.current = null
      olderCursor.current = null
      setPerms([])
      setForms([])
      setQueuedPrompts([])
      setMenu(false)
      atBottom.current = true
      apply([])
      await loadMessages(id)
      void refreshPerms()
      void refreshForms()
      void refreshActive()
      void refreshQueued(id)
    },
    [apply, loadMessages, refreshPerms, refreshForms, refreshActive, refreshQueued, clearPending],
  )

  const changeWorkdir = useCallback(async (raw: string) => {
    const dir = cleanDir(raw)
    if (!dir) return false
    // مسیر نسبی هرگز نباید ذخیره شود؛ موتور آن را در Session.create رد می‌کند.
    if (!isAbsoluteDir(dir)) {
      setError(t("Path must be absolute (for example C:\\Projects\\my-app): {dir}", { dir }))
      return false
    }
    if (!(await dirExists(dir))) {
      setError(t("Folder not found: {dir}", { dir }))
      return false
    }
    setWorkdir(dir)
    localStorage.setItem("oc-workdir", dir)
    setProjects((prev) => (prev.some((p) => sameDir(p, dir)) ? prev : [dir, ...prev]))
    return true
  }, [t])

  const addProjects = useCallback(
    async (paths: string[]): Promise<AddProjectsResult> => {
      const added: string[] = []
      const failed: { path: string; error: string }[] = []
      for (const raw of paths) {
        const dir = cleanDir(raw)
        if (!dir || !isAbsoluteDir(dir)) {
          failed.push({ path: raw, error: t("Path must be absolute") })
          continue
        }
        if (projects.some((p) => sameDir(p, dir))) {
          failed.push({ path: dir, error: t("Already in projects") })
          continue
        }
        try {
          const res = await appGet<{ ok?: boolean; path?: string }>(
            `/app/folders/check?path=${encodeURIComponent(dir)}`,
          )
          const normalized = cleanDir(res.path || dir)
          if (!normalized) throw new Error(t("Folder not found"))
          if (projects.some((p) => sameDir(p, normalized)) || added.some((p) => sameDir(p, normalized))) {
            failed.push({ path: normalized, error: t("Already in projects") })
            continue
          }
          added.push(normalized)
        } catch (e: any) {
          failed.push({ path: dir, error: e?.message ?? t("Folder not found") })
        }
      }
      if (added.length > 0) {
        setProjects((prev) => [...added, ...prev.filter((p) => !added.some((a) => sameDir(a, p)))])
      }
      return { added, failed }
    },
    [projects, t],
  )

  const removeProject = useCallback(
    (dir: string) => {
      const next = projects.filter((p) => !sameDir(p, dir))
      setProjects(next)
      if (sameDir(dir, workdir)) {
        const fallback = next[0]
        if (fallback) void changeWorkdir(fallback)
        else {
          setWorkdir("")
          localStorage.removeItem("oc-workdir")
        }
      }
    },
    [projects, workdir, changeWorkdir],
  )

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
        setError(t("Default agent for this session is unknown; pick an agent"))
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
    [agents, t],
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
          clearPending()
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
          setQueuedPrompts([])
          atBottom.current = true
          apply([])
          await refreshSessions(true)
        }
      } catch (e: any) {
        setError(e.message)
      }
    },
    [apply, refreshSessions, clearPending],
  )

  const createSession = useCallback(async (dirOverride?: string) => {
    setPage("chat")
    try {
      const fallback = config?.directory
      let directory = dirOverride ?? (workdir || fallback)
      // اگر مقدار ذخیره‌شده نسبی باشد (مثل «C:» یا «.»)، حتی یک بار هم به موتور
      // فرستاده نمی‌شود؛ Session.create با 500 و بدنهٔ خالی پاسخ می‌دهد.
      if (directory && !isAbsoluteDir(directory)) {
        localStorage.removeItem("oc-workdir")
        setWorkdir(fallback ?? "")
        setError(
          t("Stored path is invalid (\"{dir}\"); using \"{fallback}\".", {
            dir: directory,
            fallback: fallback ?? t("Default folder"),
          }),
        )
        directory = fallback
      }
      if (directory && directory !== fallback && !(await dirExists(directory))) {
        localStorage.removeItem("oc-workdir")
        setWorkdir(fallback ?? "")
        setError(t("Folder \"{dir}\" not found; using \"{fallback}\".", { dir: directory, fallback: fallback ?? "" }))
        directory = fallback
      }

      const payload: any = {}
      if (directory) payload.location = { directory }
      if (model) payload.model = model
      if (agent) payload.agent = agent
      payload.permissions = rulesForMode(permission)

      const res = await post<any>("/api/session", payload)
      const raw: Partial<SessionInfo> = res?.data ?? res ?? {}
      if (!raw.id) throw new Error(t("Failed to create conversation"))
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
        permissions: raw.permissions ?? rulesForMode(permission),
        time: raw.time ?? { created: now, updated: now },
      }
      activeRef.current = session.id
      setActiveId(session.id)
      stopRequestedAt.current = 0
      setBusy(false)
      busyRef.current = false
      setRetry(null)
      setHasMore(false)
      contextCache.current = null
      olderCursor.current = null
      atBottom.current = true
      clearPending()
      apply([])
      setPerms([])
      setForms([])
      setQueuedPrompts([])
      if (session.agent || agent) agentDefaults.current[session.id] = session.agent ?? agent!
      setSessions((prev) => [session, ...prev.filter((s) => s.id !== session.id)])
      return session.id
    } catch (e: any) {
      setError(e.message)
      return null
    }
  }, [apply, workdir, config?.directory, model, agent, permission, clearPending, t])

  const applyPermission = useCallback(async (mode: PermissionMode) => {
    setPermission(mode)
    localStorage.setItem(PERMISSION_STORAGE_KEY, mode)
    const id = activeRef.current
    if (!id) return
    const rules = rulesForMode(mode)
    setPermissionBusy(true)
    try {
      await patch(`/api/session/${id}`, { permissions: rules })
      setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, permissions: rules } : s)))
    } catch (e: any) {
      setError(e.message)
    } finally {
      setPermissionBusy(false)
    }
  }, [])

  const selectProject = useCallback(
    async (dir: string) => {
      const ok = await changeWorkdir(dir)
      if (!ok) return
      setProjectsOpen(false)
      const target = sessionsRef.current
        .filter((s) => sameDir(s.location?.directory, dir))
        .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))[0]
      if (target) await select(target.id)
      else await createSession(dir)
    },
    [changeWorkdir, select, createSession],
  )

  const flushPending = useCallback(() => {
    flushTimer.current = null
    if (pendingEvents.current.length === 0) return
    const events = pendingEvents.current
    pendingEvents.current = []
    const id = activeRef.current
    if (!id) return

    let list = messagesRef.current
    let busy: boolean | undefined
    let error: string | undefined
    let done = false
    for (const ev of events) {
      if (String(ev?.data?.sessionID ?? "") !== id) continue
      const result = reduce(list, ev, t)
      if (result.messages !== list) list = result.messages
      if (result.busy !== undefined) busy = result.busy
      if (result.error) error = result.error
      if (result.done) done = true
    }

    if (list !== messagesRef.current) apply(list)
    if (busy !== undefined) {
      setBusy(busy)
      busyRef.current = busy
      if (!busy) setRetry(null)
    }
    if (error) setError(error)
    if (done) {
      void loadMessages(id)
      void refreshPerms()
    }
  }, [apply, loadMessages, refreshPerms, t])

  const queueEvent = useCallback(
    (ev: any) => {
      ev.__seq = ++eventSeq.current
      pendingEvents.current.push(ev)
      if (flushTimer.current !== null) return
      flushTimer.current = window.setTimeout(() => {
        flushTimer.current = null
        flushPending()
      }, 50)
    },
    [flushPending],
  )

  const handleEvent = (ev: any) => {
    const type = String(ev.type ?? "")
    const data = ev.data ?? {}
    if (isExecutionEvent(type) && data.sessionID && data.sessionID === activeRef.current) {
      lastActiveEventAt.current = Date.now()
    }
    if (type === "server.connected") {
      // ممکن است بین قطع و وصل SSE چند رویداد از دست رفته باشد؛ وضعیت را از
      // موتور دوباره می‌خوانیم تا نه پیام گم شود و نه دکمه‌ها در حالت اشتباه بمانند.
      void refreshSessions()
      void refreshConfig()
      void refreshModels()
      void refreshAgents()
      void refreshCommands()
      void refreshSkills()
      void refreshRelayState()
      void checkUpdate(true)
      const current = activeRef.current
      if (current) {
        void loadMessages(current)
        void refreshPerms()
        void refreshForms()
        void refreshActive()
        void refreshQueued(current)
      }
      return
    }

    if (type === "session.status" && data.sessionID === activeRef.current) {
      const status = data.status?.type
      const running = status === "busy" || status === "retry"
      // رویداد status ممکن است بعد از توقف کاربر با تأخیر برسد و وضعیت
      // «در حال اجرا» را برگرداند. همان پنجرهٔ ۲ ثانیه‌ای که در نظرسنجی
      // داریم، اینجا هم لازم است؛ ولی ارسال پیام تازه این زمان را صفر می‌کند.
      const staleRunning = running && Date.now() - stopRequestedAt.current < 2000
      if (!staleRunning) {
        setBusy(running)
        busyRef.current = running
        if (status === "retry") {
          setRetry({
            message: String(data.status.message ?? t("Failed to connect to the provider; retrying…")),
            attempt: typeof data.status.attempt === "number" ? data.status.attempt : undefined,
            action:
              data.status.action && typeof data.status.action === "object"
                ? (data.status.action as RetryAction)
                : undefined,
          })
        } else {
          setRetry(null)
        }
        if (!running) {
          void loadMessages(data.sessionID)
          void refreshRelayState()
        }
      }
    }
    if (type === "session.idle" && data.sessionID === activeRef.current) {
      setBusy(false)
      busyRef.current = false
      setRetry(null)
      void loadMessages(data.sessionID)
      void refreshRelayState()
      void refreshQueued(data.sessionID)
    }
    if (data.sessionID === activeRef.current) {
      if (type === "session.inbox.enqueued") {
        // پیام معمولی (steer) نباید در کارت انتظار بماند؛ فقط delivery=queue.
        const item = queuedPromptFrom(
          { ...(data.item ?? {}), inboxID: data.inboxID, sessionID: data.sessionID },
          data.sessionID,
        )
        if (item) mergeQueuedPrompt(item)
        else if (data.inboxID) removeQueuedPrompt(data.inboxID)
      }
      if (type === "session.inbox.delivery.changed") {
        // رویداد فقط delivery را دارد، نه متن؛ برای برگشت به queue از موتور
        // می‌خوانیم و برای steer فوراً کارت را برمی‌داریم.
        if (data.delivery === "queue") void refreshQueued(data.sessionID)
        else if (data.inboxID) removeQueuedPrompt(data.inboxID)
      }
      if (
        (type === "session.inbox.delivered" || type === "session.inbox.cancelled") &&
        data.inboxID
      ) {
        removeQueuedPrompt(data.inboxID)
      }
      if (
        type === "session.execution.succeeded" ||
        type === "session.execution.failed" ||
        type === "session.execution.interrupted"
      ) {
        void refreshQueued(data.sessionID)
      }
    }
    if (type === "session.agent.selected" && data.sessionID === activeRef.current && typeof data.agent === "string") {
      setAgent(data.agent)
      setSessions((prev) => prev.map((s) => (s.id === data.sessionID ? { ...s, agent: data.agent } : s)))
    }
    if (type === "session.model.selected" && data.sessionID === activeRef.current && data.model) {
      setModel(data.model)
      setSessions((prev) => prev.map((s) => (s.id === data.sessionID ? { ...s, model: data.model } : s)))
    }
    if (type === "session.permissions" && Array.isArray(data.permissions)) {
      if (data.sessionID === activeRef.current) setPermission(modeFromRuleset(data.permissions))
      setSessions((prev) =>
        prev.map((s) => (s.id === data.sessionID ? { ...s, permissions: data.permissions } : s)),
      )
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
      scheduleSessionsRefresh()
    }
    if (type === "session.renamed") {
      setSessions((prev) => prev.map((s) => (s.id === data.sessionID ? { ...s, title: data.title } : s)))
    }
    if (type === "session.created" || type === "session.renamed" || type.startsWith("session.execution")) {
      void refreshSessions()
    }

    const id = data.sessionID
    if (!id || id !== activeRef.current) return

    queueEvent(ev)
  }

  const handlerRef = useRef(handleEvent)
  useEffect(() => {
    handlerRef.current = handleEvent
  })
  useEffect(() => {
    busyRef.current = busy
  })

  useEffect(() => {
    sessionsRef.current = sessions
  }, [sessions])

  useEffect(() => {
    saveProjects(projects)
  }, [projects])

  // The active folder always belongs to the project list, including folders
  // restored from the older single-folder setting (oc-workdir).
  useEffect(() => {
    if (!workdir) return
    setProjects((prev) => (prev.some((p) => sameDir(p, workdir)) ? prev : [workdir, ...prev]))
  }, [workdir])

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
            setError(t("Saved folder not found; using \"{dir}\".", { dir: cfg.directory }))
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
        // کاتالوگ ظرفیت‌ها باید پیش از خواندن مدل‌ها آماده باشد تا همان بارِ
        // اول، پنجرهٔ مدل با عدد ثبت‌شده نمایش داده شود.
        await loadModelLimitCatalog()
        if (!alive) return
        setModels(applyModelLimits(unique))
      }

      const agentList = await get<{ data: AgentInfo[] }>("/api/agent").catch(() => null)
      if (alive && agentList) setAgents(agentList.data ?? [])

      const cmdList = await get<{ data: CommandInfo[] }>("/api/command").catch(() => null)
      if (alive && cmdList) setCommands(cmdList.data ?? [])

      const skillList = await get<{ data: SkillInfo[] }>("/api/skill").catch(() => null)
      if (alive && skillList) setSkills(skillList.data ?? [])

      void refreshRelayState()
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
      void refreshRelayState()
      void checkUpdate()
    }
    window.addEventListener("focus", refresh)
    const timer = window.setInterval(refresh, 5 * 60_000)
    const relayTimer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshRelayState()
    }, 10_000)
    return () => {
      window.removeEventListener("focus", refresh)
      window.clearInterval(timer)
      window.clearInterval(relayTimer)
    }
  }, [refreshModels, refreshRelayState, checkUpdate])

  // نظرسنجی سبک وضعیت اجرا. SSE به‌تنهایی کافی نیست: استریم ممکن است کند شود،
  // قطع شود یا رویداد شروعِ پیام صف‌شده پیش از رسیدن گم شود. این نظرسنجی
  // وضعیت busy را در هر دو جهت (در حال اجرا / تمام‌شده) با موتور هم‌تراز
  // نگه می‌دارد و اگر پیام‌ها عقب افتاده باشند دوباره می‌گیرد.
  useEffect(() => {
    if (!activeId) return
    let cancelled = false
    const tick = () => {
      if (cancelled || document.visibilityState !== "visible") return
      void refreshActive()
    }
    tick()
    const timer = window.setInterval(tick, 4000)
    const onVisible = () => {
      if (document.visibilityState === "visible") tick()
    }
    document.addEventListener("visibilitychange", onVisible)
    window.addEventListener("focus", tick)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      document.removeEventListener("visibilitychange", onVisible)
      window.removeEventListener("focus", tick)
    }
  }, [activeId, refreshActive])

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

  // به‌جای خواندن scrollHeight در هر رویداد scroll (که layout اجباری می‌سازد)،
  // یک نشانگر انتهای فهرست با IntersectionObserver زیر نظر گرفته می‌شود.
  useEffect(() => {
    const root = scroller.current
    const mark = bottomMark.current
    if (!root || !mark) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        atBottom.current = entry.isIntersecting
      },
      { root, rootMargin: "0px 0px 80px 0px", threshold: 0 },
    )
    observer.observe(mark)
    return () => observer.disconnect()
  }, [page])

  // اسکرول خودکار حداکثر یک‌بار در هر فریم و فقط وقتی کاربر پایین است انجام می‌شود.
  useEffect(() => {
    if (!atBottom.current) return
    if (scrollFrame.current !== null) return
    scrollFrame.current = window.requestAnimationFrame(() => {
      scrollFrame.current = null
      const el = scroller.current
      if (el) el.scrollTop = el.scrollHeight
    })
  }, [messages, busy])

  useEffect(
    () => () => {
      if (scrollFrame.current !== null) window.cancelAnimationFrame(scrollFrame.current)
      if (flushTimer.current !== null) window.clearTimeout(flushTimer.current)
      if (sessionsRefreshTimer.current !== null) window.clearTimeout(sessionsRefreshTimer.current)
    },
    [],
  )

  const active = sessions.find((s) => s.id === activeId) ?? null

  const slashItems = useMemo<MenuItem[]>(() => {
    const items: MenuItem[] = [
      { id: "builtin:new", label: "new", hint: t("New conversation"), group: t("Commands") },
      { id: "builtin:sessions", label: "sessions", hint: t("All conversations"), group: t("Commands") },
      { id: "builtin:model", label: "model", hint: t("Choose model"), group: t("Commands") },
      { id: "builtin:agent", label: "agent", hint: t("Choose agent"), group: t("Commands") },
      { id: "builtin:compact", label: "compact", hint: t("Compact current session"), group: t("Commands") },
      { id: "builtin:undo", label: "undo", hint: t("Undo the last message and its reply"), group: t("Commands") },
      { id: "builtin:export", label: "export", hint: t("Copy conversation to clipboard"), group: t("Commands") },
      { id: "builtin:interrupt", label: "interrupt", hint: t("Stop the current run"), group: t("Commands") },
      { id: "builtin:settings", label: "settings", hint: t("OpenCode settings"), group: t("Commands") },
      { id: "builtin:relays", label: "relays", hint: t("Manage cloud relays and IP rotation"), group: t("Commands") },
      { id: "builtin:update", label: "update", hint: t("Update engine"), group: t("Commands") },
    ]
    for (const c of commands) {
      items.push({ id: `custom:${c.name}`, label: c.name, hint: c.description ?? "", group: t("Custom") })
    }
    for (const s of skills) {
      items.push({ id: `skill:${s.id}`, label: s.id, hint: s.description ?? "", group: t("Skills") })
    }
    return items
  }, [commands, skills, t])

  const send = useCallback(async (text: string, attachments: Attachment[] = [], promptFiles: PromptFile[] = []) => {
    const queued = busyRef.current
    const skill = pendingSkill.current
    let id = activeRef.current
    if (!id) {
      id = await createSession()
      if (!id) return false
    }
    stopRequestedAt.current = 0
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
          if (!res?.ok || !res.path) throw new Error(res?.error ?? t("File upload failed"))
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
      const res = await post<any>(`/api/session/${id}/prompt`, body)
      if (queued) {
        // پاسخ موتور همان آیتم صندوق ورودی است؛ اگر رویداد SSE دیر برسد یا
        // گم شود، کارت انتظار بلافاصله از همین پاسخ ساخته می‌شود.
        const raw = res?.data ?? res
        const item = raw
          ? queuedPromptFrom({ ...raw, delivery: raw.delivery ?? "queue" }, id)
          : null
        if (item) mergeQueuedPrompt(item)
        else window.setTimeout(() => void refreshQueued(id), 400)
      }
      return true
    } catch (e: any) {
      if (!queued) {
        setBusy(false)
        busyRef.current = false
      }
      setError(e.message)
      return false
    }
  }, [createSession, mergeQueuedPrompt, refreshQueued, t])

  const stop = useCallback(async () => {
    const id = activeRef.current
    if (!id) return
    stopRequestedAt.current = Date.now()
    try {
      await post(`/api/session/${id}/interrupt`)
    } catch {}
    setBusy(false)
    busyRef.current = false
    setRetry(null)
  }, [])

  const beginEdit = (message: Message) => {
    const sid = activeRef.current
    if (!sid || message.type !== "user" || edit) return
    if (busyRef.current) {
      setError(t("You can't edit the message until the current response finishes"))
      return
    }
    if (perms.length > 0 || forms.length > 0) {
      setError(t("Answer pending requests first"))
      return
    }
    const lastUser = [...messagesRef.current].reverse().find((m) => m.type === "user")
    if (!lastUser || lastUser.id !== message.id) {
      setError(t("Only the last message in the conversation can be edited"))
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
      setError(t("The current response must finish before editing the message"))
      return
    }
    const sid = activeRef.current
    if (!sid || sid !== draft.sessionId) {
      setError(t("The session changed; edit cancelled"))
      setEdit(null)
      return
    }
    const text = draft.text.trim()
    if (text === "" && draft.files.length === 0) {
      setError(t("Message text is empty"))
      return
    }
    if (!draft.reverted) {
      const lastUser = [...messagesRef.current].reverse().find((m) => m.type === "user")
      if (!lastUser || lastUser.id !== draft.messageId) {
        setError(t("Only the last message in the conversation can be edited"))
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

      stopRequestedAt.current = 0
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
      setNotice(t("Message edited and sent again"))
      void loadMessages(sid).catch((e: any) => setError(e.message))
    } catch (e: any) {
      setError(t("Failed to edit message: {error}", { error: e.message }))
      setEdit((prev) => (prev ? { ...prev, saving: false, reverted } : prev))
    }
  }

  const restoreEdit = async () => {
    const draft = edit
    if (!draft || draft.saving || !draft.reverted) return
    if (busyRef.current) {
      setError(t("The current response must finish before restoring the message"))
      return
    }
    const sid = activeRef.current
    if (!sid || sid !== draft.sessionId) {
      setError(t("The session changed; restore cancelled"))
      setEdit(null)
      return
    }
    if (draft.originalText.trim() === "" && draft.originalFiles.length === 0) {
      setError(t("The original message has nothing to send"))
      return
    }

    setError(null)
    setNotice(null)
    setEdit({ ...draft, saving: true })
    stopRequestedAt.current = 0
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
      setNotice(t("Original message sent again"))
      void loadMessages(sid).catch((e: any) => setError(e.message))
    } catch (e: any) {
      setBusy(false)
      busyRef.current = false
      setEdit((prev) => (prev ? { ...prev, saving: false } : prev))
      setError(t("Failed to restore message: {error}", { error: e.message }))
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
        case "builtin:relays":
          setPage("relays")
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
            setError(t("Start a conversation first"))
            return
          }
          try {
            await post(`/api/session/${sid}/compact`, {})
            stopRequestedAt.current = 0
            setBusy(true)
          } catch (e: any) {
            setError(e.message)
          }
          return
        }
        case "builtin:undo": {
          if (!sid) {
            setError(t("Start a conversation first"))
            return
          }
          const list = messagesRef.current
          const lastUser = [...list].reverse().find((m) => m.type === "user")
          if (!lastUser) {
            setError(t("Nothing to undo"))
            return
          }
          try {
            await post(`/api/session/${sid}/revert/stage`, { messageID: lastUser.id, files: false })
            await post(`/api/session/${sid}/revert/commit`, {})
            await loadMessages(sid)
            setError(null)
            setNotice(t("Last message and its reply were undone"))
          } catch (e: any) {
            setError(e.message)
          }
          return
        }
        case "builtin:export": {
          if (!sid) {
            setError(t("Start a conversation first"))
            return
          }
          const list = await collectAllMessages(sid)
          if (list.length === 0) {
            setError(t("Nothing to export"))
            return
          }
          const title = sessions.find((s) => s.id === sid)?.title ?? list.find((m) => m.type === "user")?.text ?? t("Conversation")
          const lines: string[] = [`# ${title}`, ""]
          for (const m of list) {
            if (m.type === "user") {
              lines.push(`## ${t("User")}`, "")
              if (m.text) lines.push(m.text, "")
              if (m.files?.length) lines.push(...m.files.map((f) => `- ${t("File: {name}", { name: f.name ?? f.uri })}`), "")
            } else if (m.type === "assistant") {
              const text = (m.content ?? [])
                .map((p) => (p.type === "compaction" ? (p.text ?? "") : p.type === "text" ? (p.text ?? "") : ""))
                .filter((tx) => tx.trim())
                .join("\n\n")
              if (text.trim()) lines.push(`## ${t("Assistant")}`, "", text, "")
            }
          }
          const md = lines.join("\n")
          const date = new Date().toISOString().slice(0, 10).replaceAll("-", "")
          try {
            await navigator.clipboard.writeText(md)
            setError(null)
            setNotice(t("Conversation copied to clipboard (Markdown)"))
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
            setNotice(t("Conversation Markdown file downloaded"))
          }
          return
        }
      }
      if (id.startsWith("custom:")) {
        const name = id.slice(8)
        if (!sid) {
          setError(t("Start a conversation first"))
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
        setNotice(t("Skill \"{name}\" enabled for the next message", { name: skillId }))
        return
      }
    },
    [createSession, stop, sessions, loadMessages, collectAllMessages, refreshModels, refreshAgents, checkUpdate, t],
  )

  const reply = useCallback(async (request: PermissionRequest, decision: string) => {
    setPerms((prev) => prev.filter((p) => p.id !== request.id))
    try {
      await post(`/api/session/${request.sessionID}/permission/${request.id}/reply`, { decision })
    } catch (e: any) {
      setError(e.message)
      if (activeRef.current === request.sessionID) {
        setPerms((prev) => (prev.some((p) => p.id === request.id) ? prev : [request, ...prev]))
      }
    }
  }, [])

  const replyForm = useCallback(async (form: EngineForm, answer: Record<string, any>) => {
    setForms((prev) => prev.filter((x) => x.id !== form.id))
    try {
      await post(`/api/session/${form.sessionID}/form/${form.id}/reply`, { answer })
    } catch (e: any) {
      setError(e.message)
      if (activeRef.current === form.sessionID) {
        setForms((prev) => (prev.some((x) => x.id === form.id) ? prev : [form, ...prev]))
      }
    }
  }, [])

  const cancelForm = useCallback(async (form: EngineForm) => {
    setForms((prev) => prev.filter((x) => x.id !== form.id))
    try {
      await del(`/api/session/${form.sessionID}/form/${form.id}`)
    } catch (e: any) {
      setError(e.message)
      if (activeRef.current === form.sessionID) {
        setForms((prev) => (prev.some((x) => x.id === form.id) ? prev : [form, ...prev]))
      }
    }
  }, [])

  const visible = useMemo(() => messages.filter((m) => m.type === "user" || m.type === "assistant"), [messages])
  const groups = useMemo(() => groupMessages(visible), [visible])
  const lastAssistant = useMemo(() => {
    for (let i = visible.length - 1; i >= 0; i--) {
      if (visible[i].type === "assistant") return visible[i]
    }
    return undefined
  }, [visible])
  const lastUserId = useMemo(() => {
    for (let i = visible.length - 1; i >= 0; i--) {
      if (visible[i].type === "user") return visible[i].id
    }
    return null
  }, [visible])
  const lastAssistantGroupIndex = useMemo(() => {
    for (let i = groups.length - 1; i >= 0; i--) {
      if (groups[i].kind === "assistant") return i
    }
    return -1
  }, [groups])
  const showTyping = busy && (!lastAssistant || Boolean(lastAssistant.time?.completed))
  // برچسب وضعیت برای این‌که کاربر همیشه بداند مدل در حال فکر کردن، اجرای ابزار
  // یا نوشتن است؛ حتی وقتی هیچ متن تازه‌ای در پیام دیده نمی‌شود.
  const runStatus = useMemo(() => {
    if (!busy) return ""
    if (retry) return t("Reconnecting to the provider…")
    // A completed message from the previous run should not produce a
    // "writing" status; until a fresh message opens, the generic status is right.
    const content = lastAssistant && !lastAssistant.time?.completed ? (lastAssistant.content ?? []) : []
    if (content.some((p) => p.type === "tool" && p.state?.status === "running")) return t("Running a tool…")
    if (content.some((p) => p.type === "text" && p.text?.trim())) return t("Writing the response…")
    if (content.some((p) => p.type === "reasoning" && p.text?.trim())) return t("Thinking…")
    return t("Model is working…")
  }, [busy, retry, lastAssistant, t])
  const editBlockedTitle = edit
    ? t("This edit is open")
    : busy
      ? t("Wait for the current response to finish")
      : perms.length > 0 || forms.length > 0
        ? t("Answer pending requests first")
        : t("Edit the last message")

  const currentModel = models.find((m) => m.providerID === model?.providerID && m.id === model?.id)
  const modelLabel = `${currentModel?.name ?? model?.id ?? t("Choose a model")}${model?.variant ? ` · ${model.variant}` : ""}`
  const agentLabel = agents.find((a) => a.id === agent)?.name ?? (agent ?? t("Default agent"))
  const folderLabel = folder(active?.location?.directory) || folder(workdir) || folder(config?.directory)

  // نشان کوچک وضعیت اتصال روی دکمهٔ رله‌ها در پایین نوار کناری.
  const relayBadge = useMemo(() => {
    if (!connected) return { text: t("Disconnected"), tone: "off" as const }
    const enabledRelays = (relayState?.relays ?? []).filter((r) => r.enabled !== false)
    const nowTs = Date.now()
    const healthy = enabledRelays.filter(
      (r) =>
        r.status !== "unreachable" &&
        r.status !== "auth_error" &&
        (r.cooldownUntil || 0) <= nowTs &&
        (r.exhaustedUntil || 0) <= nowTs,
    )
    const tunnelRunning = relayState?.psiphon?.config.enabled ? relayState.psiphon.running : 0
    const tunnelLive = relayState?.psiphon?.config.enabled ? relayState.psiphon.live : 0
    if (relayState?.lastRouteInfo?.blocked) {
      return { text: "429", tone: "blocked" as const }
    }
    if (relayState?.enabled && (enabledRelays.length > 0 || tunnelRunning > 0)) {
      if (healthy.length > 0 || tunnelLive > 0) return { text: t("Active"), tone: "relay" as const }
      if (tunnelRunning > 0) return { text: t("Connecting…"), tone: "direct" as const }
      return { text: t("Relay blocked"), tone: "blocked" as const }
    }
    return { text: t("Direct connection"), tone: "direct" as const }
  }, [connected, relayState, t])

  const openUpdate = useCallback(() => {
    void checkUpdate(true)
    setUpdateOpen(true)
  }, [checkUpdate])
  const openSettings = useCallback(() => setSettingsOpen(true), [])
  const toggleRelays = useCallback(() => {
    setMenu(false)
    setPage((p) => (p === "relays" ? "chat" : "relays"))
  }, [])
  const openRelaysPage = useCallback(() => setPage("relays"), [])
  const refreshRelay = useCallback(() => {
    void refreshRelayState()
  }, [refreshRelayState])
  const closePicker = useCallback(() => setPickerOpen(false), [])
  const closeAgent = useCallback(() => setAgentOpen(false), [])
  const backToChat = useCallback(() => setPage("chat"), [])
  const relaysChanged = useCallback(() => {
    void refreshModels()
    void refreshRelayState()
  }, [refreshModels, refreshRelayState])
  const closeSettings = useCallback(() => setSettingsOpen(false), [])
  const settingsChanged = useCallback(() => {
    void refreshModels()
    void refreshAgents()
    void refreshSessions()
    void checkUpdate(true)
  }, [refreshModels, refreshAgents, refreshSessions, checkUpdate])
  const closeUpdate = useCallback(() => setUpdateOpen(false), [])
  const updateDone = useCallback(() => {
    setUpdateAvailable(null)
    void checkUpdate(true)
  }, [checkUpdate])
  const handleSlashPick = useCallback(
    (id: string) => {
      void runSlash(id)
    },
    [runSlash],
  )

  const exitApp = useCallback(async () => {
    if (exiting) return
    setExiting(true)
    setError(null)
    try {
      const res = await fetch("/app/exit", {
        method: "POST",
        headers: { "x-opencode-chat": "1" },
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setExited(true)
    } catch (e: any) {
      // If the server is already gone there is nothing left to stop.
      let alive = true
      try {
        await fetch("/__ping", { signal: AbortSignal.timeout(1200) })
      } catch {
        alive = false
      }
      if (alive) {
        setExiting(false)
        setError(t("Could not stop the app: {error}", { error: e.message }))
      } else {
        setExited(true)
      }
    }
  }, [exiting, t])

  const registerComposerImage = useCallback((add: (image: Attachment) => void) => {
    composerAddImage.current = add
  }, [])

  const openImageEditor = useCallback((src: string, name?: string) => {
    setEditingMessageImage({ src, name })
  }, [])

  const imageEditorValue = useMemo(() => ({ openImage: openImageEditor }), [openImageEditor])

  const saveMessageImage = useCallback(
    (image: Attachment) => {
      const add = composerAddImage.current
      if (!add) {
        setError(t("The composer is not ready; open a conversation and try again."))
        setEditingMessageImage(null)
        return
      }
      add(image)
      setEditingMessageImage(null)
      setNotice(t("Edited image added to the message"))
    },
    [t],
  )

  useEffect(() => {
    if (!exited) return
    // Allowed only for tabs/windows opened by a script; the overlay stays as
    // the fallback when the browser blocks it.
    const timer = window.setTimeout(() => {
      try {
        window.close()
      } catch {}
    }, 700)
    return () => window.clearTimeout(timer)
  }, [exited])

  if (exited) {
    return (
      <div className="exit-screen" role="status" aria-live="polite">
        <div className="exit-card">
          <div className="exit-mark">
            <Owl size={38} />
          </div>
          <h1>{t("OpenCode Chat has stopped")}</h1>
          <p>{t("The server and the OpenCode engine are closed. You can close this tab.")}</p>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              try {
                window.close()
              } catch {}
            }}
          >
            {t("Close tab")}
          </button>
        </div>
      </div>
    )
  }

  return (
    <ImageEditorProvider value={imageEditorValue}>
    <div className={`app ${menu ? "menu-open" : ""}`} data-session={activeId ?? ""}>
      <Sidebar
        sessions={sessions}
        activeId={activeId}
        activePage={page}
        relayBadge={relayBadge}
        connected={connected}
        version={config?.version}
        workdir={workdir || config?.directory || ""}
        projects={projects}
        onOpenProjects={() => setProjectsOpen(true)}
        onSelect={select}
        onNew={createSession}
        onRename={renameSession}
        onDelete={deleteSession}
        updateAvailable={updateAvailable}
        onUpdate={openUpdate}
        onSettings={openSettings}
        onOpenRelays={toggleRelays}
        onExit={() => void exitApp()}
        exiting={exiting}
      />

      {page === "relays" ? (
        <main className="chat relays-main-view">
          <Suspense fallback={<div className="lazy-fallback">{t("Loading relays…")}</div>}>
            <Relays fullPage onBack={backToChat} onChanged={relaysChanged} />
          </Suspense>
        </main>
      ) : (
      <main className="chat">
        <header className="chat-head">
          <button type="button" className="hamburger" onClick={() => setMenu((v) => !v)} aria-label={t("All conversations")}>
            ☰
          </button>
          <div className="chat-title">
            <h1>{active?.title || t("New conversation")}</h1>
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
                  title={t("Choose model")}
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
                    onClose={closePicker}
                  />
                )}
              </div>
              {agents.filter((a) => a.mode !== "subagent" && !a.hidden).length > 0 && (
                <div className="model-anchor">
                  <button
                    type="button"
                    className={`chip agent chip-btn ${agentOpen ? "open" : ""}`}
                    onClick={() => setAgentOpen((v) => !v)}
                    title={t("Choose agent")}
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
                      onClose={closeAgent}
                    />
                  )}
                </div>
              )}
              {perms.length > 0 && <span className="chip warn">{t("{n} waiting for approval", { n: num(perms.length) })}</span>}
              {active && (
                <UsageChip messages={messages} models={models} sessionCost={active.cost} sessionTokens={active.tokens} />
              )}
            </div>
          </div>
          <div className="chat-head-right">
            <ConnectionStatusChip
              state={relayState}
              connected={connected}
              onRefresh={refreshRelay}
              onOpenRelays={openRelaysPage}
            />
          </div>
        </header>

        <div className="thread" ref={scroller}>
          {visible.length > 0 && hasMore && (
            <div className="load-older-wrap" key="load-older">
              <button type="button" className="load-older" onClick={loadOlder} disabled={loadingOlder}>
                {loadingOlder ? t("Loading…") : t("Load older messages")}
              </button>
            </div>
          )}

          {visible.length > 0 && <div className="thread-filler" key="filler" aria-hidden />}

          {visible.length === 0 && (
            <div className="welcome" key="welcome">
              <div className="welcome-mark">
                <Owl size={34} />
              </div>
              <h2>{t("Where should we start?")}</h2>
              <p>{t("The same OpenCode engine, now with a proper layout.")}</p>
              <div className="suggestions">
                {SUGGESTIONS.map((s) => (
                  <button key={s.text} type="button" className="starter-card" onClick={() => send(t(s.text))}>
                    <span className="starter-icon" aria-hidden>
                      {s.icon}
                    </span>
                    <span className="starter-body">
                      <span className="starter-title">{t(s.title)}</span>
                      <span className="starter-hint">{t(s.hint)}</span>
                    </span>
                    <span className="starter-arrow" aria-hidden>
                      ↰
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {groups.map((g, gi) =>
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
                        aria-label={t("Edit the last message")}
                        onClick={() => beginEdit(g.message)}
                      >
                        <span aria-hidden>✎</span> {t("Edit")}
                      </button>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <AssistantGroup
                key={g.messages[0].id}
                messages={g.messages}
                live={
                  busy &&
                  gi === lastAssistantGroupIndex &&
                  !g.messages[g.messages.length - 1]?.time?.completed
                }
              />
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

          <div ref={bottomMark} className="thread-end" aria-hidden />
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

        <QueuedPrompts
          items={queuedPrompts}
          onSendNow={(item) => void sendQueuedNow(item)}
          onCancel={(item) => void cancelQueued(item)}
        />

        <Composer
          busy={busy}
          status={runStatus}
          disabled={!config || Boolean(edit)}
          onSend={send}
          onStop={stop}
          placeholder={edit ? t("Editing last message…") : t("Write your message…")}
          slashItems={slashItems}
          onSlashPick={handleSlashPick}
          workdir={active?.location?.directory || workdir || config?.directory || ""}
          permission={permission}
          onPermissionChange={applyPermission}
          permissionBusy={permissionBusy}
          registerAddImage={registerComposerImage}
        />
      </main>
      )}

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

      <Projects
        open={projectsOpen}
        workdir={workdir || config?.directory || ""}
        projects={projects}
        onClose={() => setProjectsOpen(false)}
        onAdd={addProjects}
        onRemove={removeProject}
        onSelect={selectProject}
      />

      {settingsOpen && (
        <Suspense fallback={<div className="lazy-fallback">{t("Loading settings…")}</div>}>
          <Settings onClose={closeSettings} onChanged={settingsChanged} />
        </Suspense>
      )}

      {updateOpen && (
        <div className="settings-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) closeUpdate() }}>
          <Suspense fallback={<div className="lazy-fallback">{t("Loading updateâ?▌")}</div>}>
            <UpdatePanel
              version={config?.version}
              available={updateAvailable}
              check={updateCheck}
              checking={checkingUpdate}
              onCheck={() => void checkUpdate(true)}
              onClose={closeUpdate}
              onDone={updateDone}
            />
          </Suspense>
        </div>
      )}

      {editingMessageImage && (
        <ImageEditor
          src={editingMessageImage.src}
          name={editingMessageImage.name}
          onClose={() => setEditingMessageImage(null)}
          onSave={saveMessageImage}
        />
      )}
    </div>
    </ImageEditorProvider>
  )
}
