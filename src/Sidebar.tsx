import { useRef, useState } from "react"
import type { SessionInfo } from "./types"
import { Owl } from "./Owl"

const rtf = new Intl.RelativeTimeFormat("fa", { numeric: "auto" })

function ago(ts: number) {
  const diff = (ts - Date.now()) / 1000
  const abs = Math.abs(diff)
  if (abs < 60) return rtf.format(Math.round(diff), "second")
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute")
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour")
  return rtf.format(Math.round(diff / 86400), "day")
}

function folder(directory?: string) {
  if (!directory) return ""
  return directory.split(/[\\/]/).filter(Boolean).pop() ?? directory
}

type Props = {
  sessions: SessionInfo[]
  activeId: string | null
  connected: boolean
  version?: string
  workdir: string
  updateAvailable?: string | null
  onUpdate: () => void
  onWorkdir: (dir: string) => Promise<boolean>
  onSelect: (id: string) => void
  onNew: () => void
  onRename: (id: string, title: string) => void | Promise<void>
  onDelete: (id: string) => void | Promise<void>
}

export function Sidebar({ sessions, activeId, connected, version, workdir, updateAvailable, onUpdate, onWorkdir, onSelect, onNew, onRename, onDelete }: Props) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(workdir)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [titleDraft, setTitleDraft] = useState("")
  const [confirming, setConfirming] = useState<string | null>(null)
  const confirmTimer = useRef<number | null>(null)

  const confirmDelete = (id: string) => {
    if (confirming === id) {
      window.clearTimeout(confirmTimer.current ?? 0)
      setConfirming(null)
      void onDelete(id)
      return
    }
    setConfirming(id)
    if (confirmTimer.current) window.clearTimeout(confirmTimer.current)
    confirmTimer.current = window.setTimeout(() => setConfirming(null), 2600)
  }

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">
          <Owl size={22} />
        </div>
        <div className="brand-text">
          <strong>OpenCode Chat</strong>
          <span className={connected ? "online" : "offline"}>
            <i /> {connected ? "متصل" : "قطع ارتباط"}
          </span>
        </div>
      </div>

      <button type="button" className="new-chat" onClick={onNew}>
        <span>+</span> گفت‌وگوی جدید
      </button>

      <div className="session-list">
        {sessions.length === 0 ? (
          <div className="empty-list" key="empty">
            هنوز گفت‌وگویی نیست
          </div>
        ) : (
          sessions.map((s) => (
            <div key={s.id} className={`session ${s.id === activeId ? "active" : ""}`}>
              {renaming === s.id ? (
                <form
                  className="rename-form"
                  onSubmit={async (e) => {
                    e.preventDefault()
                    await onRename(s.id, titleDraft)
                    setRenaming(null)
                  }}
                >
                  <input
                    dir="auto"
                    autoFocus
                    value={titleDraft}
                    onChange={(e) => setTitleDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") setRenaming(null)
                    }}
                    onBlur={() => setRenaming(null)}
                  />
                </form>
              ) : (
                <>
                  <button type="button" className="session-main" onClick={() => onSelect(s.id)}>
                    <span className="session-title">{s.title || "بدون عنوان"}</span>
                    <span className="session-meta">
                      <span>{folder(s.location?.directory)}</span>
                      <span>{ago(s.time?.updated ?? s.time?.created ?? Date.now())}</span>
                    </span>
                  </button>
                  <span className="session-actions">
                    <button
                      type="button"
                      className="s-icon"
                      title="تغییر نام"
                      onClick={() => {
                        setTitleDraft(s.title || "")
                        setRenaming(s.id)
                      }}
                    >
                      ✎
                    </button>
                    <button
                      type="button"
                      className={`s-icon danger ${confirming === s.id ? "confirm" : ""}`}
                      title={confirming === s.id ? "برای حذف دوباره کلیک کن" : "حذف"}
                      onClick={() => confirmDelete(s.id)}
                    >
                      {confirming === s.id ? "مطمئنی؟" : "✕"}
                    </button>
                  </span>
                </>
              )}
            </div>
          ))
        )}
      </div>

      <div className="sidebar-foot">
        {editing ? (
          <form
            className="dir-form"
            onSubmit={async (e) => {
              e.preventDefault()
              const value = draft.trim()
              if (!value) return
              if (await onWorkdir(value)) setEditing(false)
            }}
          >
            <input
              dir="ltr"
              autoFocus
              value={draft}
              placeholder="C:\path\to\project"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setEditing(false)
              }}
            />
            <button type="submit">ثبت</button>
          </form>
        ) : (
          <button
            type="button"
            className="dir-btn"
            title={workdir}
            onClick={() => {
              setDraft(workdir)
              setEditing(true)
            }}
          >
            <span className="dir-icon">▸</span>
            <span className="dir-name" dir="auto">
              {folder(workdir) || "انتخاب پوشه"}
            </span>
            <span className="dir-edit">تغییر</span>
          </button>
        )}
        <div className="foot-row">
          <button
            type="button"
            className={`foot-version ${updateAvailable ? "has-update" : ""}`}
            onClick={onUpdate}
            title={updateAvailable ? `نسخه‌ی جدید v${updateAvailable} در دسترس است` : "به‌روزرسانی موتور"}
          >
            <span>موتور v{version ?? "?"}</span>
            {updateAvailable && <span className="upd-badge">آپدیت!</span>}
          </button>
          <span className="app-version" title="نسخه‌ی این پنل وب">
            پنل v{__APP_VERSION__}
          </span>
        </div>
      </div>
    </aside>
  )
}
