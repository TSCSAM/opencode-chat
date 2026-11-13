import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { fileURLToPath } from "node:url"
import zlib from "node:zlib"
import { modify, applyEdits, parse as parseJsonc } from "jsonc-parser"
import {
  psiphonCanRenew,
  psiphonCandidates,
  psiphonEntryById,
  psiphonFetch,
  psiphonMarkSpent,
  psiphonRenew,
  psiphonReportFailure,
  psiphonReportOk,
  psiphonRunningCount,
  psiphonStatus,
  psiphonTestRegion,
} from "./psiphon-manager.mjs"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Relay errors can reach the UI, so they follow the language sent by the
// client (English by default). Terminal logs stay English.
function langOf(input) {
  const value = typeof input === "string" ? input : input?.lang
  return value === "fa" ? "fa" : "en"
}

function tr(input, en, fa) {
  return langOf(input) === "fa" ? fa : en
}

// Load bundled relay sources from relays/ folder
const VERCEL_SOURCE = fs.readFileSync(path.join(__dirname, "relays", "vercel-bun", "api", "relay.js"), "utf8")
const NETLIFY_SOURCE = fs.readFileSync(path.join(__dirname, "relays", "netlify-relay.js"), "utf8")
const CLOUDFLARE_SOURCE = fs.readFileSync(path.join(__dirname, "relays", "cloudflare-worker.js"), "utf8")

export const PLATFORMS = ["vercel", "netlify", "cloudflare"]

// Known default upstream baseURLs for OpenCode providers
export const DEFAULT_PROVIDER_URLS = {
  opencode: "https://opencode.ai/inference/openai/v1",
  agentrouter: "https://agentrouter.org/v1",
}

// Persistent relay configuration file path
function relayStorePath() {
  // Test/portable override: lets a second panel instance use its own relay
  // state without touching the installed user's relays.json.
  if (process.env.OPENCODE_CHAT_RELAY_STORE) {
    const override = path.resolve(process.env.OPENCODE_CHAT_RELAY_STORE)
    fs.mkdirSync(path.dirname(override), { recursive: true })
    return override
  }
  const base =
    process.platform === "win32"
      ? path.join(os.homedir(), ".config", "opencode")
      : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "opencode")
  fs.mkdirSync(base, { recursive: true })
  return path.join(base, "relays.json")
}

// Relay routing is opt-in: the master switch starts off, and it only takes
// effect after the user enables it *and* at least one relay exists.
const SETTINGS_REVISION = 2
const DEFAULT_SETTINGS = {
  settingsRevision: SETTINGS_REVISION,
  enabled: false,
  activeId: "",
  rotate: false,
  exhaustedFailover: true,
  allowDirect: true,
  relayRotations: 4,
  providers: ["opencode"],
  originalUrls: {
    opencode: "https://opencode.ai/inference/openai/v1",
  },
  savedTokens: {
    vercel: "",
    netlify: "",
    cloudflare: "",
  },
  savedAccount: "",
  relays: [],
}

let state = loadState()

// One-time migration for installations created before relays became opt-in.
// The previous default was `enabled: true`, so treat missing revision as an
// implicit default and turn the master switch off once.
if (Number(state.settingsRevision ?? 0) < SETTINGS_REVISION) {
  state.enabled = false
  state.settingsRevision = SETTINGS_REVISION
  saveState()
}

function loadState() {
  try {
    const raw = fs.readFileSync(relayStorePath(), "utf8")
    const parsed = JSON.parse(raw)
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      providers: Array.isArray(parsed.providers) ? parsed.providers : ["opencode"],
      originalUrls: { ...DEFAULT_SETTINGS.originalUrls, ...(parsed.originalUrls || {}) },
      savedTokens: { ...DEFAULT_SETTINGS.savedTokens, ...(parsed.savedTokens || {}) },
      savedAccount: typeof parsed.savedAccount === "string" ? parsed.savedAccount : "",
      relays: Array.isArray(parsed.relays) ? parsed.relays : [],
      // Files written before this revision had `enabled: true` only because it
      // used to be the default. Keep the old value out of the migration check
      // so the one-time migration below can turn it off.
      settingsRevision: Number.isFinite(Number(parsed.settingsRevision))
        ? Number(parsed.settingsRevision)
        : 0,
    }
  } catch {
    return structuredClone(DEFAULT_SETTINGS)
  }
}

export function saveState() {
  const file = relayStorePath()
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8")
  fs.renameSync(tmp, file)
}

// Runtime memory maps for serverless instance rotation and egress IP tracking
const spentEgress = new Map() // relayId -> Map<ip, untilTimestamp>
const liveEgress = new Map() // relayId -> current egress IP
const liveInstance = new Map() // relayId -> current container instance ID
const bunRelays = new Set() // relayIds confirmed to support multi-instance recycling
const rotating = new Map() // relayId -> Promise<boolean>
const recentEvents = [] // diagnostic log entries for the UI
let lastRouteInfo = {
  mode: "", // "relay" | "direct" | "blocked"
  relayId: "",
  relayName: "",
  platform: "",
  region: "",
  egress: "",
  status: 0,
  blocked: false,
  blockedReason: "",
  time: 0,
}

function recordRouteOutcome(info) {
  lastRouteInfo = {
    ...lastRouteInfo,
    ...info,
    time: Date.now(),
  }
}

function logRelayEvent(level, message, detail = {}) {
  recentEvents.unshift({
    id: crypto.randomUUID(),
    time: Date.now(),
    level,
    message,
    ...detail,
  })
  if (recentEvents.length > 80) recentEvents.length = 80
}

const now = () => Date.now()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function dayKey(ts = now()) {
  return new Date(ts).toISOString().slice(0, 10)
}

function recordStat(relay, kind) {
  if (!relay) return
  relay.stats = relay.stats || { ok: 0, refused: 0, limited: 0, redirected: 0, failed: 0, daily: {} }
  relay.stats[kind] = (relay.stats[kind] || 0) + 1
  if (!relay.stats.daily || typeof relay.stats.daily !== "object") relay.stats.daily = {}
  const dk = dayKey()
  const bucket = relay.stats.daily[dk] || { ok: 0, refused: 0, limited: 0, redirected: 0, failed: 0 }
  bucket[kind] = (bucket[kind] || 0) + 1
  relay.stats.daily[dk] = bucket
  // Prune buckets older than 35 days
  const keys = Object.keys(relay.stats.daily).sort()
  while (keys.length > 35) {
    const old = keys.shift()
    if (old) delete relay.stats.daily[old]
  }
}

function aggregateWindowStats(relay, days) {
  const s = relay?.stats || {}
  const daily = s.daily && typeof s.daily === "object" ? s.daily : null
  if (!daily || Object.keys(daily).length === 0) {
    return {
      ok: Number(s.ok || 0),
      refused: Number(s.refused || 0),
      limited: Number(s.limited || 0),
      redirected: Number(s.redirected || 0),
      failed: Number(s.failed || 0),
    }
  }
  const cutoff = new Date(now() - (days - 1) * 86400000).toISOString().slice(0, 10)
  const out = { ok: 0, refused: 0, limited: 0, redirected: 0, failed: 0 }
  for (const [d, row] of Object.entries(daily)) {
    if (d >= cutoff && row && typeof row === "object") {
      out.ok += Number(row.ok || 0)
      out.refused += Number(row.refused || 0)
      out.limited += Number(row.limited || 0)
      out.redirected += Number(row.redirected || 0)
      out.failed += Number(row.failed || 0)
    }
  }
  return out
}

export function nextResetAt() {
  const d = new Date()
  d.setUTCHours(24, 0, 0, 0)
  return d.getTime()
}

export function parseRetryAfter(value) {
  if (!value) return 0
  const n = Number(value)
  if (Number.isFinite(n)) return Math.max(0, n)
  const at = Date.parse(value)
  return Number.isFinite(at) ? Math.max(0, Math.round((at - now()) / 1000)) : 0
}

const FREE_LIMIT_TEXT = /FreeUsageLimit|Free usage limit|rate.?limit|quota|too many requests|429/i

export function detectExhaustionFromBody(status, retryAfterHeader, text) {
  if (status !== 429) return null
  const seconds = parseRetryAfter(retryAfterHeader)
  if (seconds > 0) {
    const capped = Math.min(seconds, 86400)
    return { until: now() + capped * 1000, seconds: capped, refused: false }
  }
  if (FREE_LIMIT_TEXT.test(text)) {
    return { until: now() + 15 * 60 * 1000, seconds: 900, refused: true }
  }
  return { until: now() + 5 * 60 * 1000, seconds: 300, refused: false }
}

function spentList(id) {
  const m = spentEgress.get(id)
  if (!m) return []
  const t = now()
  for (const [ip, until] of m) {
    if (until <= t) m.delete(ip)
  }
  return [...m.keys()]
}

function markSpent(id, ip, until) {
  if (!ip) return
  let m = spentEgress.get(id)
  if (!m) {
    m = new Map()
    spentEgress.set(id, m)
  }
  m.set(ip, until)
}

export function relayInfo(id) {
  return {
    egress: liveEgress.get(id) || "",
    instance: liveInstance.get(id) || "",
    spent: spentList(id).length,
    spentIps: spentList(id),
    bun: bunRelays.has(id),
  }
}

function trustedRuntime(header) {
  const h = String(header || "").toLowerCase()
  return h.startsWith("bun ") || h.startsWith("node-bun-ciphers ")
}

function isCoolingDown(r) {
  return (r.cooldownUntil || 0) > now() || (r.exhaustedUntil || 0) > now()
}

function canCarryTarget(r, targetHost) {
  const h = String(targetHost || "").toLowerCase()
  // OpenCode Free inspects TLS ClientHello cipher order; Cloudflare Workers cannot customize cipher order
  if ((h === "opencode.ai" || h.endsWith(".opencode.ai")) && r.platform === "cloudflare") {
    return false
  }
  return true
}

// The master switch alone is not enough: routing is active only when the user
// has enabled it and at least one cloud relay or local tunnel region is running.
function hasRelayCapacity() {
  return state.relays.some((r) => r.enabled !== false) || psiphonRunningCount() > 0
}

function isRelayRoutingActive() {
  return state.enabled && hasRelayCapacity()
}

// Direct is a first-class route in the same pool as cloud relays and tunnel
// regions: it can be the selected primary, join automatic rotation, or act as
// the last failover route. It is never saved in relays.json.
const DIRECT_ROUTE = Object.freeze({
  id: "direct",
  name: "Direct connection",
  platform: "direct",
  url: "",
  region: "",
  runtime: "system",
  buffered: false,
  enabled: true,
  status: "healthy",
  lastError: "",
  lastEgress: "",
  lastInstance: "",
  spentCount: 0,
  spentIps: [],
  cooldownUntil: 0,
  exhaustedUntil: 0,
})

// Select ordered candidate routes for a request to targetHost. Local tunnel
// regions are virtual relays: they are not saved in relays.json, but they take
// part in the same rotation and failover policy as cloud relays. The direct
// connection is appended when the user allows it, so it can be selected as the
// primary route or receive traffic during automatic rotation.
let roundRobinIndex = 0
function candidateRoutes(targetHost) {
  const enabled = [
    ...state.relays.filter((r) => r.enabled !== false && canCarryTarget(r, targetHost)),
    ...psiphonCandidates(targetHost),
  ]
  if (state.allowDirect) enabled.push(DIRECT_ROUTE)
  const healthy = enabled.filter((r) => r.platform === "direct" || !isCoolingDown(r))
  const pool = healthy.length > 0 ? healthy : enabled
  if (pool.length === 0) return []

  if (state.rotate && pool.length > 1) {
    const start = roundRobinIndex % pool.length
    roundRobinIndex = (roundRobinIndex + 1) % pool.length
    return [...pool.slice(start), ...pool.slice(0, start)]
  }

  const active = pool.find((r) => r.id === state.activeId) || pool[0]
  if (state.exhaustedFailover === false) return [active]
  return [active, ...pool.filter((r) => r.id !== active.id)]
}

async function relayControl(relay, control) {
  const r = await fetch(relay.url, {
    headers: {
      "x-relay-key": relay.token || "",
      "x-relay-control": control,
    },
    signal: AbortSignal.timeout(10000),
  })
  if (!r.ok) {
    await r.body?.cancel().catch(() => {})
    throw new Error(`HTTP ${r.status}`)
  }
  return await r.json()
}

// Reconnect one local tunnel region so the next request usually leaves from a
// new exit address. The manager enforces the hourly renewal cap; this wrapper
// only verifies that the address really changed before the caller retries.
function rotatePsiphonRegion(relay) {
  const running = rotating.get(relay.id)
  if (running) return running
  const job = (async () => {
    const before = relay.lastEgress || psiphonEntryById(relay.id)?.lastEgress || ""
    if (!psiphonCanRenew(relay.region)) return false
    try {
      const renewed = await psiphonRenew(relay.region, "en", true, relay.scope || "other")
      if (!renewed) return false
      const entry = psiphonEntryById(relay.id)
      if (!entry) return false
      relay.lastEgress = entry.lastEgress || relay.lastEgress
      relay.lastInstance = entry.lastInstance || relay.lastInstance
      relay.latency = entry.latency ?? relay.latency
      const changed = !!entry.lastEgress && (!before || entry.lastEgress !== before)
      if (changed && entry.status !== "exhausted") {
        logRelayEvent("info", `Local tunnel ${relay.region} reconnected with a new exit`, {
          relayId: relay.id,
          oldIp: before,
          newIp: entry.lastEgress,
        })
        return true
      }
      return false
    } catch {
      return false
    }
  })().finally(() => rotating.delete(relay.id))
  rotating.set(relay.id, job)
  return job
}

// Recycle a Vercel serverless container so the next request spawns a fresh container with a new egress IP
export function rotateRelayInstance(relay) {
  if (relay.platform === "psiphon") return rotatePsiphonRegion(relay)
  const running = rotating.get(relay.id)
  if (running) return running
  const job = (async () => {
    let before
    try {
      before = await relayControl(relay, "ping")
      await relayControl(relay, "recycle")
    } catch {
      return false
    }
    for (let i = 0; i < 10; i++) {
      await sleep(i ? 800 : 1200)
      try {
        const p = await relayControl(relay, "ping")
        if (p.instance && p.instance !== before.instance && !spentList(relay.id).includes(p.egress)) {
          if (p.egress) {
            liveEgress.set(relay.id, p.egress)
            relay.lastEgress = p.egress
          }
          if (p.instance) {
            liveInstance.set(relay.id, p.instance)
            relay.lastInstance = p.instance
          }
          logRelayEvent("info", `Relay "${relay.name}" recycled and received a new IP`, {
            relayId: relay.id,
            oldIp: before.egress,
            newIp: p.egress,
          })
          return true
        }
      } catch {
        // Old instance may still be draining
      }
    }
    return false
  })().finally(() => rotating.delete(relay.id))
  rotating.set(relay.id, job)
  return job
}

// Unlike a cloud relay, a local tunnel receives the real upstream URL and
// makes the request itself through the region's SOCKS5 listener. Hop-by-hop
// and body framing headers are managed by undici.
function buildTunnelRequest(method, incomingHeaders, bodyBuffer) {
  const headers = new Headers()
  for (const [k, v] of Object.entries(incomingHeaders || {})) {
    if (v === undefined || v === null) continue
    const lower = k.toLowerCase()
    if (
      lower === "host" ||
      lower === "connection" ||
      lower === "content-length" ||
      lower === "transfer-encoding" ||
      lower === "accept-encoding"
    ) {
      continue
    }
    if (Array.isArray(v)) headers.set(k, v.join(", "))
    else headers.set(k, String(v))
  }
  return {
    method,
    headers,
    body:
      ["GET", "HEAD"].includes(String(method).toUpperCase()) || !bodyBuffer?.length
        ? undefined
        : bodyBuffer,
    redirect: "manual",
  }
}

function buildDirectRequest(targetUrl, method, incomingHeaders, bodyBuffer) {
  const headers = new Headers()
  for (const [k, v] of Object.entries(incomingHeaders || {})) {
    if (v === undefined || v === null) continue
    const lower = k.toLowerCase()
    if (lower === "host" || lower === "content-length" || lower === "connection") continue
    if (Array.isArray(v)) headers.set(k, v.join(", "))
    else headers.set(k, String(v))
  }
  return {
    url: targetUrl,
    init: {
      method,
      headers,
      body:
        ["GET", "HEAD"].includes(String(method).toUpperCase()) || !bodyBuffer?.length
          ? undefined
          : bodyBuffer,
      redirect: "manual",
    },
  }
}

function buildRelayRequest(targetUrl, method, incomingHeaders, bodyBuffer, relay) {
  const target = new URL(targetUrl)
  const headers = new Headers()
  for (const [k, v] of Object.entries(incomingHeaders || {})) {
    if (v === undefined || v === null) continue
    const lower = k.toLowerCase()
    if (lower === "host" || lower === "content-length" || lower === "connection") continue
    if (Array.isArray(v)) headers.set(k, v.join(", "))
    else headers.set(k, String(v))
  }
  headers.set("x-relay-target", target.origin)
  headers.set("x-relay-path", target.pathname + target.search)
  if (relay.token) headers.set("x-relay-key", relay.token)
  const avoid = spentList(relay.id)
  if (avoid.length > 0 && (bunRelays.has(relay.id) || relay.platform === "vercel")) {
    headers.set("x-relay-avoid", avoid.join(","))
  }
  return {
    url: relay.url,
    init: {
      method,
      headers,
      body: ["GET", "HEAD"].includes(method.toUpperCase()) || !bodyBuffer?.length ? undefined : bodyBuffer,
      redirect: "manual",
    },
  }
}

// Forward an upstream request through the relay pool with automatic 429 container recycling & failover
export async function forwardViaRelays(targetUrl, method, incomingHeaders, bodyBuffer, lang = "en") {
  const target = new URL(targetUrl)
  const candidates = candidateRoutes(target.hostname)
  const active = isRelayRoutingActive()

  if (!active || candidates.length === 0) {
    // When relay routing is intentionally disabled (or no route has been
    // configured), the direct connection is the normal path. But if the
    // feature is active while no route can carry this target, honour
    // "allowDirect" instead of silently bypassing it.
    if (active && candidates.length === 0 && !state.allowDirect) {
      const reason = tr(lang, "No active relay can carry this destination and direct connections are disabled", "هیچ رلهٔ فعالی برای این مقصد وجود ندارد و اتصال مستقیم غیرفعال است")
      recordRouteOutcome({ mode: "blocked", status: 0, blocked: true, blockedReason: reason })
      throw new Error(reason)
    }
    const directSpec = buildDirectRequest(targetUrl, method, incomingHeaders, bodyBuffer)
    const directRes = await fetch(directSpec.url, directSpec.init)
    recordRouteOutcome({
      mode: "direct",
      relayId: "",
      relayName: "",
      platform: "direct",
      region: "",
      egress: "",
      status: directRes.status,
      blocked: directRes.status === 429 || directRes.status === 403,
      blockedReason:
        directRes.status === 429
          ? tr(lang, "Rate limit (429) on the direct connection", "محدودیت مصرف ۴۲۹ روی اتصال مستقیم")
          : directRes.status === 403
            ? tr(lang, "Access blocked (403) on the direct connection", "دسترسی مسدود شده (۴۰۳) روی اتصال مستقیم")
            : "",
    })
    return directRes
  }

  const maxSpins = Math.max(0, Math.min(10, Number(state.relayRotations ?? 4)))
  let lastResponse = null
  let lastError = null

  for (let cIdx = 0; cIdx < candidates.length; cIdx++) {
    const relay = candidates[cIdx]
    const hasMoreCandidates = cIdx < candidates.length - 1
    const startMs = now()
    for (let spin = 0; spin <= maxSpins; spin++) {
      const isTunnel = relay.platform === "psiphon"
      const isDirect = relay.platform === "direct"
      const reqSpec = isTunnel
        ? null
        : isDirect
          ? buildDirectRequest(targetUrl, method, incomingHeaders, bodyBuffer)
          : buildRelayRequest(targetUrl, method, incomingHeaders, bodyBuffer, relay)
      let response
      try {
        response = isTunnel
          ? await psiphonFetch(
              relay.region,
              targetUrl,
              buildTunnelRequest(method, incomingHeaders, bodyBuffer),
            )
          : await fetch(reqSpec.url, reqSpec.init)
      } catch (err) {
        lastError = err
        if (isDirect) {
          logRelayEvent("warn", "Direct connection failed", {
            error: String(err?.message || err).slice(0, 160),
          })
          break
        }
        if (isTunnel) {
          psiphonReportFailure(relay.region)
          // A broken region should be replaced in the background; the current
          // request moves on to the next ready region instead of waiting for
          // the reconnect (which can take up to a minute).
          psiphonMarkSpent(relay.region, "", now() + 60_000, target.hostname)
          if (psiphonCanRenew(relay.region)) void rotateRelayInstance(relay)
        }
        const canRotate = !isTunnel && (bunRelays.has(relay.id) || relay.platform === "vercel")
        if (canRotate && spin < maxSpins && (await rotateRelayInstance(relay))) {
          continue
        }
        relay.status = "unreachable"
        relay.lastError = String(err?.message || err).slice(0, 160)
        relay.failures = (relay.failures || 0) + 1
        if (relay.failures >= 3) {
          relay.cooldownUntil = now() + 60000
        }
        recordStat(relay, hasMoreCandidates ? "redirected" : "failed")
        saveState()
        logRelayEvent("warn", `Connection error for relay "${relay.name}"`, { relayId: relay.id, error: relay.lastError })
        break
      }

      if (isDirect) {
        const status = response.status
        const blocked = status === 403 || status === 429
        recordRouteOutcome({
          mode: "direct",
          relayId: "",
          relayName: "",
          platform: "direct",
          region: "",
          egress: "",
          status,
          blocked,
          blockedReason:
            status === 429
              ? tr(lang, "Rate limit (429) on the direct connection", "محدودیت مصرف ۴۲۹ روی اتصال مستقیم")
              : status === 403
                ? tr(lang, "Access blocked (403) on the direct connection", "دسترسی مسدود شده (۴۰۳) روی اتصال مستقیم")
                : "",
        })
        // A rate-limited or broken direct route still lets the request fail
        // over to the next candidate. Other responses (including 403) come
        // from the destination and are returned unchanged.
        if ((status === 429 || status >= 500) && hasMoreCandidates) {
          if (lastResponse) await lastResponse.body?.cancel().catch(() => {})
          lastResponse = response
          break
        }
        if (!blocked && status < 500 && state.activeId !== "direct" && !state.rotate) {
          const preferred = candidates.find((r) => r.id === state.activeId)
          if (!state.activeId || preferred) state.activeId = "direct"
        }
        saveState()
        return response
      }

      const egress = response.headers.get("x-relay-egress") || ""
      const inst = response.headers.get("x-relay-instance") || ""
      const rt = response.headers.get("x-relay-runtime") || ""
      const isBun = !!egress && trustedRuntime(rt)
      if (egress) {
        liveEgress.set(relay.id, egress)
        relay.lastEgress = egress
      }
      if (inst) {
        liveInstance.set(relay.id, inst)
        relay.lastInstance = inst
      }
      if (isBun) bunRelays.add(relay.id)

      // Relay reported that its current warm container IP is in x-relay-avoid (HTTP 409 + x-relay-rotate: 1)
      if (response.headers.get("x-relay-rotate") === "1") {
        await response.body?.cancel().catch(() => {})
        if (spin < maxSpins && (await rotateRelayInstance(relay))) {
          continue
        }
        break
      }

      // Platform 502/503/504 without runtime header -> try rotating container
      if (!isBun && [500, 502, 503, 504].includes(response.status) && spin < maxSpins && (bunRelays.has(relay.id) || relay.platform === "vercel")) {
        if (await rotateRelayInstance(relay)) {
          await response.body?.cancel().catch(() => {})
          continue
        }
      }

      // Handle HTTP 429 Rate Limit from upstream
      if (response.status === 429) {
        let errText = ""
        try {
          errText = (await response.clone().text()).slice(0, 2000)
        } catch {}
        const ex = detectExhaustionFromBody(429, response.headers.get("retry-after"), errText)
        if (ex) {
          markSpent(relay.id, egress, ex.until)
          if (isTunnel) {
            psiphonMarkSpent(relay.region, egress, ex.until, target.hostname)
          }
        }
        logRelayEvent("warn", `Rate limit (429) on relay "${relay.name}"${egress ? ` (IP: ${egress})` : ""}`, {
          relayId: relay.id,
          egress,
        })

        // A cloud container or a local tunnel region can be replaced with one
        // that usually egresses from a different address. Cloud rotation waits
        // for the new container because the same relay is retried; a tunnel
        // reconnects in the background while this request tries another region,
        // so one 429 cannot burn a whole hour of renewals or block for minutes.
        if (isTunnel) {
          relay.exhaustedUntil = ex ? ex.until : now() + 10 * 60 * 1000
          relay.status = "exhausted"
          recordStat(relay, ex?.refused ? "refused" : "limited")
          if (hasMoreCandidates) recordStat(relay, "redirected")
          saveState()
          if (psiphonCanRenew(relay.region)) void rotateRelayInstance(relay)
          if (lastResponse) await lastResponse.body?.cancel().catch(() => {})
          lastResponse = response
          break
        }

        const canRotate = isBun || bunRelays.has(relay.id) || relay.platform === "vercel"
        if (canRotate && spin < maxSpins) {
          if (await rotateRelayInstance(relay)) {
            await response.body?.cancel().catch(() => {})
            continue
          }
        }

        // All rotations on this relay exhausted; mark relay on cooldown and try next backup relay
        relay.exhaustedUntil = ex ? ex.until : now() + 10 * 60 * 1000
        relay.status = "exhausted"
        recordStat(relay, ex?.refused ? "refused" : "limited")
        if (hasMoreCandidates) recordStat(relay, "redirected")
        saveState()
        if (lastResponse) await lastResponse.body?.cancel().catch(() => {})
        lastResponse = response
        break
      }

      // Check if a cloud relay rejected its own access token. A tunnel passes
      // upstream 401 responses straight through.
      if (!isTunnel && response.status === 401) {
        const txt = await response.clone().text().catch(() => "")
        if (/Unauthorized relay request/i.test(txt)) {
          relay.status = "auth_error"
          relay.lastError = tr(lang, "The relay access token is invalid (HTTP 401)", "توکن دسترسی رله نامعتبر است (HTTP 401)")
          relay.cooldownUntil = now() + 5 * 60 * 1000
          recordStat(relay, hasMoreCandidates ? "redirected" : "failed")
          saveState()
          if (lastResponse) await lastResponse.body?.cancel().catch(() => {})
          lastResponse = response
          break
        }
      }

      if (response.status === 403) {
        recordStat(relay, "refused")
      } else if (response.status >= 500) {
        recordStat(relay, hasMoreCandidates ? "redirected" : "failed")
      } else {
        recordStat(relay, "ok")
      }

      // Success / normal upstream response
      if (isTunnel && response.status < 400) {
        psiphonReportOk(relay.region, target.hostname)
      }
      relay.latency = now() - startMs
      relay.status = "healthy"
      relay.lastError = ""
      relay.failures = 0
      relay.cooldownUntil = 0
      relay.exhaustedUntil = 0
      if (state.activeId !== relay.id && !state.rotate) {
        // Keep an explicitly selected primary while it is temporarily
        // unavailable (for example a tunnel region that is reconnecting).
        // Fallback routes still carry the request, but must not silently
        // replace the user's choice.
        const preferred = candidates.find((r) => r.id === state.activeId)
        if (!state.activeId || preferred) state.activeId = relay.id
      }
      recordRouteOutcome({
        mode: "relay",
        relayId: relay.id,
        relayName: relay.name,
        platform: relay.platform,
        region: relay.region || "",
        egress: egress || relay.lastEgress || "",
        status: response.status,
        blocked: response.status === 403,
        blockedReason:
          response.status === 403
            ? tr(lang, `The destination rejected the request (403 on ${relay.name})`, `درخواست توسط سرور مقصد رد شد (۴۰۳ روی ${relay.name})`)
            : "",
      })
      saveState()
      return response
    }
  }

  if (lastResponse) {
    recordRouteOutcome({
      mode: "blocked",
      status: lastResponse.status || 429,
      blocked: true,
      blockedReason:
        lastResponse.status === 429
          ? tr(lang, "All active relays reached the 429 rate limit", "همهٔ رله‌های فعال به سقف محدودیت ۴۲۹ رسیده‌اند")
          : tr(lang, `Relay communication error (HTTP ${lastResponse.status})`, `خطای ارتباط با رله‌ها (HTTP ${lastResponse.status})`),
    })
    return lastResponse
  }
  recordRouteOutcome({
    mode: "blocked",
    status: 0,
    blocked: true,
    blockedReason: tr(lang, "No active relay is available and direct connections are disabled", "هیچ رلهٔ فعالی در دسترس نیست و اتصال مستقیم غیرفعال است"),
  })
  throw lastError || new Error(tr(lang, "No active relay is available", "هیچ رلهٔ فعالی در دسترس نیست"))
}

// Pure Node.js store-only ZIP builder for Netlify Function deployment (uses zlib.crc32)
function createZip(files) {
  const parts = []
  const central = []
  let offset = 0
  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name)
    const data = Buffer.from(content)
    const crc = zlib.crc32(data) >>> 0
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0x21, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)

    const dir = Buffer.alloc(46)
    dir.writeUInt32LE(0x02014b50, 0)
    dir.writeUInt16LE(20, 4)
    dir.writeUInt16LE(20, 6)
    dir.writeUInt16LE(0x0800, 8)
    dir.writeUInt16LE(0x21, 14)
    dir.writeUInt32LE(crc, 16)
    dir.writeUInt32LE(data.length, 20)
    dir.writeUInt32LE(data.length, 24)
    dir.writeUInt16LE(nameBuf.length, 28)
    dir.writeUInt32LE(offset, 42)

    parts.push(local, nameBuf, data)
    central.push(dir, nameBuf)
    offset += 30 + nameBuf.length + data.length
  }
  const dirBuf = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(files).length, 8)
  end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(dirBuf.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, dirBuf, end])
}

function slug(value, fallback) {
  const s = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
  return s || `${fallback}-${crypto.randomBytes(2).toString("hex")}`
}

function cleanReason(data, text, secrets) {
  const found =
    data?.errors?.[0]?.message ||
    data?.error?.message ||
    (typeof data?.error === "string" ? data.error : "") ||
    data?.message ||
    (Array.isArray(data?.errors) && typeof data.errors[0] === "string" ? data.errors[0] : "") ||
    text
  return secrets
    .filter(Boolean)
    .reduce((s, x) => s.split(x).join("***"), String(found))
    .replace(/\s+/g, " ")
    .slice(0, 300)
}

async function platformApi(label, url, init, secrets, okStatuses = [], lang = "en") {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(90000) }).catch((e) => {
    throw new Error(
      tr(
        lang,
        `Could not connect to ${label}: ${cleanReason(undefined, String(e?.message || e), secrets)}`,
        `امکان اتصال به ${label} نبود: ${cleanReason(undefined, String(e?.message || e), secrets)}`,
      ),
    )
  })
  const text = await r.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    data = undefined
  }
  if (!r.ok && !okStatuses.includes(r.status)) {
    throw new Error(
      tr(
        lang,
        `${label} rejected the request (HTTP ${r.status}): ${cleanReason(data, text, secrets)}`,
        `${label} درخواست را رد کرد (HTTP ${r.status}): ${cleanReason(data, text, secrets)}`,
      ),
    )
  }
  return data ?? {}
}

const bearerJson = (token, extra = {}) => ({
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
  ...extra,
})

// Resolve platform API token from request input or saved store
function resolvePlatformToken(platform, input) {
  const direct = String(input?.token || input?.apiToken || "").trim()
  if (direct.length >= 8) {
    if (input?.remember) {
      state.savedTokens = state.savedTokens || {}
      state.savedTokens[platform] = direct
      if (platform === "cloudflare" && input?.accountId) {
        state.savedAccount = String(input.accountId).trim().toLowerCase()
      }
      saveState()
    }
    return direct
  }
  if (input?.useSaved && state.savedTokens?.[platform]) {
    if (platform === "cloudflare" && input?.accountId && input?.remember) {
      state.savedAccount = String(input.accountId).trim().toLowerCase()
      saveState()
    }
    return state.savedTokens[platform]
  }
  return ""
}

export function forgetSavedToken(platform, lang = "en") {
  if (!PLATFORMS.includes(platform)) {
    throw new Error(tr(lang, "Invalid platform.", "پلتفرم نامعتبر است."))
  }
  state.savedTokens = state.savedTokens || {}
  state.savedTokens[platform] = ""
  saveState()
  return getPublicState()
}

// Vercel account plan limits (same as opencode-chat relay limits)
const PLAN_LIMITS = {
  hobby: { regionsPerProject: 1, deploymentsPerDay: 100, projects: 200 },
  pro: { regionsPerProject: 5, deploymentsPerDay: 6000, projects: null },
  enterprise: { regionsPerProject: 99, deploymentsPerDay: 24000, projects: null },
}

export async function inspectVercelPlan(input) {
  const token = resolvePlatformToken("vercel", input)
  if (token.length < 8) {
    throw new Error(tr(input, "Please enter a Vercel API token.", "لطفاً توکن API ورسل را وارد کنید."))
  }
  const headers = { authorization: `Bearer ${token}` }
  const secrets = [token]
  const teamsRes = await platformApi("Vercel", "https://api.vercel.com/v2/teams", { headers }, secrets, [], input?.lang)
  const teams = teamsRes.teams || []
  const team = input?.teamId ? teams.find((t) => t.id === input.teamId || t.slug === input.teamId) : teams[0]
  let plan = String(team?.billing?.plan || "").toLowerCase()
  if (!plan) {
    // Also check personal user account if no team billing plan was returned
    try {
      const userRes = await platformApi("Vercel", "https://api.vercel.com/v2/user", { headers }, secrets, [], input?.lang)
      plan = String(userRes?.user?.billing?.plan || "hobby").toLowerCase()
    } catch {
      plan = "hobby"
    }
  }
  const scope = team?.id ? `&teamId=${encodeURIComponent(team.id)}` : ""
  const list = await platformApi("Vercel", `https://api.vercel.com/v9/projects?limit=100${scope}`, { headers }, secrets, [], input?.lang)
  return {
    plan,
    team: String(team?.slug || ""),
    teams: teams.length,
    projects: (list.projects || []).length,
    projectsMore: Boolean(list.pagination?.next),
    limits: PLAN_LIMITS[plan] || PLAN_LIMITS.hobby,
  }
}

async function deployVercel(input, access) {
  const region = /^[a-z]{3}\d$/.test(String(input.region || "")) ? String(input.region) : "fra1"
  const name = slug(input.name, `opencode-relay-${region}`)
  const secrets = [input.token, access]
  const team = input.teamId ? `&teamId=${encodeURIComponent(input.teamId)}` : ""
  const node = input.runtime === "node"
  const config = JSON.stringify({
    ...(node ? {} : { bunVersion: "1.x" }),
    regions: [region],
    rewrites: [{ source: "/(.*)", destination: "/api/relay" }],
    functions: { "api/relay.js": { maxDuration: 300 } },
  })
  const created = await platformApi(
    "Vercel",
    `https://api.vercel.com/v13/deployments?skipAutoDetectionConfirmation=1${team}`,
    {
      method: "POST",
      headers: bearerJson(input.token),
      body: JSON.stringify({
        name,
        target: "production",
        regions: [region],
        projectSettings: { framework: null, serverlessFunctionRegion: region },
        env: { OPENCODE_CHAT_RELAY_TOKEN: access },
        files: [
          { file: "api/relay.js", data: VERCEL_SOURCE, encoding: "utf-8" },
          { file: "vercel.json", data: config, encoding: "utf-8" },
          {
            file: "package.json",
            data: JSON.stringify({ name, ...(node ? { type: "module" } : {}), private: true }),
            encoding: "utf-8",
          },
        ],
      }),
    },
    secrets,
    [],
    input?.lang,
  )
  let d = created
  const until = now() + 120000
  while (d.readyState !== "READY" && now() < until) {
    if (d.readyState === "ERROR" || d.readyState === "CANCELED") {
      throw new Error(
        tr(input, `Failed to create the relay on Vercel (${d.readyState})`, `خطا در ساخت رله روی Vercel (${d.readyState})`),
      )
    }
    await sleep(2000)
    d = await platformApi(
      "Vercel",
      `https://api.vercel.com/v13/deployments/${created.id}?${team.slice(1)}`,
      { headers: bearerJson(input.token) },
      secrets,
      [],
      input?.lang,
    )
  }
  if (d.readyState !== "READY") {
    throw new Error(
      tr(input, "Deployment to Vercel took more than 2 minutes.", "استقرار در Vercel بیش از ۲ دقیقه طول کشید."),
    )
  }
  const alias =
    (d.alias || []).find((a) => a.endsWith(".vercel.app") && !/-[a-z0-9]{9}-/.test(a)) ||
    (d.alias || [])[0] ||
    d.url
  return {
    name,
    url: `https://${alias}`,
    buffered: false,
    runtime: node ? "node-bun-ciphers" : "bun",
    region,
  }
}

async function deployNetlify(input, access) {
  const secrets = [input.token, access]
  const auth = bearerJson(input.token)
  const base = "https://api.netlify.com/api/v1"
  let site
  let name = slug(input.name, "opencode-relay")
  for (let tries = 0; tries < 3 && !site?.id; tries++) {
    const r = await fetch(`${base}/sites`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name }),
      signal: AbortSignal.timeout(60000),
    })
    const text = await r.text()
    let data
    try {
      data = JSON.parse(text)
    } catch {
      data = {}
    }
    if (r.ok) site = data
    else if (r.status === 422) name = `${slug(input.name, "opencode-relay")}-${crypto.randomBytes(2).toString("hex")}`
    else
      throw new Error(
        tr(
          input,
          `Netlify rejected the request (HTTP ${r.status}): ${cleanReason(data, text, secrets)}`,
          `Netlify درخواست را رد کرد (HTTP ${r.status}): ${cleanReason(data, text, secrets)}`,
        ),
      )
  }
  if (!site?.id) throw new Error(tr(input, "Netlify did not accept the site name.", "Netlify نام سایت را نپذیرفت."))
  try {
    await platformApi(
      "Netlify",
      `${base}/sites/${site.id}`,
      { method: "PATCH", headers: auth, body: JSON.stringify({ sso_login: false }) },
      secrets,
      [],
      input?.lang,
    )
    await platformApi(
      "Netlify",
      `${base}/accounts/${site.account_id || site.account_slug}/env?site_id=${site.id}`,
      {
        method: "POST",
        headers: auth,
        body: JSON.stringify([{ key: "OPENCODE_CHAT_RELAY_TOKEN", values: [{ value: access, context: "all" }] }]),
      },
      secrets,
      [],
      input?.lang,
    )
    const html = "<!doctype html><title>OpenCode Relay</title>"
    const fn = createZip({ "relay.js": NETLIFY_SOURCE })
    const deploy = await platformApi(
      "Netlify",
      `${base}/sites/${site.id}/deploys`,
      {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          files: { "/index.html": crypto.createHash("sha1").update(html).digest("hex") },
          functions: { relay: crypto.createHash("sha256").update(fn).digest("hex") },
        }),
      },
      secrets,
      [],
      input?.lang,
    )
    const octet = { authorization: `Bearer ${input.token}`, "content-type": "application/octet-stream" }
    if ((deploy.required || []).length) {
      await platformApi(
        "Netlify",
        `${base}/deploys/${deploy.id}/files/index.html`,
        { method: "PUT", headers: octet, body: html },
        secrets,
        [],
        input?.lang,
      )
    }
    await platformApi(
      "Netlify",
      `${base}/deploys/${deploy.id}/functions/relay?runtime=js`,
      { method: "PUT", headers: octet, body: fn },
      secrets,
      [],
      input?.lang,
    )
    let d = deploy
    const until = now() + 120000
    while (d.state !== "ready" && now() < until) {
      if (d.state === "error") {
        throw new Error(
          tr(
            input,
            `Failed to publish the relay on Netlify: ${cleanReason(undefined, d.error_message || "deploy error", secrets)}`,
            `خطا در انتشار رله روی Netlify: ${cleanReason(undefined, d.error_message || "deploy error", secrets)}`,
          ),
        )
      }
      await sleep(2000)
      d = await platformApi("Netlify", `${base}/deploys/${deploy.id}`, { headers: auth }, secrets, [], input?.lang)
    }
    if (d.state !== "ready")
      throw new Error(
        tr(input, "Deployment to Netlify took more than 2 minutes.", "استقرار در Netlify بیش از ۲ دقیقه طول کشید."),
      )
  } catch (e) {
    await fetch(`${base}/sites/${site.id}`, { method: "DELETE", headers: auth, signal: AbortSignal.timeout(30000) }).catch(() => {})
    throw e
  }
  const host = String(site.default_domain || site.ssl_url?.replace(/^https:\/\//, "") || `${name}.netlify.app`)
  return {
    name,
    url: `https://${host}/.netlify/functions/relay`,
    buffered: true,
    runtime: "node-bun-ciphers",
    siteId: String(site.id),
  }
}

async function deployCloudflare(input, access) {
  const account = String(input.accountId || state.savedAccount || "").trim().toLowerCase()
  if (!/^[a-f0-9]{32}$/.test(account)) {
    throw new Error(
      tr(
        input,
        "The Cloudflare account ID must be 32 hexadecimal characters.",
        "شناسهٔ حساب Cloudflare باید ۳۲ کاراکتر هگزادسیمال باشد.",
      ),
    )
  }
  const secrets = [input.token, access]
  const auth = { authorization: `Bearer ${input.token}` }
  const base = `https://api.cloudflare.com/client/v4/accounts/${account}`
  const name = slug(input.name, "opencode-relay")
  const subdomain = (await platformApi("Cloudflare", `${base}/workers/subdomain`, { headers: auth }, secrets, [], input?.lang))
    ?.result?.subdomain
  if (!subdomain) {
    throw new Error(
      tr(
        input,
        "This Cloudflare account has no workers.dev subdomain yet. Open Workers & Pages once in the Cloudflare dashboard.",
        "این حساب Cloudflare هنوز زیر دامنهٔ workers.dev ندارد. یک‌بار بخش Workers & Pages را در داشبورد Cloudflare باز کنید.",
      ),
    )
  }
  const form = new FormData()
  form.append(
    "metadata",
    new Blob(
      [
        JSON.stringify({
          main_module: "worker.js",
          compatibility_date: "2025-01-01",
          bindings: [{ type: "secret_text", name: "RELAY_TOKEN", text: access }],
        }),
      ],
      { type: "application/json" },
    ),
  )
  form.append("worker.js", new Blob([CLOUDFLARE_SOURCE], { type: "application/javascript+module" }), "worker.js")
  await platformApi(
    "Cloudflare",
    `${base}/workers/scripts/${encodeURIComponent(name)}`,
    { method: "PUT", headers: auth, body: form },
    secrets,
    [],
    input?.lang,
  )
  try {
    await platformApi(
      "Cloudflare",
      `${base}/workers/scripts/${encodeURIComponent(name)}/subdomain`,
      {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      },
      secrets,
      [],
      input?.lang,
    )
  } catch (e) {
    await fetch(`${base}/workers/scripts/${encodeURIComponent(name)}`, { method: "DELETE", headers: auth, signal: AbortSignal.timeout(30000) }).catch(() => {})
    throw e
  }
  return {
    name,
    url: `https://${name}.${subdomain}.workers.dev`,
    buffered: false,
    runtime: "cloudflare-worker",
    account,
  }
}

async function verifyDeployedRelay(url, token, platform) {
  let status = 0
  let egress = ""
  let instance = ""
  const tries = platform === "cloudflare" ? 12 : 6
  for (let i = 0; i < tries; i++) {
    try {
      const headers =
        platform === "cloudflare" || platform === "vercel"
          ? { "x-relay-key": token, "x-relay-control": "ping" }
          : { "x-relay-key": token, "x-relay-target": "https://opencode.ai", "x-relay-path": "/inference/v1/models" }
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(15000) })
      status = r.status
      egress = r.headers.get("x-relay-egress") || ""
      instance = r.headers.get("x-relay-instance") || ""
      if (r.ok) {
        try {
          const data = await r.json()
          if (data?.egress) egress = data.egress
          if (data?.instance) instance = data.instance
        } catch {}
        return { reachable: true, status, egress, instance }
      }
      await r.body?.cancel().catch(() => {})
    } catch {
      status = 0
    }
    await sleep(2000)
  }
  return { reachable: false, status, egress, instance }
}

// One-click deploy and save relay into state
export async function deployAndAddRelay(input) {
  if (!PLATFORMS.includes(input?.platform)) {
    throw new Error(
      tr(input, "Platform must be one of Vercel, Netlify, or Cloudflare.", "پلتفرم باید یکی از Vercel، Netlify یا Cloudflare باشد."),
    )
  }
  const token = resolvePlatformToken(input.platform, input)
  if (token.length < 8) {
    throw new Error(tr(input, "Please enter the platform API token.", "لطفاً توکن API پلتفرم را وارد کنید."))
  }
  const deployInput = { ...input, token }
  const access = crypto.randomBytes(24).toString("base64url")
  const made =
    deployInput.platform === "netlify"
      ? await deployNetlify(deployInput, access)
      : deployInput.platform === "cloudflare"
        ? await deployCloudflare(deployInput, access)
        : await deployVercel(deployInput, access)

  const check = await verifyDeployedRelay(made.url, access, deployInput.platform)
  const id = `relay-${crypto.randomBytes(4).toString("hex")}`
  const entry = {
    id,
    name: made.name,
    platform: deployInput.platform,
    url: made.url,
    token: access,
    region: made.region || "",
    runtime: made.runtime,
    buffered: !!made.buffered,
    siteId: made.siteId || "",
    account: made.account || "",
    enabled: true,
    status: check.reachable ? "healthy" : `HTTP ${check.status || 0}`,
    lastEgress: check.egress || "",
    lastInstance: check.instance || "",
    createdAt: now(),
    stats: { ok: 0, refused: 0, limited: 0, redirected: 0, failed: 0, daily: {} },
  }
  if (check.egress) liveEgress.set(id, check.egress)
  if (check.instance) liveInstance.set(id, check.instance)
  if (made.runtime === "bun" || deployInput.platform === "vercel") bunRelays.add(id)
  state.relays.push(entry)
  if (!state.activeId) state.activeId = id
  saveState()
  logRelayEvent("info", `New relay "${entry.name}" deployed and enabled on ${deployInput.platform}`, {
    relayId: id,
    egress: entry.lastEgress,
  })
  return entry
}

// Add an existing custom/already-deployed relay URL
export async function addCustomRelay(input) {
  const url = String(input.url || "").trim()
  const token = String(input.token || input.apiToken || "").trim()
  const name = String(input.name || "").trim() || "custom-relay"
  const platform = PLATFORMS.includes(input.platform) ? input.platform : "vercel"
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(tr(input, "The relay URL is not valid.", "آدرس URL رله معتبر نیست."))
  }
  const isLocalHost =
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "localhost" ||
    parsed.hostname === "[::1]" ||
    parsed.hostname === "::1"
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLocalHost)) {
    throw new Error(
      tr(
        input,
        "The relay URL must start with https://; http is only allowed for localhost.",
        "آدرس رله باید با https:// شروع شود؛ http فقط برای localhost مجاز است.",
      ),
    )
  }
  if (!token)
    throw new Error(tr(input, "The relay access token (x-relay-key) is required.", "توکن دسترسی رله (x-relay-key) الزامی است."))
  const id = `relay-${crypto.randomBytes(4).toString("hex")}`
  const entry = {
    id,
    name,
    platform,
    url: parsed.toString().replace(/\/$/, ""),
    token,
    region: input.region || "",
    runtime: platform === "cloudflare" ? "cloudflare-worker" : platform === "netlify" ? "node-bun-ciphers" : "bun",
    buffered: platform === "netlify",
    enabled: true,
    status: "untested",
    lastEgress: "",
    lastInstance: "",
    createdAt: now(),
    stats: { ok: 0, refused: 0, limited: 0, redirected: 0, failed: 0, daily: {} },
  }
  state.relays.push(entry)
  if (!state.activeId) state.activeId = id
  saveState()
  try {
    await testRelayById(id, input?.lang)
  } catch {}
  return state.relays.find((r) => r.id === id)
}

// Test a single relay's reachability, latency, runtime, and outbound IP
export async function testRelayById(id, lang = "en") {
  if (String(id).startsWith("psiphon:")) {
    const region = String(id).slice("psiphon:".length).toUpperCase()
    const result = await psiphonTestRegion(region, lang)
    logRelayEvent(result.ok ? "info" : "warn", `Local tunnel ${region} test ${result.ok ? "succeeded" : "failed"} (${result.latency || 0}ms)`, {
      relayId: id,
      egress: result.egress,
    })
    return result
  }
  const relay = state.relays.find((r) => r.id === id)
  if (!relay) throw new Error(tr(lang, "Relay not found.", "رله پیدا نشد."))
  const start = now()
  try {
    // First try ping control if Vercel/Cloudflare
    const pingRes = await fetch(relay.url, {
      headers: {
        "x-relay-key": relay.token || "",
        "x-relay-control": "ping",
      },
      signal: AbortSignal.timeout(15000),
    })
    const rt = pingRes.headers.get("x-relay-runtime") || ""
    if (pingRes.ok && (pingRes.headers.get("content-type") || "").includes("json")) {
      const data = await pingRes.json().catch(() => ({}))
      if (data.egress || data.runtime) {
        relay.latency = now() - start
        relay.status = "healthy"
        relay.lastError = ""
        relay.cooldownUntil = 0
        relay.exhaustedUntil = 0
        if (data.egress) {
          liveEgress.set(relay.id, data.egress)
          relay.lastEgress = data.egress
        }
        if (data.instance) {
          liveInstance.set(relay.id, data.instance)
          relay.lastInstance = data.instance
        }
        if (trustedRuntime(data.runtime || rt)) bunRelays.add(relay.id)
        saveState()
        logRelayEvent("info", `Relay "${relay.name}" test succeeded (${relay.latency}ms)`, {
          relayId: relay.id,
          egress: relay.lastEgress,
        })
        return {
          ok: true,
          latency: relay.latency,
          egress: relay.lastEgress,
          instance: relay.lastInstance,
          runtime: data.runtime || rt || relay.runtime,
        }
      }
    } else {
      await pingRes.body?.cancel().catch(() => {})
    }

    // Fallback test via catalog request (for Netlify or relays without ping handler)
    const catRes = await fetch(relay.url, {
      headers: {
        "x-relay-key": relay.token || "",
        "x-relay-target": "https://opencode.ai",
        "x-relay-path": "/inference/v1/models",
      },
      signal: AbortSignal.timeout(15000),
    })
    const egress = catRes.headers.get("x-relay-egress") || ""
    const inst = catRes.headers.get("x-relay-instance") || ""
    const catRt = catRes.headers.get("x-relay-runtime") || ""
    await catRes.body?.cancel().catch(() => {})
    relay.latency = now() - start
    if (catRes.ok) {
      relay.status = "healthy"
      relay.lastError = ""
      relay.cooldownUntil = 0
      relay.exhaustedUntil = 0
      if (egress) {
        liveEgress.set(relay.id, egress)
        relay.lastEgress = egress
      }
      if (inst) {
        liveInstance.set(relay.id, inst)
        relay.lastInstance = inst
      }
      if (egress && trustedRuntime(catRt)) bunRelays.add(relay.id)
      saveState()
      logRelayEvent("info", `Relay "${relay.name}" test succeeded (${relay.latency}ms)`, {
        relayId: relay.id,
        egress: relay.lastEgress,
      })
      return {
        ok: true,
        latency: relay.latency,
        egress: relay.lastEgress,
        instance: relay.lastInstance,
        runtime: catRt || relay.runtime,
      }
    }
    relay.status = `HTTP ${catRes.status}`
    relay.lastError = tr(lang, `HTTP status code ${catRes.status}`, `کد وضعیت HTTP ${catRes.status}`)
    saveState()
    return { ok: false, status: catRes.status, error: relay.lastError }
  } catch (e) {
    relay.status = "unreachable"
    relay.lastError = String(e?.message || e).slice(0, 160)
    saveState()
    throw new Error(tr(lang, `Cannot reach the relay: ${relay.lastError}`, `عدم دسترسی به رله: ${relay.lastError}`))
  }
}

export async function recycleRelayById(id, lang = "en") {
  if (String(id).startsWith("psiphon:")) {
    const region = String(id).slice("psiphon:".length).toUpperCase()
    const before = psiphonEntryById(id)?.lastEgress || ""
    const renewed = await psiphonRenew(region, lang, false)
    const entry = psiphonEntryById(id)
    return {
      ok: renewed && !!entry && entry.lastEgress !== before,
      egress: entry?.lastEgress || "",
      instance: entry?.lastInstance || "",
      spentCount: entry?.spentCount || 0,
    }
  }
  const relay = state.relays.find((r) => r.id === id)
  if (!relay) throw new Error(tr(lang, "Relay not found.", "رله پیدا نشد."))
  const ok = await rotateRelayInstance(relay)
  const info = relayInfo(relay.id)
  if (info.egress) relay.lastEgress = info.egress
  if (info.instance) relay.lastInstance = info.instance
  relay.cooldownUntil = 0
  relay.exhaustedUntil = 0
  if (ok) relay.status = "healthy"
  saveState()
  return {
    ok,
    egress: relay.lastEgress || info.egress,
    instance: relay.lastInstance || info.instance,
    spentCount: info.spent,
  }
}

export function deleteRelayById(id, lang = "en") {
  if (String(id).startsWith("psiphon:")) {
    throw new Error(
      tr(
        lang,
        "Local tunnel regions are managed from the tunnel panel, not as cloud relays.",
        "منطقه‌های تونل محلی از پنل تونل مدیریت می‌شوند، نه به‌عنوان رلهٔ ابری.",
      ),
    )
  }
  const idx = state.relays.findIndex((r) => r.id === id)
  if (idx < 0) throw new Error(tr(lang, "Relay not found.", "رله پیدا نشد."))
  const removed = state.relays[idx]
  state.relays.splice(idx, 1)
  spentEgress.delete(id)
  liveEgress.delete(id)
  liveInstance.delete(id)
  bunRelays.delete(id)
  if (state.activeId === id) {
    state.activeId = state.relays.find((r) => r.enabled !== false)?.id || ""
  }
  // Never leave the master switch latently on after the last route is gone.
  if (!hasRelayCapacity()) state.enabled = false
  saveState()
  logRelayEvent("info", `Relay "${removed.name}" deleted`)
}

export function updateRelayConfig(patch) {
  if (typeof patch.enabled === "boolean") state.enabled = patch.enabled
  if (typeof patch.rotate === "boolean") {
    state.rotate = patch.rotate
    // Rotation and a fixed primary are mutually exclusive: turning rotation
    // on returns the policy to automatic.
    if (patch.rotate) state.activeId = ""
  }
  if (typeof patch.activeId === "string") {
    const id = patch.activeId.trim()
    if (!id) {
      state.activeId = ""
    } else if (id === "direct") {
      state.activeId = "direct"
      state.allowDirect = true
      state.rotate = false
    } else if (/^psiphon:[A-Za-z]{2}$/.test(id)) {
      state.activeId = `psiphon:${id.slice(8).toUpperCase()}`
      state.rotate = false
    } else if (state.relays.some((r) => r.id === id && r.enabled !== false)) {
      state.activeId = id
      state.rotate = false
    } else {
      state.activeId = ""
    }
  }
  if (typeof patch.exhaustedFailover === "boolean") state.exhaustedFailover = patch.exhaustedFailover
  const directPatch =
    typeof patch.allowDirect === "boolean"
      ? patch.allowDirect
      : typeof patch.fallbackDirect === "boolean"
        ? patch.fallbackDirect
        : undefined
  if (directPatch !== undefined) {
    state.allowDirect = directPatch
    if (!state.allowDirect && state.activeId === "direct") state.activeId = ""
  }
  if (typeof patch.relayRotations === "number") {
    state.relayRotations = Math.max(0, Math.min(10, Math.round(patch.relayRotations)))
  }
  const provList = Array.isArray(patch.providers)
    ? patch.providers
    : Array.isArray(patch.routeProviders)
      ? patch.routeProviders
      : null
  if (provList) {
    state.providers = provList.map((x) => String(x).trim()).filter(Boolean)
  }
  if (patch.originalUrls && typeof patch.originalUrls === "object") {
    for (const [k, v] of Object.entries(patch.originalUrls)) {
      if (typeof v === "string" && v.startsWith("https://")) {
        state.originalUrls[k] = v.trim()
      }
    }
  }
  if (patch.relayToggle && typeof patch.relayToggle === "object") {
    const r = state.relays.find((x) => x.id === patch.relayToggle.id)
    if (r) {
      if (typeof patch.relayToggle.enabled === "boolean") r.enabled = patch.relayToggle.enabled
        if (patch.relayToggle.clearCooldown) {
          r.cooldownUntil = 0
          r.exhaustedUntil = 0
          r.failures = 0
          r.status = "healthy"
          spentEgress.delete(r.id)
          if (lastRouteInfo.blocked) {
            lastRouteInfo = { ...lastRouteInfo, blocked: false, blockedReason: "" }
          }
        }
    }
  }
  // Turning off the last route also turns off the master switch so the UI
  // never shows a hidden "enabled" state with nothing to route through.
  if (!hasRelayCapacity()) state.enabled = false
  saveState()
  return getPublicState()
}

export function getPublicState() {
  const psiphon = psiphonStatus()
  const activeId = (() => {
    const id = state.activeId
    if (!id || state.rotate) return ""
    if (id === "direct") return state.allowDirect ? "direct" : ""
    if (id.startsWith("psiphon:")) {
      return psiphon.regions.some((r) => `psiphon:${r.region}` === id) ? id : ""
    }
    const relay = state.relays.find((r) => r.id === id)
    return relay && relay.enabled !== false ? id : ""
  })()
  return {
    enabled: state.enabled,
    active: isRelayRoutingActive(),
    activeId,
    rotate: state.rotate,
    exhaustedFailover: state.exhaustedFailover,
    allowDirect: state.allowDirect,
    relayRotations: state.relayRotations,
    providers: state.providers,
    originalUrls: state.originalUrls,
    savedTokens: {
      vercel: Boolean(state.savedTokens?.vercel),
      netlify: Boolean(state.savedTokens?.netlify),
      cloudflare: Boolean(state.savedTokens?.cloudflare),
    },
    savedAccount: state.savedAccount || "",
    lastRouteInfo,
    relays: state.relays.map((r) => {
      const info = relayInfo(r.id)
      const s7 = aggregateWindowStats(r, 7)
      const s30 = aggregateWindowStats(r, 30)
      return {
        id: r.id,
        name: r.name,
        platform: r.platform,
        url: r.url,
        region: r.region || "",
        runtime: r.runtime || "bun",
        buffered: !!r.buffered,
        enabled: r.enabled !== false,
        status: r.status || "untested",
        latency: r.latency,
        lastError: r.lastError || "",
        lastEgress: info.egress || r.lastEgress || "",
        lastInstance: info.instance || r.lastInstance || "",
        spentCount: info.spent,
        spentIps: info.spentIps,
        cooldownUntil: r.cooldownUntil || 0,
        exhaustedUntil: r.exhaustedUntil || 0,
        stats: {
          ok: Number(r.stats?.ok || 0),
          refused: Number(r.stats?.refused || 0),
          limited: Number(r.stats?.limited || 0),
          redirected: Number(r.stats?.redirected || 0),
          failed: Number(r.stats?.failed || 0),
        },
        stats7d: s7,
        stats30d: s30,
      }
    }),
    psiphon,
    events: recentEvents.slice(0, 30),
  }
}

export function getRelaySources() {
  return {
    vercel: VERCEL_SOURCE,
    netlify: NETLIFY_SOURCE,
    cloudflare: CLOUDFLARE_SOURCE,
  }
}

// Convert upstream HTTPS URL (e.g. "https://opencode.ai/inference/openai/v1") to local gateway URL
export function toLocalGatewayUrl(localOrigin, upstreamUrl) {
  const u = new URL(upstreamUrl)
  const scheme = u.protocol.replace(":", "")
  const base = `${localOrigin.replace(/\/$/, "")}/app/relay-gateway/${scheme}/${u.host}${u.pathname}`.replace(/\/$/, "")
  return `${base}${u.search}${u.hash}`
}

// OpenCode config is JSONC: comments and trailing commas are valid there. Keep a
// single tolerant parser so routing can also be restored after relays are disabled.
function parseConfigJsonc(raw) {
  const errors = []
  const value = parseJsonc(raw, errors, { allowTrailingComma: true, disallowComments: false })
  if (errors.length > 0) throw new Error("invalid JSONC config")
  return value
}

// Sync opencode.json so enabled providers route through local relay gateway when relays are active
export function syncEngineProviderRouting(configPath, localOrigin) {
  try {
    let raw = "{\n}\n"
    try {
      raw = fs.readFileSync(configPath, "utf8")
    } catch {}
    let parsed = {}
    try {
      parsed = parseConfigJsonc(raw) ?? {}
    } catch {}

    const formattingOptions = { tabSize: 2, insertSpaces: true }
    const hasActiveRelays = isRelayRoutingActive()
    const managedProviders = new Set([
      ...Object.keys(DEFAULT_PROVIDER_URLS),
      ...Object.keys(state.originalUrls || {}),
      ...(state.providers || []),
    ])

    let next = raw
    for (const pid of managedProviders) {
      const currentUrl = parsed?.providers?.[pid]?.settings?.baseURL
      // Record original non-loopback HTTPS baseURL if user had one configured
      if (
        typeof currentUrl === "string" &&
        currentUrl.startsWith("https://") &&
        !currentUrl.includes("127.0.0.1") &&
        !currentUrl.includes("localhost")
      ) {
        state.originalUrls[pid] = currentUrl
      }

      const shouldRoute = hasActiveRelays && state.providers.includes(pid)
      const origUrl = state.originalUrls[pid] || DEFAULT_PROVIDER_URLS[pid]

      if (shouldRoute && origUrl) {
        const gwUrl = toLocalGatewayUrl(localOrigin, origUrl)
        const edits = modify(next, ["providers", pid, "settings", "baseURL"], gwUrl, { formattingOptions })
        next = applyEdits(next, edits)
      } else if (typeof currentUrl === "string" && currentUrl.includes("/app/relay-gateway/")) {
        if (pid === "opencode" || pid === "agentrouter") {
          const edits = modify(next, ["providers", pid, "settings", "baseURL"], undefined, { formattingOptions })
          next = applyEdits(next, edits)
          try {
            const pObj = parseConfigJsonc(next)
            if (pObj?.providers?.[pid]?.settings && Object.keys(pObj.providers[pid].settings).length === 0) {
              next = applyEdits(next, modify(next, ["providers", pid, "settings"], undefined, { formattingOptions }))
            }
            const pObj2 = parseConfigJsonc(next)
            if (pObj2?.providers?.[pid] && Object.keys(pObj2.providers[pid]).length === 0) {
              next = applyEdits(next, modify(next, ["providers", pid], undefined, { formattingOptions }))
            }
          } catch {}
        } else if (origUrl) {
          const edits = modify(next, ["providers", pid, "settings", "baseURL"], origUrl, { formattingOptions })
          next = applyEdits(next, edits)
        }
      }
    }

    if (next !== raw) {
      fs.mkdirSync(path.dirname(configPath), { recursive: true })
      const tmp = `${configPath}.tmp-${process.pid}-${Date.now()}`
      fs.writeFileSync(tmp, next, "utf8")
      fs.renameSync(tmp, configPath)
    }
    saveState()
  } catch (e) {
    console.error("[relay] Failed to sync engine settings:", e?.message || e)
  }
}
