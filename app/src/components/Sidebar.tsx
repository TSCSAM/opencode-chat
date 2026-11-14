import { memo, useRef, useState } from "react"
import type { SessionInfo } from "../lib/types"
import { Owl } from "./Owl"
import { useI18n } from "../lib/i18n"

function folder(directory?: string) {
  if (!directory) return ""
  return directory.split(/[\\/]/).filter(Boolean).pop() ?? directory
}

function PowerIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M12 3v9" />
      <path d="M6.4 6.4a8 8 0 1 0 11.2 0" />
    </svg>
  )
}

type Props = {
  sessions: SessionInfo[]
  activeId: string | null
  activePage?: "chat" | "relays"
  relayBadge?: {
    text: string
    tone: "relay" | "direct" | "blocked" | "off"
  }
  connected: boolean
  version?: string
  workdir: string
  projects: string[]
  updateAvailable?: string | null
  onUpdate: () => void
  onSettings: () => void
  onOpenRelays?: () => void
  onOpenProjects: () => void
  onExit?: () => void
  exiting?: boolean
  onSelect: (id: string) => void
  onNew: () => void
  onRename: (id: string, title: string) => void | Promise<void>
  onDelete: (id: string) => void | Promise<void>
}

export const Sidebar = memo(function Sidebar({
  sessions,
  activeId,
  activePage = "chat",
  relayBadge,
  connected,
  version,
  workdir,
  projects,
  updateAvailable,
  onUpdate,
  onSettings,
  onOpenRelays,
  onOpenProjects,
  onExit,
  exiting = false,
  onSelect,
  onNew,
  onRename,
  onDelete,
}: Props) {
  const { t, relative, toggleLang, lang } = useI18n()
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
            <i /> {connected ? t("Connected") : t("Disconnected")}
          </span>
        </div>
        {onExit && (
          <button
            type="button"
            className="brand-exit"
            onClick={onExit}
            disabled={exiting}
            title={t("Stop the app and the OpenCode engine")}
            aria-label={t("Exit")}
          >
            <span className="brand-exit-icon" aria-hidden>
              <PowerIcon />
            </span>
            <span className="brand-exit-text">{exiting ? t("Closing…") : t("Exit")}</span>
          </button>
        )}
      </div>

      <button type="button" className="new-chat" onClick={() => onNew()}>
        <span>+</span> {t("New chat")}
      </button>

      <div className="session-list">
        {sessions.length === 0 ? (
          <div className="empty-list" key="empty">
            {t("No conversations yet")}
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
                    <span className="session-title">{s.title || t("Untitled")}</span>
                    <span className="session-meta">
                      <span>{folder(s.location?.directory)}</span>
                      <span>{relative(s.time?.updated ?? s.time?.created ?? Date.now())}</span>
                    </span>
                  </button>
                  <span className="session-actions">
                    <button
                      type="button"
                      className="s-icon"
                      title={t("Rename")}
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
                      title={confirming === s.id ? t("Click again to delete") : t("Delete")}
                      onClick={() => confirmDelete(s.id)}
                    >
                      {confirming === s.id ? t("Sure?") : "✕"}
                    </button>
                  </span>
                </>
              )}
            </div>
          ))
        )}
      </div>

      <div className="sidebar-foot">
        {onOpenRelays && (
          <button
            type="button"
            className={`sidebar-relays-btn ${activePage === "relays" ? "active" : ""}`}
            onClick={onOpenRelays}
          >
            <span className="sidebar-relays-icon">🛰️</span>
            <span className="sidebar-relays-label">{t("Cloud relays (IP rotation)")}</span>
            {relayBadge && (
              <span className={`sidebar-relays-badge tone-${relayBadge.tone}`}>
                {relayBadge.text}
              </span>
            )}
          </button>
        )}
        <button
          type="button"
          className="projects-btn"
          title={workdir || t("Choose a project folder")}
          onClick={onOpenProjects}
        >
          <span className="projects-icon" aria-hidden>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h8.5A1.5 1.5 0 0 1 21 9.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z" />
            </svg>
          </span>
          <span className="projects-text">
            <span className="projects-label">{t("Projects")}</span>
            <span className="projects-active" dir="auto">
              {folder(workdir) || t("Choose a project folder")}
            </span>
          </span>
          <span className="projects-count" title={t("{n} project folders", { n: String(projects.length) })}>
            {projects.length}
          </span>
          <span className="projects-chevron" aria-hidden>⌄</span>
        </button>
        <div className="foot-row">
          <button
            type="button"
            className={`foot-version ${updateAvailable ? "has-update" : ""}`}
            onClick={onUpdate}
            title={updateAvailable ? t("New version v{version} is available", { version: updateAvailable }) : t("Update engine")}
          >
            <span>{t("Engine v{version}", { version: version ?? "?" })}</span>
            {updateAvailable && <span className="upd-badge">{t("Update!")}</span>}
          </button>
          <div className="foot-actions">
            <span className="app-version" title={t("This web panel version")}>
              {t("Panel v{version}", { version: __APP_VERSION__ })}
            </span>
            <button
              type="button"
              className="foot-lang"
              onClick={toggleLang}
              title={t("Switch language")}
              aria-label={t("Switch language")}
            >
              {lang === "fa" ? "EN" : "فا"}
            </button>
            <button
              type="button"
              className="foot-settings"
              onClick={onSettings}
              title={t("OpenCode settings")}
              aria-label={t("OpenCode settings")}
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1.08 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.26.604.852.997 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </aside>
  )
})
