import { useRef, useState } from "react"
import type { UpdateCheck } from "../lib/types"
import { useI18n } from "../lib/i18n"

type Props = {
  version?: string
  available?: string | null
  check?: UpdateCheck | null
  checking?: boolean
  onCheck: () => void
  onClose: () => void
  onDone: () => void // برای ریست حالت آپدیت بعد از نصب
}

export function UpdatePanel({ version, available, check, checking = false, onCheck, onClose, onDone }: Props) {
  const { t } = useI18n()
  const [running, setRunning] = useState(false)
  const [output, setOutput] = useState<string[]>([])
  const [restartMsg, setRestartMsg] = useState<string | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const current = (check?.current && check.current !== "?" ? check.current : version) ?? "?"
  const latest = check?.latest ?? available ?? null
  const hasUpdate = Boolean(available || check?.available)
  const upToDate = Boolean(check?.latest && check.available === false && !check.error)
  const status = checking
    ? t("Checking…")
    : check?.error
      ? t("Check failed: {error}", { error: check.error })
      : check?.available
        ? t("A new version is available")
        : upToDate
          ? t("Core is up to date")
          : t("Status unknown")

  const install = async () => {
    setRunning(true)
    setOutput([t("Updating engine…")])
    try {
      const res = await fetch("/app/update/install", {
        method: "POST",
        headers: { "x-opencode-chat": "1" },
      })
      const reader = res.body?.getReader()
      if (!reader) throw new Error(t("No stream body"))
      const dec = new TextDecoder()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = dec.decode(value, { stream: true })
        setOutput((prev) => [...prev.slice(-160), chunk])
        const el = boxRef.current
        if (el) el.scrollTop = el.scrollHeight
      }
      setOutput((prev) => [...prev, t("Done. If a new version was installed, restart the engine.")])
      setRestartMsg(t("Version changes take effect after restarting the service."))
      onDone()
    } catch (e: any) {
      setOutput((prev) => [...prev, t("Error: {error}", { error: e.message })])
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="update-pop" role="dialog" aria-label={t("OpenCode engine update")}>
      <div className="update-head">
        <strong>{t("OpenCode engine update")}</strong>
        <button type="button" className="upd-close" onClick={onClose} aria-label={t("Close")}>×</button>
      </div>
      <div className="update-rows">
        <div className="update-row">
          <span>{t("Current version:")}</span>
          <code dir="ltr">v{current}</code>
        </div>
        <div className="update-row">
          <span>{t("Latest:")}</span>
          {latest ? (
            <code dir="ltr" className={check?.available ? "upd-hot" : ""}>v{latest}</code>
          ) : (
            <span className="settings-muted">{checking ? t("Checking…") : t("Unknown")}</span>
          )}
        </div>
        <div className="update-row">
          <span>{t("Status:")}</span>
          <span className={check?.available ? "upd-hot" : check?.error ? "upd-err" : "settings-muted"}>{status}</span>
        </div>
      </div>

      <div className="update-actions">
        <button type="button" className="update-btn" onClick={onCheck} disabled={checking || running}>
          {checking ? t("Checking…") : t("Check again")}
        </button>
        {hasUpdate && !running && (
          <button type="button" className="update-btn" onClick={() => void install()} disabled={checking}>
            {t("Update now")}
          </button>
        )}
        {!hasUpdate && (
          <button type="button" className="update-btn" disabled={running || checking} onClick={() => void install()} title={t("Run opencode upgrade — installs if a newer version exists")}>
            {t("Check and install (opencode upgrade)")}
          </button>
        )}
      </div>

      {output.length > 0 && (
        <div className="update-log" ref={boxRef}>
          {output.join("").split("\n").map((line, i) => (
            <div key={i} dir="ltr">{line || "\u00a0"}</div>
          ))}
        </div>
      )}

      {restartMsg && (
        <div className="update-restart">
          {restartMsg}
          <button type="button" onClick={() => { void restartService(); setRestartMsg(t("Restarting service… Connection reconnects automatically when it comes back.")) }}>
            {t("Restart service")}
          </button>
        </div>
      )}
    </div>
  )
}

function restartService() {
  fetch("/app/service/restart", {
    method: "POST",
    headers: { "x-opencode-chat": "1" },
  }).catch(() => {})
}
