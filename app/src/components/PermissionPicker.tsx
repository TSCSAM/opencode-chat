import { useEffect, useRef, useState } from "react"
import { useI18n } from "../lib/i18n"
import { PERMISSION_MODES, type PermissionMode } from "../lib/permissions"

function ModeIcon({ mode }: { mode: PermissionMode }) {
  const common = {
    width: 15,
    height: 15,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  }
  if (mode === "plan") {
    return (
      <svg {...common}>
        <path d="M4 5h16M4 12h10M4 19h7" />
        <path d="m17 15 3 3-3 3" />
      </svg>
    )
  }
  if (mode === "ask") {
    return (
      <svg {...common}>
        <path d="M8 11V6.5a1.5 1.5 0 0 1 3 0V11" />
        <path d="M11 10V5.5a1.5 1.5 0 0 1 3 0V10" />
        <path d="M14 10V7a1.5 1.5 0 0 1 3 0v7a6 6 0 0 1-6 6h-1a6 6 0 0 1-5.2-3l-2-3.4a1.6 1.6 0 0 1 2.7-1.7L8 14" />
      </svg>
    )
  }
  if (mode === "full") {
    return (
      <svg {...common}>
        <path d="M12 3 5 6v5c0 4.4 2.9 8.3 7 9.5 4.1-1.2 7-5.1 7-9.5V6z" />
        <path d="m9 12 2 2 4-4" />
      </svg>
    )
  }
  return (
    <svg {...common}>
      <path d="M12 3 5 6v5c0 4.4 2.9 8.3 7 9.5 4.1-1.2 7-5.1 7-9.5V6z" />
      <path d="M12 8v4M12 15.5v.5" />
    </svg>
  )
}

export function PermissionPicker({
  mode,
  busy = false,
  disabled = false,
  onChange,
}: {
  mode: PermissionMode
  busy?: boolean
  disabled?: boolean
  onChange: (mode: PermissionMode) => void
}) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  const current = PERMISSION_MODES.find((item) => item.id === mode) ?? PERMISSION_MODES[2]

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false)
    }
    document.addEventListener("mousedown", onDown)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onDown)
      document.removeEventListener("keydown", onKey)
    }
  }, [open])

  return (
    <div className="permission-wrap" ref={wrap}>
      <button
        type="button"
        className={`permission-btn tone-${current.tone} ${open ? "open" : ""}`}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        title={t("Permission mode")}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="permission-btn-icon" aria-hidden>
          <ModeIcon mode={current.id} />
        </span>
        <span className="permission-btn-label">{t(current.title)}</span>
        {busy ? <span className="permission-spinner" aria-hidden /> : <span className="permission-caret" aria-hidden>▴</span>}
      </button>

      {open && (
        <div className="permission-menu" role="listbox" aria-label={t("Permission mode")}>
          <div className="permission-menu-head">{t("Permission mode")}</div>
          {PERMISSION_MODES.map((item) => (
            <button
              key={item.id}
              type="button"
              role="option"
              aria-selected={item.id === mode}
              className={`permission-option ${item.id === mode ? "on" : ""}`}
              disabled={busy}
              onClick={() => {
                setOpen(false)
                if (item.id !== mode) onChange(item.id)
              }}
            >
              <span className={`permission-option-icon tone-${item.tone}`} aria-hidden>
                <ModeIcon mode={item.id} />
              </span>
              <span className="permission-option-copy">
                <span className="permission-option-title">{t(item.title)}</span>
                <span className="permission-option-desc">{t(item.description)}</span>
              </span>
              {item.id === mode && <span className="permission-check" aria-hidden>✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
