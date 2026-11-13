import http from "node:http"
import net from "node:net"
import os from "node:os"
import { spawn, spawnSync } from "node:child_process"
import fsSync from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"
import { applyEdits, modify, parse, printParseErrorCode } from "jsonc-parser"
import {
  addCustomRelay,
  deleteRelayById,
  deployAndAddRelay,
  forgetSavedToken,
  forwardViaRelays,
  getPublicState,
  getRelaySources,
  inspectVercelPlan,
  recycleRelayById,
  syncEngineProviderRouting,
  testRelayById,
  updateRelayConfig,
} from "./relay-manager.mjs"
import {
  psiphonConnect,
  psiphonDisconnect,
  psiphonProbeRegion,
  psiphonRenew,
  psiphonSetListener,
  psiphonSetSettings,
  psiphonStart,
  psiphonStop,
  psiphonTestAll,
  psiphonTestRegion,
  psiphonUpdateServers,
} from "./psiphon-manager.mjs"
import {
  TOOL_SERVER_NAME,
  ensureToolServerRegistered,
  fetchMcpStatus,
  reloadEngineConfig,
  restartToolServer,
} from "./tooling.mjs"

// Server-side messages that can reach the UI follow the language sent by the
// client (English by default). Engine/relay diagnostics keep their own text.
function requestLang(req) {
  const raw = String(req?.headers?.["accept-language"] ?? "").toLowerCase()
  return raw.includes("fa") ? "fa" : "en"
}

function pick(lang, en, fa) {
  return lang === "fa" ? fa : en
}

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

// server.mjs lives in app/server; the Vite app, tools and data live one level up.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const prod = process.argv.includes("--prod")
// let (نه const): اگر پورت را برنامهٔ دیگری گرفته باشد، به یک پورت آزاد مهاجرت
// می‌کنیم و hostAllowed/originAllowed هم باید پورت جدید را ببینند.
let PORT = Number(process.env.PORT || 5178)
const dirArg = process.argv.find((arg) => arg.startsWith("--dir="))
const workdir = path.resolve(process.env.OPENCODE_CHAT_DIR || (dirArg ? dirArg.slice(6) : process.cwd()))
const shouldOpen = process.argv.includes("--open")
let url = `http://127.0.0.1:${PORT}`

function openBrowser() {
  const child =
    process.platform === "win32"
      ? spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" })
      : spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { detached: true, stdio: "ignore" })
  child.on("error", () => {})
  child.unref()
}

// همان مسیری که @opencode/client برای ثبت سرویس استفاده می‌کند.
function serviceRegistrationPath() {
  const stateHome = process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state")
  return path.join(stateHome, "opencode", "service.json")
}

function readServiceInfoSync() {
  try {
    return JSON.parse(fsSync.readFileSync(serviceRegistrationPath(), "utf8"))
  } catch {
    return null
  }
}

// The Windows launcher starts the server detached and waits for this handshake
// file before closing its console window.
function writeLaunchStatus() {
  const file = process.env.OPENCODE_CHAT_STATUS_FILE
  if (!file) return
  try {
    fsSync.writeFileSync(
      file,
      JSON.stringify({ pid: process.pid, url, engine: endpoint?.url ?? "" }),
      "utf8",
    )
  } catch {}
}

function removeLaunchStatus() {
  const file = process.env.OPENCODE_CHAT_STATUS_FILE
  if (!file) return
  try {
    fsSync.unlinkSync(file)
  } catch {}
}

// روی ویندوز درخت کامل پروسه (و هر bun/فرزند باقی‌مانده) را می‌بندیم.
function killProcessTreeSync(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      })
    } catch {}
    return
  }
  try {
    process.kill(-pid, "SIGTERM")
  } catch {
    try {
      process.kill(pid, "SIGTERM")
    } catch {}
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

let hidingEngineConsole = false

function hideEngineConsole(ms = 30000) {
  if (process.platform !== "win32" || hidingEngineConsole) return
  hidingEngineConsole = true
  const seconds = Math.max(1, Math.ceil(ms / 1000))
  // یک پروسهٔ PowerShell برای کل بازه، به‌جای spawn هر ۵۰۰ میلی‌ثانیه.
  const script = [
    HIDE_CONSOLE_PS,
    `$deadline = (Get-Date).AddSeconds(${seconds})`,
    "while ((Get-Date) -lt $deadline) {",
    "  Get-Process opencode -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like '*serve --service*' } | ForEach-Object { [W32H]::ShowWindowAsync($_.MainWindowHandle, 0) | Out-Null }",
    "  Start-Sleep -Milliseconds 500",
    "}",
  ].join("\n")
  try {
    const child = spawn(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true, stdio: "ignore" },
    )
    child.on("error", () => { hidingEngineConsole = false })
    child.on("exit", () => { hidingEngineConsole = false })
    child.unref()
  } catch {
    hidingEngineConsole = false
  }
}

console.log("openchat: looking for the OpenCode engine (it will be started in the background if it is off)…")
let endpoint
let engineStartedByApp = false
try {
  const svc = await serviceCommand()
  if (svc) console.log("openchat: engine start command:", JSON.stringify(svc))
  hideEngineConsole(45000)
  endpoint = await Service.ensure({
    ...(svc ? { command: svc } : {}),
    onStart: () => {
      engineStartedByApp = true
    },
  })
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

// نسخهٔ موتور در پس‌زمینه تازه می‌شود و پاسخ‌ها هرگز منتظر موتور نمی‌مانند.
// این نکته حیاتی است: مسیر /__config مبنای تشخیص «قبلاً در حال اجراست» بود و
// وقتی منتظر موتور می‌ماند (تا ۳ ثانیه)، آن تشخیص شکست می‌خورد و برنامه به
// اشتباه می‌گفت «پورت اشغال است» در حالی که خودش صاحب پورت بود.
let engineVersion = info.version
let engineVersionAt = Date.now()
let refreshingEngineVersion = false

async function refreshEngineVersion() {
  if (refreshingEngineVersion) return
  refreshingEngineVersion = true
  try {
    const fresh = await client.server.info({ signal: AbortSignal.timeout(3000) })
    if (fresh?.version) {
      engineVersion = fresh.version
      engineVersionAt = Date.now()
    }
  } catch {
    // موتور ممکن است در حال ری‌استارت باشد؛ نسخهٔ کهنه نگه داشته می‌شود.
  } finally {
    refreshingEngineVersion = false
  }
}

async function resolveEngineConfigPath() {
  try {
    const cfgRes = await fetch(endpoint.url + "/api/config", { headers: { ...auth }, signal: AbortSignal.timeout(4000) })
    const cfg = await cfgRes.json().catch(() => null)
    const doc = (cfg?.data ?? cfg ?? []).find?.((e) => e?.type === "document" && e.path)
    if (doc?.path) return doc.path
  } catch {}
  return path.join(os.homedir(), ".config", "opencode", "opencode.json")
}

async function syncRelaysToEngine() {
  const cfgPath = await resolveEngineConfigPath()
  syncEngineProviderRouting(cfgPath, url)
  await fetch(endpoint.url + "/api/location/reload", {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(5000),
  }).catch(() => {})
}

// ---------------------------------------------------------------------------
// Bundled MCP tool hub
//
// The tools live in app/server/mcp. At startup we merge a local stdio server
// into the user's OpenCode config and reload it. Existing MCP servers and
// JSONC comments are preserved. The model sees the tools directly because
// codemode is disabled; no slash command or manual invocation is needed.
// ---------------------------------------------------------------------------
let toolServerState = {
  name: TOOL_SERVER_NAME,
  registered: false,
  changed: false,
  configPath: null,
  status: null,
  error: null,
  checkedAt: 0,
}

async function syncToolsToEngine({ reconnect = false } = {}) {
  const cfgPath = await resolveEngineConfigPath()
  try {
    const result = await ensureToolServerRegistered({ cfgPath, appRoot: root, workdir })
    toolServerState = {
      ...toolServerState,
      registered: true,
      changed: result.changed,
      configPath: result.path,
      error: null,
      checkedAt: Date.now(),
    }
    await reloadEngineConfig(endpoint.url, auth, 5000)
    if (result.changed) console.log(`openchat: local tools registered in ${result.path}`)
    // A config reload updates the server definition, but an already-connected
    // MCP process keeps its original tool catalog (including codemode). Force a
    // fresh handshake when requested; startup schedules this after the engine's
    // tool registry has settled, because a reconnect that is too early can be
    // missed by the registry's ToolsChanged subscription.
    if (reconnect) {
      const reconnected = await restartToolServer(endpoint.url, auth, 30_000)
      toolServerState.reconnected = reconnected
      if (!reconnected) console.warn("openchat: local tools registered but the MCP handshake did not complete yet")
    }
    // Give the engine a moment to finish the handshake, then record status.
    setTimeout(async () => {
      toolServerState.status = await fetchMcpStatus(endpoint.url, auth)
      toolServerState.checkedAt = Date.now()
    }, reconnect ? 900 : 1200)?.unref?.()
    return result
  } catch (error) {
    toolServerState = {
      ...toolServerState,
      registered: false,
      error: String(error?.message ?? error),
      checkedAt: Date.now(),
    }
    console.error(`openchat: could not register local tools: ${error?.message ?? error}`)
    return null
  }
}

// ---------------------------------------------------------------------------
// ظرفیت کانتکس و حداکثر خروجی مدل‌ها
//
// موتور OpenCode این اعداد را از models.dev و کاتالوگ پرووایدرها می‌خواند و
// برای چند مدلِ رایگانِ OpenCode مقدار پیش‌فرض (۲۰۰ هزار / ۳۲ هزار) را ثبت
// کرده — در حالی که سازندهٔ اصلی مدل، پنجرهٔ ۱ میلیونی اعلام کرده است.
//
// «model-limits.json» مرجع این پروژه است: مقادیری که از سایت خودِ پرووایدر یا
// سازندهٔ مدل تأیید شده‌اند. دو جا مصرف می‌شود:
//   ۱) نوشته می‌شود در تنظیمات موتور (providers.<id>.models.<model>.limit) تا
//      خود موتور هم عدد درست را در آستانهٔ فشرده‌سازی و در /api/model بدهد.
//   ۲) در رابط کاربری روی دادهٔ موتور اعمال می‌شود تا نمایش حتی پیش از نوشتن
//      در فایل پیکربندی هم درست باشد.
// ---------------------------------------------------------------------------
const MODEL_LIMITS_PATH = path.join(root, "data", "model-limits.json")
const TOOL_CATALOG_PATH = path.join(root, "data", "tool-catalog.json")
let toolCatalogCache = { at: 0, data: null }

async function readToolCatalog() {
  if (toolCatalogCache.data && Date.now() - toolCatalogCache.at < 30_000) return toolCatalogCache.data
  const data = JSON.parse(await fsp.readFile(TOOL_CATALOG_PATH, "utf8"))
  toolCatalogCache = { at: Date.now(), data }
  return data
}

function normalizeCatalog(raw) {
  const providers = {}
  for (const [pid, provider] of Object.entries(raw?.providers ?? {})) {
    const models = {}
    for (const [id, entry] of Object.entries(provider?.models ?? {})) {
      const context = Number(entry?.context)
      const output = Number(entry?.output)
      if (!Number.isFinite(context) || !Number.isFinite(output)) continue
      models[id] = {
        context,
        output,
        ...(entry?.source ? { source: entry.source } : {}),
        ...(entry?.note ? { note: entry.note } : {}),
        ...(entry?.verified ? { verified: true } : {}),
      }
    }
    if (Object.keys(models).length === 0) continue
    providers[pid] = { models }
  }
  return {
    version: Number(raw?.version) || 1,
    updatedAt: raw?.updatedAt ?? null,
    description: raw?.description ?? null,
    sources: raw?.sources ?? {},
    notes: raw?.notes ?? {},
    providers,
  }
}

let catalogCache = null
let catalogCacheMtime = 0
async function readModelLimits() {
  try {
    // ویرایش model-limits.json نباید تا ری‌استارت سرور نادیده بماند؛ mtime
    // تغییر فایل را تشخیص می‌دهد و کاتالوگ تازه خوانده می‌شود.
    const stat = await fsp.stat(MODEL_LIMITS_PATH)
    if (catalogCache && stat.mtimeMs === catalogCacheMtime) return catalogCache
    const raw = await fsp.readFile(MODEL_LIMITS_PATH, "utf8")
    catalogCache = normalizeCatalog(JSON.parse(raw))
    catalogCacheMtime = stat.mtimeMs
  } catch (err) {
    console.error("openchat: cannot read model-limits.json:", err?.message ?? err)
    catalogCache = normalizeCatalog({})
  }
  return catalogCache
}

async function fetchEngineModels() {
  try {
    const res = await fetch(endpoint.url + "/api/model", {
      headers: { ...auth },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return []
    const body = await res.json()
    return Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : []
  } catch {
    return []
  }
}

// برای هر مدلی که موتور الان ارائه می‌کند، مقدار کاتالوگ را برمی‌گرداند؛
// فقط وقتی «متفاوت» است که اعداد موتور با سند سازنده نخواند.
function modelLimitPlan(models, catalog) {
  const rows = []
  for (const model of models) {
    const providerID = model?.providerID
    const id = model?.id
    const entry = catalog?.providers?.[providerID]?.models?.[id]
    if (!entry) continue
    const engineContext = Number(model?.limit?.context)
    const engineOutput = Number(model?.limit?.output)
    const differs = engineContext !== entry.context || engineOutput !== entry.output
    rows.push({
      providerID,
      id,
      name: model?.name ?? id,
      context: entry.context,
      output: entry.output,
      engineContext,
      engineOutput,
      differs,
      verified: entry.verified === true,
      source: entry.source ?? null,
      note: entry.note ?? null,
    })
  }
  return rows
}

async function writeModelLimitsToConfig(cfgPath, rows) {
  const changed = rows.filter((r) => r.differs)
  if (changed.length === 0) return { wrote: false, changed: [] }
  let text = ""
  try {
    text = await fsp.readFile(cfgPath, "utf8")
  } catch {}
  let next = text
  const formattingOptions = { insertSpaces: true, tabSize: 2, eol: "\n" }
  for (const row of changed) {
    const edits = modify(
      next,
      ["providers", row.providerID, "models", row.id, "limit"],
      { context: row.context, output: row.output },
      { formattingOptions },
    )
    next = applyEdits(next, edits)
  }
  try {
    parseJsonc(next)
  } catch (err) {
    throw new Error(`produced invalid JSONC: ${err?.message ?? err}`)
  }
  if (next !== text) {
    const tmp = `${cfgPath}.tmp-${process.pid}-${Date.now()}`
    await fsp.writeFile(tmp, next, "utf8")
    await fsp.rename(tmp, cfgPath)
  }
  return { wrote: next !== text, changed }
}

let modelLimitsSync = null

async function syncModelLimits({ force = false } = {}) {
  // همگام‌سازی هم‌زمان دو بار (مثلاً شروع برنامه + دکمهٔ کاربر) می‌تواند فایل
  // پیکربندی را نیمه‌ویرایش‌شده رها کند؛ یک قفل ساده جلویش را می‌گیرد.
  if (modelLimitsSync) return modelLimitsSync
  modelLimitsSync = runModelLimitSync({ force }).finally(() => {
    modelLimitsSync = null
  })
  return modelLimitsSync
}

async function runModelLimitSync({ force = false } = {}) {
  const catalog = await readModelLimits()
  const models = await fetchEngineModels()
  const rows = modelLimitPlan(models, catalog)
  const cfgPath = await resolveEngineConfigPath()
  let wrote = false
  let changed = []
  try {
    const result = await writeModelLimitsToConfig(cfgPath, rows)
    wrote = result.wrote
    changed = result.changed
  } catch (err) {
    console.error("openchat: cannot write model limits:", err?.message ?? err)
  }
  if (wrote) {
    await fetch(endpoint.url + "/api/location/reload", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(8000),
    }).catch(() => {})
  }
  const summary = {
    catalogUpdatedAt: catalog.updatedAt,
    tracked: rows.length,
    changed: changed.map((r) => `${r.providerID}/${r.id} → ${r.context}/${r.output}`),
    wrote,
    configPath: cfgPath,
  }
  if (changed.length > 0) {
    console.log(
      `openchat: model limits synced (${changed.length} corrected): ${summary.changed.join(", ")}`,
    )
  } else if (force) {
    console.log("openchat: model limits already match the catalog")
  }
  return { ...summary, rows }
}

// ---------------------------------------------------------------------------
// Custom providers
//
// Providers added from Settings → Custom providers are stored in
// data/custom-providers.json (local UI state, including disabled entries) and
// the enabled ones are written into the engine's providers map. Keeping the
// UI list separate from the engine config means a provider can be switched off
// without losing its base URL, key and model list.
// ---------------------------------------------------------------------------
const CUSTOM_PROVIDERS_PATH = path.join(root, "data", "custom-providers.json")
const CUSTOM_PROVIDER_PACKAGES = {
  anthropic: "@opencode/ai/providers/anthropic-compatible",
  chat: "@opencode/ai/providers/openai-compatible",
  responses: "@opencode/ai/providers/openai-compatible/responses",
}
const CUSTOM_API_FORMATS = new Set(Object.keys(CUSTOM_PROVIDER_PACKAGES))

async function readCustomProviders() {
  try {
    const raw = JSON.parse(await fsp.readFile(CUSTOM_PROVIDERS_PATH, "utf8"))
    return { version: 1, providers: Array.isArray(raw?.providers) ? raw.providers : [] }
  } catch (err) {
    if (err?.code !== "ENOENT") {
      console.error("openchat: cannot read custom-providers.json:", err?.message ?? err)
    }
    return { version: 1, providers: [] }
  }
}

async function writeCustomProviders(data) {
  const out = JSON.stringify({ version: 1, providers: data.providers }, null, 2) + "\n"
  const tmp = `${CUSTOM_PROVIDERS_PATH}.tmp-${process.pid}-${Date.now()}`
  await fsp.writeFile(tmp, out, "utf8")
  await fsp.rename(tmp, CUSTOM_PROVIDERS_PATH)
}

function normalizeCustomProvider(raw, existing) {
  const id = String(raw?.id ?? "").trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) {
    throw new Error("Provider ID must start with a letter or digit and contain only a-z, 0-9, dot, dash or underscore.")
  }
  const baseURL = String(raw?.baseURL ?? "").trim().replace(/\/+$/, "")
  if (!/^https?:\/\//i.test(baseURL)) throw new Error("Base URL must start with http:// or https://.")
  try {
    new URL(baseURL)
  } catch {
    throw new Error("Base URL is not a valid URL.")
  }
  const api = CUSTOM_API_FORMATS.has(raw?.api) ? raw.api : "chat"
  const name = String(raw?.name ?? "").trim().slice(0, 120) || id
  let apiKey = typeof raw?.apiKey === "string" ? raw.apiKey.trim() : ""
  if (raw?.clearKey === true) apiKey = ""
  else if (!apiKey && existing?.apiKey) apiKey = existing.apiKey
  const models = []
  const seen = new Set()
  for (const item of Array.isArray(raw?.models) ? raw.models : []) {
    const modelId = String(item?.id ?? "").trim()
    if (!modelId || /\s/.test(modelId) || modelId.length > 160 || seen.has(modelId)) continue
    seen.add(modelId)
    const context = Math.trunc(Number(item?.context))
    const output = Math.trunc(Number(item?.output))
    models.push({
      id: modelId,
      ...(typeof item?.name === "string" && item.name.trim() ? { name: item.name.trim().slice(0, 160) } : {}),
      ...(Number.isFinite(context) && context > 0 ? { context } : {}),
      ...(Number.isFinite(output) && output > 0 ? { output } : {}),
    })
  }
  return {
    id,
    name,
    baseURL,
    api,
    apiKey,
    enabled: raw?.enabled !== false,
    models,
    updatedAt: new Date().toISOString(),
  }
}

function publicCustomProvider(provider) {
  const { apiKey, ...rest } = provider
  return { ...rest, apiKey: "", hasKey: Boolean(apiKey) }
}

function engineProviderFromCustom(provider) {
  const models = {}
  for (const model of provider.models) {
    const limit = {}
    if (model.context) limit.context = model.context
    if (model.output) limit.output = model.output
    models[model.id] = {
      ...(model.name ? { name: model.name } : {}),
      ...(Object.keys(limit).length > 0 ? { limit } : {}),
    }
  }
  const settings = { baseURL: provider.baseURL }
  if (provider.apiKey) settings.apiKey = provider.apiKey
  return {
    name: provider.name,
    package: CUSTOM_PROVIDER_PACKAGES[provider.api] ?? CUSTOM_PROVIDER_PACKAGES.chat,
    settings,
    models,
  }
}

async function readEngineProviderIds() {
  const cfgPath = await resolveEngineConfigPath()
  try {
    const text = await fsp.readFile(cfgPath, "utf8")
    const parsed = parseJsonc(text)
    return { cfgPath, ids: new Set(Object.keys(parsed?.providers ?? {})) }
  } catch {
    return { cfgPath, ids: new Set() }
  }
}

async function syncCustomProvidersToEngine(providers, removedIds = []) {
  const cfgPath = await resolveEngineConfigPath()
  let text = ""
  try {
    text = await fsp.readFile(cfgPath, "utf8")
  } catch {}
  let next = text
  const formattingOptions = { insertSpaces: true, tabSize: 2, eol: "\n" }
  for (const id of removedIds) {
    next = applyEdits(next, modify(next, ["providers", id], undefined, { formattingOptions }))
  }
  for (const provider of providers) {
    const value = provider.enabled ? engineProviderFromCustom(provider) : undefined
    next = applyEdits(next, modify(next, ["providers", provider.id], value, { formattingOptions }))
  }
  try {
    parseJsonc(next)
  } catch (err) {
    throw new Error(`produced invalid JSONC: ${err?.message ?? err}`)
  }
  if (next !== text) {
    const tmp = `${cfgPath}.tmp-${process.pid}-${Date.now()}`
    await fsp.writeFile(tmp, next, "utf8")
    await fsp.rename(tmp, cfgPath)
    await reloadEngineConfig(endpoint.url, auth, 6000).catch(() => {})
  }
  return { wrote: next !== text, configPath: cfgPath }
}

let customProvidersLock = Promise.resolve()
function withCustomProvidersLock(task) {
  const next = customProvidersLock.then(task, task)
  customProvidersLock = next.catch(() => {})
  return next
}

async function fetchCustomProviderModels({ baseURL, api, apiKey }) {
  const rootURL = String(baseURL ?? "").trim().replace(/\/+$/, "")
  if (!/^https?:\/\//i.test(rootURL)) throw new Error("Base URL must start with http:// or https://.")
  const target = `${rootURL}/models`
  const headers = { accept: "application/json" }
  if (api === "anthropic") {
    if (apiKey) headers["x-api-key"] = apiKey
    headers["anthropic-version"] = "2023-06-01"
  } else if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`
  }
  let upstream
  try {
    upstream = await fetch(target, { headers, signal: AbortSignal.timeout(15000) })
  } catch (err) {
    throw new Error(`Request failed: ${err?.message ?? err}`)
  }
  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => "")
    throw new Error(`Provider returned ${upstream.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`)
  }
  const body = await upstream.json().catch(() => null)
  const list = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : []
  const models = []
  const seen = new Set()
  for (const item of list) {
    const id = typeof item === "string" ? item : item?.id ?? item?.model ?? item?.name
    if (typeof id !== "string" || !id.trim() || seen.has(id.trim())) continue
    const modelId = id.trim()
    seen.add(modelId)
    const label = typeof item === "object" && item ? item.display_name ?? item.displayName ?? item.name ?? "" : ""
    models.push({ id: modelId, ...(label && label !== modelId ? { name: String(label) } : {}) })
    if (models.length >= 500) break
  }
  return models
}

async function saveCustomProvider(raw) {
  return withCustomProvidersLock(async () => {
    const data = await readCustomProviders()
    const id = String(raw?.id ?? "").trim().toLowerCase()
    const existing = data.providers.find((p) => p.id === id)
    if (!existing) {
      const engine = await readEngineProviderIds()
      if (engine.ids.has(id)) {
        const err = new Error(`Provider ID "${id}" already exists in the engine config.`)
        err.statusCode = 409
        throw err
      }
    }
    const provider = normalizeCustomProvider(raw, existing)
    const providers = existing
      ? data.providers.map((p) => (p.id === provider.id ? provider : p))
      : [...data.providers, provider]
    await writeCustomProviders({ providers })
    const sync = await syncCustomProvidersToEngine(providers)
    return { provider: publicCustomProvider(provider), providers: providers.map(publicCustomProvider), ...sync }
  })
}

async function deleteCustomProvider(id) {
  return withCustomProvidersLock(async () => {
    const data = await readCustomProviders()
    const provider = data.providers.find((p) => p.id === id)
    if (!provider) return { providers: data.providers.map(publicCustomProvider), removed: false }
    const providers = data.providers.filter((p) => p.id !== id)
    await writeCustomProviders({ providers })
    await syncCustomProvidersToEngine(providers, [id])
    return { providers: providers.map(publicCustomProvider), removed: true }
  })
}

// هر تغییری در تونل محلی باید مسیردهی موتور را دوباره همگام کند؛ مثل
// متصل‌شدن، قطع‌شدن یا ازکارافتادن یک منطقه. خودِ همگام‌سازی تغییر مسیر را
// فقط وقتی اعمال می‌کند که حداقل یک رله یا تونل فعال وجود داشته باشد.
psiphonSetListener(() => {
  void syncRelaysToEngine().catch((error) => {
    console.warn(`openchat: tunnel relay sync failed: ${error?.message ?? error}`)
  })
})
await syncRelaysToEngine()
await syncToolsToEngine()
// همگام‌سازی ظرفیت‌ها عمداً بلاک‌کننده نیست: راه‌اندازی پنل نباید منتظر موتور
// بماند. بعد از همگام‌سازی رله‌ها و ابزارها اجرا می‌شود تا دو نوشتنِ هم‌زمان روی
// فایل پیکربندی رخ ندهد.
void syncModelLimits()

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

async function checkEngineUpdate(force = false, lang = "en") {
  let current = info.version ?? "?"
  try {
    const fresh = await client.server.info({ signal: AbortSignal.timeout(3000) })
    if (fresh?.version) current = fresh.version
  } catch {}
  const latestInfo = await latestEngineVersion(force)
  const latest = latestInfo.latest
  const comparable = Boolean(versionParts(current) && versionParts(latest))
  const error = !latest
    ? latestInfo.error ?? pick(lang, "Couldn't fetch the latest version from npm", "دریافت آخرین نسخه از npm ممکن نشد")
    : !comparable
      ? pick(lang, "The current and latest versions cannot be compared", "نسخهٔ فعلی یا آخر قابل مقایسه نیست")
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
const UPLOAD_BODY_LIMIT = 40 * MB

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

// ---------------------------------------------------------------------------
// Folder browser for the project picker. The app is local-only, so the UI can
// browse real directories, but every response is still plain JSON and the
// caller only ever receives directory names/paths (never file contents).
// ---------------------------------------------------------------------------
const SKIP_FOLDER_NAMES = new Set([
  "node_modules",
  "$Recycle.Bin",
  "System Volume Information",
  ".git",
  ".hg",
  ".svn",
])
let folderPlacesCache = { at: 0, rows: [] }

async function withTimeout(promise, ms) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function isDirectory(target) {
  try {
    const stat = await withTimeout(fsp.stat(target), 700)
    return stat.isDirectory()
  } catch {
    return false
  }
}

async function listDriveRoots() {
  if (process.platform !== "win32") return [{ name: "/", path: "/" }]
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("")
  const rows = await Promise.all(
    letters.map(async (letter) => {
      const target = `${letter}:\\`
      return (await isDirectory(target)) ? { name: `${letter}:`, path: target } : null
    }),
  )
  return rows.filter(Boolean)
}

async function listFolderPlaces() {
  if (Date.now() - folderPlacesCache.at < 30_000 && folderPlacesCache.rows.length > 0) {
    return folderPlacesCache.rows
  }
  const home = os.homedir()
  const candidates = [
    { name: "Current project", path: workdir },
    { name: "Home", path: home },
    { name: "Desktop", path: path.join(home, "Desktop") },
    { name: "Documents", path: path.join(home, "Documents") },
    { name: "Downloads", path: path.join(home, "Downloads") },
  ]
  const seen = new Set()
  const rows = []
  for (const item of candidates) {
    const key = path.resolve(item.path).toLowerCase()
    if (seen.has(key)) continue
    if (!(await isDirectory(item.path))) continue
    seen.add(key)
    rows.push({ name: item.name, path: path.resolve(item.path) })
  }
  folderPlacesCache = { at: Date.now(), rows }
  return rows
}

async function folderListing(rawPath) {
  const target = path.resolve(rawPath || workdir)
  const stat = await fsp.stat(target).catch(() => null)
  if (!stat?.isDirectory()) {
    const err = new Error("folder not found")
    err.statusCode = 404
    throw err
  }
  let entries = []
  try {
    entries = await fsp.readdir(target, { withFileTypes: true })
  } catch {
    entries = []
  }
  const folders = []
  for (const entry of entries) {
    if (entry.name.startsWith(".") || SKIP_FOLDER_NAMES.has(entry.name)) continue
    const full = path.join(target, entry.name)
    if (entry.isDirectory()) {
      folders.push({ name: entry.name, path: full })
      continue
    }
    // Junctions/symlinks are common on Windows; include them only when they
    // resolve to a directory so the picker never offers a broken target.
    if (entry.isSymbolicLink() && (await isDirectory(full))) {
      folders.push({ name: entry.name, path: full })
    }
  }
  folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }))
  const parent = path.dirname(target)
  return {
    path: target,
    parent: parent && parent !== target ? parent : null,
    entries: folders,
    drives: await listDriveRoots(),
    places: await listFolderPlaces(),
    home: os.homedir(),
  }
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
        message: pick(
          requestLang(req),
          `Path must be absolute (for example C:\\Projects\\my-app): ${dir}`,
          `مسیر باید کامل باشد (مثلاً C:\\Projects\\my-app): ${dir}`,
        ),
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
  let pathname
  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    return json(res, 400, { error: "bad path" })
  }
  let file = path.join(dist, pathname)
  const rel = path.relative(dist, file)
  if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
    return json(res, 403, { error: "forbidden" })
  }
  try {
    const stat = await fsp.stat(file)
    if (stat.isDirectory()) file = path.join(file, "index.html")
  } catch {
    // فقط مسیرهای بدون پسوند (routeهای SPA) به index.html برمی‌گردند؛
    // asset گم‌شده باید 404 بگیرد تا خطای MIME جایگزین آن نشود.
    if (path.extname(pathname)) return json(res, 404, { error: "not found" })
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
      // نسخه هر بار در پس‌زمینه تازه می‌شود تا بعد از upgrade/restart، UI نسخهٔ
      // کهنهٔ زمان راه‌اندازی سرور را نشان ندهد. خودِ پاسخ هرگز منتظر موتور
      // نمی‌ماند تا تشخیص «قبلاً در حال اجراست» سریع و قطعی باشد.
      if (Date.now() - engineVersionAt > 5000) void refreshEngineVersion()
      return json(res, 200, {
        directory: workdir,
        upstream: endpoint.url,
        version: engineVersion,
        dev: !prod,
      })
    }

    // نقطهٔ سلامت سبک: هیچ وابستگی‌ای به موتور ندارد و فوری پاسخ می‌دهد.
    // تشخیص اینکه نمونهٔ دیگری از همین برنامه روی پورت هست از این مسیر
    // انجام می‌شود، پس هرگز نباید کند یا معلق بماند.
    if (appPath === "/__ping") {
      return json(res, 200, { ok: true, app: "opencode-chat" })
    }

    if (appPath === "/app/tools" && req.method === "GET") {
      const catalog = await readToolCatalog().catch(() => ({ tools: [] }))
      if (!toolServerState.status && Date.now() - toolServerState.checkedAt > 2000) {
        toolServerState.status = await fetchMcpStatus(endpoint.url, auth)
        toolServerState.checkedAt = Date.now()
      }
      return json(res, 200, {
        ok: true,
        server: TOOL_SERVER_NAME,
        ...toolServerState,
        status: toolServerState.status,
        catalog,
      })
    }

    if (appPath === "/app/tools/register" && req.method === "POST") {
      const result = await syncToolsToEngine({ reconnect: true })
      await new Promise((resolve) => setTimeout(resolve, 900))
      toolServerState.status = await fetchMcpStatus(endpoint.url, auth)
      toolServerState.checkedAt = Date.now()
      return json(res, result ? 200 : 500, {
        ok: Boolean(result),
        server: TOOL_SERVER_NAME,
        ...toolServerState,
        status: toolServerState.status,
      })
    }

    if (appPath === "/app/tools/status" && req.method === "POST") {
      toolServerState.status = await fetchMcpStatus(endpoint.url, auth)
      toolServerState.checkedAt = Date.now()
      return json(res, 200, { ok: true, server: TOOL_SERVER_NAME, ...toolServerState, status: toolServerState.status })
    }

    if (appPath === "/app/folders" && req.method === "GET") {
      try {
        const data = await folderListing(url.searchParams.get("path") ?? "")
        return json(res, 200, { ok: true, ...data })
      } catch (err) {
        return json(res, err?.statusCode ?? 400, {
          error: pick(requestLang(req), "That folder cannot be opened", "این پوشه باز نمی‌شود"),
        })
      }
    }

    if (appPath === "/app/folders/check" && req.method === "GET") {
      const target = String(url.searchParams.get("path") ?? "").trim()
      if (!target || !isAbsoluteDir(target)) {
        return json(res, 400, {
          error: pick(
            requestLang(req),
            "The path must be absolute (for example C:\\Projects\\my-app)",
            "مسیر باید کامل باشد (مثلاً C:\\Projects\\my-app)",
          ),
        })
      }
      if (!(await isDirectory(target))) {
        return json(res, 404, {
          error: pick(requestLang(req), `Folder not found: ${target}`, `پوشه پیدا نشد: ${target}`),
        })
      }
      return json(res, 200, { ok: true, path: path.resolve(target) })
    }

    if (appPath === "/app/upload" && req.method === "POST") {
      if (!requireJson(req, res)) return
      let raw
      try {
        raw = await readBody(req, UPLOAD_BODY_LIMIT)
      } catch (err) {
        if (err?.statusCode === 413) return json(res, 413, { error: pick(requestLang(req), "Request body is too large", "حجم درخواست بیش از حد مجاز است") })
        throw err
      }
      let body
      try {
        body = JSON.parse(raw ?? "{}")
      } catch {
        return json(res, 400, { error: "bad json body" })
      }
      // The composer sends every attachment as a base64 data URL. Images keep
      // their old path, but text files, PDFs, archives and other documents are
      // accepted too so the "+" button can attach anything the engine can read.
      const dataUrl = typeof body?.dataUrl === "string" ? body.dataUrl : ""
      const comma = dataUrl.indexOf(",")
      if (!dataUrl.startsWith("data:") || comma < 0) {
        return json(res, 400, {
          error: pick(requestLang(req), "The attachment is not a data URL", "پیوست یک data URL معتبر نیست"),
        })
      }
      const header = dataUrl.slice(5, comma)
      const mime = (header.split(";")[0] || "application/octet-stream").toLowerCase()
      if (!/;base64(?:;|$)/i.test(header)) {
        return json(res, 400, {
          error: pick(requestLang(req), "Only base64 attachments are accepted", "فقط پیوست base64 قابل قبول است"),
        })
      }
      const payload = dataUrl.slice(comma + 1).replace(/\s+/g, "")
      if (!/^[A-Za-z0-9+/=]+$/.test(payload)) {
        return json(res, 400, {
          error: pick(requestLang(req), "The attachment data is not valid base64", "دادهٔ پیوست base64 معتبر نیست"),
        })
      }
      const buf = Buffer.from(payload, "base64")
      if (buf.length === 0) {
        return json(res, 400, { error: pick(requestLang(req), "The attachment is empty", "پیوست خالی است") })
      }
      if (buf.length > 25 * 1024 * 1024) {
        return json(res, 413, {
          error: pick(requestLang(req), "File size exceeds 25 MB", "حجم فایل بیش از ۲۵MB است"),
        })
      }
      const extFromName = path.extname(String(body?.name ?? "")).toLowerCase()
      const safeExtFromName = /^\.[a-z0-9]{1,10}$/.test(extFromName) ? extFromName : ""
      const extByMime = {
        "image/png": "png",
        "image/jpeg": "jpg",
        "image/webp": "webp",
        "image/gif": "gif",
        "image/bmp": "bmp",
        "application/pdf": "pdf",
        "application/json": "json",
        "application/zip": "zip",
        "text/plain": "txt",
        "text/markdown": "md",
        "text/csv": "csv",
        "text/html": "html",
        "application/xml": "xml",
      }
      const ext = safeExtFromName || `.${extByMime[mime] ?? "bin"}`
      const name = `opencode-file-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`
      const target = path.join(os.tmpdir(), name)
      try {
        await fsp.writeFile(target, buf)
      } catch (err) {
        return json(res, 500, {
          error: pick(requestLang(req), `Failed to write the attachment: ${err}`, `نوشتن پیوست ناموفق: ${err}`),
        })
      }
      return json(res, 200, {
        ok: true,
        path: target,
        name: typeof body?.name === "string" && body.name.trim() ? body.name : name,
        mime,
        bytes: buf.length,
      })
    }

    if (appPath === "/app/config/write" && req.method === "POST") {
      if (!requireJson(req, res)) return
      let raw
      try {
        raw = await readBody(req, CONFIG_BODY_LIMIT)
      } catch (err) {
        if (err?.statusCode === 413) return json(res, 413, { error: pick(requestLang(req), "Settings payload is too large", "حجم تنظیمات بیش از حد مجاز است") })
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

    if (appPath === "/app/model-limits" && req.method === "GET") {
      const catalog = await readModelLimits()
      const models = await fetchEngineModels()
      const rows = modelLimitPlan(models, catalog)
      return json(res, 200, {
        catalog: {
          version: catalog.version,
          updatedAt: catalog.updatedAt,
          description: catalog.description,
          sources: catalog.sources,
          notes: catalog.notes,
          providers: catalog.providers,
        },
        rows,
        tracked: rows.length,
        pending: rows.filter((r) => r.differs).length,
      })
    }

    if (appPath === "/app/model-limits/apply" && req.method === "POST") {
      try {
        const result = await syncModelLimits({ force: true })
        return json(res, 200, { ok: true, ...result })
      } catch (err) {
        return json(res, 500, { error: String(err?.message ?? err) })
      }
    }

    if (appPath === "/app/custom-providers" && req.method === "GET") {
      const data = await readCustomProviders()
      return json(res, 200, {
        providers: data.providers.map(publicCustomProvider),
        configPath: await resolveEngineConfigPath(),
      })
    }

    if (appPath === "/app/custom-providers" && req.method === "POST") {
      if (!requireJson(req, res)) return
      let body
      try {
        body = JSON.parse((await readBody(req, CONFIG_BODY_LIMIT)) ?? "{}")
      } catch {
        return json(res, 400, { error: "bad json body" })
      }
      try {
        const result = await saveCustomProvider(body?.provider ?? body)
        return json(res, 200, { ok: true, ...result })
      } catch (err) {
        return json(res, err?.statusCode === 409 ? 409 : 400, { error: String(err?.message ?? err) })
      }
    }

    if (appPath === "/app/custom-providers/delete" && req.method === "POST") {
      if (!requireJson(req, res)) return
      let body
      try {
        body = JSON.parse((await readBody(req, CONFIG_BODY_LIMIT)) ?? "{}")
      } catch {
        return json(res, 400, { error: "bad json body" })
      }
      const id = String(body?.id ?? "").trim().toLowerCase()
      if (!id) return json(res, 400, { error: "id is required" })
      try {
        const result = await deleteCustomProvider(id)
        return json(res, 200, { ok: true, ...result })
      } catch (err) {
        return json(res, 500, { error: String(err?.message ?? err) })
      }
    }

    if (appPath === "/app/custom-providers/models" && req.method === "POST") {
      if (!requireJson(req, res)) return
      let body
      try {
        body = JSON.parse((await readBody(req, CONFIG_BODY_LIMIT)) ?? "{}")
      } catch {
        return json(res, 400, { error: "bad json body" })
      }
      let apiKey = typeof body?.apiKey === "string" ? body.apiKey.trim() : ""
      if (!apiKey) {
        const data = await readCustomProviders()
        const existing = data.providers.find((p) => p.id === String(body?.id ?? "").trim().toLowerCase())
        if (existing?.apiKey) apiKey = existing.apiKey
      }
      try {
        const models = await fetchCustomProviderModels({
          baseURL: body?.baseURL,
          api: body?.api,
          apiKey,
        })
        return json(res, 200, { ok: true, models })
      } catch (err) {
        return json(res, 502, { error: String(err?.message ?? err) })
      }
    }

    if (appPath.startsWith("/app/relay-gateway/")) {
      const rest = appPath.slice("/app/relay-gateway/".length)
      const slash = rest.indexOf("/")
      const scheme = slash > 0 ? rest.slice(0, slash) : "https"
      const hostAndPath = slash > 0 ? rest.slice(slash + 1) : rest
      if ((scheme !== "https" && scheme !== "http") || !hostAndPath) {
        return json(res, 400, { error: "bad relay-gateway target" })
      }
      const targetUrl = `${scheme}://${hostAndPath}${url.search}`
      const bodyBuf = await readBody(req, API_BODY_LIMIT)
      let upstream
      try {
        upstream = await forwardViaRelays(targetUrl, req.method || "GET", req.headers, bodyBuf, requestLang(req))
      } catch (err) {
        return json(res, 502, {
          error: {
            message: pick(
              requestLang(req),
              `Failed to send the request through the relay: ${err?.message ?? err}`,
              `خطا در ارسال درخواست از طریق رله: ${err?.message ?? err}`,
            ),
            type: "relay_gateway_error",
          },
        })
      }
      const outHeaders = {
        "content-type": upstream.headers.get("content-type") || "application/json",
        "cache-control": "no-cache, no-transform",
        "x-accel-buffering": "no",
      }
      const retryAfter = upstream.headers.get("retry-after")
      if (retryAfter) outHeaders["retry-after"] = retryAfter
      res.writeHead(upstream.status, outHeaders)
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
      return res.end()
    }

    if (appPath === "/app/relays" && req.method === "GET") {
      return json(res, 200, getPublicState())
    }

    if (appPath === "/app/relays/psiphon/status" && req.method === "GET") {
      const state = getPublicState()
      return json(res, 200, { ok: true, status: state.psiphon, state })
    }

    if (appPath === "/app/relays/psiphon/settings" && req.method === "POST") {
      if (!requireJson(req, res)) return
      const raw = await readBody(req, CONFIG_BODY_LIMIT)
      let body
      try {
        body = JSON.parse(raw ?? "{}")
      } catch {
        return json(res, 400, { error: "bad json body" })
      }
      try {
        const status = await psiphonSetSettings(body, requestLang(req))
        await syncRelaysToEngine()
        return json(res, 200, { ok: true, status, state: getPublicState() })
      } catch (err) {
        return json(res, 400, { error: String(err?.message ?? err), state: getPublicState() })
      }
    }

    if (appPath === "/app/relays/psiphon/connect" && req.method === "POST") {
      if (!requireJson(req, res)) return
      try {
        const status = await psiphonConnect(requestLang(req))
        await syncRelaysToEngine()
        return json(res, 200, { ok: true, status, state: getPublicState() })
      } catch (err) {
        return json(res, 400, { error: String(err?.message ?? err), state: getPublicState() })
      }
    }

    if (appPath === "/app/relays/psiphon/disconnect" && req.method === "POST") {
      if (!requireJson(req, res)) return
      try {
        const status = await psiphonDisconnect(requestLang(req))
        await syncRelaysToEngine()
        return json(res, 200, { ok: true, status, state: getPublicState() })
      } catch (err) {
        return json(res, 400, { error: String(err?.message ?? err), state: getPublicState() })
      }
    }

    if (appPath === "/app/relays/psiphon/update" && req.method === "POST") {
      if (!requireJson(req, res)) return
      try {
        const status = await psiphonUpdateServers(requestLang(req))
        return json(res, 200, { ok: true, status, state: getPublicState() })
      } catch (err) {
        return json(res, 400, { error: String(err?.message ?? err), state: getPublicState() })
      }
    }

    if (appPath === "/app/relays/psiphon/renew" && req.method === "POST") {
      if (!requireJson(req, res)) return
      const raw = await readBody(req, CONFIG_BODY_LIMIT)
      let body
      try {
        body = JSON.parse(raw ?? "{}")
      } catch {
        return json(res, 400, { error: "bad json body" })
      }
      try {
        const changed = await psiphonRenew(String(body?.region || ""), requestLang(req), false, String(body?.scope || ""))
        return json(res, 200, { ok: true, changed, state: getPublicState() })
      } catch (err) {
        return json(res, 400, { error: String(err?.message ?? err), state: getPublicState() })
      }
    }

    if (appPath === "/app/relays/psiphon/test" && req.method === "POST") {
      if (!requireJson(req, res)) return
      const raw = await readBody(req, CONFIG_BODY_LIMIT)
      let body
      try {
        body = JSON.parse(raw ?? "{}")
      } catch {
        return json(res, 400, { error: "bad json body" })
      }
      const lang = requestLang(req)
      const region = String(body?.region || body?.id || "").replace(/^psiphon:/i, "").toUpperCase()
      try {
        const results = region
          ? [{ region, ...(await psiphonTestRegion(region, lang)) }]
          : await psiphonTestAll(lang)
        return json(res, 200, { ok: true, results, state: getPublicState() })
      } catch (err) {
        return json(res, 400, { error: String(err?.message ?? err), state: getPublicState() })
      }
    }

    if (appPath === "/app/relays/psiphon/probe" && req.method === "POST") {
      if (!requireJson(req, res)) return
      const raw = await readBody(req, CONFIG_BODY_LIMIT)
      let body
      try {
        body = JSON.parse(raw ?? "{}")
      } catch {
        return json(res, 400, { error: "bad json body" })
      }
      const lang = requestLang(req)
      const region = String(body?.region || body?.id || "").replace(/^psiphon:/i, "").toUpperCase()
      try {
        const result = await psiphonProbeRegion(region, lang)
        return json(res, 200, { ok: true, result, state: getPublicState() })
      } catch (err) {
        return json(res, 400, { error: String(err?.message ?? err), state: getPublicState() })
      }
    }

    if (appPath === "/app/relays/sources" && req.method === "GET") {
      return json(res, 200, getRelaySources())
    }

    if (appPath === "/app/relays/config" && req.method === "POST") {
      if (!requireJson(req, res)) return
      const raw = await readBody(req, CONFIG_BODY_LIMIT)
      let body
      try {
        body = JSON.parse(raw ?? "{}")
      } catch {
        return json(res, 400, { error: "bad json body" })
      }
      const state = updateRelayConfig(body)
      await syncRelaysToEngine()
      return json(res, 200, state)
    }

    if (appPath === "/app/relays/deploy" && req.method === "POST") {
      if (!requireJson(req, res)) return
      const raw = await readBody(req, CONFIG_BODY_LIMIT)
      const body = JSON.parse(raw ?? "{}")
      try {
        const entry = await deployAndAddRelay({ ...body, lang: requestLang(req) })
        await syncRelaysToEngine()
        return json(res, 200, { ok: true, relay: entry, state: getPublicState() })
      } catch (err) {
        return json(res, 400, { error: String(err?.message ?? err) })
      }
    }

    if (appPath === "/app/relays/add" && req.method === "POST") {
      if (!requireJson(req, res)) return
      const raw = await readBody(req, CONFIG_BODY_LIMIT)
      const body = JSON.parse(raw ?? "{}")
      try {
        const entry = await addCustomRelay({ ...body, lang: requestLang(req) })
        await syncRelaysToEngine()
        return json(res, 200, { ok: true, relay: entry, state: getPublicState() })
      } catch (err) {
        return json(res, 400, { error: String(err?.message ?? err) })
      }
    }

    if (appPath === "/app/relays/test" && req.method === "POST") {
      if (!requireJson(req, res)) return
      const raw = await readBody(req, CONFIG_BODY_LIMIT)
      const body = JSON.parse(raw ?? "{}")
      try {
        const result = await testRelayById(String(body?.id || ""), requestLang(req))
        return json(res, 200, { ...result, state: getPublicState() })
      } catch (err) {
        return json(res, 400, { error: String(err?.message ?? err), state: getPublicState() })
      }
    }

    if (appPath === "/app/relays/recycle" && req.method === "POST") {
      if (!requireJson(req, res)) return
      const raw = await readBody(req, CONFIG_BODY_LIMIT)
      const body = JSON.parse(raw ?? "{}")
      try {
        const result = await recycleRelayById(String(body?.id || ""), requestLang(req))
        return json(res, 200, { ...result, state: getPublicState() })
      } catch (err) {
        return json(res, 400, { error: String(err?.message ?? err), state: getPublicState() })
      }
    }

    if (appPath === "/app/relays/delete" && req.method === "POST") {
      if (!requireJson(req, res)) return
      const raw = await readBody(req, CONFIG_BODY_LIMIT)
      const body = JSON.parse(raw ?? "{}")
      try {
        deleteRelayById(String(body?.id || ""), requestLang(req))
        await syncRelaysToEngine()
        return json(res, 200, { ok: true, state: getPublicState() })
      } catch (err) {
        return json(res, 400, { error: String(err?.message ?? err) })
      }
    }

    if (appPath === "/app/relays/inspect" && req.method === "POST") {
      if (!requireJson(req, res)) return
      const raw = await readBody(req, CONFIG_BODY_LIMIT)
      const body = JSON.parse(raw ?? "{}")
      try {
        const info = await inspectVercelPlan({ ...body, lang: requestLang(req) })
        return json(res, 200, { ...info, state: getPublicState() })
      } catch (err) {
        return json(res, 400, { error: String(err?.message ?? err) })
      }
    }

    if (appPath === "/app/relays/token/forget" && req.method === "POST") {
      if (!requireJson(req, res)) return
      const raw = await readBody(req, CONFIG_BODY_LIMIT)
      const body = JSON.parse(raw ?? "{}")
      try {
        const state = forgetSavedToken(String(body?.platform || ""), requestLang(req))
        return json(res, 200, { ok: true, state })
      } catch (err) {
        return json(res, 400, { error: String(err?.message ?? err) })
      }
    }

    if (appPath === "/app/update/check" && req.method === "GET") {
      return json(res, 200, await checkEngineUpdate(url.searchParams.get("force") === "1", requestLang(req)))
    }

    if (appPath === "/app/update/install" && req.method === "POST") {
      if (!requireLocalHeader(req, res)) return
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-cache" })
      hideEngineConsole(20000)
      const [command, ...commandArgs] = await opencodeCommand(["upgrade"])
      const child = spawn(command, commandArgs, { windowsHide: true })
      const write = (chunk) => {
        try {
          if (!res.destroyed && !res.writableEnded) res.write(chunk)
        } catch {}
      }
      const pipe = (s) => s?.on("data", write)
      pipe(child.stdout)
      pipe(child.stderr)
      child.on("error", (err) => write(`\nERROR: ${err}\n`))
      // اگر کاربر صفحه را ببندد، upgrade باید تا آخر اجرا شود؛ کشتن نیمه‌کارهٔ
      // نصب می‌تواند CLI را خراب کند.
      child.on("close", (code) => {
        try {
          if (!res.destroyed && !res.writableEnded) res.end(`\n[exit ${code}]`)
        } catch {}
      })
      return
    }

    if (appPath === "/app/exit" && req.method === "POST") {
      if (!requireLocalHeader(req, res)) return
      // پاسخ را کامل می‌فرستیم و بعد سرور و موتور را می‌بندیم؛ این کار از
      // خطای شبکه در مرورگر هنگام خاموش‌شدن سرویس جلوگیری می‌کند.
      json(res, 200, { ok: true, stopping: true })
      setTimeout(() => void shutdown("exit requested from the panel", 0), 150)
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

// بررسی می‌کند آیا نمونهٔ دیگری از همین برنامه روی این پورت در حال اجراست.
// نسخهٔ قبلی این بررسی را روی /__config با مهلت ۸۰۰ میلی‌ثانیه انجام می‌داد،
// ولی /__config منتظر موتور می‌ماند؛ در نتیجه وقتی موتور کند بود، بررسی
// شکست می‌خورد و برنامه به‌اشتباه می‌گفت «پورت را برنامهٔ دیگری گرفته» —
// در حالی که خودِ برنامه صاحب پورت بود. حالا از /__ping استفاده می‌شود که
// هیچ وابستگی‌ای به موتور ندارد و فوری پاسخ می‌دهد.
function probeApp(target, timeout = 2000) {
  return new Promise((resolve) => {
    const req = http.get(`${target}/__ping`, { timeout }, (res) => {
      let body = ""
      res.setEncoding("utf8")
      res.on("data", (chunk) => (body += chunk))
      res.on("end", () => {
        try {
          resolve(JSON.parse(body)?.app === "opencode-chat")
        } catch {
          resolve(false)
        }
      })
    })
    req.on("timeout", () => {
      req.destroy()
      resolve(false)
    })
    req.on("error", () => resolve(false))
  })
}

// یک پورت آزاد روی loopback پیدا می‌کند. به‌جای اینکه به کاربر بگوییم
// «PORT را تنظیم کن»، خودمان مهاجرت می‌کنیم؛ این برای اجرای دوبار کلیکی
// روی فایل .cmd خیلی مهم است.
function findFreePort(start) {
  return new Promise((resolve) => {
    const tryPort = (port) => {
      const tester = net.createServer()
      tester.unref()
      tester.once("error", () => {
        tester.close()
        if (port >= start + 50) return resolve(null)
        tryPort(port + 1)
      })
      tester.listen(port, "127.0.0.1", () => {
        tester.close(() => resolve(port))
      })
    }
    tryPort(start)
  })
}

// ---------------------------------------------------------------------------
// چرخهٔ عمر موتور
//
// موتور با detached:true اجرا می‌شود و به همین دلیل با بستن پنجرهٔ CMD زنده
// می‌ماند. این بخش تضمین می‌کند با خروج برنامه، سرویس و فرزندانش (مثل bun)
// هم بسته شوند. OPENCODE_CHAT_KEEP_ENGINE=1 برای اشتراک با TUI مفید است.
let engineCleanupEnabled = false
let engineCleanupDone = false
let shuttingDown = false
let engineWatcher = null

function startEngineWatchdog() {
  if (process.env.OPENCODE_CHAT_KEEP_ENGINE === "1" || engineWatcher) return
  try {
    // یک ناظر جداگانه: اگر پنجرهٔ کنسول مستقیم بسته شود Node هیچ سیگنالی
    // نمی‌گیرد؛ این پروسهٔ کوچک مرگ والد را می‌بیند و موتور را می‌بندد.
    const child = spawn(
      process.execPath,
      [path.join(root, "tools", "service-watchdog.mjs"), String(process.pid), serviceRegistrationPath()],
      { detached: true, windowsHide: true, stdio: "ignore" },
    )
    child.on("error", () => {})
    child.unref()
    engineWatcher = child
  } catch {}
}

function stopEngineSync() {
  if (engineCleanupDone) return
  // قبل از listen، فقط موتوری را می‌بندیم که خود همین پروسه راه انداخته است.
  // این کار جلوی بسته‌شدن هستهٔ مشترک توسط نمونهٔ دوم/ناموفق را می‌گیرد.
  if (!engineCleanupEnabled && !engineStartedByApp) return
  engineCleanupDone = true
  if (process.env.OPENCODE_CHAT_KEEP_ENGINE === "1") return
  const serviceInfo = readServiceInfoSync()
  if (serviceInfo?.pid) killProcessTreeSync(serviceInfo.pid)
}

async function shutdown(reason, code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  removeLaunchStatus()
  psiphonSetListener(undefined)
  await psiphonStop().catch((error) => {
    console.warn(`openchat: tunnel stop failed: ${error?.message ?? error}`)
  })
  if (!engineCleanupEnabled && !engineStartedByApp) {
    // A duplicate/failed instance that never owned the engine must leave the
    // primary instance's service untouched.
    process.exit(code)
  }
  console.log(`\n  openchat: ${reason}; stopping the OpenCode engine${engineStartedByApp ? "" : " (shared service)"}…`)
  try {
    server.close()
  } catch {}
  if (process.env.OPENCODE_CHAT_KEEP_ENGINE !== "1") {
    // pid را قبل از Service.stop می‌خوانیم؛ خودِ stop فایل ثبت را پاک می‌کند.
    const serviceInfo = readServiceInfoSync()
    try {
      await Service.stop({ pty: "clear" })
    } catch {}
    if (serviceInfo?.pid) killProcessTreeSync(serviceInfo.pid)
  }
  engineCleanupDone = true
  try {
    engineWatcher?.kill()
  } catch {}
  process.exit(code)
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
  try {
    process.on(signal, () => {
      void shutdown(signal, 0)
    })
  } catch {}
}
// آخرین سد دفاعی برای خروج‌های غیرمنتظره (نه بستن مستقیم پنجره؛ آن را
// service-watchdog انجام می‌دهد).
process.on("exit", stopEngineSync)

async function hasRunningSessions() {
  try {
    const res = await fetch(`${endpoint.url}/api/session/active`, {
      headers: { ...auth },
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) return false
    const body = await res.json().catch(() => null)
    const active = body?.data ?? body ?? {}
    return Object.values(active).some((entry) => entry?.type === "running")
  } catch {
    return false
  }
}

let toolsReconnectScheduled = false
function onListening() {
  console.log(`\n  opencode-chat  ${url}`)
  console.log(`  engine         ${endpoint.url} (v${info.version})`)
  console.log(`  working dir    ${workdir}`)
  console.log(`\n  close this window or use Exit in the panel to stop everything (the engine is stopped too).\n`)
  engineCleanupEnabled = true
  startEngineWatchdog()
  writeLaunchStatus()
  // تونل فقط بعد از گرفتن پورت اصلی بالا می‌آید؛ نمونهٔ تکراری که با
  // EADDRINUSE خارج می‌شود نباید پروسهٔ تونل جداگانه بسازد.
  void psiphonStart().catch((error) => {
    console.warn(`openchat: tunnel start failed: ${error?.message ?? error}`)
  })
  if (shouldOpen) setTimeout(openBrowser, 300)
  // Reconnect once after the engine's tool registry has settled. The initial
  // MCP handshake can happen before that registry subscribes to ToolsChanged,
  // leaving the model with an empty tool catalog until a manual reconnect.
  if (!toolsReconnectScheduled) {
    toolsReconnectScheduled = true
    const reconnectWhenIdle = async () => {
      // Never interrupt a run that was already in progress when the app
      // started. If one is active, leave the current connection alone; the
      // Tools tab has a manual Reconnect button for that case.
      if (await hasRunningSessions()) {
        console.log("openchat: tools reconnect skipped because a session is running")
        return
      }
      await syncToolsToEngine({ reconnect: true })
        .then(() => console.log("openchat: local tools reconnected for the model"))
        .catch((error) => console.warn(`openchat: tool reconnect failed: ${error?.message ?? error}`))
    }
    setTimeout(() => void reconnectWhenIdle(), 3000)?.unref?.()
  }
}

// فقط یک‌بار ثبت می‌شود: اگر listen با callback صدا زده شود، Node یک شنوندهٔ
// تازهٔ 'listening' اضافه می‌کند و با هر تلاش دوبارهٔ listen، بنر راه‌اندازی
// چند بار چاپ می‌شد.
server.on("listening", onListening)

let fallbackAttempts = 0
server.on("error", async (err) => {
  if (err?.code !== "EADDRINUSE") {
    console.error("server error:", err)
    process.exit(1)
  }
  // ۱) آیا همین برنامه از قبل روی این پورت در حال اجراست؟ → فقط مرورگر باز شود.
  if (await probeApp(url)) {
    console.log(`\n  already running at ${url}\n`)
    if (shouldOpen) openBrowser()
    process.exit(0)
  }
  // ۲) پورت را برنامهٔ دیگری گرفته → یک پورت آزاد پیدا کن و همان‌جا بالا بیا.
  if (fallbackAttempts >= 3) {
    console.error(`\n  could not bind any port near ${PORT}. Close the program using it and try again.\n`)
    process.exit(1)
  }
  fallbackAttempts += 1
  const free = await findFreePort(PORT + 1)
  if (!free) {
    console.error(`\n  port ${PORT} is used by another program and no free port was found.`)
    console.error(`  Close whatever is using port ${PORT} and try again.\n`)
    process.exit(1)
  }
  console.warn(`\n  port ${PORT} is used by another program - continuing on ${free} instead.`)
  PORT = free
  url = `http://127.0.0.1:${PORT}`
  // مسیر رله‌ها باید به پورت جدید اشاره کند، نه پورت قبلی.
  await syncRelaysToEngine().catch(() => {})
  server.listen(PORT, "127.0.0.1")
})

server.listen(PORT, "127.0.0.1")
