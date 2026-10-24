import { useState } from "react"
import type { Part } from "./types"

const LABELS: Record<string, string> = {
  running: "در حال اجرا",
  streaming: "در حال دریافت",
  completed: "انجام شد",
  error: "خطا",
}

const TITLES: Record<string, string> = {
  shell: "ترمینال",
  bash: "ترمینال",
  read: "خواندن فایل",
  write: "نوشتن فایل",
  edit: "ویرایش فایل",
  glob: "جست‌وجوی فایل",
  grep: "جست‌وجو در متن",
  webfetch: "دریافت وب",
  websearch: "جست‌وجوی وب",
  task: "زیرعامل",
  todowrite: "فهرست کارها",
  list: "فهرست",
  question: "سؤال",
}

function summarize(part: Part): string {
  const input = part.state?.input ?? {}
  if (Array.isArray(input.questions) && input.questions.length > 0) {
    const q = input.questions[0]?.question
    if (typeof q === "string" && q.trim()) {
      const text = q.trim()
      return text.length > 120 ? text.slice(0, 120) + "…" : text
    }
  }
  const raw =
    input.command ??
    input.filePath ??
    input.path ??
    input.pattern ??
    input.url ??
    input.query ??
    input.description ??
    ""
  const text = typeof raw === "string" ? raw : JSON.stringify(raw)
  return text.length > 120 ? text.slice(0, 120) + "…" : text
}

export function ToolCard({ part }: { part: Part }) {
  const [open, setOpen] = useState(false)
  const state = part.state ?? {}
  const status: string = state.status ?? "running"
  const input = state.input ?? {}
  const blocks: any[] = Array.isArray(state.content) ? state.content : []
  const output = blocks
    .map((c) => (typeof c?.text === "string" ? c.text : c?.type === "file" ? `[فایل] ${c.path ?? ""}` : ""))
    .filter(Boolean)
    .join("\n")
    .trim()
  const title = TITLES[part.name ?? ""] ?? part.name ?? "ابزار"
  const summary = summarize(part)

  return (
    <div className={`tool tool-${status}`}>
      <button type="button" className="tool-head" onClick={() => setOpen((v) => !v)}>
        <span className="tool-dot" aria-hidden />
        <span className="tool-title">{title}</span>
        {summary && <code className="tool-summary" dir="ltr">{summary}</code>}
        <span className={`pill pill-${status}`}>{LABELS[status] ?? status}</span>
        <span className="tool-caret">{open ? "▴" : "▾"}</span>
      </button>

      {open && (
        <div className="tool-body">
          {Object.keys(input).length > 0 && (
            <pre dir="ltr" className="tool-pre">{formatInput(input)}</pre>
          )}
          {output && <pre dir="ltr" className="tool-pre tool-out">{output}</pre>}
          {!output && !Object.keys(input).length && <div className="tool-empty">جزئیاتی ثبت نشده</div>}
        </div>
      )}
    </div>
  )
}

function formatInput(input: Record<string, any>) {
  if (typeof input.command === "string" && Object.keys(input).length <= 2) return input.command
  return JSON.stringify(input, null, 2)
}
