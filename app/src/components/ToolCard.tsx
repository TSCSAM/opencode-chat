import { memo, useState } from "react"
import type { Part } from "../lib/types"
import { useI18n } from "../lib/i18n"

const LABELS: Record<string, string> = {
  running: "Running",
  streaming: "Streaming",
  completed: "Completed",
  error: "Error",
}

const TITLES: Record<string, string> = {
  shell: "Terminal",
  bash: "Terminal",
  read: "Read file",
  write: "Write file",
  edit: "Edit file",
  glob: "Find files",
  grep: "Search text",
  webfetch: "Fetch web",
  websearch: "Web search",
  task: "Subagent",
  todowrite: "Todo list",
  list: "List",
  question: "Question",
  execute: "Code mode",
}

// The bundled MCP hub exposes one tool per capability group. OpenCode prefixes
// the names with the server id, so the UI strips it and shows a friendly title.
const MCP_PREFIX = "opencode-chat-tools_"
const MCP_TITLES: Record<string, string> = {
  files: "Files",
  documents: "Documents",
  web: "Web",
  browser: "Browser",
  images: "Images",
  data: "Data",
  database: "Database",
  media: "Media",
  memory: "Memory",
  system: "Computer",
  shell: "Terminal",
  code: "Code",
  git: "Git & GitHub",
  devops: "DevOps",
  maps: "Maps",
  seo: "SEO",
  comms: "Messaging",
  workflow: "Workflow",
  translate: "Translate",
  catalog: "Tools",
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
  const code = typeof input.code === "string" ? input.code.trim().split(/\r?\n/)[0] : ""
  const raw =
    input.command ??
    input.filePath ??
    input.path ??
    input.pattern ??
    input.url ??
    input.query ??
    input.description ??
    code ??
    ""
  const target = typeof raw === "string" ? raw : JSON.stringify(raw)
  const action = typeof input.action === "string" ? input.action : ""
  const text = action && target ? `${action} · ${target}` : action || target
  return text.length > 120 ? text.slice(0, 120) + "…" : text
}

function toolTitle(name: string): string {
  if (TITLES[name]) return TITLES[name]
  if (name.startsWith(MCP_PREFIX)) {
    const base = name.slice(MCP_PREFIX.length)
    return MCP_TITLES[base] ?? base.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
  }
  return "Tool"
}

export const ToolCard = memo(function ToolCard({ part }: { part: Part }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const state = part.state ?? {}
  const status: string = state.status ?? "running"
  const input = state.input ?? {}
  const blocks: any[] = Array.isArray(state.content) ? state.content : []
  const output = blocks
    .map((c) =>
      typeof c?.text === "string"
        ? c.text
        : c?.type === "file"
          ? t("File: {name}", { name: c.name ?? c.uri ?? c.path ?? "" })
          : "",
    )
    .filter(Boolean)
    .join("\n")
    .trim()
  const errorText =
    typeof state.error === "string" ? state.error : typeof state.error?.message === "string" ? state.error.message : ""
  const title = t(toolTitle(part.name ?? ""))
  const summary = summarize(part)

  return (
    <div className={`tool tool-${status}`}>
      <button type="button" className="tool-head" onClick={() => setOpen((v) => !v)}>
        <span className="tool-dot" aria-hidden />
        <span className="tool-title">{title}</span>
        {summary && <code className="tool-summary" dir="ltr">{summary}</code>}
        <span className={`pill pill-${status}`}>{LABELS[status] ? t(LABELS[status]) : status}</span>
        <span className="tool-caret">{open ? "▴" : "▾"}</span>
      </button>

      {open && (
        <div className="tool-body">
          {Object.keys(input).length > 0 && (
            <pre dir="ltr" className="tool-pre">{formatInput(input)}</pre>
          )}
          {output && <pre dir="ltr" className="tool-pre tool-out">{output}</pre>}
          {errorText && <pre dir="ltr" className="tool-pre tool-err">{errorText}</pre>}
          {!output && !errorText && !Object.keys(input).length && <div className="tool-empty">{t("No details recorded")}</div>}
        </div>
      )}
    </div>
  )
})

function formatInput(input: Record<string, any>) {
  if (typeof input.command === "string" && Object.keys(input).length <= 2) return input.command
  return JSON.stringify(input, null, 2)
}
