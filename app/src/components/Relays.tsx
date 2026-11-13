import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { appGet, appPost } from "../lib/api"
import { useI18n } from "../lib/i18n"
import { PsiphonTunnelPanel, type TunnelStatus } from "./PsiphonTunnelPanel"

type DeployPlatform = "vercel" | "netlify" | "cloudflare"

type RelayOutcomeStats = {
  ok: number
  refused: number
  limited: number
  redirected: number
  failed: number
}

export type RelayEntry = {
  id: string
  name: string
  platform: DeployPlatform
  url: string
  region: string
  runtime: string
  buffered: boolean
  enabled: boolean
  status: string
  latency?: number
  lastError: string
  lastEgress: string
  lastInstance: string
  spentCount: number
  spentIps: string[]
  cooldownUntil: number
  exhaustedUntil: number
  stats: RelayOutcomeStats
  stats7d: RelayOutcomeStats
  stats30d: RelayOutcomeStats
}

type RelayEvent = {
  id: string
  time: number
  level: "info" | "warn" | "error"
  message: string
  relayId?: string
  egress?: string
}

export type RelayState = {
  enabled: boolean
  /** True only when the master switch is on and at least one relay is enabled. */
  active?: boolean
  activeId: string
  rotate: boolean
  exhaustedFailover: boolean
  allowDirect: boolean
  relayRotations: number
  providers: string[]
  originalUrls: Record<string, string>
  savedTokens: {
    vercel: boolean
    netlify: boolean
    cloudflare: boolean
  }
  savedAccount: string
  lastRouteInfo?: {
    mode: string
    relayId: string
    relayName: string
    platform: string
    region: string
    egress: string
    status: number
    blocked: boolean
    blockedReason: string
    time: number
  }
  relays: RelayEntry[]
  events: RelayEvent[]
  psiphon?: TunnelStatus
}

type RelaySources = {
  vercel: string
  netlify: string
  cloudflare: string
}

type PlanInspect = {
  plan: string
  team: string
  teams: number
  projects: number
  projectsMore: boolean
  limits: {
    regionsPerProject: number
    deploymentsPerDay: number
    projects: number | null
  }
}

type BatchJob = {
  region: string
  name: string
  status: "waiting" | "running" | "done" | "failed" | "skipped"
  detail?: string
}

const VERCEL_REGIONS: { id: string; label: string }[] = [
  { id: "fra1", label: "Europe — Frankfurt" },
  { id: "cdg1", label: "Europe — Paris" },
  { id: "lhr1", label: "Europe — London" },
  { id: "dub1", label: "Europe — Dublin" },
  { id: "arn1", label: "Europe — Stockholm" },
  { id: "iad1", label: "US East — Washington" },
  { id: "sfo1", label: "US West — San Francisco" },
  { id: "pdx1", label: "US Northwest — Portland" },
  { id: "cle1", label: "US Central — Cleveland" },
  { id: "gru1", label: "South America — São Paulo" },
  { id: "hnd1", label: "Asia — Tokyo" },
  { id: "kix1", label: "Asia — Osaka" },
  { id: "icn1", label: "Asia — Seoul" },
  { id: "sin1", label: "Asia — Singapore" },
  { id: "hkg1", label: "Asia — Hong Kong" },
  { id: "tpe1", label: "Asia — Taipei" },
  { id: "bom1", label: "Asia — Mumbai" },
  { id: "syd1", label: "Oceania — Sydney" },
  { id: "cpt1", label: "Africa — Cape Town" },
]

function regionLabel(id: string): string {
  return VERCEL_REGIONS.find((r) => r.id === id)?.label ?? id
}

function countryName(lang: string, code: string): string {
  try {
    return new Intl.DisplayNames([lang === "fa" ? "fa-IR" : "en-US"], { type: "region" }).of(code) ?? code
  } catch {
    return code
  }
}

const DEPLOY_HELP: Record<
  DeployPlatform,
  {
    label: string
    tokenUrl: string
    placeholder: string
    nameLabel: string
    what: string[]
    steps: string[]
    note: { tone: "good" | "warn"; text: string }
  }
> = {
  vercel: {
    label: "Vercel",
    tokenUrl: "https://vercel.com/account/tokens",
    placeholder: "vcp_...",
    nameLabel: "Project name (optional)",
    what: [
      "A lightweight serverless function is deployed to your Vercel account and routes AI model requests through Vercel's cloud servers.",
      "With the Bun runtime, every container has its own egress IP. As soon as a 429 (rate limit) response arrives, the container is recycled and immediately replaced by a fresh one with a new IP.",
      "A random secret is configured on the server during deployment so only your app can pass through this relay.",
    ],
    steps: [
      "Click “Create a token on Vercel” to open the Vercel account tokens page.",
      "Enter a name, set the scope to your personal account or team, and click Create.",
      "Copy the token, paste it below, tick the regions you want, and press deploy.",
    ],
    note: {
      tone: "good",
      text: "The main recommendation for OpenCode Free: Vercel relays with the Bun runtime have a fully compatible TLS fingerprint and can recycle containers to mint fresh egress IPs in the same region.",
    },
  },
  netlify: {
    label: "Netlify",
    tokenUrl: "https://app.netlify.com/user/applications#personal-access-tokens",
    placeholder: "nfp_...",
    nameLabel: "Site name (optional)",
    what: [
      "A small site containing a Netlify Function is created in your Netlify account.",
      "This relay arranges the TLS cipher order like Bun so it can pass the OpenCode Free firewall check.",
      "Note that responses from free Netlify functions are fully buffered, so the model reply appears after a few seconds.",
    ],
    steps: [
      "Click “Create a token on Netlify” to open the Personal access tokens section.",
      "Click New access token, write a description, and press Generate token.",
      "Copy the token and enter it below.",
    ],
    note: {
      tone: "good",
      text: "Compatible with OpenCode Free and all services. A good backup relay alongside Vercel.",
    },
  },
  cloudflare: {
    label: "Cloudflare",
    tokenUrl: "https://dash.cloudflare.com/profile/api-tokens",
    placeholder: "cfut_...",
    nameLabel: "Worker name (optional)",
    what: [
      "A Cloudflare Worker is published to Cloudflare's edge network under your account's workers.dev subdomain.",
      "Response streaming is instant with no buffering and the free daily quota is very high.",
      "Because Cloudflare Workers cannot customize the TLS fingerprint, this relay is great for standard services such as AgentRouter and OpenAI gateways, but OpenCode Free rejects it.",
    ],
    steps: [
      "Make sure you have opened Workers & Pages once in the Cloudflare dashboard so your workers.dev subdomain exists.",
      "On the API Tokens page click Create Token and choose the Edit Cloudflare Workers template.",
      "Enter the 32-character Account ID (from the Workers & Pages sidebar) and the token below.",
    ],
    note: {
      tone: "warn",
      text: "Note: OpenCode Free servers reject the Cloudflare Worker TLS fingerprint, so the app automatically keeps OpenCode Free traffic off Cloudflare and uses it only for other providers.",
    },
  },
}

const KNOWN_PROVIDERS: { id: string; label: string; desc: string }[] = [
  { id: "opencode", label: "OpenCode Zen / Free", desc: "OpenCode's free and built-in models (cloud relay or local tunnel)" },
  { id: "agentrouter", label: "AgentRouter", desc: "AgentRouter.org service (works with all three platforms)" },
]

export function Relays({
  fullPage = false,
  onBack,
  onOpenFullPage,
  onChanged,
}: {
  fullPage?: boolean
  onBack?: () => void
  onOpenFullPage?: () => void
  onChanged?: () => void
}) {
  const { t, num, lang } = useI18n()
  const [state, setState] = useState<RelayState | null>(null)
  const [sources, setSources] = useState<RelaySources | null>(null)
  const [showSources, setShowSources] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [statsWindow, setStatsWindow] = useState<7 | 30>(7)

  // Modals
  const [deployModalPlatform, setDeployModalPlatform] = useState<DeployPlatform | null>(null)
  const [customModalOpen, setCustomModalOpen] = useState(false)

  // Custom relay form
  const [customPlatform, setCustomPlatform] = useState<DeployPlatform>("vercel")
  const [customName, setCustomName] = useState("")
  const [customUrl, setCustomUrl] = useState("")
  const [customToken, setCustomToken] = useState("")
  const [customRegion, setCustomRegion] = useState("")

  const formatRemaining = (untilMs: number) => {
    const diff = Math.max(0, untilMs - Date.now())
    const mins = Math.ceil(diff / 60000)
    if (mins <= 1) return t("Less than a minute")
    return t("{n} minutes", { n: num(mins) })
  }

  const load = useCallback(async () => {
    try {
      const s = await appGet<RelayState>("/app/relays")
      setState(s)
    } catch (e: any) {
      setError(e.message || String(e))
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = setInterval(() => {
      void load()
    }, 8000)
    return () => clearInterval(timer)
  }, [load])

  const updateConfig = async (patch: Record<string, unknown>) => {
    setBusy("config")
    setError(null)
    try {
      const next = await appPost<RelayState>("/app/relays/config", patch)
      setState(next)
      onChanged?.()
    } catch (e: any) {
      setError(e.message || String(e))
    } finally {
      setBusy(null)
    }
  }

  const handleTestRelay = async (id: string) => {
    setBusy(`test:${id}`)
    setError(null)
    setNotice(null)
    try {
      const res = await appPost<{ ok: boolean; latency?: number; egress?: string; error?: string; state: RelayState }>(
        "/app/relays/test",
        { id },
      )
      setState(res.state)
      if (res.ok) {
        setNotice(`${t("Relay connection test succeeded ({latency}ms)", { latency: num(res.latency ?? 0) })}${res.egress ? ` — ${t("Egress IP: {ip}", { ip: res.egress })}` : ""}`)
      } else {
        setError(res.error || t("The relay returned an invalid response."))
      }
    } catch (e: any) {
      setError(e.message || String(e))
      void load()
    } finally {
      setBusy(null)
    }
  }

  const handleRecycleRelay = async (id: string) => {
    setBusy(`recycle:${id}`)
    setError(null)
    setNotice(null)
    try {
      const res = await appPost<{ ok: boolean; egress?: string; instance?: string; state: RelayState }>(
        "/app/relays/recycle",
        { id },
      )
      setState(res.state)
      if (res.ok) {
        setNotice(`${t("Relay container recycled and a new egress IP was assigned")}${res.egress ? `: ${res.egress}` : ""}`)
      } else {
        setNotice(t("Recycle requested; the fresh container will take over on the next request."))
      }
    } catch (e: any) {
      setError(e.message || String(e))
    } finally {
      setBusy(null)
    }
  }

  const handleTestAll = async () => {
    if (!state?.relays.length) return
    setBusy("test-all")
    setError(null)
    setNotice(null)
    let okCount = 0
    for (const r of state.relays) {
      try {
        const res = await appPost<{ ok: boolean; state: RelayState }>("/app/relays/test", { id: r.id })
        setState(res.state)
        if (res.ok) okCount++
      } catch {}
    }
    setBusy(null)
    setNotice(t("All relays checked: {ok} of {total} healthy.", { ok: num(okCount), total: num(state.relays.length) }))
  }

  const handleDeleteRelay = async (id: string, name: string) => {
    if (!window.confirm(t("Delete relay \"{name}\" from the app list?", { name }))) return
    setBusy(`delete:${id}`)
    setError(null)
    try {
      const res = await appPost<{ ok: boolean; state: RelayState }>("/app/relays/delete", { id })
      setState(res.state)
      onChanged?.()
    } catch (e: any) {
      setError(e.message || String(e))
    } finally {
      setBusy(null)
    }
  }

  const handleAddCustom = async () => {
    if (!customUrl.trim() || !customToken.trim()) {
      setError(t("Relay URL and access token (x-relay-key) are required."))
      return
    }
    setBusy("add-custom")
    setError(null)
    try {
      const res = await appPost<{ ok: boolean; relay: RelayEntry; state: RelayState }>("/app/relays/add", {
        platform: customPlatform,
        name: customName.trim() || undefined,
        url: customUrl.trim(),
        token: customToken.trim(),
        region: customRegion.trim() || undefined,
      })
      setState(res.state)
      setCustomName("")
      setCustomUrl("")
      setCustomToken("")
      setCustomRegion("")
      setCustomModalOpen(false)
      setNotice(t("Relay \"{name}\" was added and tested.", { name: res.relay.name }))
      onChanged?.()
    } catch (e: any) {
      setError(e.message || String(e))
    } finally {
      setBusy(null)
    }
  }

  const toggleShowSources = async () => {
    if (!showSources && !sources) {
      try {
        const s = await appGet<RelaySources>("/app/relays/sources")
        setSources(s)
      } catch (e: any) {
        setError(e.message || String(e))
      }
    }
    setShowSources((v) => !v)
  }

  const toggleProvider = (providerId: string) => {
    if (!state) return
    const current = state.providers || []
    const next = current.includes(providerId)
      ? current.filter((x) => x !== providerId)
      : [...current, providerId]
    void updateConfig({ providers: next })
  }

  const deployedVercelRegions = useMemo(() => {
    const s = new Set<string>()
    for (const r of state?.relays || []) {
      if (r.platform === "vercel" && r.region) s.add(r.region)
    }
    return s
  }, [state?.relays])

  const tunnelRunning = state?.psiphon?.running ?? 0
  const tunnelLive = state?.psiphon?.live ?? 0
  const availableRelays = (state?.relays.filter((r) => r.enabled !== false).length ?? 0) + (tunnelRunning > 0 ? 1 : 0)
  const relayActive = Boolean(state?.enabled && availableRelays > 0)
  const healthyCount = useMemo(
    () =>
      (state?.relays || []).filter((r) => r.enabled && r.status === "healthy").length +
      tunnelLive +
      (state?.allowDirect ? 1 : 0),
    [state?.relays, state?.allowDirect, tunnelLive],
  )

  if (!state) {
    return (
      <div className={fullPage ? "relays-page" : "relays-embedded"}>
        <div className="settings-loading">{t("Loading relay and tunnel status…")}</div>
      </div>
    )
  }

  const totals = state.relays.reduce(
    (acc, r) => {
      const row = statsWindow === 7 ? r.stats7d || r.stats : r.stats30d || r.stats
      acc.ok += row?.ok || 0
      acc.refused += row?.refused || 0
      acc.redirected += row?.redirected || 0
      acc.failed += row?.failed || 0
      acc.limited += row?.limited || 0
      return acc
    },
    { ok: 0, refused: 0, redirected: 0, failed: 0, limited: 0 },
  )
  for (const row of state.psiphon?.regions || []) {
    totals.ok += row.stats?.ok || 0
    totals.refused += row.stats?.refused || 0
    totals.redirected += row.stats?.redirected || 0
    totals.failed += row.stats?.failed || 0
    totals.limited += row.stats?.limited || 0
  }
  const tunnelRows = state.psiphon?.regions || []
  const routeRowCount = state.relays.length + tunnelRows.length
  const lastRoute = state.lastRouteInfo
  const directActive = state.activeId === "direct" && !state.rotate
  const directCard = (
    <div
      className={`relay-pool-item is-direct ${directActive ? "is-primary-relay" : ""} ${
        state.allowDirect ? "" : "is-disabled"
      }`}
    >
      <div className="relay-pool-item-top">
        <div className="relay-pool-title-group">
          <span className={`relay-status-dot ${state.allowDirect ? "is-ok" : "is-disabled"}`} />
          <strong className="relay-pool-name">{t("Direct connection")}</strong>
          <span className="relay-platform-badge is-direct">{t("System")}</span>
          {directActive && <span className="relay-active-pill">{t("Selected primary relay")}</span>}
        </div>
        <div className="relay-pool-actions">
          {!directActive && state.allowDirect && !state.rotate && (
            <button
              type="button"
              className="btn btn-xs"
              disabled={busy !== null}
              onClick={() => void updateConfig({ activeId: "direct" })}
              title={t("Make the direct connection the default first route")}
            >
              {t("Select as primary")}
            </button>
          )}
        </div>
      </div>
      <div className="relay-pool-metrics">
        <span className="relay-metric-chip">
          {t("Status:")}{" "}
          <strong>{state.allowDirect ? t("Available") : t("Disabled")}</strong>
        </span>
        {state.lastRouteInfo?.mode === "direct" && state.lastRouteInfo.status > 0 && (
          <span className="relay-metric-chip">
            {t("Last used: HTTP {status}", { status: num(state.lastRouteInfo.status) })}
          </span>
        )}
        <span className="relay-metric-chip">
          {t("System internet connection; no relay or tunnel in between.")}
        </span>
      </div>
    </div>
  )

  return (
    <div className={fullPage ? "relays-page" : "relays-embedded"}>
      {/* Page Header */}
      <header className="relays-page-header">
        <div className="relays-page-header-main">
          {fullPage && onBack && (
            <button type="button" className="btn btn-sm relays-back-btn" onClick={onBack}>
              ← {t("Back to chat")}
            </button>
          )}
          <div>
            <div className="relays-title-row">
              <h2 className="relays-page-title">{t("Relays, local tunnel and automatic IP rotation")}</h2>
              <span className={`relays-global-pill ${relayActive && healthyCount > 0 ? "is-on" : "is-off"}`}>
                {relayActive
                  ? t("{n} active routes in the pool", { n: num(healthyCount) })
                  : state.enabled
                    ? t("Add a relay or connect the tunnel")
                    : t("Relay routing is disabled")}
              </span>
            </div>
            <p className="relays-page-subtitle">
              {t("Route OpenCode traffic through the direct connection, your own cloud functions on Vercel, Netlify and Cloudflare, or regional exits of the local Psiphon tunnel. When an HTTP 429 is hit, the current relay or exit is rotated and the request is retried immediately with a fresh egress IP.")}
            </p>
          </div>
        </div>

        <div className="relays-page-header-actions">
          {!fullPage && onOpenFullPage && (
            <button type="button" className="btn btn-sm btn-primary" onClick={onOpenFullPage}>
              {t("Open full page ↗")}
            </button>
          )}
          <label
            className="relays-master-switch"
            title={availableRelays === 0 ? t("Add a relay or connect the tunnel first to enable relay routing") : undefined}
          >
            <input
              type="checkbox"
              checked={relayActive}
              disabled={busy === "config" || availableRelays === 0}
              onChange={(e) => void updateConfig({ enabled: e.target.checked })}
            />
            <span>{t("Enable relay system")}</span>
            {availableRelays === 0 && (
              <span className="relays-switch-hint">{t("Add a relay or connect the tunnel")}</span>
            )}
          </label>
        </div>
      </header>

      {error && (
        <div className="relay-alert relay-alert-error">
          <span>⚠️ {error}</span>
          <button type="button" className="relay-alert-close" onClick={() => setError(null)}>
            ✕
          </button>
        </div>
      )}
      {notice && (
        <div className="relay-alert relay-alert-ok">
          <span>✓ {notice}</span>
          <button type="button" className="relay-alert-close" onClick={() => setNotice(null)}>
            ✕
          </button>
        </div>
      )}

      {/* Top Deploy Bar (opencode-chat "Deploy a relay" bar) */}
      <section className="relays-card relays-deploy-bar-card">
        <div className="relays-deploy-bar">
          <div className="relays-deploy-bar-info">
            <div className="relays-section-title">{t("Deploy a new cloud relay automatically")}</div>
            <p className="relays-section-desc">
              {t("Pick a platform and the relay script will be created, configured and enabled in your cloud account with your API token:")}
            </p>
          </div>

          <div className="relays-deploy-buttons">
            <button
              type="button"
              className="relay-platform-btn relay-platform-vercel"
              onClick={() => setDeployModalPlatform("vercel")}
            >
              <span className="relay-platform-icon">▲</span>
              <span className="relay-platform-name">{t("Deploy on Vercel")}</span>
              <span className="relay-platform-tag is-good">{t("Recommended • container rotation and 19 regions")}</span>
            </button>

            <button
              type="button"
              className="relay-platform-btn relay-platform-netlify"
              onClick={() => setDeployModalPlatform("netlify")}
            >
              <span className="relay-platform-icon">◆</span>
              <span className="relay-platform-name">{t("Deploy on Netlify")}</span>
              <span className="relay-platform-tag is-good">{t("Compatible with OpenCode Free")}</span>
            </button>

            <button
              type="button"
              className="relay-platform-btn relay-platform-cloudflare"
              onClick={() => setDeployModalPlatform("cloudflare")}
            >
              <span className="relay-platform-icon">☁</span>
              <span className="relay-platform-name">{t("Deploy on Cloudflare")}</span>
              <span className="relay-platform-tag is-neutral">{t("For standard providers")}</span>
            </button>

            <button
              type="button"
              className="relay-platform-btn relay-platform-custom"
              onClick={() => setCustomModalOpen(true)}
            >
              <span className="relay-platform-icon">＋</span>
              <span className="relay-platform-name">{t("Add an already deployed relay")}</span>
              <span className="relay-platform-tag is-neutral">{t("Connect with URL and access key")}</span>
            </button>
          </div>
        </div>
      </section>

      {state.psiphon && (
        <PsiphonTunnelPanel
          status={state.psiphon}
          masterEnabled={state.enabled}
          primaryId={state.activeId}
          autoRotate={state.rotate}
          onSelectPrimary={(id) => updateConfig({ activeId: id })}
          onApplied={() => {
            void load()
            onChanged?.()
          }}
        />
      )}

      {/* Main Two-Column Grid: Active Relay Pool + Routing Strategy */}
      <div className="relays-main-grid">
        {/* Left / Primary Column: Relay Pool List */}
        <section className="relays-card relays-pool-card">
          <div className="relays-card-head">
            <div>
              <div className="relays-section-title">
                {t("Your relay pool ({n})", { n: num(state.relays.length + 1) })}
              </div>
              <p className="relays-section-desc">
                {t("Live status of the direct connection and each cloud relay, including its egress IP, container ID and the number of IPs that hit the 429 limit.")}
              </p>
            </div>
            <div className="relays-card-head-actions">
              {state.relays.length > 0 && (
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busy !== null}
                  onClick={() => void handleTestAll()}
                >
                  {busy === "test-all" ? t("Testing all…") : t("Test all")}
                </button>
              )}
              <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => void load()}>
                {t("Update")}
              </button>
            </div>
          </div>

          {directCard}

          {state.relays.length === 0 ? (
            <div className="relays-empty-box">
              <div className="relays-empty-icon">🛰️</div>
              <div className="relays-empty-title">{t("No cloud relays registered yet")}</div>
              <p className="relays-empty-desc">
                {tunnelRunning > 0
                  ? t("The local tunnel is connected with {n} regions and is already taking part in relay routing. You can still add cloud relays as extra backup routes.", { n: num(tunnelRunning) })
                  : t("To get around HTTP 429 errors, click Deploy on Vercel in the bar above and deploy several regions in one go, or connect the local tunnel.")}
              </p>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => setDeployModalPlatform("vercel")}
              >
                {t("▲ Start deploying a Vercel relay")}
              </button>
            </div>
          ) : (
            <div className="relay-pool-list">
              {state.relays.map((r) => {
                const isExhausted = r.exhaustedUntil > Date.now() || r.cooldownUntil > Date.now()
                const isActive = state.activeId === r.id
                const statusClass = !r.enabled
                  ? "is-disabled"
                  : isExhausted
                    ? "is-exhausted"
                    : r.status === "healthy"
                      ? "is-ok"
                      : r.status === "untested"
                        ? "is-unknown"
                        : "is-err"

                return (
                  <div key={r.id} className={`relay-pool-item ${statusClass} ${isActive ? "is-primary-relay" : ""}`}>
                    <div className="relay-pool-item-top">
                      <div className="relay-pool-title-group">
                        <span className={`relay-status-dot ${statusClass}`} />
                        <strong className="relay-pool-name">{r.name}</strong>
                        <span className={`relay-platform-badge is-${r.platform}`}>{r.platform}</span>
                        {r.region && (
                          <span className="relay-meta-badge" title={`${t(regionLabel(r.region))} (${r.region})`}>
                            📍 {r.region}
                          </span>
                        )}
                        {r.runtime && <span className="relay-meta-badge">⚙ {r.runtime}</span>}
                        {isActive && !state.rotate && (
                          <span className="relay-active-pill">{t("Selected primary relay")}</span>
                        )}
                      </div>

                      <div className="relay-pool-actions">
                        {!isActive && r.enabled && !state.rotate && (
                          <button
                            type="button"
                            className="btn btn-xs"
                            disabled={busy !== null}
                            onClick={() => void updateConfig({ activeId: r.id })}
                            title={t("Make this the default first relay")}
                          >
                            {t("Select as primary")}
                          </button>
                        )}
                        <button
                          type="button"
                          className="btn btn-xs"
                          disabled={busy !== null}
                          onClick={() => void handleTestRelay(r.id)}
                        >
                          {busy === `test:${r.id}` ? t("Testing…") : t("Test")}
                        </button>
                        {(r.platform === "vercel" || r.runtime === "bun") && (
                          <button
                            type="button"
                            className="btn btn-xs btn-accent"
                            disabled={busy !== null}
                            onClick={() => void handleRecycleRelay(r.id)}
                            title={t("Power off the current container and get a fresh one with a new egress IP")}
                          >
                            {busy === `recycle:${r.id}` ? t("Rotating…") : `↻ ${t("Rotate container IP")}`}
                          </button>
                        )}
                        <button
                          type="button"
                          className="btn btn-xs"
                          disabled={busy !== null}
                          onClick={() =>
                            void updateConfig({
                              relayToggle: {
                                id: r.id,
                                enabled: !r.enabled,
                                clearCooldown: isExhausted,
                              },
                            })
                          }
                        >
                          {isExhausted ? t("Clear limit") : r.enabled ? t("Disable") : t("Enable")}
                        </button>
                        <button
                          type="button"
                          className="btn btn-xs btn-danger"
                          disabled={busy !== null}
                          onClick={() => void handleDeleteRelay(r.id, r.name)}
                        >
                          {t("Delete")}
                        </button>
                      </div>
                    </div>

                    <div className="relay-pool-url" dir="ltr">
                      {r.url}
                    </div>

                    <div className="relay-pool-metrics">
                      <span className="relay-metric-chip">
                        {t("Status:")}{" "}
                        <strong>
                          {!r.enabled
                            ? t("Disabled")
                            : isExhausted
                              ? t("Limited for {time}", { time: formatRemaining(Math.max(r.exhaustedUntil, r.cooldownUntil)) })
                              : r.status === "healthy"
                                ? t("Healthy and ready")
                                : r.status}
                        </strong>
                      </span>
                      {r.lastEgress && (
                        <span className="relay-metric-chip" dir="ltr">
                          IP: <strong>{r.lastEgress}</strong>
                        </span>
                      )}
                      {r.lastInstance && (
                        <span className="relay-metric-chip" dir="ltr">
                          {t("Container")}: <code>{r.lastInstance.slice(0, 8)}</code>
                        </span>
                      )}
                      {typeof r.latency === "number" && (
                        <span className="relay-metric-chip" dir="ltr">
                          {t("Ping")}: <strong>{r.latency} ms</strong>
                        </span>
                      )}
                      {r.spentCount > 0 && (
                        <span
                          className="relay-metric-chip is-warn"
                          title={t("Burned IPs the relay automatically avoids: {ips}", { ips: (r.spentIps || []).join(", ") })}
                        >
                          {t("Swapped IPs")}: <strong>{num(r.spentCount)}</strong>
                        </span>
                      )}
                    </div>

                    {r.lastError && <div className="relay-pool-error">{t("Last error: {error}", { error: r.lastError })}</div>}
                  </div>
                )
              })}
            </div>
          )}
        </section>

        {/* Right / Secondary Column: Routing Strategy & Provider Selection */}
        <aside className="relays-side-column">
          <section className="relays-card">
            <div className="relays-section-title">{t("Routing policy and rotation")}</div>
            <p className="relays-section-desc">
              {t("Choose one primary route or let the app rotate and fail over across the direct connection, cloud relays and the Psiphon tunnel.")}
            </p>

            <div className="relays-options-stack">
              <div className="relays-primary-route">
                <label htmlFor="relay-primary-route-select" className="relays-primary-route-label">
                  {t("Primary route")}
                </label>
                <select
                  id="relay-primary-route-select"
                  className="settings-input relays-primary-route-select"
                  value={state.activeId}
                  disabled={busy === "config"}
                  onChange={(e) => void updateConfig({ activeId: e.target.value })}
                >
                  <option value="">{t("Automatic — rotate and fail over across all routes")}</option>
                  <optgroup label={t("Direct connection")}>
                    <option value="direct">{t("Direct connection")}</option>
                  </optgroup>
                  {state.relays.some((r) => r.enabled !== false) && (
                    <optgroup label={t("Cloud relays")}>
                      {state.relays
                        .filter((r) => r.enabled !== false)
                        .map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.name}
                          </option>
                        ))}
                    </optgroup>
                  )}
                  {tunnelRows.length > 0 && (
                    <optgroup label={t("Psiphon tunnel")}>
                      {tunnelRows.map((r) => (
                        <option key={r.region} value={`psiphon:${r.region}`}>
                          {r.region} — {countryName(lang, r.region)}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
                <div className="relays-check-desc">
                  {t("This route is tried first. Automatic distributes requests and fails over across every enabled route.")}
                </div>
              </div>

              <div className="relays-current-route">
                <span>{t("Current route:")}</span>
                <strong>
                  {lastRoute?.mode === "direct"
                    ? t("Direct connection")
                    : lastRoute?.mode === "relay"
                      ? lastRoute.relayName || lastRoute.platform || t("Relay")
                      : lastRoute?.mode === "blocked"
                        ? t("Blocked")
                        : t("No request routed yet")}
                </strong>
                {lastRoute?.blockedReason ? (
                  <span className="relays-current-route-detail">{lastRoute.blockedReason}</span>
                ) : lastRoute?.status ? (
                  <span className="relays-current-route-detail" dir="ltr">HTTP {num(lastRoute.status)}</span>
                ) : null}
              </div>

              <label className="relays-check-option">
                <input
                  type="checkbox"
                  checked={state.rotate}
                  disabled={busy === "config"}
                  onChange={(e) => void updateConfig({ rotate: e.target.checked })}
                />
                <div>
                  <div className="relays-check-title">{t("Automatic rotation across all routes")}</div>
                  <div className="relays-check-desc">
                    {t("Each new request goes to the next route: cloud relays, Psiphon regions and the direct connection.")}
                  </div>
                </div>
              </label>

              <label className="relays-check-option">
                <input
                  type="checkbox"
                  checked={state.exhaustedFailover}
                  disabled={busy === "config"}
                  onChange={(e) => void updateConfig({ exhaustedFailover: e.target.checked })}
                />
                <div>
                  <div className="relays-check-title">{t("Automatic failover to the next route on 429 or errors")}</div>
                  <div className="relays-check-desc">
                    {t("If a relay, a tunnel region or the direct connection fails or is rate-limited, move to the next healthy route without showing an error.")}
                  </div>
                </div>
              </label>

              <label className="relays-check-option">
                <input
                  type="checkbox"
                  checked={state.allowDirect}
                  disabled={busy === "config"}
                  onChange={(e) => void updateConfig({ allowDirect: e.target.checked })}
                />
                <div>
                  <div className="relays-check-title">{t("Allow direct connection")}</div>
                  <div className="relays-check-desc">
                    {t("Direct can be selected as the primary route; this switch controls whether it also joins automatic rotation and failover.")}
                  </div>
                </div>
              </label>

              <div className="relays-select-row">
                <label htmlFor="relay-rotations-select">{t("Maximum container recycle attempts per request:")}</label>
                <select
                  id="relay-rotations-select"
                  className="settings-input relays-inline-select"
                  value={state.relayRotations}
                  disabled={busy === "config"}
                  onChange={(e) => void updateConfig({ relayRotations: Number(e.target.value) })}
                >
                  {[1, 2, 3, 4, 6, 8].map((n) => (
                    <option key={n} value={n}>
                      {t("{n} container rotations", { n: num(n) })}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </section>

          <section className="relays-card">
            <div className="relays-section-title">{t("Services covered by the relay")}</div>
            <p className="relays-section-desc">
              {t("Choose which services' traffic in opencode.json should pass through the local relay gateway:")}
            </p>
            <div className="relays-options-stack">
              {KNOWN_PROVIDERS.map((p) => {
                const checked = (state.providers || []).includes(p.id)
                return (
                  <label key={p.id} className="relays-check-option">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={busy === "config"}
                      onChange={() => toggleProvider(p.id)}
                    />
                    <div>
                      <div className="relays-check-title">{p.label}</div>
                      <div className="relays-check-desc">{t(p.desc)}</div>
                    </div>
                  </label>
                )
              })}
            </div>
          </section>
        </aside>
      </div>

      {/* "How your relays have done" Performance Table */}
      <section className="relays-card relays-stats-card">
        <div className="relays-card-head">
          <div>
            <div className="relays-section-title">{t("How your relays have done")}</div>
            <p className="relays-section-desc">
              {t("Requests that succeeded, were refused, redirected to the next relay, or hit the rate limit:")}
            </p>
          </div>
          <div className="relays-window-tabs" role="tablist">
            <button
              type="button"
              className={`relays-window-tab ${statsWindow === 7 ? "is-active" : ""}`}
              onClick={() => setStatsWindow(7)}
            >
              {t("Last 7 days")}
            </button>
            <button
              type="button"
              className={`relays-window-tab ${statsWindow === 30 ? "is-active" : ""}`}
              onClick={() => setStatsWindow(30)}
            >
              {t("Last 30 days")}
            </button>
          </div>
        </div>

        <div className="relays-table-wrap">
          <table className="relays-stats-table">
            <thead>
              <tr>
                <th>{t("Relay")}</th>
                <th>{t("Region")}</th>
                <th>{t("Worked")}</th>
                <th>{t("Refused")}</th>
                <th>{t("Redirected")}</th>
                <th>{t("Failed")}</th>
                <th>{t("Retry limit")}</th>
              </tr>
            </thead>
            <tbody>
              {routeRowCount === 0 ? (
                <tr>
                  <td colSpan={7} className="relays-table-empty">
                    {t("No statistics to show yet.")}
                  </td>
                </tr>
              ) : (
                <>
                  {state.relays.map((r) => {
                    const row = statsWindow === 7 ? r.stats7d || r.stats : r.stats30d || r.stats
                    return (
                      <tr key={r.id}>
                        <td>
                          <div className="relays-table-name-cell">
                            <span className={`relay-platform-badge is-${r.platform}`}>{r.platform}</span>
                            <strong>{r.name}</strong>
                          </div>
                        </td>
                        <td>{r.region ? `${r.region} (${t(regionLabel(r.region))})` : t("Global (Edge)")}</td>
                        <td className="stat-col-ok">{num(row?.ok || 0)}</td>
                        <td className={row?.refused ? "stat-col-warn" : ""}>{num(row?.refused || 0)}</td>
                        <td className={row?.redirected ? "stat-col-info" : ""}>{num(row?.redirected || 0)}</td>
                        <td className={row?.failed ? "stat-col-err" : ""}>{num(row?.failed || 0)}</td>
                        <td className={row?.limited ? "stat-col-warn" : ""}>{num(row?.limited || 0)}</td>
                      </tr>
                    )
                  })}
                  {tunnelRows.map((r) => (
                    <tr key={`tunnel:${r.region}`}>
                      <td>
                        <div className="relays-table-name-cell">
                          <span className="relay-platform-badge is-psiphon">tunnel</span>
                          <strong>{t("Tunnel region {region}", { region: r.region })}</strong>
                        </div>
                      </td>
                      <td>{`${r.region} (${countryName(lang, r.region)})`}</td>
                      <td className="stat-col-ok">{num(r.stats?.ok || 0)}</td>
                      <td className={r.stats?.refused ? "stat-col-warn" : ""}>{num(r.stats?.refused || 0)}</td>
                      <td className={r.stats?.redirected ? "stat-col-info" : ""}>{num(r.stats?.redirected || 0)}</td>
                      <td className={r.stats?.failed ? "stat-col-err" : ""}>{num(r.stats?.failed || 0)}</td>
                      <td className={r.stats?.limited ? "stat-col-warn" : ""}>{num(r.stats?.limited || 0)}</td>
                    </tr>
                  ))}
                  {routeRowCount > 1 && (
                    <tr className="relays-table-total-row">
                      <td>{t("All relays")}</td>
                      <td>—</td>
                      <td className="stat-col-ok">{num(totals.ok)}</td>
                      <td>{num(totals.refused)}</td>
                      <td>{num(totals.redirected)}</td>
                      <td>{num(totals.failed)}</td>
                      <td>{num(totals.limited)}</td>
                    </tr>
                  )}
                </>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Recent Diagnostic Log + Source Code Viewer */}
      <div className="relays-bottom-row">
        {state.events && state.events.length > 0 && (
          <section className="relays-card">
            <div className="relays-section-title">{t("Recent relay rotation events")}</div>
            <div className="relay-events-list">
              {state.events.slice(0, 8).map((ev) => (
                <div key={ev.id} className={`relay-event-item is-${ev.level}`}>
                  <span className="relay-event-time">
                    {new Date(ev.time).toLocaleTimeString("fa-IR", {
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                    })}
                  </span>
                  <span className="relay-event-msg">{ev.message}</span>
                </div>
              ))}
            </div>
          </section>
        )}

        <section className="relays-card">
          <div className="relays-card-head">
            <div>
              <div className="relays-section-title">{t("Relay source code for manual deployment")}</div>
              <p className="relays-section-desc">
                {t("If you prefer to upload the relay server code manually to Vercel, Netlify or Cloudflare:")}
              </p>
            </div>
            <button type="button" className="btn btn-sm" onClick={() => void toggleShowSources()}>
              {showSources ? t("Hide source code") : t("Show relay source code")}
            </button>
          </div>
          {showSources && sources && (
            <div className="relay-sources-box">
              <div className="relay-source-block">
                <div className="relay-source-header">Vercel (relays/vercel-bun/api/relay.js)</div>
                <pre className="relay-source-pre" dir="ltr">
                  {sources.vercel}
                </pre>
              </div>
              <div className="relay-source-block">
                <div className="relay-source-header">Netlify (relays/netlify-relay.js)</div>
                <pre className="relay-source-pre" dir="ltr">
                  {sources.netlify}
                </pre>
              </div>
              <div className="relay-source-block">
                <div className="relay-source-header">Cloudflare Worker (relays/cloudflare-worker.js)</div>
                <pre className="relay-source-pre" dir="ltr">
                  {sources.cloudflare}
                </pre>
              </div>
            </div>
          )}
        </section>
      </div>

      {/* Rich Platform Deploy Dialog (opencode-chat style) */}
      {deployModalPlatform && (
        <DeployRelayModal
          platform={deployModalPlatform}
          state={state}
          deployedVercelRegions={deployedVercelRegions}
          onClose={() => setDeployModalPlatform(null)}
          onStateUpdated={(nextState, msg) => {
            setState(nextState)
            if (msg) setNotice(msg)
            onChanged?.()
          }}
        />
      )}

      {/* Add Existing / Custom Relay Modal */}
      {customModalOpen && (
        <div
          className="modal-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setCustomModalOpen(false)
          }}
        >
          <div className="modal relays-deploy-modal" role="dialog" aria-modal="true">
            <header className="modal-header">
              <h2>{t("Add an already deployed relay")}</h2>
              <button type="button" className="icon-btn" onClick={() => setCustomModalOpen(false)}>
                ✕
              </button>
            </header>
            <div className="modal-body relays-modal-body">
              <p className="relays-section-desc">
                {t("If you already deployed a relay on your account, enter its details to add it to the pool:")}
              </p>
              <div className="relays-form-grid">
                <div className="settings-field">
                  <label>{t("Platform")}</label>
                  <select
                    className="settings-input"
                    value={customPlatform}
                    onChange={(e) => setCustomPlatform(e.target.value as DeployPlatform)}
                  >
                    <option value="vercel">Vercel</option>
                    <option value="netlify">Netlify</option>
                    <option value="cloudflare">Cloudflare</option>
                  </select>
                </div>
                <div className="settings-field">
                  <label>{t("Custom relay name")}</label>
                  <input
                    type="text"
                    className="settings-input"
                    dir="ltr"
                    placeholder="opencode-relay-fra1"
                    value={customName}
                    onChange={(e) => setCustomName(e.target.value)}
                  />
                </div>
                <div className="settings-field">
                  <label>{t("Region code (optional — e.g. fra1)")}</label>
                  <input
                    type="text"
                    className="settings-input"
                    dir="ltr"
                    placeholder="fra1"
                    value={customRegion}
                    onChange={(e) => setCustomRegion(e.target.value)}
                  />
                </div>
              </div>

              <div className="settings-field">
                <label>{t("Full relay URL")}</label>
                <input
                  type="url"
                  className="settings-input"
                  dir="ltr"
                  placeholder="https://my-relay.vercel.app"
                  value={customUrl}
                  onChange={(e) => setCustomUrl(e.target.value)}
                />
              </div>

              <div className="settings-field">
                <label>{t("Relay access token (OPENCODE_CHAT_RELAY_TOKEN / RELAY_TOKEN)")}</label>
                <input
                  type="password"
                  className="settings-input"
                  dir="ltr"
                  placeholder={t("Secret defined in the server environment variable")}
                  value={customToken}
                  onChange={(e) => setCustomToken(e.target.value)}
                />
              </div>
            </div>
            <footer className="modal-footer">
              <button type="button" className="btn" onClick={() => setCustomModalOpen(false)}>
                {t("Cancel")}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy === "add-custom"}
                onClick={() => void handleAddCustom()}
              >
                {busy === "add-custom" ? t("Checking and adding…") : t("Add and test relay")}
              </button>
            </footer>
          </div>
        </div>
      )}
    </div>
  )
}

function DeployRelayModal({
  platform,
  state,
  deployedVercelRegions,
  onClose,
  onStateUpdated,
}: {
  platform: DeployPlatform
  state: RelayState
  deployedVercelRegions: Set<string>
  onClose: () => void
  onStateUpdated: (next: RelayState, notice?: string) => void
}) {
  const { t, num } = useI18n()
  const help = DEPLOY_HELP[platform]
  const hasSavedToken = Boolean(state.savedTokens?.[platform])

  const [token, setToken] = useState("")
  const [remember, setRemember] = useState(true)
  const [accountId, setAccountId] = useState(state.savedAccount || "")
  const [name, setName] = useState("")
  const [runtime, setRuntime] = useState<"bun" | "node">("bun")

  // Default region selection: pick first Vercel region not yet deployed, or fra1
  const defaultRegion = useMemo(() => {
    const unused = VERCEL_REGIONS.find((r) => !deployedVercelRegions.has(r.id))
    return unused ? unused.id : "fra1"
  }, [deployedVercelRegions])

  const [selectedRegions, setSelectedRegions] = useState<string[]>([defaultRegion])
  const [planInfo, setPlanInfo] = useState<PlanInspect | null>(null)
  const [checkingPlan, setCheckingPlan] = useState(false)
  const [deploying, setDeploying] = useState(false)
  const [batchJobs, setBatchJobs] = useState<BatchJob[] | null>(null)
  const [modalError, setModalError] = useState<string | null>(null)
  const stopBatchRef = useRef(false)

  const canAuthenticate = token.trim().length >= 8 || hasSavedToken
  const cloudflareReady = platform !== "cloudflare" || /^[a-f0-9]{32}$/i.test(accountId.trim())
  const regionsReady = platform !== "vercel" || selectedRegions.length > 0

  const toggleRegion = (id: string) => {
    setSelectedRegions((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  const handleForgetToken = async () => {
    setModalError(null)
    try {
      const res = await appPost<{ ok: boolean; state: RelayState }>("/app/relays/token/forget", { platform })
      onStateUpdated(res.state)
    } catch (e: any) {
      setModalError(e.message || String(e))
    }
  }

  const handleCheckVercelPlan = async () => {
    setCheckingPlan(true)
    setModalError(null)
    try {
      const res = await appPost<PlanInspect & { state: RelayState }>("/app/relays/inspect", {
        token: token.trim() || undefined,
        useSaved: !token.trim() && hasSavedToken,
        remember,
      })
      setPlanInfo(res)
      if (res.state) onStateUpdated(res.state)
    } catch (e: any) {
      setModalError(e.message || String(e))
    } finally {
      setCheckingPlan(false)
    }
  }

  const handleStartDeploy = async () => {
    if (!canAuthenticate) {
      setModalError(t("Please enter the {platform} API token.", { platform: help.label }))
      return
    }
    if (!cloudflareReady) {
      setModalError(t("Cloudflare account ID must be exactly 32 hexadecimal characters."))
      return
    }

    setDeploying(true)
    setModalError(null)
    stopBatchRef.current = false

    // Single deployment for Netlify / Cloudflare or single Vercel region
    if (platform !== "vercel" || selectedRegions.length === 1) {
      const region = platform === "vercel" ? selectedRegions[0] : undefined
      try {
        const res = await appPost<{ ok: boolean; relay: RelayEntry; state: RelayState }>("/app/relays/deploy", {
          platform,
          token: token.trim() || undefined,
          useSaved: !token.trim() && hasSavedToken,
          remember,
          accountId: platform === "cloudflare" ? accountId.trim() : undefined,
          name: name.trim() || undefined,
          region,
          runtime: platform === "vercel" ? runtime : undefined,
        })
        onStateUpdated(
          res.state,
          `${t("Relay \"{name}\" was created and enabled on {platform}", { name: res.relay.name, platform: help.label })}${res.relay.lastEgress ? ` ${t("(IP: {ip})", { ip: res.relay.lastEgress })}` : ""}.`,
        )
        onClose()
      } catch (e: any) {
        setModalError(e.message || String(e))
      } finally {
        setDeploying(false)
      }
      return
    }

    // Multi-region sequential batch deployment for Vercel
    const baseSlug = name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 28)

    const initialJobs: BatchJob[] = selectedRegions.map((reg) => ({
      region: reg,
      name: baseSlug ? `${baseSlug}-${reg}` : `opencode-relay-${reg}`,
      status: "waiting",
    }))
    setBatchJobs(initialJobs)

    let latestState = state
    let successCount = 0

    for (let i = 0; i < initialJobs.length; i++) {
      if (stopBatchRef.current) {
        setBatchJobs((prev) =>
          (prev || []).map((j, idx) => (idx >= i ? { ...j, status: "skipped", detail: t("Stopped by user") } : j)),
        )
        break
      }

      const job = initialJobs[i]
      setBatchJobs((prev) => (prev || []).map((j, idx) => (idx === i ? { ...j, status: "running" } : j)))

      try {
        const res = await appPost<{ ok: boolean; relay: RelayEntry; state: RelayState }>("/app/relays/deploy", {
          platform: "vercel",
          token: token.trim() || undefined,
          useSaved: !token.trim() && (hasSavedToken || i > 0),
          remember,
          name: job.name,
          region: job.region,
          runtime,
        })
        latestState = res.state
        successCount++
        onStateUpdated(latestState)
        setBatchJobs((prev) =>
          (prev || []).map((j, idx) =>
            idx === i
              ? {
                  ...j,
                  name: res.relay.name,
                  status: "done",
                  detail: res.relay.lastEgress ? `IP: ${res.relay.lastEgress}` : res.relay.url,
                }
              : j,
          ),
        )
      } catch (e: any) {
        setBatchJobs((prev) =>
          (prev || []).map((j, idx) =>
            idx === i ? { ...j, status: "failed", detail: e.message || String(e) } : j,
          ),
        )
      }
    }

    setDeploying(false)
    if (successCount > 0) {
      onStateUpdated(
        latestState,
        t("{n} Vercel relays were deployed to the selected regions.", { n: num(successCount) }),
      )
    }
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !deploying) onClose()
      }}
    >
      <div className="modal relays-deploy-modal" role="dialog" aria-modal="true">
        <header className="modal-header">
          <h2>{t("Deploy a relay on {platform}", { platform: help.label })}</h2>
          <button type="button" className="icon-btn" disabled={deploying} onClick={onClose}>
            ✕
          </button>
        </header>

        <div className="modal-body relays-modal-body">
          {/* Explanation Box ("What is a ... relay?" + "How to get the token") */}
          <div className="deploy-help-box">
            <div className="deploy-help-title">{t("What is a {platform} relay and how does it work?", { platform: help.label })}</div>
            <ul className="deploy-help-list">
              {help.what.map((item, idx) => (
                <li key={idx}>{t(item)}</li>
              ))}
            </ul>
            <div className="deploy-help-title">{t("How to get an access token:")}</div>
            <ol className="deploy-help-steps">
              {help.steps.map((step, idx) => (
                <li key={idx}>{t(step)}</li>
              ))}
            </ol>
            <div className={`deploy-compat-callout is-${help.note.tone}`}>{t(help.note.text)}</div>
          </div>

          {modalError && <div className="relay-alert relay-alert-error">⚠️ {modalError}</div>}

          {/* API Token Section */}
          <div className="settings-field">
            <div className="deploy-label-row">
              <label>{t("{platform} account API token", { platform: help.label })}</label>
              <a
                href={help.tokenUrl}
                target="_blank"
                rel="noreferrer"
                className="deploy-external-link"
              >
                {t("Create a token on {platform} ↗", { platform: help.label })}
              </a>
            </div>
            <input
              type="password"
              className="settings-input"
              dir="ltr"
              placeholder={hasSavedToken ? t("A token is already saved on this machine — enter a new token to replace it") : help.placeholder}
              value={token}
              disabled={deploying}
              onChange={(e) => setToken(e.target.value)}
            />

            <div className="deploy-token-toolbar">
              <label className="deploy-remember-check">
                <input
                  type="checkbox"
                  checked={remember}
                  disabled={deploying}
                  onChange={(e) => setRemember(e.target.checked)}
                />
                <span>{t("Save this token on this computer for future deployments")}</span>
              </label>

              <div className="deploy-token-actions">
                {hasSavedToken && (
                  <button
                    type="button"
                    className="btn btn-xs"
                    disabled={deploying}
                    onClick={() => void handleForgetToken()}
                  >
                    {t("Delete saved token")}
                  </button>
                )}
                {platform === "vercel" && (
                  <button
                    type="button"
                    className="btn btn-xs"
                    disabled={!canAuthenticate || checkingPlan || deploying}
                    onClick={() => void handleCheckVercelPlan()}
                  >
                    {checkingPlan ? t("Checking…") : t("Check my plan")}
                  </button>
                )}
              </div>
            </div>

            {planInfo && (
              <div className="deploy-plan-banner">
                {t("Detected plan: {plan}", { plan: planInfo.plan.toUpperCase() })}
                {planInfo.team ? ` ${t("(team: {team})", { team: planInfo.team })}` : ` ${t("(personal account)")}`} • {t("Current projects: {n}", {
                  n: `${num(planInfo.projects)}${planInfo.projectsMore ? "+" : ""}`,
                })}
                {planInfo.limits.projects ? ` ${t("of {n}", { n: num(planInfo.limits.projects) })}` : ""} • {t("Daily deploy limit: {n}", {
                  n: num(planInfo.limits.deploymentsPerDay),
                })}
              </div>
            )}
          </div>

          {/* Cloudflare Account ID */}
          {platform === "cloudflare" && (
            <div className="settings-field">
              <label>{t("Cloudflare account ID (32 characters)")}</label>
              <input
                type="text"
                className="settings-input"
                dir="ltr"
                placeholder="0123456789abcdef0123456789abcdef"
                value={accountId}
                disabled={deploying}
                onChange={(e) => setAccountId(e.target.value)}
              />
            </div>
          )}

          {/* Vercel 19-Region Multi-Select Grid */}
          {platform === "vercel" && (
            <div className="settings-field">
              <div className="deploy-regions-header">
                <div>
                  <label>{t("Server regions — multiple selection is supported")}</label>
                  <div className="relays-check-desc">
                    {t("Each region creates an independent project with its own IP pool. Regions that already have a relay are marked.")}
                  </div>
                </div>
                <div className="deploy-regions-actions">
                  <span className="deploy-regions-count">
                    {t("{n} regions selected", { n: num(selectedRegions.length) })}
                  </span>
                  <button
                    type="button"
                    className="btn btn-xs"
                    disabled={deploying}
                    onClick={() => setSelectedRegions(VERCEL_REGIONS.map((r) => r.id))}
                  >
                    {t("Select all ({n})", { n: num(VERCEL_REGIONS.length) })}
                  </button>
                  <button
                    type="button"
                    className="btn btn-xs"
                    disabled={deploying}
                    onClick={() =>
                      setSelectedRegions(
                        VERCEL_REGIONS.filter((r) => !deployedVercelRegions.has(r.id)).map((r) => r.id),
                      )
                    }
                  >
                    {t("Regions without a relay")}
                  </button>
                  <button
                    type="button"
                    className="btn btn-xs"
                    disabled={deploying}
                    onClick={() => setSelectedRegions([])}
                  >
                    {t("Clear")}
                  </button>
                </div>
              </div>

              <div className="deploy-regions-grid">
                {VERCEL_REGIONS.map((reg) => {
                  const checked = selectedRegions.includes(reg.id)
                  const alreadyHas = deployedVercelRegions.has(reg.id)
                  return (
                    <label
                      key={reg.id}
                      className={`deploy-region-item ${checked ? "is-selected" : ""} ${alreadyHas ? "has-existing" : ""}`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={deploying}
                        onChange={() => toggleRegion(reg.id)}
                      />
                      <div className="deploy-region-text">
                        <div className="deploy-region-top">
                          <code className="deploy-region-code">{reg.id}</code>
                          {alreadyHas && <span className="deploy-region-existing-tag">{t("Has relay")}</span>}
                        </div>
                        <span className="deploy-region-label">{t(reg.label)}</span>
                      </div>
                    </label>
                  )
                })}
              </div>
            </div>
          )}

          {/* Runtime & Project Name Row */}
          <div className="relays-form-grid">
            {platform === "vercel" && (
              <div className="settings-field">
                <label>{t("Function runtime")}</label>
                <select
                  className="settings-input"
                  value={runtime}
                  disabled={deploying}
                  onChange={(e) => setRuntime(e.target.value as "bun" | "node")}
                >
                  <option value="bun">{t("Bun 1.x (recommended — full container rotation and TLS support)")}</option>
                  <option value="node">{t("Node.js (manual Bun TLS fingerprint)")}</option>
                </select>
              </div>
            )}

            <div className="settings-field">
              <label>{t(help.nameLabel)}</label>
              <input
                type="text"
                className="settings-input"
                dir="ltr"
                placeholder={
                  platform === "vercel" && selectedRegions.length > 1
                    ? t("Name prefix (each region code is appended automatically)")
                    : `opencode-relay${platform === "vercel" && selectedRegions[0] ? `-${selectedRegions[0]}` : ""}`
                }
                value={name}
                disabled={deploying}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
          </div>

          {/* Batch Progress Queue when deploying multiple regions */}
          {batchJobs && (
            <div className="deploy-batch-box">
              <div className="deploy-batch-header">
                <strong>{t("Batch deployment status ({done} of {total})", {
                  done: num(batchJobs.filter((j) => j.status === "done").length),
                  total: num(batchJobs.length),
                })}</strong>
                {deploying && (
                  <button
                    type="button"
                    className="btn btn-xs btn-danger"
                    onClick={() => {
                      stopBatchRef.current = true
                    }}
                  >
                    {t("Stop after this item")}
                  </button>
                )}
              </div>
              <div className="deploy-batch-list">
                {batchJobs.map((job) => (
                  <div key={job.region} className={`deploy-batch-row is-${job.status}`}>
                    <code className="deploy-region-code">{job.region}</code>
                    <span className="deploy-batch-name" dir="ltr">
                      {job.name}
                    </span>
                    <span className="deploy-batch-status">
                      {job.status === "waiting" && t("Waiting…")}
                      {job.status === "running" && t("Building and testing on Vercel…")}
                      {job.status === "done" && t("✓ Enabled ({detail})", { detail: job.detail || "" })}
                      {job.status === "failed" && t("✕ Error: {detail}", { detail: job.detail || "" })}
                      {job.status === "skipped" && t("Skipped")}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <footer className="modal-footer">
          <button type="button" className="btn" disabled={deploying} onClick={onClose}>
            {batchJobs && !deploying ? t("Close") : t("Cancel")}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={deploying || !canAuthenticate || !cloudflareReady || !regionsReady}
            onClick={() => void handleStartDeploy()}
          >
            {deploying
              ? t("Building and starting (about 20–45 seconds)…")
              : platform === "vercel" && selectedRegions.length > 1
                ? t("Deploy {n} relays to Vercel automatically", { n: num(selectedRegions.length) })
                : t("Deploy the relay to {platform} automatically", { platform: help.label })}
          </button>
        </footer>
      </div>
    </div>
  )
}
