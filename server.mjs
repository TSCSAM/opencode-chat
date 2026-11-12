import http from "node:http"
import os from "node:os"
import { spawn } from "node:child_process"
import fsp from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"
import { applyEdits, modify, parse, printParseErrorCode } from "jsonc-parser"

function parseJsonc(src) {
  const errors = []
  const value = parse(src, errors, { allowTrailingComma: true, disallowComments: false })
  if (errors.length > 0) {
    const first = errors[0]
    throw new Error(`${printParseErrorCode(first.error)} at offset ${first.offset}`)
  }
  return value
}

// patch را برگ‌به‌برگ روی متن سند اعمال می‌کند تا کامنت‌ها و ترتیب کلیدها حفظ
// شوند. null در patch یعنی حذف کلید (هم‌معنی deepMerge).
function collectPatch(value, path, ops) {
  if (value === null) {
    ops.push({ path, value: undefined })
    return
  }
  if (Array.isArray(value) || typeof value !== "object") {
    ops.push({ path, value })
    return
  }
  const entries = Object.entries(value)
  if (entries.length === 0) {
    if (path.length > 0) ops.push({ path, value: {} })
    return
  }
  for (const [key, child] of entries) collectPatch(child, [...path, key], ops)
}

function patchJsonc(text, patch, remove = []) {
  const ops = []
  collectPatch(patch, [], ops)
  for (const entry of remove) {
    const path = Array.isArray(entry) ? entry : [entry]
    if (path.length > 0) ops.push({ path, value: undefined })
  }
  let out = text
  for (const op of ops) {
    const edits = modify(out, op.path, op.value, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
    })
    out = applyEdits(out, edits)
  }
  return out
}

function deepMerge(base, patch) {
  if (patch === null) return null
  if (Array.isArray(patch)) return patch
  if (typeof patch === "object" && base && typeof base === "object" && !Array.isArray(base)) {
    const out = { ...base }
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) delete out[k]
      else out[k] = deepMerge(out[k], v)
    }
    return out
  }
  return patch
}

const root = path.dirname(fileURLToPath(import.meta.url))
const prod = process.argv.includes("--prod")
const PORT = Number(process.env.PORT || 5178)
const dirArg = process.argv.find((arg) => arg.startsWith("--dir="))
const workdir = path.resolve(process.env.OPENCODE_CHAT_DIR || (dirArg ? dirArg.slice(6) : process.cwd()))
const shouldOpen = process.argv.includes("--open")
const url = `http://127.0.0.1:${PORT}`

function openBrowser() {
  const child =
    process.platform === "win32"
      ? spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" })
      : spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { detached: true, stdio: "ignore" })
  child.on("error", () => {})
  child.unref()
}

async function serviceCommand() {
  if (process.platform !== "win32") return undefined
  const npmDir = path.join(
    process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"),
    "npm",
  )
  let entries = null
  try {
    entries = await fsp.readdir(npmDir)
  } catch {
    entries = null
  }
  if (entries) {
    const exe = entries.find((e) => e.toLowerCase() === "opencode.exe")
    if (exe) return [path.join(npmDir, exe), "serve", "--service"]
    const cmd = entries.find((e) => e.toLowerCase() === "opencode.cmd")
    if (cmd) return ["cmd", "/c", path.join(npmDir, cmd), "serve", "--service"]
  }
  return ["cmd", "/c", "opencode", "serve", "--service"]
}

// برای upgrade/restart به‌جای cmd مخصوص ویندوز، باینری واقعی را پیدا می‌کنیم تا
// روی macOS/Linux هم کار کند. OPENCODE_BIN برای نصب‌های غیرمعمول است.
async function opencodeCommand(args) {
  if (process.env.OPENCODE_BIN) return [process.env.OPENCODE_BIN, ...args]
  if (process.platform !== "win32") return ["opencode", ...args]
  const npmDir = path.join(
    process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"),
    "npm",
  )
  let entries = null
  try {
    entries = await fsp.readdir(npmDir)
  } catch {
    entries = null
  }
  if (entries) {
    const exe = entries.find((e) => e.toLowerCase() === "opencode.exe")
    if (exe) return [path.join(npmDir, exe), ...args]
    const cmd = entries.find((e) => e.toLowerCase() === "opencode.cmd")
    if (cmd) return ["cmd", "/c", path.join(npmDir, cmd), ...args]
  }
  return ["cmd", "/c", "opencode", ...args]
}

const HIDE_CONSOLE_PS = [
  "$code = @'",
  "using System;",
  "using System.Runtime.InteropServices;",
  "public class W32H {",
  '  [DllImport("user32.dll")]',
  "  public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);",
  "}",
  "'@",
  "Add-Type -TypeDefinition $code",
  "Get-Process opencode -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like '*serve --service*' } | ForEach-Object { [W32H]::ShowWindowAsync($_.MainWindowHandle, 0) | Out-Null }",
].join("\n")

function hideEngineConsole(ms = 30000) {
  if (process.platform !== "win32") return
  const fire = () => {
    try {
      spawn("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", HIDE_CONSOLE_PS], {
        windowsHide: true,
        stdio: "ignore",
      }).unref()
} catch {}
  }
  fire()
  const t = setInterval(fire, 500)
  setTimeout(() => clearInterval(t), Math.max(1000, ms))
}

console.log("openchat: looking for the OpenCode engine (it will be started in the background if it is off)…")
let endpoint
try {
  const svc = await serviceCommand()
  if (svc) console.log("openchat: engine start command:", JSON.stringify(svc))
  hideEngineConsole(45000)
  endpoint = await Service.ensure(svc ? { command: svc } : {})
} catch (e) {
  console.error("")
  console.error(`openchat: failed to start the OpenCode engine: ${e?.message ?? e}`)
  const cause = e?.cause
  if (cause) console.error(`  cause: ${cause.message ?? cause}`)
  console.error(`openchat: if it persists: npm install -g opencode-ai   (then run this launcher again)`)
  throw e
}
hideEngineConsole(3000)
const auth = Service.headers(endpoint)
const client = OpenCode.make({ baseUrl: endpoint.url, headers: auth })
const info = await client.server.info({ signal: AbortSignal.timeout(5000) }).catch(() => ({ version: "?" }))
console.log(`openchat: engine connected ${endpoint.url} (v${info.version ?? "?"})`)

const NPM_LATEST_URL = "https://registry.npmjs.org/@opencode/cli/latest"
let updateCache = { at: 0, latest: null, error: null }

function versionParts(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(value ?? ""))
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

function compareVersions(a, b) {
  const pa = versionParts(a)
  const pb = versionParts(b)
  if (!pa || !pb) return 0
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1
  }
  return 0
}

// نسخهٔ نصب‌شده را از خود موتور می‌پرسیم و آخرین نسخه را از رجیستری npm
// می‌خوانیم. `opencode upgrade` روی برخی نصب‌ها بی‌صدا است و راه --check ندارد،
// بنابراین برای «فقط بررسی» از رجیستری استفاده می‌کنیم.
async function latestEngineVersion(force = false) {
  const now = Date.now()
  if (!force && updateCache.latest && now - updateCache.at < 60_000) return updateCache
  try {
    const res = await fetch(NPM_LATEST_URL, {
      headers: { accept: "application/json", "user-agent": "opencode-chat" },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) throw new Error(`npm registry HTTP ${res.status}`)
    const body = await res.json()
    const latest = typeof body?.version === "string" ? body.version : null
    if (!latest) throw new Error("npm registry response has no version")
    updateCache = { at: now, latest, error: null }
  } catch (err) {
    updateCache = { at: now, latest: updateCache.latest, error: String(err?.message ?? err) }
  }
  return updateCache
}

async function checkEngineUpdate(force = false) {
  let current = info.version ?? "?"
  try {
    const fresh = await client.server.info({ signal: AbortSignal.timeout(3000) })
    if (fresh?.version) current = fresh.version
  } catch {}
  const latestInfo = await latestEngineVersion(force)
  const latest = latestInfo.latest
  const comparable = Boolean(versionParts(current) && versionParts(latest))
  const error = !latest
    ? latestInfo.error ?? "دریافت آخرین نسخه از npm ممکن نشد"
    : !comparable
      ? "نسخهٔ فعلی یا آخر قابل مقایسه نیست"
      : undefined
  return {
    current,
    latest,
    available: comparable ? compareVersions(latest, current) > 0 : false,
    checkedAt: Date.now(),
    ...(error ? { error } : {}),
  }
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff2": "font/woff2",
  ".map": "application/json",
}

const MB = 1024 * 1024
const API_BODY_LIMIT = 16 * MB
const CONFIG_BODY_LIMIT = 2 * MB
const UPLOAD_BODY_LIMIT = 24 * MB

const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "media-src 'self' data: blob: https:",
].join("; ")

function applySecurityHeaders(res) {
  res.setHeader("content-security-policy", CSP)
  res.setHeader("x-content-type-options", "nosniff")
  res.setHeader("x-frame-options", "DENY")
  res.setHeader("referrer-policy", "no-referrer")
  res.setHeader("cross-origin-resource-policy", "same-origin")
}

function json(res, code, body) {
  const buf = Buffer.from(JSON.stringify(body))
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "content-length": buf.length })
  res.end(buf)
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"])

// سرور فقط روی loopback گوش می‌دهد؛ پس هر Host دیگری یا DNS rebinding است یا
// پروکسی ناخواسته. Origin/Sec-Fetch-Site هم جلوی CSRF از سایت‌های دیگر را
// می‌گیرند (مرورگر روی درخواست cross-origin این هدرها را می‌فرستد).
function hostAllowed(hostHeader) {
  if (!hostHeader) return false
  const host = String(hostHeader).toLowerCase()
  if (host === `127.0.0.1:${PORT}` || host === `localhost:${PORT}` || host === `[::1]:${PORT}`) return true
  return PORT === 80 && LOOPBACK_HOSTS.has(host)
}

function originAllowed(origin) {
  if (!origin) return true
  if (origin === "null") return false
  try {
    const u = new URL(origin)
    if (u.protocol !== "http:" && u.protocol !== "https:") return false
    if (!LOOPBACK_HOSTS.has(u.hostname)) return false
    return Number(u.port || (u.protocol === "https:" ? 443 : 80)) === PORT
  } catch {
    return false
  }
}

function guardRequest(req, res) {
  if (!hostAllowed(req.headers.host)) {
    json(res, 403, { error: "unexpected Host header" })
    return false
  }
  const method = String(req.method ?? "GET").toUpperCase()
  if (method === "GET" || method === "HEAD") return true
  if (method === "OPTIONS") {
    json(res, 403, { error: "CORS preflight is not allowed" })
    return false
  }
  const site = String(req.headers["sec-fetch-site"] ?? "").toLowerCase()
  if (site && site !== "same-origin" && site !== "none") {
    json(res, 403, { error: "cross-site request blocked" })
    return false
  }
  if (!originAllowed(req.headers.origin)) {
    json(res, 403, { error: "cross-origin request blocked" })
    return false
  }
  return true
}

function requireJson(req, res) {
  const ct = String(req.headers["content-type"] ?? "").toLowerCase()
  if (!ct.startsWith("application/json")) {
    json(res, 415, { error: "content-type must be application/json" })
    return false
  }
  return true
}

function requireLocalHeader(req, res) {
  if (String(req.headers["x-opencode-chat"] ?? "") !== "1") {
    json(res, 403, { error: "missing x-opencode-chat header" })
    return false
  }
  return true
}

function bodyTooLarge() {
  const err = new Error("request body too large")
  err.statusCode = 413
  return err
}

async function readBody(req, limit = API_BODY_LIMIT) {
  if (req.method === "GET" || req.method === "HEAD") return undefined
  const declared = Number(req.headers["content-length"])
  if (Number.isFinite(declared) && declared > limit) throw bodyTooLarge()
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > limit) throw bodyTooLarge()
    chunks.push(chunk)
  }
  return chunks.length ? Buffer.concat(chunks) : undefined
}

// موتور OpenCode مسیرهای نسبی مثل «C:» یا «.» را در GET /api/location با 200
// می‌پذیرد ولی Session.create آن‌ها را با «Path is not absolute» و پاسخ 500 با
// بدنهٔ خالی رد می‌کند. این گارد آخرین سد دفاعی است تا هیچ کلاینتی 500 بی‌پیام نگیرد.
function isAbsoluteDir(dir) {
  return /^[A-Za-z]:[\\/]/.test(dir) || /^\\\\[^\\]/.test(dir) || dir.startsWith("/")
}

async function proxy(req, res) {
  const url = new URL(req.url, "http://localhost")
  const target = endpoint.url + url.pathname.replace(/^\/oc/, "") + url.search
  const headers = { ...auth }
  if (req.headers["content-type"]) headers["content-type"] = req.headers["content-type"]
  if (req.headers.accept) headers["accept"] = req.headers.accept

  const body = await readBody(req)

  if (req.method === "POST" && url.pathname === "/oc/api/session" && body?.length) {
    let parsed
    try {
      // بعضی کلاینت‌ها (مثلاً PowerShell) UTF-8 با BOM می‌فرستند و JSON.parse
      // بدون حذف BOM شکست می‌خورد؛ در این حالت گارد بی‌اثر می‌شد.
      parsed = JSON.parse(body.toString("utf8").replace(/^\uFEFF/, ""))
    } catch {
      parsed = null
    }
    const dir = parsed?.location?.directory
    if (typeof dir === "string" && dir.trim() && !isAbsoluteDir(dir.trim())) {
      return json(res, 400, {
        message: `مسیر باید کامل باشد (مثلاً C:\\Projects\\my-app): ${dir}`,
      })
    }
  }

  const controller = new AbortController()
  res.on("close", () => controller.abort())

  let upstream
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers,
      body,
      signal: controller.signal,
    })
  } catch (err) {
    if (!res.headersSent) json(res, 502, { error: "opencode service unreachable", detail: String(err) })
    return
  }

  const out = {
    "content-type": upstream.headers.get("content-type") || "application/json",
    "cache-control": "no-cache, no-transform",
    "x-accel-buffering": "no",
  }
  res.writeHead(upstream.status, out)
  res.flushHeaders?.()
  req.socket?.setNoDelay(true)
  res.socket?.setNoDelay(true)

  if (!upstream.body) return res.end()
  try {
    for await (const chunk of upstream.body) {
      if (res.writableEnded) break
      res.write(chunk)
    }
} catch {}
  res.end()
}

async function serveStatic(req, res) {
  const url = new URL(req.url, "http://localhost")
  const dist = path.join(root, "dist")
  let file = path.join(dist, decodeURIComponent(url.pathname))
  const rel = path.relative(dist, file)
  if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
    return json(res, 403, { error: "forbidden" })
  }
  try {
    const stat = await fsp.stat(file)
    if (stat.isDirectory()) file = path.join(file, "index.html")
  } catch {
    file = path.join(root, "dist", "index.html")
  }
  try {
    const data = await fsp.readFile(file)
    res.writeHead(200, {
      "content-type": MIME[path.extname(file)] || "application/octet-stream",
      "cache-control": file.endsWith("index.html")
        ? "no-cache, no-store, must-revalidate"
        : "public, max-age=31536000, immutable",
    })
    res.end(data)
  } catch {
    json(res, 404, { error: "not built. run: npm run build" })
  }
}

let vite
const server = http.createServer(async (req, res) => {
  applySecurityHeaders(res)
  if (!guardRequest(req, res)) return
  const url = new URL(req.url, "http://localhost")
  try {
    const appPath =
      url.pathname === "/oc/__config" || url.pathname.startsWith("/oc/app/")
        ? url.pathname.slice(3)
        : url.pathname
    if (url.pathname.startsWith("/oc/") && appPath === url.pathname) return await proxy(req, res)
    if (appPath === "/__config") {
      // نسخه را هر بار از موتور می‌خوانیم تا بعد از upgrade/restart، UI نسخهٔ
      // کهنهٔ زمان راه‌اندازی سرور را نشان ندهد.
      let version = info.version
      try {
        const fresh = await client.server.info({ signal: AbortSignal.timeout(3000) })
        if (fresh?.version) version = fresh.version
      } catch {}
      return json(res, 200, {
        directory: workdir,
        upstream: endpoint.url,
        version,
        dev: !prod,
      })
    }

    if (appPath === "/app/upload" && req.method === "POST") {
      if (!requireJson(req, res)) return
      let raw
      try {
        raw = await readBody(req, UPLOAD_BODY_LIMIT)
      } catch (err) {
        if (err?.statusCode === 413) return json(res, 413, { error: "حجم درخواست بیش از حد مجاز است" })
        throw err
      }
      let body
      try {
        body = JSON.parse(raw ?? "{}")
      } catch {
        return json(res, 400, { error: "bad json body" })
      }
      const m = /^data:image\/(png|jpe?g|webp|gif|bmp);base64,([A-Za-z0-9+/=]+)$/.exec(body?.dataUrl ?? "")
      if (!m) return json(res, 400, { error: "فقط تصویر (png/jpg/webp/gif/bmp) قابل قبول است" })
      const buf = Buffer.from(m[2], "base64")
      if (buf.length === 0) return json(res, 400, { error: "تصویر خالی است" })
      if (buf.length > 15 * 1024 * 1024) return json(res, 413, { error: "حجم تصویر بیش از ۱۵MB است" })
      const ext = m[1] === "jpeg" ? "jpg" : m[1]
      const name = `opencode-img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
      const target = path.join(os.tmpdir(), name)
      try {
        await fsp.writeFile(target, buf)
      } catch (err) {
        return json(res, 500, { error: `نوشتن تصویر ناموفق: ${err}` })
      }
      return json(res, 200, { ok: true, path: target, name: body.name || name, bytes: buf.length })
    }

    if (appPath === "/app/config/write" && req.method === "POST") {
      if (!requireJson(req, res)) return
      let raw
      try {
        raw = await readBody(req, CONFIG_BODY_LIMIT)
      } catch (err) {
        if (err?.statusCode === 413) return json(res, 413, { error: "حجم تنظیمات بیش از حد مجاز است" })
        throw err
      }
      let body
      try {
        body = JSON.parse(raw ?? "{}")
      } catch {
        return json(res, 400, { error: "bad json body" })
      }
      const patch = body?.patch
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
        return json(res, 400, { error: "patch must be an object" })
      }
      const remove = Array.isArray(body?.remove)
        ? body.remove.filter(
            (k) => typeof k === "string" || (Array.isArray(k) && k.length > 0 && k.every((s) => typeof s === "string")),
          )
        : []
      const cfgRes = await fetch(endpoint.url + "/api/config", { headers: { ...auth } })
      const cfg = await cfgRes.json().catch(() => null)
      const doc = (cfg?.data ?? cfg ?? []).find?.((e) => e?.type === "document" && e.path)
      if (!doc?.path) return json(res, 404, { error: "no editable config document found" })
      const text = await fsp.readFile(doc.path, "utf8").catch(() => "")
      let base = {}
      let editable = false
      if (text.trim()) {
        try {
          base = parseJsonc(text)
        } catch (err) {
          return json(res, 500, { error: `cannot parse config file: ${err.message ?? err}` })
        }
        if (base != null && (typeof base !== "object" || Array.isArray(base))) {
          return json(res, 500, { error: "config document is not a JSON object" })
        }
        editable = base != null
      }
      if (!editable) base = {}
      const merged = deepMerge(base, patch)
      for (const entry of remove) {
        const pathParts = Array.isArray(entry) ? entry : [entry]
        let target = merged
        for (let i = 0; i < pathParts.length - 1 && target; i++) target = target[pathParts[i]]
        if (target && typeof target === "object") delete target[pathParts[pathParts.length - 1]]
      }
      if (!merged || typeof merged !== "object" || Array.isArray(merged)) {
        return json(res, 400, { error: "merge produced invalid config" })
      }
      let out
      if (editable) {
        out = patchJsonc(text, patch, remove)
        try {
          parseJsonc(out)
        } catch (err) {
          return json(res, 500, { error: `edit produced invalid JSONC: ${err.message ?? err}` })
        }
      } else {
        out = JSON.stringify(merged, null, 2) + "\n"
      }
      await fsp.writeFile(doc.path, out, "utf8")
      await fetch(endpoint.url + "/api/location/reload", {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(5000),
      }).catch(() => {})
      return json(res, 200, { ok: true, wrote: doc.path })
    }

    if (appPath === "/app/update/check" && req.method === "GET") {
      return json(res, 200, await checkEngineUpdate(url.searchParams.get("force") === "1"))
    }

    if (appPath === "/app/update/install" && req.method === "POST") {
      if (!requireLocalHeader(req, res)) return
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-cache" })
      hideEngineConsole(20000)
      const [command, ...commandArgs] = await opencodeCommand(["upgrade"])
      const child = spawn(command, commandArgs, { windowsHide: true })
      const pipe = (s) => s?.on("data", (c) => { if (!res.writableEnded) res.write(c) })
      pipe(child.stdout)
      pipe(child.stderr)
      child.on("error", (err) => { if (!res.writableEnded) res.write(`\nERROR: ${err}\n`) })
      res.on("close", () => { try { child.kill() } catch {} })
      child.on("close", (code) => { if (!res.writableEnded) res.end(`\n[exit ${code}]`) })
      return
    }

    if (appPath === "/app/service/restart" && req.method === "POST") {
      if (!requireLocalHeader(req, res)) return
      hideEngineConsole(35000)
      const chunks = []
      try {
        const [command, ...commandArgs] = await opencodeCommand(["service", "restart"])
        await new Promise((resolve) => {
          const child = spawn(command, commandArgs, { windowsHide: true })
          child.stdout?.on("data", (c) => chunks.push(c))
          child.stderr?.on("data", (c) => chunks.push(c))
          child.on("error", (err) => { chunks.push(Buffer.from(`ERROR: ${err}`)); resolve() })
          child.on("close", () => resolve())
        })
      } catch (err) {
        chunks.push(Buffer.from(String(err)))
      }
      chunks.push(Buffer.from("\n[next: connection is re-established automatically]"))
      return json(res, 200, { ok: true, log: Buffer.concat(chunks).toString("utf8").slice(0, 4000) })
    }

    if (vite) return vite.middlewares(req, res)
    return await serveStatic(req, res)
  } catch (err) {
    if (!res.headersSent) {
      const code = Number(err?.statusCode) || 500
      json(res, code, { error: String(err?.message ?? err) })
    } else res.end()
  }
})

if (!prod) {
  const { createServer } = await import("vite")
  vite = await createServer({
    configFile: path.join(root, "vite.config.ts"),
    server: { middlewareMode: true, ws: { server } },
    appType: "spa",
  })
}

function probeConfig(target) {
  return new Promise((resolve) => {
    const req = http.get(`${target}/__config`, { timeout: 800 }, (res) => {
      let body = ""
      res.setEncoding("utf8")
      res.on("data", (chunk) => (body += chunk))
      res.on("end", () => {
        try {
          resolve(Boolean(JSON.parse(body).upstream))
        } catch {
          resolve(false)
        }
      })
    })
    req.on("timeout", () => req.destroy())
    req.on("error", () => resolve(false))
  })
}

server.on("error", async (err) => {
  if (err?.code !== "EADDRINUSE") {
    console.error("server error:", err)
    process.exitCode = 1
    return
  }
  const running = await probeConfig(url)
  if (running) {
    console.log(`\n  already running at ${url}\n`)
    if (shouldOpen) openBrowser()
    process.exitCode = 0
    return
  }
  console.error(`\n  port ${PORT} is used by another program. Set PORT to a free port.\n`)
  process.exitCode = 1
})

server.listen(PORT, "127.0.0.1", () => {
  console.log(`\n  opencode-chat  ${url}`)
  console.log(`  engine         ${endpoint.url} (v${info.version})`)
  console.log(`  working dir    ${workdir}`)
  console.log(`\n  close this window to stop.\n`)
  if (shouldOpen) setTimeout(openBrowser, 300)
})
