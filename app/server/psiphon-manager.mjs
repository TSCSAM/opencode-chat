// Local multi-region tunnel route.
//
// One official tunnel client runs for each selected region. Every client has
// its own data directory and a loopback SOCKS5 port, and the relay manager can
// send a request through any connected region. Requests never leave this
// computer in cleartext: the local client builds the tunnel and the request is
// made through its SOCKS5 listener.
import { spawn } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import { accessSync, constants as fsConstants } from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  fetch as undiciFetch,
  Headers as UndiciHeaders,
  Response as UndiciResponse,
  Socks5ProxyAgent,
} from "undici"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const APP_ROOT = path.resolve(__dirname, "..")
const IS_WIN = process.platform === "win32"
const IS_LINUX_X64 = process.platform === "linux" && process.arch === "x64"
const REGION = /^[A-Z]{2}$/
const KNOWN = ["BE", "CA", "CH", "DE", "DK", "ES", "FR", "GB", "IE", "IN", "IT", "JP", "NL", "NO", "PL", "SE", "SG", "US"]
const MAX_REGIONS = 18
const MAX_RENEWALS_PER_HOUR = 3
const RENEWAL_WINDOW = 60 * 60 * 1000
const PROBE_TIMEOUT = 45_000
const NODE_STORE = "ca.psiphon.PsiphonTunnel.tunnel-core"
const TRACE_URLS = ["https://opencode.ai/cdn-cgi/trace", "https://www.cloudflare.com/cdn-cgi/trace"]
const TLS_OPTIONS = {
  // Keep a browser-like order. Some upstream services inspect the ClientHello.
  ciphers:
    "TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:" +
    "ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:" +
    "ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:" +
    "ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305",
  ecdhCurve: "X25519:P-256:P-384",
  minVersion: "TLSv1.2",
}

function tr(lang, en, fa) {
  return lang === "fa" ? fa : en
}

function configBase() {
  if (process.env.OPENCODE_CHAT_PSIPHON_CONFIG_DIR) {
    return path.resolve(process.env.OPENCODE_CHAT_PSIPHON_CONFIG_DIR)
  }
  if (IS_WIN) return path.join(os.homedir(), ".config", "opencode")
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "opencode")
}

function storePath() {
  const base = configBase()
  fs.mkdirSync(base, { recursive: true })
  return path.join(base, "psiphon.json")
}

function runtimeRoot() {
  return path.join(configBase(), "psiphon")
}

const defaults = () => ({
  version: 1,
  enabled: true,
  autoStart: false,
  wasConnected: false,
  regions: [],
  mode: "spread",
  pinned: "",
  skip: true,
  renew: true,
  available: [...KNOWN],
  updatedAt: 0,
  spent: {},
  kilo: {},
  renewedAt: {},
})

function normalizeConfig(raw) {
  const base = defaults()
  const src = raw && typeof raw === "object" ? raw : {}
  const config = { ...base, ...src }
  config.enabled = src.enabled !== false
  config.autoStart = !!src.autoStart
  config.wasConnected = !!src.wasConnected
  config.skip = src.skip !== false
  config.renew = src.renew !== false
  config.mode = src.mode === "single" ? "single" : "spread"
  config.available = Array.isArray(src.available)
    ? uniqueRegions(src.available)
    : [...KNOWN]
  if (config.available.length === 0) config.available = [...KNOWN]
  config.regions = Array.isArray(src.regions) ? uniqueRegions(src.regions).slice(0, MAX_REGIONS) : []
  config.pinned = REGION.test(String(src.pinned || "").toUpperCase()) ? String(src.pinned).toUpperCase() : ""
  if (config.mode === "single" && !config.regions.includes(config.pinned)) config.pinned = config.regions[0] || ""
  config.updatedAt = Number(src.updatedAt) || 0
  config.spent = cleanUntilMap(src.spent)
  config.kilo = cleanUntilMap(src.kilo)
  config.renewedAt = cleanRenewalMap(src.renewedAt)
  return config
}

function cleanUntilMap(value) {
  const out = {}
  if (!value || typeof value !== "object") return out
  const now = Date.now()
  for (const [ip, until] of Object.entries(value)) {
    const t = Number(until) || 0
    if (ip && t > now) out[ip] = t
  }
  return out
}

function cleanRenewalMap(value) {
  const out = {}
  if (!value || typeof value !== "object") return out
  const now = Date.now()
  for (const [region, list] of Object.entries(value)) {
    if (!REGION.test(region) || !Array.isArray(list)) continue
    const kept = list.map(Number).filter((t) => t > now - RENEWAL_WINDOW).sort()
    if (kept.length) out[region] = kept
  }
  return out
}

function uniqueRegions(list) {
  return [...new Set(list.map((r) => String(r).toUpperCase()).filter((r) => REGION.test(r)))].sort()
}

function loadConfig() {
  try {
    return normalizeConfig(JSON.parse(fs.readFileSync(storePath(), "utf8")))
  } catch {
    return defaults()
  }
}

let config = loadConfig()

function saveConfigNow() {
  const file = storePath()
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  try {
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2), "utf8")
    fs.renameSync(tmp, file)
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true })
    } catch {}
    console.warn(`[psiphon] Could not save settings: ${err?.message || err}`)
  }
}

let saveTimer
function saveConfig() {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = undefined
    saveConfigNow()
  }, 350)
  saveTimer.unref?.()
}

// ---------------------------------------------------------------------------
// Bundled client discovery
// ---------------------------------------------------------------------------

function coreName() {
  if (IS_WIN) return "psiphon-tunnel-core-windows-i686.exe"
  if (IS_LINUX_X64) return "psiphon-tunnel-core-linux-amd64"
  return ""
}

function clientFolders() {
  return [
    process.env.OPENCODE_CHAT_PSIPHON_DIR || "",
    path.join(__dirname, "psiphon"),
    path.join(APP_ROOT, "psiphon"),
    path.join(path.dirname(process.execPath), "psiphon"),
    process.resourcesPath ? path.join(process.resourcesPath, "psiphon") : "",
  ].filter(Boolean)
}

function isRunnable(file) {
  try {
    if (!fs.statSync(file).isFile()) return false
    if (!IS_WIN) accessSync(file, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

function findClient() {
  const name = coreName()
  if (!name) return null
  for (const folder of clientFolders()) {
    const core = path.join(folder, name)
    if (!isRunnable(core)) continue
    if (!fs.existsSync(path.join(folder, "psiphon.json"))) continue
    if (!fs.existsSync(path.join(folder, "server-list.dat"))) continue
    return { core, folder, name }
  }
  return null
}

function missingInfo() {
  const name = coreName()
  if (!name) {
    return {
      code: "unsupported",
      detail: `${process.platform}-${process.arch}`,
      message: `The bundled tunnel client does not support this platform (${process.platform} ${process.arch}).`,
    }
  }
  const expected = clientFolders().map((folder) => path.join(folder, name))
  const unreadable = expected.find((file) => {
    try {
      return fs.statSync(file).isFile() && !isRunnable(file)
    } catch {
      return false
    }
  })
  if (unreadable) {
    return {
      code: "not_executable",
      detail: unreadable,
      message: `The tunnel client at ${unreadable} is not executable. On Linux run: chmod +x "${unreadable}"`,
    }
  }
  return {
    code: "missing",
    detail: expected[0] || "",
    message: "The bundled tunnel client is missing from this build.",
  }
}

function ensureExecutable(core) {
  if (IS_WIN) return
  try {
    accessSync(core, fsConstants.X_OK)
  } catch {
    fs.chmodSync(core, 0o755)
  }
}

// ---------------------------------------------------------------------------
// Runtime state
// ---------------------------------------------------------------------------

const instances = new Map()
const probeRuns = new Set()
let probeJob
let starting = new Map()
let epoch = 0
let busy = ""
let lastError = ""
let monitor
let changeListener
let changeTimer
let roundRobin = 0

function notifyChange() {
  if (!changeListener) return
  if (changeTimer) return
  changeTimer = setTimeout(() => {
    changeTimer = undefined
    try {
      changeListener()
    } catch {}
  }, 450)
  changeTimer.unref?.()
}

export function psiphonSetListener(fn) {
  changeListener = typeof fn === "function" ? fn : undefined
}

function regionDir(region) {
  return path.join(runtimeRoot(), "regions", region.toLowerCase())
}

function nodesDir() {
  return path.join(runtimeRoot(), "nodes")
}

function storeOf(dir) {
  return path.join(dir, NODE_STORE)
}

function usedPorts(except) {
  const used = new Set()
  for (const inst of instances.values()) if (inst.region !== except) used.add(inst.port)
  return used
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const port = server.address()?.port
      server.close(() => (port ? resolve(port) : reject(new Error("No free port"))))
    })
  })
}

async function pickPort(previous, region) {
  const used = usedPorts(region)
  if (previous && !used.has(previous)) return previous
  for (let i = 0; i < 30; i++) {
    const port = await freePort()
    if (!used.has(port)) return port
  }
  throw new Error("Could not reserve a local port for the tunnel.")
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(predicate, timeoutMs, intervalMs = 250) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (predicate()) return true
    await sleep(intervalMs)
  }
  return false
}

function scopeOfHost(target) {
  let host = ""
  try {
    host = typeof target === "string" && target.includes("://") ? new URL(target).hostname : String(target || "")
  } catch {
    host = String(target || "")
  }
  host = host.toLowerCase()
  if (host === "opencode.ai" || host.endsWith(".opencode.ai")) return "opencode"
  if (host === "kilo.ai" || host.endsWith(".kilo.ai")) return "kilo"
  return "other"
}

function spentUntil(ip, scope) {
  if (!ip) return 0
  const map = scope === "kilo" ? config.kilo : scope === "opencode" ? config.spent : null
  const until = map?.[ip] || 0
  return until > Date.now() ? until : 0
}

function blockedUntil(inst, scope) {
  const until = inst?.blockedUntil?.[scope] || 0
  return until > Date.now() ? until : 0
}

function isBlocked(inst, scope) {
  if (!config.skip) return false
  if (inst.recheck === scope) return true
  return !!blockedUntil(inst, scope) || !!spentUntil(inst.exitIp, scope)
}

function renewalCount(region) {
  const now = Date.now()
  const list = (config.renewedAt[region] || []).filter((t) => t > now - RENEWAL_WINDOW)
  config.renewedAt[region] = list
  return list.length
}

function pruneSpent() {
  const now = Date.now()
  let changed = false
  for (const map of [config.spent, config.kilo]) {
    for (const [ip, until] of Object.entries(map)) {
      if (until <= now) {
        delete map[ip]
        changed = true
      }
    }
  }
  for (const [region, list] of Object.entries(config.renewedAt)) {
    const kept = list.filter((t) => t > now - RENEWAL_WINDOW)
    if (kept.length !== list.length) {
      if (kept.length) config.renewedAt[region] = kept
      else delete config.renewedAt[region]
      changed = true
    }
  }
  if (changed) saveConfig()
}

function statsOf(inst) {
  if (!inst.stats) {
    inst.stats = {
      ok: 0,
      refused: 0,
      limited: 0,
      redirected: 0,
      failed: 0,
      daily: {},
    }
  }
  return inst.stats
}

function rememberIp(inst, ip) {
  if (!ip) return
  inst.history = Array.isArray(inst.history) ? inst.history : []
  if (!inst.history.includes(ip)) inst.history.unshift(ip)
  inst.history = inst.history.slice(0, 24)
}

function agentFor(inst) {
  if (!inst.agent) {
    inst.agent = new Socks5ProxyAgent(`socks5://127.0.0.1:${inst.port}`, {
      requestTls: TLS_OPTIONS,
    })
  }
  return inst.agent
}

function closeAgent(inst) {
  const agent = inst.agent
  inst.agent = undefined
  if (agent) agent.close().catch(() => {})
}

async function fetchThrough(inst, url, init = {}) {
  const dispatcher = agentFor(inst)
  return undiciFetch(url, {
    ...init,
    dispatcher,
  })
}

async function traceThrough(inst, timeoutMs = 18_000) {
  for (const url of TRACE_URLS) {
    try {
      const res = await fetchThrough(inst, url, {
        headers: { "user-agent": "curl/8.0", accept: "text/plain" },
        signal: AbortSignal.timeout(timeoutMs),
      })
      const text = await res.text()
      if (!res.ok) continue
      const fields = {}
      for (const line of text.split(/\r?\n/)) {
        const at = line.indexOf("=")
        if (at > 0) fields[line.slice(0, at)] = line.slice(at + 1)
      }
      if (fields.ip) return { ip: fields.ip, loc: (fields.loc || "").toUpperCase() }
    } catch {}
  }
  return null
}

// ---------------------------------------------------------------------------
// Process lifecycle
// ---------------------------------------------------------------------------

function stopProcess(proc) {
  try {
    proc?.kill()
  } catch {}
}

function exitOf(proc) {
  return new Promise((resolve) => {
    if (!proc || proc.exitCode !== null || proc.signalCode) return resolve()
    let done = false
    const finish = () => {
      if (done) return
      done = true
      resolve()
    }
    proc.once("exit", finish)
    setTimeout(finish, 5000).unref?.()
  })
}

function copyNodeStore(dir) {
  const from = storeOf(nodesDir())
  const to = storeOf(dir)
  if (fs.existsSync(from) && !fs.existsSync(to)) {
    try {
      fs.cpSync(from, to, { recursive: true })
    } catch {}
  }
}

async function launch(region, dir, port, onNotice) {
  const found = findClient()
  if (!found) throw new Error(missingInfo().message)
  ensureExecutable(found.core)
  fs.mkdirSync(dir, { recursive: true })
  copyNodeStore(dir)
  const base = JSON.parse(fs.readFileSync(path.join(found.folder, "psiphon.json"), "utf8"))
  const tunnelConfig = {
    ...base,
    DataRootDirectory: dir,
    LocalSocksProxyPort: port,
    DisableLocalHTTPProxy: true,
    DisableRemoteServerListFetcher: true,
    EnableUpgradeDownload: false,
    EnableFeedbackUpload: false,
    EstablishTunnelTimeoutSeconds: 0,
    ...(region ? { EgressRegion: region } : {}),
  }
  const configFile = path.join(dir, "tunnel.config")
  fs.writeFileSync(configFile, JSON.stringify(tunnelConfig), "utf8")
  const proc = spawn(found.core, ["-config", configFile, "-serverList", path.join(found.folder, "server-list.dat")], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  })
  let buffer = ""
  const feed = (chunk) => {
    buffer += String(chunk)
    if (buffer.length > 1_000_000) buffer = buffer.slice(-200_000)
    let at
    while ((at = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, at)
      buffer = buffer.slice(at + 1)
      try {
        onNotice(JSON.parse(line))
      } catch {}
    }
  }
  proc.stdout?.on("data", feed)
  proc.stderr?.on("data", feed)
  await new Promise((resolve, reject) => {
    proc.once("spawn", resolve)
    proc.once("error", reject)
  })
  return proc
}

function onNotice(inst, notice) {
  if (instances.get(inst.region) !== inst || inst.stopping) return
  const type = notice?.noticeType
  const data = notice?.data || {}
  if (type === "AvailableEgressRegions" && Array.isArray(data.regions)) {
    const list = uniqueRegions(data.regions)
    if (JSON.stringify(list) !== JSON.stringify(config.available)) {
      config.available = list.length ? list : config.available
      saveConfig()
    }
    return
  }
  if (type === "Tunnels") {
    const count = Number(data.count) || 0
    if (count > 0) {
      const first = !inst.readyAt
      inst.state = "ready"
      inst.readyAt = inst.readyAt || Date.now()
      inst.error = ""
      inst.failures = 0
      if (Date.now() - inst.startedAt > 60_000) inst.restarts = 0
      void learnExit(inst, first)
      notifyChange()
    } else if (inst.state === "ready") {
      inst.state = "reconnecting"
      notifyChange()
    }
    return
  }
  if (type === "Error" || type === "Alert") {
    inst.output = String(data.message || "").slice(0, 400)
    return
  }
  if (type === "Connecting" && data.region) {
    inst.connecting = String(data.region).toUpperCase()
  }
}

async function learnExit(inst, first) {
  if (inst.learning) return inst.learning
  inst.learning = (async () => {
    const trace = await traceThrough(inst)
    if (instances.get(inst.region) !== inst || inst.stopping) return
    if (!trace?.ip) {
      if (!inst.exitIp) inst.error = "The tunnel connected, but its exit address could not be read."
      return
    }
    const changed = trace.ip !== inst.exitIp
    inst.exitIp = trace.ip
    inst.location = trace.loc || inst.location || ""
    inst.lastExitAt = Date.now()
    rememberIp(inst, trace.ip)
    if (first || changed) {
      inst.exitChangedAt = Date.now()
      inst.error = ""
      console.log(`[psiphon] ${inst.region} connected; exit ${trace.ip}${trace.loc ? ` (${trace.loc})` : ""}`)
      notifyChange()
    }
    const recheck = inst.recheck
    if (recheck) {
      if (blockedUntil(inst, recheck) || spentUntil(inst.exitIp, recheck)) {
        // The new connection landed on an address that is still known to be
        // used up. Keep the region out of that provider's rotation; a later
        // real request or a manual "new address" can try again.
        inst.error = ""
      } else {
        inst.recheck = ""
      }
    }
  })().finally(() => {
    inst.learning = undefined
  })
  return inst.learning
}

function scheduleRestart(inst, code) {
  const canRestart =
    config.enabled &&
    config.wasConnected &&
    config.regions.includes(inst.region) &&
    (inst.restarts || 0) < 5
  if (!canRestart) return
  const attempt = inst.restarts || 0
  inst.restarts = attempt + 1
  const wait = Math.min(120_000, 5_000 * 2 ** attempt)
  const timer = setTimeout(() => {
    if (instances.get(inst.region) !== inst || inst.stopping) return
    void startInstance(inst.region, false).catch(() => {})
  }, wait)
  timer.unref?.()
}

function onExit(inst, code) {
  if (instances.get(inst.region) !== inst || inst.stopping || inst.state === "failed") return
  closeAgent(inst)
  inst.state = "failed"
  inst.error = inst.output || `The tunnel client stopped (code ${code ?? "?"}).`
  console.warn(`[psiphon] ${inst.region} client exited: ${inst.error}`)
  notifyChange()
  scheduleRestart(inst, code)
}

async function startOnce(region, fresh, at) {
  const old = instances.get(region)
  if (old) {
    old.stopping = true
    closeAgent(old)
    stopProcess(old.proc)
    await exitOf(old.proc)
  }
  if (at !== epoch) throw new Error("The tunnel was stopped.")
  const dir = regionDir(region)
  fs.mkdirSync(dir, { recursive: true })
  if (fresh) fs.rmSync(storeOf(dir), { recursive: true, force: true })
  const port = await pickPort(fresh ? 0 : old?.port, region)
  if (at !== epoch) throw new Error("The tunnel was stopped.")
  const inst = {
    region,
    port,
    proc: undefined,
    state: "starting",
    exitIp: "",
    location: "",
    startedAt: Date.now(),
    readyAt: 0,
    failures: 0,
    restarts: old?.restarts || 0,
    error: "",
    output: "",
    renewedAt: [],
    history: old?.history || [],
    blockedUntil: {},
    recheck: "",
    instanceId: crypto.randomUUID(),
    stats: old?.stats || undefined,
    stopping: false,
    learning: undefined,
    agent: undefined,
  }
  instances.set(region, inst)
  try {
    inst.proc = await launch(region, dir, port, (notice) => onNotice(inst, notice))
    inst.proc.once("exit", (code) => onExit(inst, code))
    if (at !== epoch || instances.get(region) !== inst) {
      inst.stopping = true
      stopProcess(inst.proc)
      if (instances.get(region) === inst) instances.delete(region)
      throw new Error("The tunnel was stopped.")
    }
  } catch (err) {
    inst.state = "failed"
    inst.error = String(err?.message || err).slice(0, 300)
    throw err
  }
  return inst
}

function startInstance(region, fresh = false) {
  const running = starting.get(region)
  if (running) return running
  const at = epoch
  const job = startOnce(region, fresh, at).finally(() => {
    if (starting.get(region) === job) starting.delete(region)
  })
  starting.set(region, job)
  return job
}

async function stopAll() {
  epoch += 1
  if (monitor) {
    clearInterval(monitor)
    monitor = undefined
  }
  const live = [...instances.values()]
  const probes = [...probeRuns]
  instances.clear()
  for (const inst of live) {
    inst.stopping = true
    closeAgent(inst)
    stopProcess(inst.proc)
  }
  for (const run of probes) stopProcess(run.proc)
  await Promise.all([
    ...live.map((inst) => exitOf(inst.proc)),
    ...probes.map((run) => exitOf(run.proc)),
  ])
  notifyChange()
}

function startMonitor() {
  if (monitor) return
  monitor = setInterval(() => {
    pruneSpent()
    for (const inst of instances.values()) {
      if (inst.state === "ready" && !inst.exitIp && !inst.learning) {
        void learnExit(inst, false)
      }
      if (typeof inst.proc?.exitCode === "number" && inst.state !== "failed") {
        onExit(inst, inst.proc.exitCode)
      }
    }
  }, 30_000)
  monitor.unref?.()
}

// ---------------------------------------------------------------------------
// Public status and entries
// ---------------------------------------------------------------------------

export function psiphonRunningCount() {
  return instances.size
}

export function psiphonLiveCount() {
  return [...instances.values()].filter((inst) => inst.state === "ready").length
}

export function psiphonCanRenew(region) {
  if (!config.renew) return false
  if (!instances.has(region)) return false
  return renewalCount(region) < MAX_RENEWALS_PER_HOUR
}

export function psiphonStatus() {
  const found = findClient()
  const missing = found ? null : missingInfo()
  const live = psiphonLiveCount()
  const spentIps = new Set([
    ...Object.keys(config.spent),
    ...Object.keys(config.kilo),
  ])
  return {
    installed: !!found,
    problem: missing?.message || "",
    problemCode: missing?.code || "",
    problemDetail: missing?.detail || "",
    platform: `${process.platform}-${process.arch}`,
    busy,
    lastError,
    running: instances.size,
    live,
    active: config.enabled && instances.size > 0,
    config: {
      enabled: config.enabled,
      autoStart: config.autoStart,
      regions: [...config.regions],
      mode: config.mode,
      pinned: config.pinned,
      skip: config.skip,
      renew: config.renew,
    },
    available: [...config.available],
    updatedAt: config.updatedAt,
    regions: config.regions.map((region) => {
      const inst = instances.get(region)
      const scope = "opencode"
      const until = spentUntil(inst?.exitIp, scope)
      const kiloUntil = spentUntil(inst?.exitIp, "kilo")
      const otherUntil = blockedUntil(inst, "other")
      const activeSpent = (inst?.history || []).filter(
        (ip) => spentUntil(ip, "opencode") || spentUntil(ip, "kilo"),
      )
      return {
        region,
        state: inst ? inst.state : "stopped",
        port: inst?.port || 0,
        exitIp: inst?.exitIp || "",
        location: inst?.location || "",
        since: inst?.readyAt || 0,
        usedUpUntil: until,
        kiloUntil,
        otherUntil,
        checking: inst?.recheck || "",
        renewing: !!inst?.renewing,
        renewals: renewalCount(region),
        error: inst?.error || "",
        instanceId: inst?.instanceId || "",
        latency: inst?.latency,
        lastUsed: inst?.lastUsed || 0,
        spentCount: activeSpent.length,
        spentIps: activeSpent,
        stats: statsOf(inst || { stats: undefined }),
      }
    }),
    spent: spentIps.size,
    maxRenewals: MAX_RENEWALS_PER_HOUR,
    route: {
      active: config.enabled && instances.size > 0,
      ready: live,
    },
  }
}

export function psiphonEntry(region, targetHost = "") {
  const inst = instances.get(region)
  if (!inst) return undefined
  const scope = scopeOfHost(targetHost)
  const spend = Math.max(spentUntil(inst.exitIp, scope), blockedUntil(inst, scope))
  const spent = (inst.history || []).filter(
    (ip) => spentUntil(ip, "opencode") || spentUntil(ip, "kilo"),
  )
  const exhaustedUntil = config.skip ? spend : 0
  return {
    id: `psiphon:${region}`,
    name: `Psiphon ${region}`,
    platform: "psiphon",
    url: `socks5://127.0.0.1:${inst.port}`,
    region,
    runtime: "tunnel",
    buffered: false,
    enabled: config.enabled && config.regions.includes(region) && inst.state === "ready",
    status:
      inst.state === "ready"
        ? isBlocked(inst, scope)
          ? "exhausted"
          : "healthy"
        : inst.state === "failed"
          ? "unreachable"
          : inst.state,
    latency: inst.latency,
    lastError: inst.error || "",
    lastEgress: inst.exitIp || "",
    lastInstance: inst.instanceId || "",
    spentCount: spent.length,
    spentIps: spent,
    cooldownUntil: 0,
    exhaustedUntil,
    stats: statsOf(inst),
    scope,
  }
}

export function psiphonCandidates(targetHost = "") {
  if (!config.enabled || instances.size === 0) return []
  const scope = scopeOfHost(targetHost)
  const chosen = config.mode === "single" ? [config.pinned || config.regions[0] || ""] : [...config.regions]
  let list = chosen
    .map((region) => instances.get(region))
    .filter((inst) => !!inst && inst.state === "ready" && !inst.stopping && !isBlocked(inst, scope))
  if (list.length === 0) return []
  if (config.mode === "spread" && list.length > 1) {
    const start = roundRobin % list.length
    roundRobin = (roundRobin + 1) % list.length
    list = [...list.slice(start), ...list.slice(0, start)]
  }
  return list.map((inst) => psiphonEntry(inst.region, targetHost))
}

export function psiphonFetch(region, targetUrl, init = {}) {
  const inst = instances.get(region)
  if (!inst || inst.state !== "ready") {
    throw new Error(`Psiphon ${region} is not connected.`)
  }
  inst.lastUsed = Date.now()
  return fetchThrough(inst, targetUrl, init).then((response) => {
    const headers = new UndiciHeaders()
    for (const [key, value] of response.headers.entries()) {
      if (/^(content-encoding|content-length|transfer-encoding)$/i.test(key)) continue
      try {
        headers.set(key, value)
      } catch {}
    }
    if (inst.exitIp) headers.set("x-relay-egress", inst.exitIp)
    headers.set("x-relay-instance", inst.instanceId || "")
    headers.set("x-relay-runtime", "tunnel")
    return new UndiciResponse(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  })
}

export function psiphonMarkSpent(region, ip, until, targetHost = "") {
  const inst = instances.get(region)
  const scope = scopeOfHost(targetHost)
  const address = String(ip || inst?.exitIp || "").trim()
  const at = Number(until) || Date.now() + 5 * 60 * 1000
  if (!inst) return scope
  if (address) {
    if (scope === "kilo") config.kilo[address] = at
    else if (scope === "opencode") config.spent[address] = at
    else {
      inst.blockedUntil.other = at
    }
    rememberIp(inst, address)
  } else {
    inst.blockedUntil[scope] = at
  }
  if (scope !== "opencode" && scope !== "kilo") inst.blockedUntil.other = at
  saveConfig()
  return scope
}

export function psiphonReportOk(region, targetHost = "") {
  const inst = instances.get(region)
  if (!inst) return
  const scope = scopeOfHost(targetHost)
  inst.failures = 0
  let changed = false
  if (scope === "opencode" && inst.exitIp && config.spent[inst.exitIp]) {
    delete config.spent[inst.exitIp]
    changed = true
  }
  if (scope === "kilo" && inst.exitIp && config.kilo[inst.exitIp]) {
    delete config.kilo[inst.exitIp]
    changed = true
  }
  if (inst.blockedUntil[scope]) {
    inst.blockedUntil[scope] = 0
    changed = true
  }
  if (inst.recheck === scope) inst.recheck = ""
  if (changed) saveConfig()
}

export function psiphonReportFailure(region) {
  const inst = instances.get(region)
  if (!inst) return
  inst.failures = (inst.failures || 0) + 1
  if (inst.failures >= 3 && inst.state === "ready") {
    inst.failures = 0
    inst.error = "Repeated connection errors through this region."
    notifyChange()
  }
}

export function psiphonEntryById(id) {
  const raw = String(id || "")
  if (!raw.startsWith("psiphon:")) return undefined
  return psiphonEntry(raw.slice("psiphon:".length).toUpperCase())
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function guard(name, lang, fn) {
  if (busy) {
    throw new Error(tr(lang, `The tunnel is busy (${busy}). Try again in a moment.`, `تونل مشغول است (${busy}). کمی بعد دوباره تلاش کنید.`))
  }
  busy = name
  lastError = ""
  return Promise.resolve()
    .then(fn)
    .catch((err) => {
      lastError = String(err?.message || err).slice(0, 400)
      throw err
    })
    .finally(() => {
      busy = ""
      notifyChange()
    })
}

async function reconcileRegions(lang) {
  const wanted = new Set(config.regions)
  for (const [region, inst] of [...instances]) {
    if (!wanted.has(region)) {
      inst.stopping = true
      closeAgent(inst)
      stopProcess(inst.proc)
      instances.delete(region)
      await exitOf(inst.proc)
    }
  }
  const errors = []
  for (const region of config.regions) {
    const inst = instances.get(region)
    if (!inst || inst.state === "failed") {
      try {
        if (inst) inst.restarts = 0
        await startInstance(region, false)
      } catch (err) {
        errors.push(`${region}: ${String(err?.message || err)}`)
      }
    }
  }
  if (errors.length && instances.size === 0) {
    throw new Error(tr(lang, `Could not start any region. ${errors.join("; ")}`, `هیچ منطقه‌ای راه‌اندازی نشد. ${errors.join("; ")}`))
  }
  if (errors.length) lastError = errors.join("; ")
}

export function psiphonConnect(lang = "en") {
  return guard("connecting", lang, async () => {
    if (!config.enabled) {
      throw new Error(tr(lang, "Turn the local tunnel on first.", "اول تونل محلی را روشن کنید."))
    }
    const found = findClient()
    if (!found) throw new Error(missingInfo().message)
    if (!config.regions.length) {
      throw new Error(tr(lang, "Choose at least one region.", "حداقل یک منطقه انتخاب کنید."))
    }
    await reconcileRegions(lang)
    config.wasConnected = true
    saveConfigNow()
    startMonitor()
    notifyChange()
    return psiphonStatus()
  })
}

export function psiphonDisconnect(lang = "en") {
  return guard("disconnecting", lang, async () => {
    config.wasConnected = false
    saveConfigNow()
    await stopAll()
    return psiphonStatus()
  })
}

export async function psiphonRenew(region, lang = "en", auto = false, scope = "") {
  const code = String(region || "").toUpperCase()
  if (!config.regions.includes(code)) {
    throw new Error(tr(lang, `${code || "This region"} is not one of the selected regions.`, `${code || "این منطقه"} از منطقه‌های انتخاب‌شده نیست.`))
  }
  const inst = instances.get(code)
  if (!inst) {
    throw new Error(tr(lang, `Psiphon ${code} is not running. Connect it first.`, `Psiphon ${code} در حال اجرا نیست. اول آن را متصل کنید.`))
  }
  if (auto && !psiphonCanRenew(code)) return false
  if (inst.renewing) return false
  if (auto && busy) return false
  inst.renewing = true
  const before = inst.exitIp
  const recheck = scope || inst.recheck || "opencode"
  renewalCount(code)
  config.renewedAt[code] = [...(config.renewedAt[code] || []), Date.now()]
  saveConfigNow()
  try {
    await startInstance(code, true)
    const fresh = instances.get(code)
    if (!fresh) return false
    fresh.recheck = recheck
    fresh.renewing = true
    await waitFor(() => !!fresh.exitIp && fresh.exitIp !== before, 55_000)
    fresh.recheck = ""
    fresh.renewing = false
    notifyChange()
    return true
  } catch (err) {
    inst.renewing = false
    throw err
  }
}

export function psiphonUpdateServers(lang = "en") {
  return guard("updating servers", lang, async () => {
    const found = findClient()
    if (!found) throw new Error(missingInfo().message)
    const dir = nodesDir()
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(dir, { recursive: true })
    const port = await pickPort(0, "")
    let proc
    let regions = []
    let connected = false
    try {
      const done = new Promise((resolve) => {
        const timer = setTimeout(resolve, 90_000)
        timer.unref?.()
        launch("", dir, port, (notice) => {
          if (notice?.noticeType === "AvailableEgressRegions" && Array.isArray(notice.data?.regions)) {
            regions = notice.data.regions
          }
          if (notice?.noticeType === "Tunnels" && Number(notice.data?.count) > 0 && !connected) {
            connected = true
            const wait = setTimeout(() => {
              clearTimeout(timer)
              resolve()
            }, 15_000)
            wait.unref?.()
          }
        })
          .then((child) => {
            proc = child
            child.once("exit", () => {
              clearTimeout(timer)
              resolve()
            })
          })
          .catch(() => {
            clearTimeout(timer)
            resolve()
          })
      })
      await done
    } finally {
      stopProcess(proc)
      if (proc) await exitOf(proc)
    }
    if (!connected && regions.length === 0) {
      throw new Error(
        tr(
          lang,
          "The local client could not connect to update its server list. Check this computer's internet connection and try again.",
          "کلاینت محلی برای به‌روزرسانی فهرست سرورها متصل نشد. اتصال اینترنت رایانه را بررسی و دوباره تلاش کنید.",
        ),
      )
    }
    if (regions.length) config.available = uniqueRegions(regions)
    config.updatedAt = Date.now()
    saveConfigNow()
    // Non-running regions pick up the new list the next time they start.
    for (const region of config.regions) {
      if (!instances.has(region)) {
        try {
          fs.rmSync(storeOf(regionDir(region)), { recursive: true, force: true })
        } catch {}
      }
    }
    return psiphonStatus()
  })
}

export function psiphonSetSettings(patch = {}, lang = "en") {
  return guard("saving settings", lang, async () => {
    if (typeof patch.enabled === "boolean") config.enabled = patch.enabled
    if (typeof patch.autoStart === "boolean") config.autoStart = patch.autoStart
    if (typeof patch.skip === "boolean") config.skip = patch.skip
    if (typeof patch.renew === "boolean") config.renew = patch.renew
    if (patch.mode !== undefined) {
      if (patch.mode !== "spread" && patch.mode !== "single") {
        throw new Error(tr(lang, "Mode must be spread or single.", "حالت باید spread یا single باشد."))
      }
      config.mode = patch.mode
    }
    if (patch.regions !== undefined) {
      if (!Array.isArray(patch.regions)) {
        throw new Error(tr(lang, "Regions must be a list.", "منطقه‌ها باید فهرست باشند."))
      }
      const list = uniqueRegions(patch.regions)
      if (list.length > MAX_REGIONS) {
        throw new Error(tr(lang, `Choose at most ${MAX_REGIONS} regions.`, `حداکثر ${MAX_REGIONS} منطقه انتخاب کنید.`))
      }
      config.regions = list
      if (!list.includes(config.pinned)) config.pinned = list[0] || ""
    }
    if (patch.pinned !== undefined) {
      const pinned = String(patch.pinned || "").toUpperCase()
      if (pinned && !REGION.test(pinned)) {
        throw new Error(tr(lang, "The pinned region code is not valid.", "کد منطقهٔ انتخابی معتبر نیست."))
      }
      config.pinned = pinned
    }
    if (config.mode === "single" && !config.regions.includes(config.pinned)) {
      config.pinned = config.regions[0] || ""
    }
    saveConfigNow()
    if (!config.enabled) {
      config.wasConnected = false
      await stopAll()
    } else if (config.regions.length === 0) {
      config.wasConnected = false
      await stopAll()
    } else if (instances.size > 0) {
      await reconcileRegions(lang)
    }
    notifyChange()
    return psiphonStatus()
  })
}

export async function psiphonTestRegion(region, lang = "en") {
  const code = String(region || "").toUpperCase()
  const inst = instances.get(code)
  if (!inst || inst.state !== "ready") {
    throw new Error(tr(lang, `Psiphon ${code} is not connected.`, `Psiphon ${code} متصل نیست.`))
  }
  const started = Date.now()
  try {
    const res = await fetchThrough(inst, "https://opencode.ai/inference/v1/models", {
      headers: { accept: "application/json", "user-agent": "opencode-chat" },
      signal: AbortSignal.timeout(20_000),
    })
    await res.body?.cancel().catch(() => {})
    inst.latency = Date.now() - started
    if (!inst.exitIp) void learnExit(inst, false)
    return {
      ok: res.ok,
      status: res.status,
      latency: inst.latency,
      egress: inst.exitIp || "",
      error: res.ok ? "" : tr(lang, `The test returned HTTP ${res.status}.`, `تست کد HTTP ${res.status} برگرداند.`),
    }
  } catch (err) {
    inst.latency = Date.now() - started
    return {
      ok: false,
      status: 0,
      latency: inst.latency,
      egress: inst.exitIp || "",
      error: tr(
        lang,
        `The test through ${code} failed: ${String(err?.message || err)}`,
        `تست از طریق ${code} ناموفق بود: ${String(err?.message || err)}`,
      ),
    }
  }
}

export async function psiphonTestAll(lang = "en") {
  const results = []
  for (const region of config.regions) {
    try {
      results.push({ region, ...(await psiphonTestRegion(region, lang)) })
    } catch (err) {
      results.push({ region, ok: false, status: 0, latency: 0, egress: "", error: String(err?.message || err) })
    }
  }
  return results
}

async function probePort() {
  const used = usedPorts("")
  for (let i = 0; i < 30; i++) {
    const port = await freePort()
    const taken = used.has(port) || [...probeRuns].some((run) => run.port === port)
    if (!taken) return port
  }
  throw new Error("Could not reserve a local port for the tunnel test.")
}

async function runProbe(code, lang) {
  const started = Date.now()
  const dir = path.join(runtimeRoot(), "probes", `${code}-${crypto.randomUUID()}`)
  const inst = { region: code, port: 0, agent: undefined }
  const run = { region: code, dir, port: 0, proc: undefined }
  let lastMessage = ""
  let readyAt = 0
  let exitCode
  fs.mkdirSync(dir, { recursive: true })
  probeRuns.add(run)
  try {
    run.port = inst.port = await probePort()
    const outcome = await new Promise((resolve, reject) => {
      let settled = false
      let timer
      const finish = (value) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        resolve(value)
      }
      timer = setTimeout(() => finish("timeout"), PROBE_TIMEOUT)
      timer.unref?.()
      launch(code, dir, inst.port, (notice) => {
        const type = notice?.noticeType
        const data = notice?.data || {}
        if (type === "Tunnels" && Number(data.count) > 0) {
          readyAt = Date.now()
          finish("ready")
        } else if (type === "Error" || type === "Alert") {
          lastMessage = String(data.message || "").slice(0, 300)
        }
      })
        .then((child) => {
          run.proc = child
          if (typeof child.exitCode === "number") {
            exitCode = child.exitCode
            finish("exit")
            return
          }
          child.once("exit", (value) => {
            exitCode = value
            finish("exit")
          })
          child.once("error", (err) => {
            lastMessage = String(err?.message || err).slice(0, 300)
            finish("exit")
          })
        })
        .catch(reject)
    })

    if (outcome !== "ready") {
      const seconds = Math.round(PROBE_TIMEOUT / 1000)
      const error =
        outcome === "timeout"
          ? tr(lang, `This region did not connect within ${seconds} seconds.`, `این منطقه در ${seconds} ثانیه متصل نشد.`)
          : tr(
              lang,
              `The local client stopped during the test${typeof exitCode === "number" ? ` (code ${exitCode})` : ""}.`,
              `کلاینت محلی در طول تست متوقف شد${typeof exitCode === "number" ? ` (کد ${exitCode})` : ""}.`,
            )
      return {
        region: code,
        ok: false,
        connected: false,
        connectMs: 0,
        latency: 0,
        egress: "",
        location: "",
        error: lastMessage ? `${error} ${lastMessage}` : error,
        at: Date.now(),
      }
    }

    const traceStarted = Date.now()
    const trace = await traceThrough(inst, 12_000)
    const latency = Date.now() - traceStarted
    return {
      region: code,
      ok: !!trace?.ip,
      connected: true,
      connectMs: readyAt - started,
      latency,
      egress: trace?.ip || "",
      location: trace?.loc || "",
      error: trace?.ip
        ? ""
        : tr(
            lang,
            "The tunnel connected, but no data came back through it.",
            "تونل متصل شد، اما داده‌ای از آن بازنگشت.",
          ),
      at: Date.now(),
    }
  } catch (err) {
    return {
      region: code,
      ok: false,
      connected: false,
      connectMs: 0,
      latency: 0,
      egress: "",
      location: "",
      error: String(err?.message || err),
      at: Date.now(),
    }
  } finally {
    if (run.proc) {
      stopProcess(run.proc)
      await exitOf(run.proc)
    }
    closeAgent(inst)
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {}
    probeRuns.delete(run)
  }
}

// Tests a region without adding it to the active tunnel. A temporary local
// client is started with its own data directory and SOCKS port, then stopped
// and removed once the probe finishes.
export async function psiphonProbeRegion(region, lang = "en") {
  const code = String(region || "").replace(/^psiphon:/i, "").toUpperCase()
  if (!REGION.test(code)) {
    throw new Error(tr(lang, "The region code is not valid.", "کد منطقه معتبر نیست."))
  }
  if (probeJob) {
    throw new Error(
      tr(
        lang,
        "Another region test is already running. Try again in a moment.",
        "یک تست منطقهٔ دیگر در حال اجراست. کمی بعد دوباره تلاش کنید.",
      ),
    )
  }
  const live = instances.get(code)
  if (live && live.state === "ready") {
    const result = await psiphonTestRegion(code, lang)
    return {
      region: code,
      ok: result.ok,
      connected: true,
      connectMs: 0,
      latency: result.latency,
      egress: result.egress,
      location: live.location || "",
      error: result.error,
      at: Date.now(),
    }
  }
  if (!findClient()) throw new Error(missingInfo().message)
  const job = runProbe(code, lang)
  probeJob = job
  try {
    return await job
  } finally {
    if (probeJob === job) probeJob = undefined
  }
}

// ---------------------------------------------------------------------------
// Startup and shutdown
// ---------------------------------------------------------------------------

export async function psiphonStart() {
  pruneSpent()
  try {
    fs.rmSync(path.join(runtimeRoot(), "probes"), { recursive: true, force: true })
  } catch {}
  if (!config.enabled || config.regions.length === 0) return
  if (!findClient()) return
  if (!config.autoStart && !config.wasConnected) return
  await psiphonConnect("en").catch((err) => {
    console.warn(`[psiphon] start: ${err?.message || err}`)
  })
}

export async function psiphonStop() {
  if (monitor) {
    clearInterval(monitor)
    monitor = undefined
  }
  await stopAll()
  try {
    fs.rmSync(path.join(runtimeRoot(), "probes"), { recursive: true, force: true })
  } catch {}
}

// Last-resort cleanup if the host process exits without the normal shutdown
// hook (for example a forced window close).
process.once("exit", () => {
  for (const inst of instances.values()) {
    inst.stopping = true
    try {
      inst.proc?.kill()
    } catch {}
  }
  for (const run of probeRuns) {
    try {
      run.proc?.kill()
    } catch {}
  }
})