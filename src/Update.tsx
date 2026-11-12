import { useRef, useState } from "react"
import type { UpdateCheck } from "./types"

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
  const [running, setRunning] = useState(false)
  const [output, setOutput] = useState<string[]>([])
  const [restartMsg, setRestartMsg] = useState<string | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const current = (check?.current && check.current !== "?" ? check.current : version) ?? "?"
  const latest = check?.latest ?? available ?? null
  const hasUpdate = Boolean(available || check?.available)
  const upToDate = Boolean(check?.latest && check.available === false && !check.error)
  const status = checking
    ? "در حال بررسی…"
    : check?.error
      ? `بررسی ناموفق: ${check.error}`
      : check?.available
        ? "نسخهٔ جدید در دسترس است"
        : upToDate
          ? "هسته به‌روز است"
          : "وضعیت نامشخص"

  const install = async () => {
    setRunning(true)
    setOutput(["در حال به‌روزرسانی موتور…"])
    try {
      const res = await fetch("/app/update/install", {
        method: "POST",
        headers: { "x-opencode-chat": "1" },
      })
      const reader = res.body?.getReader()
      if (!reader) throw new Error("بدنه‌ای در جریان نیست")
      const dec = new TextDecoder()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = dec.decode(value, { stream: true })
        setOutput((prev) => [...prev.slice(-160), chunk])
        const el = boxRef.current
        if (el) el.scrollTop = el.scrollHeight
      }
      setOutput((prev) => [...prev, "پایان. اگر نسخه‌ی تازه نصب شد، موتور را ری‌استارت کن."])
      setRestartMsg("تغییر نسخه پس از ری‌استارت سرویس اعمال می‌شود.")
      onDone()
    } catch (e: any) {
      setOutput((prev) => [...prev, `خطا: ${e.message}`])
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="update-pop" role="dialog" aria-label="به‌روزرسانی موتور">
      <div className="update-head">
        <strong>به‌روزرسانی موتور OpenCode</strong>
        <button type="button" className="upd-close" onClick={onClose} aria-label="بستن">×</button>
      </div>
      <div className="update-rows">
        <div className="update-row">
          <span>نسخه‌ی فعلی:</span>
          <code dir="ltr">v{current}</code>
        </div>
        <div className="update-row">
          <span>جدیدترین:</span>
          {latest ? (
            <code dir="ltr" className={check?.available ? "upd-hot" : ""}>v{latest}</code>
          ) : (
            <span className="settings-muted">{checking ? "در حال بررسی…" : "نامشخص"}</span>
          )}
        </div>
        <div className="update-row">
          <span>وضعیت:</span>
          <span className={check?.available ? "upd-hot" : check?.error ? "upd-err" : "settings-muted"}>{status}</span>
        </div>
      </div>

      <div className="update-actions">
        <button type="button" className="update-btn" onClick={onCheck} disabled={checking || running}>
          {checking ? "در حال بررسی…" : "بررسی مجدد"}
        </button>
        {hasUpdate && !running && (
          <button type="button" className="update-btn" onClick={() => void install()} disabled={checking}>
            به‌روزرسانی کن
          </button>
        )}
        {!hasUpdate && (
          <button type="button" className="update-btn" disabled={running || checking} onClick={() => void install()} title="اجرای opencode upgrade — اگر نسخه‌ی تازه‌ای باشد نصب می‌شود">
            بررسی و نصب (opencode upgrade)
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
          <button type="button" onClick={() => { void restartService(); setRestartMsg("در حال ری‌استارت سرویس… اتصال بعد از بالا آمدن خودش برقرار می‌شود.") }}>
            ری‌استارت سرویس
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
