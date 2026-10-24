import { useMemo, useState } from "react"
import type { EngineForm, FormFieldShape } from "./types"

const EMPTY: Record<string, any> = {}

function fieldVisible(f: FormFieldShape, answers: Record<string, any>): boolean {
  if (f.hidden) return false
  const conds = f.when ?? []
  if (conds.length === 0) return true
  return conds.every((c) => (c.op === "eq" ? answers[c.key] === c.value : answers[c.key] !== c.value))
}

type Props = {
  form: EngineForm
  onReply: (form: EngineForm, answer: Record<string, any>) => void
  onCancel: (form: EngineForm) => void
}

export function QuestionCard({ form, onReply, onCancel }: Props) {
  const [answers, setAnswers] = useState<Record<string, any>>(EMPTY)
  const [customDraft, setCustomDraft] = useState<Record<string, string>>({})

  const visible = useMemo(() => form.fields.filter((f) => fieldVisible(f, answers)), [form.fields, answers])

  const setAnswer = (key: string, value: any) => {
    setAnswers((prev) => ({ ...prev, [key]: value }))
  }

  const submit = () => {
    const answer: Record<string, any> = {}
    for (const f of visible) {
      const customText = (customDraft[f.key] ?? "").trim()
      const picked = answers[f.key]
      if (customText !== "") {
        answer[f.key] = customText
        continue
      }
      if (f.required && (picked === undefined || picked === "")) {
        if (f.default !== undefined) answer[f.key] = f.default
      }
      if (picked !== undefined && picked !== "") answer[f.key] = picked
    }
    onReply(form, answer)
  }

  return (
    <div className="qcard" data-form={form.id}>
      <div className="qcard-head">
        <span className="qcard-badge">؟</span>
        <span>سؤال از کاربر</span>
      </div>

      {visible.map((f) => (
        <div key={f.key} className="qfield">
          <div className="qfield-title" dir="auto">
            {f.title ?? f.key}
            {f.required && <span className="qreq"> *</span>}
          </div>
          {f.description && (
            <div className="qfield-desc" dir="auto">
              {f.description}
            </div>
          )}

          {f.type === "multiselect" ? (
            <div className="qopts">
              {(f.options ?? []).map((o) => {
                const picked: string[] = answers[f.key] ?? []
                const on = picked.includes(o.value)
                return (
                  <button
                    key={o.value}
                    type="button"
                    className={`qopt ${on ? "on" : ""}`}
                    title={o.description}
                    onClick={() =>
                      setAnswer(f.key, on ? picked.filter((x) => x !== o.value) : [...picked, o.value])
                    }
                  >
                    <span className="qcheck">{on ? "☑" : "☐"}</span>
                    <span dir="auto">{o.label}</span>
                  </button>
                )
              })}
            </div>
          ) : (f.options ?? []).length > 0 ? (
            <div className="qopts">
              {(f.options ?? []).map((o) => (
                <button
                  key={o.value}
                  type="button"
                  className={`qopt ${answers[f.key] === o.value ? "on" : ""}`}
                  title={o.description}
                  onClick={() => setAnswer(f.key, o.value)}
                >
                  <span className="qcheck">{answers[f.key] === o.value ? "◉" : "○"}</span>
                  <span dir="auto">{o.label}</span>
                </button>
              ))}
            </div>
          ) : null}

          {f.custom ? (
            <input
              dir="auto"
              className="qcustom"
              placeholder="یا پاسخ دستی بنویس…"
              value={customDraft[f.key] ?? ""}
              onChange={(e) => setCustomDraft((prev) => ({ ...prev, [f.key]: e.target.value }))}
            />
          ) : null}

          {!f.options?.length && f.custom !== true && (f.type === "string" || f.type === undefined) && (
            <input
              dir="auto"
              className="qcustom"
              placeholder={f.placeholder ?? "پاسخ…"}
              value={answers[f.key] ?? ""}
              onChange={(e) => setAnswer(f.key, e.target.value)}
            />
          )}

          {f.type === "number" || f.type === "integer" ? (
            <input
              dir="ltr"
              type="number"
              className="qcustom"
              placeholder="عدد…"
              value={answers[f.key] ?? ""}
              onChange={(e) =>
                setAnswer(f.key, f.type === "integer" ? (e.target.value === "" ? undefined : parseInt(e.target.value, 10)) : e.target.value === "" ? undefined : parseFloat(e.target.value))
              }
            />
          ) : null}

          {f.type === "boolean" && (
            <div className="qopts">
              <button type="button" className={`qopt ${answers[f.key] === true ? "on" : ""}`} onClick={() => setAnswer(f.key, true)}>
                <span className="qcheck">{answers[f.key] === true ? "◉" : "○"}</span>
                <span>بله</span>
              </button>
              <button type="button" className={`qopt ${answers[f.key] === false ? "on" : ""}`} onClick={() => setAnswer(f.key, false)}>
                <span className="qcheck">{answers[f.key] === false ? "◉" : "○"}</span>
                <span>خیر</span>
              </button>
            </div>
          )}

          {f.type === "external" && f.url && (
            <a className="qexternal" dir="ltr" href={f.url} target="_blank" rel="noreferrer">
              {f.title || f.url}
            </a>
          )}
        </div>
      ))}

      <div className="qcard-actions">
        <button type="button" className="qsubmit" onClick={submit}>
          ثبت پاسخ
        </button>
        <button type="button" className="qskip" onClick={() => onCancel(form)}>
          رد کن
        </button>
      </div>
    </div>
  )
}
