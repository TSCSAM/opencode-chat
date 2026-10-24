import http from "node:http"
import os from "node:os"
import { spawn } from "node:child_process"
import fsp from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"

function stripJsonc(src) {
  let out = ""
  let inStr = false
  let esc = false
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (inStr) {
      out += c
      if (esc) esc = false
      else if (c === "\\") esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') {
      inStr = true
      out += c
      continue
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++
      continue
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2
      while (i + 1 < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++
      i++
      continue
    }
    out += c
  }
  return out.replace(/,\s*([}\]])/g, "$1")
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
  if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref()
  } else {
    spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { detached: true, stdio: "ignore" }).unref()
  }
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
const info = await client.server.info().catch(() => ({ version: "?" }))
console.log(`openchat: engine connected ${endpoint.url} (v${info.version ?? "?"})`)

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

function json(res, code, body) {
  const buf = Buffer.from(JSON.stringify(body))
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "content-length": buf.length })
  res.end(buf)
}

async function readBody(req) {
  if (req.method === "GET" || req.method === "HEAD") return undefined
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return chunks.length ? Buffer.concat(chunks) : undefined
}

async function proxy(req, res) {
  const url = new URL(req.url, "http://localhost")
  const target = endpoint.url + url.pathname.replace(/^\/oc/, "") + url.search
  const headers = { ...auth }
  if (req.headers["content-type"]) headers["content-type"] = req.headers["content-type"]
  if (req.headers.accept) headers["accept"] = req.headers.accept

  const controller = new AbortController()
  res.on("close", () => controller.abort())

  let upstream
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers,
      body: await readBody(req),
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
  let file = path.join(root, "dist", decodeURIComponent(url.pathname))
  if (!path.normalize(file).startsWith(path.join(root, "dist"))) return json(res, 403, { error: "forbidden" })
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
  const url = new URL(req.url, "http://localhost")
  try {
    const appPath =
      url.pathname === "/oc/__config" || url.pathname.startsWith("/oc/app/")
        ? url.pathname.slice(3)
        : url.pathname
    if (url.pathname.startsWith("/oc/") && appPath === url.pathname) return await proxy(req, res)
    if (appPath === "/__config") {
      return json(res, 200, {
        directory: workdir,
        upstream: endpoint.url,
        version: info.version,
        dev: !prod,
      })
    }

    if (appPath === "/app/upload" && req.method === "POST") {
      let body
      try {
        body = JSON.parse(await readBody(req) ?? "{}")
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
      let body
      try {
        body = JSON.parse(await readBody(req) ?? "{}")
      } catch {
        return json(res, 400, { error: "bad json body" })
      }
      const patch = body?.patch
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
        return json(res, 400, { error: "patch must be an object" })
      }
      const cfgRes = await fetch(endpoint.url + "/api/config", { headers: { ...auth } })
      const cfg = await cfgRes.json().catch(() => null)
      const doc = (cfg?.data ?? cfg ?? []).find?.((e) => e?.type === "document" && e.path)
      if (!doc?.path) return json(res, 404, { error: "no editable config document found" })
      let base = {}
      try {
        base = JSON.parse(stripJsonc(await fsp.readFile(doc.path, "utf8")) || "{}")
      } catch (err) {
        return json(res, 500, { error: `cannot parse config file: ${err}` })
      }
      const merged = deepMerge(base, patch)
      if (!merged || typeof merged !== "object") return json(res, 400, { error: "merge produced invalid config" })
      await fsp.writeFile(doc.path, JSON.stringify(merged, null, 2) + "\n", "utf8")
      await fetch(endpoint.url + "/api/location/reload", {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(5000),
      }).catch(() => {})
      return json(res, 200, { ok: true, wrote: doc.path })
    }

    if (appPath === "/app/update/install" && req.method === "POST") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-cache" })
      hideEngineConsole(20000)
      const child = spawn("cmd", ["/c", "opencode", "upgrade"], { windowsHide: true })
      const pipe = (s) => s?.on("data", (c) => { if (!res.writableEnded) res.write(c) })
      pipe(child.stdout)
      pipe(child.stderr)
      child.on("error", (err) => { if (!res.writableEnded) res.write(`\nERROR: ${err}\n`) })
      res.on("close", () => { try { child.kill() } catch {} })
      child.on("close", (code) => { if (!res.writableEnded) res.end(`\n[exit ${code}]`) })
      return
    }

    if (appPath === "/app/service/restart" && req.method === "POST") {
      hideEngineConsole(35000)
      const chunks = []
      try {
        await new Promise((resolve) => {
          const child = spawn("cmd", ["/c", "opencode", "service", "restart"], { windowsHide: true })
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
    if (!res.headersSent) json(res, 500, { error: String(err) })
    else res.end()
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
