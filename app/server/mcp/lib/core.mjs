// Shared runtime for the bundled OpenCode Chat tool server.
// Everything here is local-first: no user file leaves the machine unless a
// tool call explicitly asks for a network operation.
import fs from "node:fs"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { spawn, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

export const SERVER_NAME = "opencode-chat-tools"
export const SERVER_VERSION = "1.10.0"
export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..")
export const WORKSPACE = path.resolve(process.env.OPENCODE_CHAT_WORKSPACE || process.cwd())
export const DATA_DIR = path.resolve(process.env.OPENCODE_CHAT_TOOLS_DATA || path.join(APP_ROOT, "data"))
export const CACHE_DIR = path.join(DATA_DIR, "tool-cache")
export const STATE_FILE = path.join(DATA_DIR, "tool-state.json")
export const MEMORY_FILE = path.join(DATA_DIR, "tool-memory.json")
export const TMP_DIR = path.join(os.tmpdir(), "opencode-chat-tools")
export const MAX_TEXT = 240_000
export const MAX_JSON = 4_000_000
export const IS_WIN = process.platform === "win32"
export const IS_MAC = process.platform === "darwin"

export class ToolError extends Error {
  constructor(message, code = "TOOL_ERROR", details) {
    super(message)
    this.name = "ToolError"
    this.code = code
    this.details = details
  }
}

export function ensureDirSync(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

export async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true })
  return dir
}

export function expandHome(value) {
  if (typeof value !== "string") return value
  if (value === "~") return os.homedir()
  if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(os.homedir(), value.slice(2))
  return value
}

export function resolvePath(value, options = {}) {
  const { base = WORKSPACE, mustExist = false, createParent = false } = options
  if (typeof value !== "string" || !value.trim()) {
    throw new ToolError("path is required", "BAD_INPUT")
  }
  let raw = expandHome(value.trim())
  if (raw === "." || raw === "./" || raw === ".\\") raw = base
  if (path.isAbsolute(raw)) raw = path.normalize(raw)
  else raw = path.resolve(base, raw)
  if (createParent) ensureDirSync(path.dirname(raw))
  if (mustExist && !fs.existsSync(raw)) {
    throw new ToolError(`path does not exist: ${raw}`, "NOT_FOUND")
  }
  return raw
}

export function assertSafeTarget(target, action = "modify") {
  const parsed = path.parse(target)
  if (target === parsed.root) {
    throw new ToolError(`refusing to ${action} a drive/root directory: ${target}`, "UNSAFE_PATH")
  }
  if (target === WORKSPACE && ["delete", "move", "rename"].includes(action)) {
    throw new ToolError(`refusing to ${action} the workspace root`, "UNSAFE_PATH")
  }
  const protectedNames = new Set(["windows", "system32", "syswow64", "program files", "program files (x86)"])
  const parts = target.toLowerCase().split(/[\\/]+/).filter(Boolean)
  if (IS_WIN && parts.length <= 2 && protectedNames.has(parts.at(-1))) {
    throw new ToolError(`refusing to ${action} a protected system folder: ${target}`, "UNSAFE_PATH")
  }
}

export function isBinaryBuffer(buf) {
  if (!buf || buf.length === 0) return false
  const sample = buf.subarray(0, Math.min(buf.length, 8000))
  let control = 0
  for (const byte of sample) {
    if (byte === 0) return true
    if (byte < 9 || (byte > 13 && byte < 32)) control += 1
  }
  return control / sample.length > 0.05
}

export async function readTextFile(file, max = MAX_TEXT) {
  const target = resolvePath(file, { mustExist: true })
  const stat = await fsp.stat(target)
  if (stat.isDirectory()) throw new ToolError(`expected a file, got a directory: ${target}`, "IS_DIRECTORY")
  const buf = await fsp.readFile(target)
  if (isBinaryBuffer(buf)) {
    throw new ToolError(`binary file (${formatBytes(stat.size)}); use a document/media tool instead`, "BINARY_FILE")
  }
  const text = buf.toString("utf8")
  return { path: target, text: text.length > max ? text.slice(0, max) : text, truncated: text.length > max, bytes: stat.size, stat }
}

export async function writeTextFile(file, content, options = {}) {
  const target = resolvePath(file, { createParent: true })
  if (options.overwrite === false && fs.existsSync(target)) {
    throw new ToolError(`file already exists: ${target}`, "EXISTS")
  }
  const text = String(content ?? "")
  if (text.length > MAX_JSON) throw new ToolError("content is too large", "TOO_LARGE")
  await fsp.writeFile(target, text, "utf8")
  return { path: target, bytes: Buffer.byteLength(text), lines: text.split(/\r?\n/).length }
}

export async function writeBinaryFile(file, buffer) {
  const target = resolvePath(file, { createParent: true })
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  await fsp.writeFile(target, buf)
  return { path: target, bytes: buf.length }
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "?"
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB", "TB"]
  let value = bytes / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i += 1
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[i]}`
}

export function mimeFromExt(file) {
  const ext = path.extname(String(file)).toLowerCase()
  return (
    {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
      ".gif": "image/gif",
      ".bmp": "image/bmp",
      ".svg": "image/svg+xml",
      ".pdf": "application/pdf",
      ".json": "application/json",
      ".txt": "text/plain",
      ".md": "text/markdown",
      ".html": "text/html",
      ".htm": "text/html",
      ".csv": "text/csv",
      ".xml": "application/xml",
      ".yaml": "application/yaml",
      ".yml": "application/yaml",
      ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      ".zip": "application/zip",
      ".mp4": "video/mp4",
      ".webm": "video/webm",
      ".mov": "video/quicktime",
      ".mp3": "audio/mpeg",
      ".wav": "audio/wav",
      ".ogg": "audio/ogg",
      ".m4a": "audio/mp4",
    }[ext] || "application/octet-stream"
  )
}

export function truncate(value, max = MAX_TEXT) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2)
  return text.length > max ? `${text.slice(0, max)}\n… [truncated ${text.length - max} chars]` : text
}

export function textResult(text, extra = []) {
  return { content: [{ type: "text", text: truncate(text) }, ...extra] }
}

export function jsonResult(value, extra = []) {
  return textResult(JSON.stringify(value, null, 2), extra)
}

export function imageResult(buffer, mime = "image/png", caption) {
  const content = []
  if (caption) content.push({ type: "text", text: caption })
  content.push({ type: "image", data: Buffer.from(buffer).toString("base64"), mimeType: mime })
  return { content }
}

export function blobResult(buffer, mime, name) {
  return { content: [{ type: "resource", resource: { uri: `file:///${String(name).replace(/\\/g, "/")}`, mimeType: mime, blob: Buffer.from(buffer).toString("base64") } }] }
}

export function errorResult(error) {
  const message = error instanceof Error ? error.message : String(error)
  return { content: [{ type: "text", text: `Tool error: ${message}` }], isError: true }
}

export function parseBool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback
  if (typeof value === "boolean") return value
  return ["1", "true", "yes", "on", "y"].includes(String(value).toLowerCase())
}

export function parseNumber(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
}

export function nowIso() {
  return new Date().toISOString()
}

export function hashText(text, algorithm = "sha256") {
  return crypto.createHash(algorithm).update(text).digest("hex")
}

export function unique(list) {
  return [...new Set(list.filter((x) => x !== undefined && x !== null && x !== ""))]
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

export function redactSecrets(text) {
  return String(text)
    .replace(/\b(sk-[A-Za-z0-9_-]{16,})\b/g, "sk-***")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, "$1***")
    .replace(/\b(api[_-]?key|token|secret|password)\s*[:=]\s*["']?[^"'\s]{8,}/gi, "$1=***")
}

export function safeName(value, fallback = "file") {
  return String(value || fallback)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 120) || fallback
}

export function stamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-")
}

export function globToRegExp(pattern) {
  let src = String(pattern || "*")
  src = src.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  src = src.replace(/\*/g, ".*").replace(/\?/g, ".")
  return new RegExp(`^${src}$`, "i")
}

export async function walkFiles(root, options = {}) {
  const {
    maxFiles = 4000,
    maxDepth = 12,
    ignore = ["node_modules", ".git", "dist", "build", ".next", ".cache", "vendor", "__pycache__", ".venv", "venv"],
  } = options
  const base = resolvePath(root, { mustExist: true })
  const ignoreSet = new Set(ignore)
  const out = []
  async function visit(dir, depth) {
    if (out.length >= maxFiles || depth > maxDepth) return
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) return
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (ignoreSet.has(entry.name) || entry.name.startsWith(".git")) continue
        await visit(path.join(dir, entry.name), depth + 1)
      } else if (entry.isFile()) {
        const full = path.join(dir, entry.name)
        try {
          const stat = await fsp.stat(full)
          out.push({ path: full, relative: path.relative(base, full), name: entry.name, size: stat.size, mtime: stat.mtimeMs })
        } catch {}
      }
    }
  }
  await visit(base, 0)
  return out
}

export async function searchFiles(root, pattern, options = {}) {
  const { maxResults = 200, content = true, regex = false, ignoreCase = true, maxFileBytes = 2_000_000 } = options
  const files = await walkFiles(root, { maxFiles: options.maxFiles ?? 4000 })
  const matchName = regex
    ? new RegExp(pattern, ignoreCase ? "i" : "")
    : globToRegExp(pattern.includes("*") || pattern.includes("?") ? pattern : `*${pattern}*`)
  const results = []
  for (const file of files) {
    if (results.length >= maxResults) break
    if (matchName.test(file.name) || matchName.test(file.relative)) {
      results.push({ ...file, match: "name" })
      continue
    }
    if (!content || file.size > maxFileBytes) continue
    let text
    try {
      text = await fsp.readFile(file.path, "utf8")
    } catch {
      continue
    }
    if (isBinaryBuffer(Buffer.from(text.slice(0, 8000)))) continue
    const lines = text.split(/\r?\n/)
    const needle = pattern.toLowerCase()
    for (let i = 0; i < lines.length; i++) {
      const hay = ignoreCase ? lines[i].toLowerCase() : lines[i]
      const hit = regex ? new RegExp(pattern, ignoreCase ? "i" : "").test(lines[i]) : hay.includes(needle)
      if (hit) {
        results.push({ ...file, match: "content", line: i + 1, text: lines[i].slice(0, 300) })
        break
      }
    }
  }
  return results
}

export async function runProcess(command, args = [], options = {}) {
  const {
    cwd = WORKSPACE,
    timeout = 30_000,
    input,
    env,
    maxOutput = 2_000_000,
    windowsHide = true,
    shell = false,
    killTree = true,
  } = options
  const started = Date.now()
  return await new Promise((resolve, reject) => {
    let stdout = ""
    let stderr = ""
    let timedOut = false
    let settled = false
    let child
    try {
      child = spawn(command, args, {
        cwd,
        windowsHide,
        shell,
        env: { ...process.env, ...(env || {}) },
        stdio: ["pipe", "pipe", "pipe"],
      })
    } catch (error) {
      reject(error)
      return
    }
    const append = (current, chunk) => {
      const next = current + chunk.toString("utf8")
      return next.length > maxOutput ? next.slice(0, maxOutput) : next
    }
    child.stdout?.on("data", (chunk) => {
      stdout = append(stdout, chunk)
    })
    child.stderr?.on("data", (chunk) => {
      stderr = append(stderr, chunk)
    })
    child.on("error", (error) => {
      if (settled) return
      settled = true
      reject(error)
    })
    child.on("close", (code, signal) => {
      if (settled) return
      settled = true
      resolve({ code, signal, stdout, stderr, timedOut, durationMs: Date.now() - started, command, args })
    })
    if (input !== undefined) {
      try {
        child.stdin.write(input)
        child.stdin.end()
      } catch {}
    } else {
      try {
        child.stdin.end()
      } catch {}
    }
    const timer = setTimeout(() => {
      timedOut = true
      if (killTree && child.pid) {
        if (IS_WIN) {
          spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" })
        } else {
          try {
            process.kill(-child.pid, "SIGKILL")
          } catch {
            try {
              child.kill("SIGKILL")
            } catch {}
          }
        }
      } else {
        try {
          child.kill("SIGKILL")
        } catch {}
      }
    }, timeout)
    child.on("close", () => clearTimeout(timer))
  })
}

export function runProcessSync(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || WORKSPACE,
    windowsHide: true,
    timeout: options.timeout ?? 20_000,
    input: options.input,
    env: { ...process.env, ...(options.env || {}) },
    encoding: "utf8",
    maxBuffer: options.maxBuffer ?? 2_000_000,
  })
  return {
    code: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || result.error?.message || "",
    error: result.error,
  }
}

export function encodePowerShell(script) {
  return Buffer.from(String(script), "utf16le").toString("base64")
}

export async function powershell(script, options = {}) {
  const prelude = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $OutputEncoding=[System.Text.Encoding]::UTF8; "
  const encoded = encodePowerShell(prelude + script)
  return runProcess(
    options.exe ||
      path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
    { ...options, timeout: options.timeout ?? 30_000 },
  )
}

export function which(command) {
  if (!command) return null
  const envPath = process.env.PATH || ""
  const exts = IS_WIN ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";") : [""]
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      const candidate = path.join(dir, command + (IS_WIN && !command.toLowerCase().endsWith(ext.toLowerCase()) ? ext.toLowerCase() : ""))
      if (fs.existsSync(candidate)) return candidate
    }
  }
  return null
}

export async function whichAsync(command) {
  const direct = which(command)
  if (direct) return direct
  if (IS_WIN) {
    const res = await runProcess("where.exe", [command], { timeout: 5000 }).catch(() => null)
    if (res?.code === 0) return res.stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean) || null
  } else {
    const res = await runProcess("sh", ["-c", `command -v ${JSON.stringify(command)}`], { timeout: 5000 }).catch(() => null)
    if (res?.code === 0) return res.stdout.trim() || null
  }
  return null
}

export async function readJson(file, fallback) {
  try {
    const text = await fsp.readFile(resolvePath(file), "utf8")
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

export async function writeJson(file, value) {
  const target = resolvePath(file, { createParent: true })
  await fsp.writeFile(target, JSON.stringify(value, null, 2) + "\n", "utf8")
  return target
}

export async function updateJson(file, updater, fallback = {}) {
  const current = await readJson(file, fallback)
  const next = await updater(current)
  await writeJson(file, next)
  return next
}

export function withTimeout(promise, ms, label = "operation") {
  let timer
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new ToolError(`${label} timed out after ${ms} ms`, "TIMEOUT")), ms)
    }),
  ])
}

export function normalizeNewlines(text) {
  return String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n")
}

export function lineDiff(a, b) {
  const oldLines = normalizeNewlines(a).split("\n")
  const newLines = normalizeNewlines(b).split("\n")
  const n = oldLines.length
  const m = newLines.length
  if (n * m > 4_000_000) {
    return { added: Math.max(0, m - n), removed: Math.max(0, n - m), unified: "(too large for a line diff)" }
  }
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const out = []
  let added = 0
  let removed = 0
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      out.push(`  ${oldLines[i]}`)
      i += 1
      j += 1
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push(`- ${oldLines[i]}`)
      removed += 1
      i += 1
    } else {
      out.push(`+ ${newLines[j]}`)
      added += 1
      j += 1
    }
  }
  while (i < n) {
    out.push(`- ${oldLines[i++]}`)
    removed += 1
  }
  while (j < m) {
    out.push(`+ ${newLines[j++]}`)
    added += 1
  }
  return { added, removed, unified: out.slice(0, 2000).join("\n") }
}

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

export function csvEscape(value) {
  const text = value === undefined || value === null ? "" : String(value)
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function toCsv(rows, headers) {
  const list = Array.isArray(rows) ? rows : []
  const keys = headers || (list.length && typeof list[0] === "object" ? Object.keys(list[0]) : [])
  if (!keys.length) return list.map((row) => (Array.isArray(row) ? row.map(csvEscape).join(",") : csvEscape(row))).join("\n")
  return [keys.map(csvEscape).join(","), ...list.map((row) => keys.map((key) => csvEscape(row?.[key])).join(","))].join("\n")
}

export function parseCsv(text, delimiter) {
  const input = normalizeNewlines(text)
  if (!input.trim()) return { headers: [], rows: [] }
  let sep = delimiter
  if (!sep) {
    const first = input.split("\n")[0]
    const candidates = [",", ";", "\t", "|"]
    sep = candidates.sort((a, b) => first.split(b).length - first.split(a).length)[0]
  }
  const cells = []
  let row = []
  let field = ""
  let quoted = false
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"'
          i += 1
        } else quoted = false
      } else field += ch
    } else if (ch === '"') {
      quoted = true
    } else if (ch === sep) {
      row.push(field)
      field = ""
    } else if (ch === "\n") {
      row.push(field)
      cells.push(row)
      row = []
      field = ""
    } else {
      field += ch
    }
  }
  if (field.length || row.length) {
    row.push(field)
    cells.push(row)
  }
  const nonEmpty = cells.filter((r) => r.some((c) => String(c).trim() !== ""))
  if (!nonEmpty.length) return { headers: [], rows: [] }
  const headers = nonEmpty[0].map((h) => String(h).trim())
  const rows = nonEmpty.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ""])))
  return { headers, rows, delimiter: sep }
}

export function extractJson(text) {
  const raw = String(text)
  try {
    return JSON.parse(raw)
  } catch {}
  const start = raw.indexOf("{")
  const end = raw.lastIndexOf("}")
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(raw.slice(start, end + 1))
    } catch {}
  }
  const arrStart = raw.indexOf("[")
  const arrEnd = raw.lastIndexOf("]")
  if (arrStart >= 0 && arrEnd > arrStart) {
    try {
      return JSON.parse(raw.slice(arrStart, arrEnd + 1))
    } catch {}
  }
  throw new ToolError("no valid JSON found", "BAD_JSON")
}

export function assertConfirm(args, action) {
  if (!parseBool(args?.confirm, false)) {
    throw new ToolError(`${action} requires confirm: true`, "CONFIRM_REQUIRED")
  }
}

export function toolMeta(name, description, inputSchema, annotations = {}) {
  return {
    name,
    description,
    inputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
      ...annotations,
    },
  }
}

export { fs, fsp, os, path, crypto }
