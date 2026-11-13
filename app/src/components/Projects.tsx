import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { appGet } from "../lib/api"
import { useI18n } from "../lib/i18n"

type FolderEntry = { name: string; path: string }
type FolderPlace = { name: string; path: string }
type FolderListing = {
  path: string
  parent: string | null
  entries: FolderEntry[]
  drives: FolderEntry[]
  places: FolderPlace[]
  home?: string
}

export type AddProjectsResult = {
  added: string[]
  failed: { path: string; error: string }[]
}

type Props = {
  open: boolean
  workdir: string
  projects: string[]
  onClose: () => void
  onAdd: (paths: string[]) => Promise<AddProjectsResult>
  onRemove: (path: string) => void
  onSelect: (path: string) => void | Promise<void>
}

function folderName(directory: string) {
  return directory.split(/[\\/]/).filter(Boolean).pop() ?? directory
}

function samePath(a: string, b: string) {
  return a.replace(/[\\/]+$/, "").toLowerCase() === b.replace(/[\\/]+$/, "").toLowerCase()
}

function FolderIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h8.5A1.5 1.5 0 0 1 21 9.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z" />
    </svg>
  )
}

function ChevronIcon({ dir = "end" }: { dir?: "start" | "end" }) {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ transform: dir === "start" ? "rotate(180deg)" : undefined }}
      aria-hidden
    >
      <path d="m9 18 6-6-6-6" />
    </svg>
  )
}

function crumbsFor(target: string) {
  if (!target) return []
  const windows = /^[A-Za-z]:[\\/]/.test(target) || target.startsWith("\\\\")
  const parts = target.split(/[\\/]+/).filter(Boolean)
  if (windows) {
    const root = /^[A-Za-z]:/.test(parts[0] ?? "") ? `${parts[0]}\\` : "\\\\"
    const rows = [{ label: root, path: root }]
    let current = root
    for (const part of parts.slice(1)) {
      current = current.endsWith("\\") ? current + part : `${current}\\${part}`
      rows.push({ label: part, path: current })
    }
    return rows
  }
  const rows = [{ label: "/", path: "/" }]
  let current = ""
  for (const part of parts) {
    current += `/${part}`
    rows.push({ label: part, path: current })
  }
  return rows
}

export function Projects({ open, workdir, projects, onClose, onAdd, onRemove, onSelect }: Props) {
  const { t } = useI18n()
  const [view, setView] = useState<"list" | "picker">("list")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setView("list")
    setError(null)
    setNotice(null)
    setBusy(false)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return
      if (view === "picker") {
        setView("list")
        setError(null)
      } else {
        onClose()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, view, onClose])

  if (!open) return null

  const add = async (paths: string[]) => {
    if (paths.length === 0) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = await onAdd(paths)
      if (result.failed.length > 0) {
        setError(
          result.failed
            .map((row) => `${row.path}: ${row.error}`)
            .join("\n"),
        )
      }
      if (result.added.length > 0) {
        setNotice(
          t(result.added.length === 1 ? "1 folder added" : "{n} folders added", {
            n: String(result.added.length),
          }),
        )
        setView("list")
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose()
      }}
    >
      <div className="modal projects-modal" role="dialog" aria-modal="true" aria-label={t("Projects")}>
        <header className="modal-header">
          <div className="projects-heading">
            {view === "picker" && (
              <button type="button" className="icon-btn projects-back" onClick={() => setView("list")} title={t("Back")} aria-label={t("Back")}>
                <ChevronIcon dir="start" />
              </button>
            )}
            <h2>{view === "picker" ? t("Add project folders") : t("Projects")}</h2>
          </div>
          <button type="button" className="icon-btn" disabled={busy} onClick={onClose} title={t("Close")} aria-label={t("Close")}>
            ✕
          </button>
        </header>

        <div className="modal-body projects-modal-body">
          {view === "list" ? (
            <>
              <p className="projects-intro">
                {t("Each folder is a separate project. Pick one to switch chats, or add several folders at once.")}
              </p>
              {error && <div className="projects-error" role="alert">{error}</div>}
              {notice && <div className="projects-notice" role="status">{notice}</div>}
              {projects.length === 0 ? (
                <div className="projects-empty">
                  <FolderIcon size={26} />
                  <span>{t("No project folders yet")}</span>
                  <span className="projects-empty-hint">{t("Add one or more folders to get started.")}</span>
                </div>
              ) : (
                <div className="projects-list" role="list">
                  {projects.map((project) => {
                    const active = samePath(project, workdir)
                    return (
                      <div
                        key={project}
                        className={`project-row ${active ? "active" : ""}`}
                        role="listitem"
                      >
                        <button
                          type="button"
                          className="project-row-main"
                          disabled={busy}
                          onClick={() => void onSelect(project)}
                          title={t("Switch to this project")}
                        >
                          <span className="project-row-icon" aria-hidden>
                            <FolderIcon size={18} />
                          </span>
                          <span className="project-row-copy">
                            <span className="project-row-name">
                              {folderName(project)}
                              {active && <span className="project-badge">{t("Active")}</span>}
                            </span>
                            <span className="project-row-path" dir="ltr">{project}</span>
                          </span>
                        </button>
                        <button
                          type="button"
                          className="project-remove"
                          disabled={busy}
                          onClick={() => onRemove(project)}
                          title={t("Remove from projects")}
                          aria-label={t("Remove {name} from projects", { name: folderName(project) })}
                        >
                          ✕
                        </button>
                      </div>
                    )
                  })}
                </div>
              )}
            </>
          ) : (
            <FolderPicker
              initialPath={workdir}
              existing={projects}
              busy={busy}
              error={error}
              onCancel={() => setView("list")}
              onAdd={add}
            />
          )}
        </div>

        {view === "list" && (
          <footer className="modal-footer projects-footer">
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => setView("picker")}>
              <span aria-hidden>＋</span> {t("Add folders")}
            </button>
          </footer>
        )}
      </div>
    </div>
  )
}

function FolderPicker({
  initialPath,
  existing,
  busy,
  error,
  onCancel,
  onAdd,
}: {
  initialPath: string
  existing: string[]
  busy: boolean
  error: string | null
  onCancel: () => void
  onAdd: (paths: string[]) => Promise<void>
}) {
  const { t } = useI18n()
  const [path, setPath] = useState(initialPath)
  const [listing, setListing] = useState<FolderListing | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [manual, setManual] = useState("")
  const requestId = useRef(0)

  const existingKeys = useMemo(() => new Set(existing.map((p) => p.replace(/[\\/]+$/, "").toLowerCase())), [existing])

  const load = useCallback(async (target: string) => {
    const id = ++requestId.current
    setLoading(true)
    setLoadError(null)
    try {
      const query = target ? `?path=${encodeURIComponent(target)}` : ""
      const data = await appGet<FolderListing & { ok?: boolean }>(`/app/folders${query}`)
      if (id !== requestId.current) return
      setListing(data)
      setPath(data.path)
    } catch (e: any) {
      if (id !== requestId.current) return
      setLoadError(e?.message ?? t("That folder cannot be opened"))
    } finally {
      if (id === requestId.current) setLoading(false)
    }
  }, [t])

  useEffect(() => {
    void load(initialPath)
  }, [initialPath, load])

  const toggle = (folder: string) => {
    if (existingKeys.has(folder.replace(/[\\/]+$/, "").toLowerCase())) return
    setSelected((prev) =>
      prev.some((p) => samePath(p, folder)) ? prev.filter((p) => !samePath(p, folder)) : [...prev, folder],
    )
  }

  const addManual = async () => {
    const rows = manual
      .split(/\r?\n/)
      .map((line) => line.trim().replace(/^["']+|["']+$/g, ""))
      .filter(Boolean)
    if (rows.length === 0) return
    await onAdd(rows)
    setManual("")
  }

  const crumbs = crumbsFor(path)

  return (
    <div className="folder-picker">
      <div className="folder-toolbar">
        <button
          type="button"
          className="folder-nav-btn"
          disabled={!listing?.parent || loading}
          onClick={() => listing?.parent && void load(listing.parent)}
          title={t("Up one level")}
          aria-label={t("Up one level")}
        >
          ↑
        </button>
        <form
          className="folder-path-form"
          onSubmit={(e) => {
            e.preventDefault()
            void load(path)
          }}
        >
          <input
            className="folder-path"
            dir="ltr"
            value={path}
            spellCheck={false}
            onChange={(e) => setPath(e.target.value)}
            aria-label={t("Folder path")}
          />
        </form>
        <button type="button" className="btn btn-sm" disabled={loading} onClick={() => void load(path)}>
          {t("Go")}
        </button>
      </div>

      <div className="folder-crumbs" aria-label={t("Folder path")}>
        {crumbs.map((crumb, i) => (
          <button
            key={`${crumb.path}-${i}`}
            type="button"
            className="folder-crumb"
            dir="ltr"
            onClick={() => void load(crumb.path)}
            title={crumb.path}
          >
            {crumb.label}
          </button>
        ))}
      </div>

      {(listing?.drives.length ?? 0) > 0 && (
        <div className="folder-places">
          {listing!.drives.map((drive) => (
            <button key={drive.path} type="button" className="folder-place drive" onClick={() => void load(drive.path)}>
              {drive.name}
            </button>
          ))}
        </div>
      )}

      {(listing?.places.length ?? 0) > 0 && (
        <div className="folder-places">
          {listing!.places.map((place) => (
            <button key={place.path} type="button" className="folder-place" onClick={() => void load(place.path)} title={place.path}>
              {t(place.name)}
            </button>
          ))}
        </div>
      )}

      {(loadError || error) && (
        <div className="projects-error" role="alert">
          {(loadError || error || "").split("\n").map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      )}

      <div className="folder-list" role="listbox" aria-multiselectable="true" aria-label={t("Folders")}>
        {loading ? (
          <div className="folder-empty">{t("Loading…")}</div>
        ) : (listing?.entries.length ?? 0) === 0 ? (
          <div className="folder-empty">{t("No subfolders here")}</div>
        ) : (
          listing!.entries.map((entry) => {
            const added = existingKeys.has(entry.path.replace(/[\\/]+$/, "").toLowerCase())
            const on = selected.some((p) => samePath(p, entry.path))
            return (
              <div
                key={entry.path}
                className={`folder-row ${on ? "selected" : ""} ${added ? "added" : ""}`}
                role="option"
                aria-selected={on}
                onClick={() => !added && toggle(entry.path)}
              >
                <input
                  type="checkbox"
                  checked={on || added}
                  disabled={added}
                  onClick={(e) => e.stopPropagation()}
                  onChange={() => toggle(entry.path)}
                  aria-label={entry.name}
                />
                <span className="folder-row-icon" aria-hidden>
                  <FolderIcon size={16} />
                </span>
                <span className="folder-row-name" dir="auto">{entry.name}</span>
                {added && <span className="folder-added">{t("Added")}</span>}
                <button
                  type="button"
                  className="folder-row-open"
                  onClick={(e) => {
                    e.stopPropagation()
                    void load(entry.path)
                  }}
                  title={t("Open folder")}
                  aria-label={t("Open {name}", { name: entry.name })}
                >
                  <ChevronIcon />
                </button>
              </div>
            )
          })
        )}
      </div>

      <div className="folder-manual">
        <label htmlFor="folder-manual-input">{t("Or paste folder paths, one per line")}</label>
        <textarea
          id="folder-manual-input"
          dir="ltr"
          rows={2}
          value={manual}
          placeholder={"C:\\Projects\\app-one\nC:\\Projects\\app-two"}
          onChange={(e) => setManual(e.target.value)}
        />
        <button type="button" className="btn btn-sm" disabled={busy || !manual.trim()} onClick={() => void addManual()}>
          {t("Add these paths")}
        </button>
      </div>

      <div className="folder-actions">
        <span className="folder-selected-count">
          {selected.length > 0
            ? t(selected.length === 1 ? "1 folder selected" : "{n} folders selected", { n: String(selected.length) })
            : t("Select one or more folders above")}
        </span>
        <div className="folder-actions-buttons">
          <button type="button" className="btn" disabled={busy} onClick={onCancel}>
            {t("Cancel")}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || (!listing && selected.length === 0)}
            onClick={() => void onAdd(selected.length > 0 ? selected : path ? [path] : [])}
          >
            {selected.length > 0
              ? t(selected.length === 1 ? "Add 1 folder" : "Add {n} folders", { n: String(selected.length) })
              : t("Add this folder")}
          </button>
        </div>
      </div>
    </div>
  )
}
