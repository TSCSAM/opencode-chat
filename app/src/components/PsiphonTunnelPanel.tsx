import { useEffect, useMemo, useState } from "react"
import { appPost } from "../lib/api"
import { useI18n } from "../lib/i18n"

export type TunnelScopeStats = {
  ok: number
  refused: number
  limited: number
  redirected: number
  failed: number
}

export type TunnelRegionStatus = {
  region: string
  state: "stopped" | "starting" | "ready" | "reconnecting" | "failed"
  port: number
  exitIp: string
  location: string
  since: number
  usedUpUntil: number
  kiloUntil: number
  otherUntil: number
  checking: string
  renewing: boolean
  renewals: number
  error: string
  instanceId: string
  latency?: number
  lastUsed: number
  spentCount: number
  spentIps: string[]
  stats: TunnelScopeStats
}

export type TunnelStatus = {
  installed: boolean
  problem: string
  problemCode: string
  problemDetail: string
  platform: string
  busy: string
  lastError: string
  running: number
  live: number
  active: boolean
  config: {
    enabled: boolean
    autoStart: boolean
    regions: string[]
    mode: "spread" | "single"
    pinned: string
    skip: boolean
    renew: boolean
  }
  available: string[]
  updatedAt: number
  regions: TunnelRegionStatus[]
  spent: number
  maxRenewals: number
  route: { active: boolean; ready: number }
}

type TunnelTestResult = {
  region: string
  ok: boolean
  status: number
  latency: number
  egress: string
  error: string
}

type TunnelProbeResult = {
  region: string
  ok: boolean
  connected: boolean
  connectMs: number
  latency: number
  egress: string
  location: string
  error: string
  at: number
}

type TunnelActionResponse = {
  ok?: boolean
  changed?: boolean
  status?: TunnelStatus
  results?: TunnelTestResult[]
}

type TunnelProbeResponse = {
  ok?: boolean
  result?: TunnelProbeResult
  error?: string
}

const FALLBACK_REGIONS = [
  "BE", "CA", "CH", "DE", "DK", "ES", "FR", "GB", "IE", "IN",
  "IT", "JP", "NL", "NO", "PL", "SE", "SG", "US",
]
const MAX_REGIONS = 18

function regionName(lang: string, code: string): string {
  try {
    return new Intl.DisplayNames([lang === "fa" ? "fa-IR" : "en-US"], { type: "region" }).of(code) ?? code
  } catch {
    return code
  }
}

function remainingText(t: (text: string, vars?: Record<string, string | number>) => string, num: (n: number) => string, until: number) {
  const diff = Math.max(0, until - Date.now())
  const mins = Math.ceil(diff / 60000)
  if (mins <= 1) return t("Less than a minute")
  return t("{n} minutes", { n: num(mins) })
}

function shortLatency(latency: number, num: (n: number) => string): string {
  if (!latency) return ""
  if (latency >= 1000) return `${num(Math.round(latency / 100) / 10)}s`
  return `${num(Math.round(latency))}ms`
}

export function PsiphonTunnelPanel({
  status,
  masterEnabled,
  primaryId,
  autoRotate,
  onSelectPrimary,
  onApplied,
}: {
  status: TunnelStatus
  masterEnabled: boolean
  primaryId?: string
  autoRotate?: boolean
  onSelectPrimary?: (id: string) => void | Promise<void>
  onApplied?: () => void
}) {
  const { t, num, lang } = useI18n()
  const [local, setLocal] = useState(status)
  const [draftRegions, setDraftRegions] = useState<string[]>(status.config.regions)
  const [draftMode, setDraftMode] = useState<"spread" | "single">(status.config.mode)
  const [draftPinned, setDraftPinned] = useState(status.config.pinned)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [tests, setTests] = useState<Record<string, TunnelTestResult>>({})
  const [probes, setProbes] = useState<Record<string, TunnelProbeResult>>({})
  const [probing, setProbing] = useState("")
  const [selectingPrimary, setSelectingPrimary] = useState("")

  useEffect(() => {
    setLocal(status)
  }, [status])

  const configKey = local.config.regions.join(",")
  useEffect(() => {
    setDraftRegions(local.config.regions)
    setDraftMode(local.config.mode)
    setDraftPinned(local.config.pinned)
  }, [configKey, local.config.mode, local.config.pinned])

  const availableRegions = useMemo(() => {
    const list = new Set([...(local.available?.length ? local.available : FALLBACK_REGIONS), ...draftRegions])
    return [...list].sort()
  }, [local.available, draftRegions])

  const dirty =
    draftRegions.join(",") !== local.config.regions.join(",") ||
    draftMode !== local.config.mode ||
    (draftMode === "single" && draftPinned !== local.config.pinned)

  const working = busy !== null
  const live = local.live
  const running = local.running
  const ready = live > 0
  const pillClass = !local.installed ? "is-err" : ready ? "is-ok" : running > 0 ? "is-pending" : "is-off"
  const pillLabel = !local.installed
    ? t("Client not available")
    : ready
      ? t("{n} regions ready", { n: num(live) })
      : running > 0
        ? t("Connecting…")
        : t("Disconnected")

  const applyStatus = (next?: TunnelStatus) => {
    if (next) setLocal(next)
    onApplied?.()
  }

  const run = async (
    id: string,
    path: string,
    body: Record<string, unknown>,
    after?: (res: TunnelActionResponse) => void,
  ) => {
    setBusy(id)
    setError(null)
    setNotice(null)
    try {
      const res = await appPost<TunnelActionResponse>(path, body)
      applyStatus(res.status)
      after?.(res)
      return res
    } catch (e: any) {
      setError(e?.message || String(e))
      return undefined
    } finally {
      setBusy(null)
    }
  }

  const saveSettings = async (extra: Record<string, unknown> = {}, message?: string) => {
    await run("save", "/app/relays/psiphon/settings", {
      regions: draftRegions,
      mode: draftMode,
      pinned:
        draftMode === "single" && draftRegions.includes(draftPinned)
          ? draftPinned
          : draftRegions[0] || "",
      ...extra,
    }, () => {
      if (message) setNotice(message)
    })
  }

  const toggleSetting = async (key: "enabled" | "autoStart" | "skip" | "renew", value: boolean) => {
    await run(
      key,
      "/app/relays/psiphon/settings",
      { [key]: value },
      () => setNotice(t("Tunnel settings saved.")),
    )
  }

  const handleConnect = async () => {
    await run("connect", "/app/relays/psiphon/connect", {}, () => {
      setNotice(t("Tunnel connection started. Regions become ready within about 15 seconds."))
    })
  }

  const handleDisconnect = async () => {
    await run("disconnect", "/app/relays/psiphon/disconnect", {}, () => {
      setNotice(t("Tunnel disconnected."))
      setTests({})
    })
  }

  const handleUpdateServers = async () => {
    await run("update", "/app/relays/psiphon/update", {}, () => {
      setNotice(t("The tunnel server list was updated."))
    })
  }

  const handleRenew = async (region: string) => {
    const res = await run(`renew:${region}`, "/app/relays/psiphon/renew", { region })
    if (!res) return
    setNotice(
      res.changed
        ? t("A new exit address was assigned in {region}.", { region })
        : t("The new address could not be confirmed yet; try again in a moment."),
    )
  }

  const handleTest = async (region: string) => {
    const res = await run(`test:${region}`, "/app/relays/psiphon/test", { region })
    const row = res?.results?.[0]
    if (row) {
      setTests((prev) => ({ ...prev, [region]: row }))
      if (row.ok) {
        setNotice(
          `${t("Tunnel region {region} is healthy ({latency}ms).", { region, latency: num(row.latency) })}${
            row.egress ? ` — ${t("Egress IP: {ip}", { ip: row.egress })}` : ""
          }`,
        )
      } else {
        setError(row.error || t("The relay returned an invalid response."))
      }
    }
  }

  const handleTestAll = async () => {
    const res = await run("test-all", "/app/relays/psiphon/test", {})
    if (!res?.results) return
    const next: Record<string, TunnelTestResult> = {}
    for (const row of res.results) next[row.region] = row
    setTests((prev) => ({ ...prev, ...next }))
    const ok = res.results.filter((r) => r.ok).length
    setNotice(t("Tunnel regions checked: {ok} of {total} healthy.", { ok: num(ok), total: num(res.results.length) }))
  }

  const handleProbe = async (region: string) => {
    if (probing) return
    setProbing(region)
    setError(null)
    setNotice(null)
    try {
      const res = await appPost<TunnelProbeResponse>("/app/relays/psiphon/probe", { region })
      const row = res.result
      if (!row) {
        setError(res.error || t("The connection test failed."))
        return
      }
      setProbes((prev) => ({ ...prev, [region]: row }))
      if (row.ok) {
        setNotice(
          `${t("Region {region} is reachable ({latency}ms).", { region, latency: num(row.latency) })}${
            row.egress ? ` — ${t("Egress IP: {ip}", { ip: row.egress })}` : ""
          }`,
        )
      } else {
        setError(t("Region {region} is not reachable: {error}", { region, error: row.error || t("The test failed.") }))
      }
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setProbing("")
    }
  }

  const handleSelectPrimary = async (region: string) => {
    if (!onSelectPrimary || selectingPrimary) return
    setSelectingPrimary(region)
    try {
      await onSelectPrimary(`psiphon:${region}`)
    } finally {
      setSelectingPrimary("")
    }
  }

  const toggleRegion = (code: string) => {
    setDraftRegions((prev) => {
      if (prev.includes(code)) {
        const next = prev.filter((x) => x !== code)
        if (draftPinned === code) setDraftPinned(next[0] || "")
        return next
      }
      if (prev.length >= MAX_REGIONS) return prev
      return [...prev, code]
    })
  }

  return (
    <section className="relays-card tunnel-card">
      <div className="relays-card-head">
        <div>
          <div className="relays-title-row">
            <div className="relays-section-title">{t("Local tunnel route (Psiphon)")}</div>
            <span className={`tunnel-pill ${pillClass}`}>{pillLabel}</span>
          </div>
          <p className="relays-section-desc">
            {t("Run official Psiphon clients on this computer and route relay traffic through their regional exits. Each selected region has its own local SOCKS proxy and egress IP.")}
          </p>
        </div>
        <div className="relays-card-head-actions tunnel-head-actions">
          <button
            type="button"
            className="btn btn-sm"
            disabled={working || !local.installed}
            onClick={() => void handleUpdateServers()}
          >
            {busy === "update" ? t("Updating servers…") : t("Update servers")}
          </button>
          {running > 0 ? (
            <button
              type="button"
              className="btn btn-sm btn-danger"
              disabled={working}
              onClick={() => void handleDisconnect()}
            >
              {busy === "disconnect" ? t("Disconnecting…") : t("Disconnect tunnel")}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={working || !local.installed || !local.config.enabled || draftRegions.length === 0 || dirty}
              title={dirty ? t("Save the region selection first.") : undefined}
              onClick={() => void handleConnect()}
            >
              {busy === "connect" ? t("Connecting…") : t("Connect tunnel")}
            </button>
          )}
        </div>
      </div>

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

      {!local.installed ? (
        <div className="tunnel-problem">
          <strong>{t("The tunnel client is not available on this platform.")}</strong>
          <p>{local.problem || t("Bundled tunnel binaries exist for Windows and Linux x64 only.")}</p>
          <code dir="ltr">{local.platform}</code>
        </div>
      ) : (
        <>
          {running > 0 && !masterEnabled && (
            <div className="tunnel-note is-warn">
              {t("The relay master switch is off. The tunnel is connected, but traffic is not being routed through it until you enable relay routing.")}
            </div>
          )}

          <div className="tunnel-layout">
            <div className="tunnel-config">
              <div className="tunnel-block-head">
                <div>
                  <div className="tunnel-block-title">{t("Regions")}</div>
                  <div className="relays-check-desc">
                    {t("Choose up to {n} regions. Use ⚡ to test a region before connecting; each selected region gets its own exit address.", { n: num(MAX_REGIONS) })}
                  </div>
                </div>
                <span className="tunnel-count">{t("{n} selected", { n: num(draftRegions.length) })}</span>
              </div>

              <div className="tunnel-region-grid">
                {availableRegions.map((code) => {
                  const checked = draftRegions.includes(code)
                  const disabled = working || (!checked && draftRegions.length >= MAX_REGIONS)
                  const probe = probes[code]
                  const isProbing = probing === code
                  const probeHint = isProbing
                    ? t("Testing…")
                    : probe
                      ? probe.ok
                        ? probe.connectMs > 0
                          ? t("Connected in {connect}ms; ping {latency}ms.", {
                              connect: num(probe.connectMs),
                              latency: num(probe.latency),
                            })
                          : t("Tunnel region {region} is healthy ({latency}ms).", {
                              region: code,
                              latency: num(probe.latency),
                            })
                        : probe.error || t("The test failed.")
                      : t("Test this region before selecting it. A temporary local client is started and stopped for the test.")
                  const probeTitle =
                    probe?.ok && probe.egress ? `${probeHint} — ${t("Egress IP: {ip}", { ip: probe.egress })}` : probeHint
                  return (
                    <div key={code} className={`tunnel-region-option ${checked ? "is-checked" : ""}`}>
                      <label className="tunnel-region-pick">
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={disabled}
                          onChange={() => toggleRegion(code)}
                        />
                        <span className="tunnel-region-code" dir="ltr">{code}</span>
                        <span className="tunnel-region-label">{regionName(lang, code)}</span>
                      </label>
                      <button
                        type="button"
                        className={`tunnel-region-probe ${isProbing ? "is-busy" : probe ? (probe.ok ? "is-ok" : "is-err") : ""}`}
                        disabled={!local.installed || !!probing}
                        aria-label={`${t("Test connection")}: ${code}`}
                        title={probeTitle}
                        onClick={(event) => {
                          event.preventDefault()
                          event.stopPropagation()
                          void handleProbe(code)
                        }}
                      >
                        {isProbing ? (
                          <span className="tunnel-probe-spinner" aria-hidden="true" />
                        ) : probe ? (
                          probe.ok ? `✓ ${shortLatency(probe.latency, num)}` : "✕"
                        ) : (
                          "⚡"
                        )}
                      </button>
                    </div>
                  )
                })}
              </div>

              <div className="tunnel-save-row">
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={working || !dirty}
                  onClick={() => void saveSettings({}, t("Tunnel settings saved."))}
                >
                  {busy === "save" ? t("Saving…") : t("Save regions")}
                </button>
                {dirty && <span className="tunnel-dirty-hint">{t("Unsaved changes")}</span>}
              </div>

              <div className="tunnel-mode-row">
                <div className="tunnel-block-title">{t("Routing mode")}</div>
                <div className="tunnel-radio-row">
                  <label className={`tunnel-radio ${draftMode === "spread" ? "is-checked" : ""}`}>
                    <input
                      type="radio"
                      name="tunnel-mode"
                      checked={draftMode === "spread"}
                      disabled={working}
                      onChange={() => setDraftMode("spread")}
                    />
                    <span>{t("Spread across regions")}</span>
                  </label>
                  <label className={`tunnel-radio ${draftMode === "single" ? "is-checked" : ""}`}>
                    <input
                      type="radio"
                      name="tunnel-mode"
                      checked={draftMode === "single"}
                      disabled={working}
                      onChange={() => setDraftMode("single")}
                    />
                    <span>{t("Pin to one region")}</span>
                  </label>
                </div>
                {draftMode === "single" && (
                  <select
                    className="settings-input tunnel-pin-select"
                    value={draftPinned}
                    disabled={working}
                    onChange={(e) => setDraftPinned(e.target.value)}
                  >
                    {draftRegions.map((code) => (
                      <option key={code} value={code}>
                        {code} — {regionName(lang, code)}
                      </option>
                    ))}
                  </select>
                )}
                {dirty && (
                  <button
                    type="button"
                    className="btn btn-xs tunnel-apply-mode"
                    disabled={working}
                    onClick={() => void saveSettings({}, t("Tunnel settings saved."))}
                  >
                    {t("Apply mode")}
                  </button>
                )}
              </div>
            </div>

            <div className="tunnel-options">
              <div className="tunnel-block-title">{t("Tunnel behavior")}</div>

              <label className="relays-check-option">
                <input
                  type="checkbox"
                  checked={local.config.enabled}
                  disabled={working}
                  onChange={(e) => void toggleSetting("enabled", e.target.checked)}
                />
                <div>
                  <div className="relays-check-title">{t("Enable local tunnel")}</div>
                  <div className="relays-check-desc">
                    {t("Turning this off stops every regional client immediately.")}
                  </div>
                </div>
              </label>

              <label className="relays-check-option">
                <input
                  type="checkbox"
                  checked={local.config.autoStart}
                  disabled={working || !local.config.enabled}
                  onChange={(e) => void toggleSetting("autoStart", e.target.checked)}
                />
                <div>
                  <div className="relays-check-title">{t("Reconnect when the app starts")}</div>
                  <div className="relays-check-desc">
                    {t("If the tunnel was connected when you closed the app, bring it back automatically next time.")}
                  </div>
                </div>
              </label>

              <label className="relays-check-option">
                <input
                  type="checkbox"
                  checked={local.config.skip}
                  disabled={working}
                  onChange={(e) => void toggleSetting("skip", e.target.checked)}
                />
                <div>
                  <div className="relays-check-title">{t("Skip used-up exit addresses")}</div>
                  <div className="relays-check-desc">
                    {t("When an exit has reached a provider's limit, stop sending that provider's requests through it until it is renewed.")}
                  </div>
                </div>
              </label>

              <label className="relays-check-option">
                <input
                  type="checkbox"
                  checked={local.config.renew}
                  disabled={working}
                  onChange={(e) => void toggleSetting("renew", e.target.checked)}
                />
                <div>
                  <div className="relays-check-title">{t("Get a new address when one is used up")}</div>
                  <div className="relays-check-desc">
                    {t("Each region can reconnect for a fresh exit at most {n} times per hour.", { n: num(local.maxRenewals || 3) })}
                  </div>
                </div>
              </label>

              <div className="tunnel-meta">
                <span>{t("Server list updated:")} <strong>{local.updatedAt ? new Date(local.updatedAt).toLocaleDateString(lang === "fa" ? "fa-IR" : "en-US") : t("bundled list")}</strong></span>
                <span>{t("Used-up exits remembered:")} <strong>{num(local.spent)}</strong></span>
              </div>
            </div>
          </div>

          <div className="tunnel-status-block">
            <div className="tunnel-block-head">
              <div>
                <div className="tunnel-block-title">{t("Selected regions and live status")}</div>
                <div className="relays-check-desc">
                  {t("A region is ready when its tunnel is up and its exit IP has been learned.")}
                </div>
              </div>
              <button
                type="button"
                className="btn btn-sm"
                disabled={working || running === 0}
                onClick={() => void handleTestAll()}
              >
                {busy === "test-all" ? t("Testing all…") : t("Test all regions")}
              </button>
            </div>

            {local.regions.length === 0 ? (
              <div className="tunnel-empty">{t("No regions selected. Save to clear the tunnel selection and stop active clients.")}</div>
            ) : (
              <div className="tunnel-region-list">
                {local.regions.map((region) => {
                  const stateClass =
                    region.state === "ready"
                      ? "is-ok"
                      : region.state === "starting" || region.state === "reconnecting"
                        ? "is-pending"
                        : region.state === "failed"
                          ? "is-err"
                          : "is-off"
                  const stateLabel =
                    region.state === "ready"
                      ? t("Ready")
                      : region.state === "starting"
                        ? t("Connecting…")
                        : region.state === "reconnecting"
                          ? t("Reconnecting…")
                          : region.state === "failed"
                            ? t("Failed")
                            : t("Not connected")
                  const test = tests[region.region]
                  const limitedUntil = Math.max(region.usedUpUntil || 0, region.kiloUntil || 0)
                  const isPrimary = primaryId === `psiphon:${region.region}`
                  return (
                    <div key={region.region} className={`tunnel-region-card ${stateClass}`}>
                      <div className="tunnel-region-card-head">
                        <span className="tunnel-region-code" dir="ltr">{region.region}</span>
                        <strong>{regionName(lang, region.region)}</strong>
                        <span className={`tunnel-state-badge ${stateClass}`}>{stateLabel}</span>
                        {region.renewing && <span className="tunnel-state-badge is-pending">{t("Renewing…")}</span>}
                        {isPrimary && !autoRotate && <span className="relay-active-pill">{t("Selected primary relay")}</span>}
                      </div>

                      <div className="tunnel-region-metrics">
                        <span className="relay-metric-chip" dir="ltr">
                          {t("Exit IP:")} <strong>{region.exitIp || "—"}</strong>
                        </span>
                        {typeof region.latency === "number" && region.latency > 0 && (
                          <span className="relay-metric-chip" dir="ltr">
                            {t("Ping")}: <strong>{region.latency} ms</strong>
                          </span>
                        )}
                        {region.port > 0 && (
                          <span className="relay-metric-chip" dir="ltr">
                            SOCKS: <strong>127.0.0.1:{region.port}</strong>
                          </span>
                        )}
                        <span className="relay-metric-chip">
                          {t("Address renewals: {used}/{max}", { used: num(region.renewals), max: num(local.maxRenewals || 3) })}
                        </span>
                        {region.spentCount > 0 && (
                          <span className="relay-metric-chip is-warn">
                            {t("Used-up addresses: {n}", { n: num(region.spentCount) })}
                          </span>
                        )}
                      </div>

                      {limitedUntil > Date.now() && (
                        <div className="tunnel-region-limit">
                          {t("This exit has reached a provider limit and will be skipped for {time}.", {
                            time: remainingText(t, num, limitedUntil),
                          })}
                        </div>
                      )}
                      {region.error && <div className="relay-pool-error">{t("Last error: {error}", { error: region.error })}</div>}
                      {test && (
                        <div className={`tunnel-test-result ${test.ok ? "is-ok" : "is-err"}`}>
                          {test.ok
                            ? t("Test passed with HTTP {status} in {latency}ms.", { status: num(test.status), latency: num(test.latency) })
                            : test.error || t("The test failed.")}
                        </div>
                      )}

                      <div className="tunnel-region-actions">
                        {!isPrimary && !autoRotate && region.state === "ready" && onSelectPrimary && (
                          <button
                            type="button"
                            className="btn btn-xs"
                            disabled={working || !!selectingPrimary || region.renewing}
                            title={t("Make this tunnel region the default first route")}
                            onClick={() => void handleSelectPrimary(region.region)}
                          >
                            {selectingPrimary === region.region ? t("Selecting…") : t("Select as primary")}
                          </button>
                        )}
                        <button
                          type="button"
                          className="btn btn-xs"
                          disabled={working || region.state !== "ready" || region.renewing}
                          onClick={() => void handleTest(region.region)}
                        >
                          {busy === `test:${region.region}` ? t("Testing…") : t("Test")}
                        </button>
                        <button
                          type="button"
                          className="btn btn-xs btn-accent"
                          disabled={working || region.state !== "ready" || region.renewing}
                          title={t("Reconnect this region to get a fresh exit address.")}
                          onClick={() => void handleRenew(region.region)}
                        >
                          {busy === `renew:${region.region}` ? t("Renewing…") : `↻ ${t("New address")}`}
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </>
      )}
    </section>
  )
}