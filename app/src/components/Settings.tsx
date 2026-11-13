import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react"
import { appGet, appPost, del, get, patch, post } from "../lib/api"
import type { AgentInfo, ConfigEntry, McpEntry, PluginEntry, SavedPermission } from "../lib/types"
import { ModelLimitsPanel } from "./LimitsPanel"
import { CustomProviders } from "./CustomProviders"
import { LANGUAGES, useI18n } from "../lib/i18n"

// The providers tab is heavy; load it only when it is opened.
const Providers = lazy(() => import("./Providers").then((m) => ({ default: m.Providers })))

const EXCLUDED = new Set(["theme", "keybinds", "tooltips", "$schema"])

type TabKey = "general" | "providers" | "custom" | "limits" | "perms" | "tools" | "mcp" | "plugins" | "advanced"

const TABS: { key: TabKey; label: string }[] = [
  { key: "general", label: "General" },
  { key: "providers", label: "Providers" },
  { key: "custom", label: "Custom providers" },
  { key: "limits", label: "Model limits" },
  { key: "perms", label: "Permissions" },
  { key: "tools", label: "Tools" },
  { key: "mcp", label: "MCP servers" },
  { key: "plugins", label: "Plugins" },
  { key: "advanced", label: "Advanced" },
]

function title(v: any) {
  return String(v).replace(/^\s+|\s+$/g, "")
}

// Paths of keys removed from the advanced JSON text (recursively) so the
// server can delete them from the JSONC file; deepMerge alone only adds or
// changes keys and would leave a removed key behind.
function removedPaths(base: any, next: any, prefix: string[] = []): string[][] {
  if (!base || typeof base !== "object" || Array.isArray(base)) return []
  if (!next || typeof next !== "object" || Array.isArray(next)) return []
  const out: string[][] = []
  for (const [key, value] of Object.entries(base)) {
    if (!(key in next)) {
      out.push([...prefix, key])
      continue
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      out.push(...removedPaths(value, (next as any)[key], [...prefix, key]))
    }
  }
  return out
}

export function Settings({
  onClose,
  onChanged,
}: {
  onClose: () => void
  onChanged?: () => void
}) {
  const { t, lang, setLang, dir } = useI18n()
  const [tab, setTab] = useState<TabKey>("general")
  const [cfgPath, setCfgPath] = useState<string | null>(null)
  const [cfg, setCfg] = useState<Record<string, any>>({})
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const loadConfig = useCallback(async () => {
    try {
      const raw = await get<any>("/api/config")
      const list: ConfigEntry[] = Array.isArray(raw) ? raw : (raw?.data ?? [])
      const doc = list.find((e) => e?.type === "document" && e.path)
      if (!doc) throw new Error(t("Engine settings file not found"))
      setCfgPath(doc.path!)
      setCfg(doc.info ?? {})
    } catch (e: any) {
      setError(e.message)
    }
  }, [t])

  useEffect(() => {
    void loadConfig()
    void get<{ data: AgentInfo[] }>("/api/agent")
      .then((r) => setAgents((r.data ?? []).filter((a) => a.mode !== "subagent" && !a.hidden)))
      .catch(() => {})
  }, [loadConfig])

  const shell = typeof cfg.shell === "string" ? cfg.shell : ""
  const model = typeof cfg.model === "string" ? cfg.model : typeof cfg.model === "object" && cfg.model ? `${cfg.model.providerID}/${cfg.model.model}` : ""
  const [username, setUsername] = useState("")
  const [share, setShare] = useState("")
  const [updateMode, setUpdateMode] = useState("")
  const [shellDraft, setShellDraft] = useState("")
  const [modelDraft, setModelDraft] = useState("")
  const [agentDraft, setAgentDraft] = useState("")
  const [enterpriseUrl, setEnterpriseUrl] = useState("")
  const [inited, setInited] = useState(false)

  useEffect(() => {
    if (!inited && cfg && typeof cfg === "object") {
      setUsername(typeof cfg.username === "string" ? cfg.username : "")
      setShare(typeof cfg.share === "string" ? cfg.share : "")
      setUpdateMode(typeof cfg.update === "string" ? cfg.update : "")
      setShellDraft(shell)
      setModelDraft(model)
      setAgentDraft(typeof cfg.default_agent === "string" ? cfg.default_agent : "")
      setEnterpriseUrl(typeof cfg.enterprise?.url === "string" ? cfg.enterprise.url : "")
      setInited(true)
    }
  }, [cfg, inited, shell, model])

  const saveGeneral = async () => {
    if (!cfgPath) return
    setSaving(true)
    setError(null)
    const patchBody: Record<string, any> = {
      username: username.trim() === "" ? null : username.trim(),
      share: share === "" ? null : share,
      update: updateMode === "" ? null : updateMode,
      model: modelDraft.trim() === "" ? null : modelDraft.trim(),
      default_agent: agentDraft === "" ? null : agentDraft,
      enterprise: { url: enterpriseUrl.trim() === "" ? null : enterpriseUrl.trim() },
    }
    try {
      const res = await appPost<{ ok?: boolean; error?: string }>("/app/config/write", { patch: patchBody })
      if (res?.ok === false) throw new Error(res.error ?? t("Save failed"))
      if (shellDraft.trim() !== (shell || "")) {
        try {
          await patch("/api/experimental/config", {
            shell: shellDraft.trim() === "" ? null : shellDraft.trim(),
          })
        } catch (e: any) {
          throw new Error(t("Failed to save shell: {error}", { error: e.message }))
        }
      }
      await loadConfig()
      onClose()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  const advancedValue = useMemo(() => {
    const copy: Record<string, any> = {}
    for (const [k, v] of Object.entries(cfg)) if (!EXCLUDED.has(k)) copy[k] = v
    return JSON.stringify(copy, null, 2)
  }, [cfg])
  const [advancedDraft, setAdvancedDraft] = useState<string | null>(null)
  const [advancedOpen, setAdvancedOpen] = useState(false)

  const saveAdvanced = async () => {
    if (!advancedDraft) return
    let parsed: any
    try {
      parsed = JSON.parse(advancedDraft)
    } catch (e: any) {
      setError(t("Invalid JSON: {error}", { error: e.message }))
      return
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      setError(t("Settings must be a JSON object"))
      return
    }
    for (const k of EXCLUDED) delete parsed[k]
    setSaving(true)
    setError(null)
    // deepMerge only changes keys present in the patch; keys removed from the
    // text must be deleted explicitly, otherwise they remain in the file.
    const remove = removedPaths(cfg, parsed).filter((p) => !(p.length === 1 && EXCLUDED.has(p[0])))
    try {
      const res = await appPost<{ ok?: boolean; error?: string }>("/app/config/write", { patch: parsed, remove })
      if (res?.ok === false) throw new Error(res.error ?? t("Save failed"))
      await loadConfig()
      setAdvancedDraft(null)
      setAdvancedOpen(false)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="settings-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className={`settings ${tab === "custom" ? "settings-wide" : ""}`} role="dialog" aria-label={t("OpenCode settings")}>
        <div className="settings-head">
          <h2>{t("OpenCode settings")}</h2>
          <button type="button" className="settings-close" onClick={onClose} aria-label={t("Close")}>×</button>
        </div>
        <div className="settings-tabs">
          {TABS.map((item) => (
            <button key={item.key} type="button" className={tab === item.key ? "on" : ""} onClick={() => { setTab(item.key); setAdvancedOpen(false); setAdvancedDraft(null) }}>
              {t(item.label)}
            </button>
          ))}
        </div>

        {error && <div className="settings-error">{error}</div>}

        <div className="settings-body">
          {tab === "general" && (
            <div className="settings-section">
              <div className="settings-language">
                <label className="frow">
                  <span>{t("Interface language")}</span>
                  <select value={lang} onChange={(e) => setLang(e.target.value === "fa" ? "fa" : "en")}>
                    {LANGUAGES.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.native}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="settings-note settings-language-note">
                  {t("The interface language is saved in this browser. English is the default.")}
                  <span className="settings-language-dir">{t("Layout direction")}: {dir === "rtl" ? t("Right to left") : t("Left to right")}</span>
                </p>
              </div>
              <label className="frow">
                <span>{t("Username")}</span>
                <input dir="auto" value={username} onChange={(e) => setUsername(e.target.value)} placeholder={t("No name")} />
              </label>
              <label className="frow">
                <span>{t("Share conversation (share)")}</span>
                <select value={share} onChange={(e) => setShare(e.target.value)}>
                  <option value="">{t("Default")}</option>
                  <option value="manual">{t("Manual")}</option>
                  <option value="auto">{t("Auto")}</option>
                  <option value="disabled">{t("Disabled")}</option>
                </select>
              </label>
              <label className="frow">
                <span>{t("Update behavior")}</span>
                <select value={updateMode} onChange={(e) => setUpdateMode(e.target.value)}>
                  <option value="">{t("Default")}</option>
                  <option value="notify">{t("Notify only")}</option>
                  <option value="auto">{t("Auto")}</option>
                  <option value="disable">{t("Disabled")}</option>
                </select>
              </label>
              <label className="frow">
                <span>{t("Shell")}</span>
                <input dir="ltr" value={shellDraft} onChange={(e) => setShellDraft(e.target.value)} placeholder="powershell" />
              </label>
              <label className="frow">
                <span>{t("Default model")}</span>
                <input dir="ltr" value={modelDraft} onChange={(e) => setModelDraft(e.target.value)} placeholder="opencode/glm-5.3-flash-free" />
              </label>
              <label className="frow">
                <span>{t("Default agent")}</span>
                <select value={agentDraft} onChange={(e) => setAgentDraft(e.target.value)}>
                  <option value="">{t("Engine default")}</option>
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
              </label>
              <label className="frow">
                <span>{t("Enterprise address (enterprise)")}</span>
                <input dir="ltr" value={enterpriseUrl} onChange={(e) => setEnterpriseUrl(e.target.value)} placeholder="https://…" />
              </label>
              <div className="settings-foot">
                <span className="cfg-path" dir="ltr" title={cfgPath ?? ""}>{cfgPath}</span>
                <button type="button" className="settings-save" onClick={saveGeneral} disabled={saving}>
                  {saving ? t("Saving…") : t("Save")}
                </button>
              </div>
            </div>
          )}

          {tab === "providers" && (
            <Suspense fallback={<div className="lazy-fallback">{t("Loading providers…")}</div>}>
              <Providers onChanged={onChanged} />
            </Suspense>
          )}
          {tab === "custom" && <CustomProviders />}
          {tab === "limits" && <ModelLimitsPanel />}
          {tab === "perms" && <Perms />}
          {tab === "tools" && <ToolsPanel />}
          {tab === "mcp" && <Mcp cfg={cfg} reload={loadConfig} />}
          {tab === "plugins" && <Plugins />}

          {tab === "advanced" && (
            <div className="settings-section">
              {!advancedOpen ? (
                <>
                  <p className="settings-note">
                    {t("All engine settings as JSON. Appearance keys (theme/keybinds) are hidden. Displayed as document:")}
                    <code dir="ltr">{cfgPath}</code>
                  </p>
                  <div className="settings-actions">
                    <button type="button" onClick={() => { setAdvancedDraft(advancedValue); setAdvancedOpen(true) }}>{t("Edit JSON")}</button>
                    <button type="button" onClick={() => { void navigator.clipboard?.writeText(advancedValue) }}>{t("Copy")}</button>
                  </div>
                  <pre dir="ltr" className="settings-json">{advancedValue}</pre>
                </>
              ) : (
                <>
                  <textarea
                    dir="ltr"
                    className="settings-json-edit"
                    value={advancedDraft ?? ""}
                    onChange={(e) => setAdvancedDraft(e.target.value)}
                    spellCheck={false}
                  />
                  <div className="settings-actions">
                    <button type="button" className="settings-save" onClick={saveAdvanced} disabled={saving || advancedDraft === null}>
                      {saving ? t("Saving…") : t("Save to file")}
                    </button>
                    <button type="button" onClick={() => { setAdvancedDraft(null); setAdvancedOpen(false) }}>{t("Cancel")}</button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function Perms() {
  const { t } = useI18n()
  const [rows, setRows] = useState<SavedPermission[]>([])
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await get<{ data: SavedPermission[] }>("/api/permission/saved")
      setRows(res.data ?? [])
    } catch (e: any) {
      setErr(e.message)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const remove = async (id: string) => {
    try {
      await del(`/api/permission/saved/${id}`)
      void load()
    } catch (e: any) {
      setErr(e.message)
    }
  }

  return (
    <div className="settings-section">
      <p className="settings-note">{t("Permissions saved with “Always allow” in approval cards. Delete = ask again.")}</p>
      {err && <div className="settings-error">{err}</div>}
      {rows.length === 0 ? (
        <div className="settings-empty">{t("No saved permissions")}</div>
      ) : (
        <div className="settings-list">
          {rows.map((p) => (
            <div key={p.id} className="settings-row">
              <code dir="ltr">{p.action} {p.resource ? `· ${p.resource}` : ""}</code>
              <button type="button" onClick={() => void remove(p.id)}>{t("Delete")}</button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

type ToolRow = {
  name: string
  title: string
  actions: string[]
  requires: string[]
}

type ToolsPayload = {
  ok?: boolean
  server?: string
  registered?: boolean
  reconnected?: boolean
  configPath?: string | null
  error?: string | null
  status?: { name?: string; status?: string | { status?: string } } | null
  catalog?: { version?: string; server?: string; tools?: ToolRow[] }
}

function toolConnection(payload: ToolsPayload | null) {
  const value = payload?.status?.status
  if (typeof value === "string") return value
  return value?.status ?? "unknown"
}

function ToolsPanel() {
  const { t, num } = useI18n()
  const [data, setData] = useState<ToolsPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<"" | "refresh" | "reconnect">("")
  const [err, setErr] = useState<string | null>(null)
  const [query, setQuery] = useState("")

  const load = useCallback(async () => {
    try {
      const res = await appGet<ToolsPayload>("/app/tools")
      setData(res)
      setErr(null)
    } catch (e: any) {
      setErr(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const refresh = async () => {
    setBusy("refresh")
    try {
      const res = await appPost<ToolsPayload>("/app/tools/status")
      setData((prev) => ({ ...(prev ?? {}), ...res }))
      setErr(null)
    } catch (e: any) {
      setErr(e.message)
    } finally {
      setBusy("")
      await load()
    }
  }

  const reconnect = async () => {
    setBusy("reconnect")
    try {
      const res = await appPost<ToolsPayload>("/app/tools/register")
      setData((prev) => ({ ...(prev ?? {}), ...res }))
      setErr(null)
    } catch (e: any) {
      setErr(e.message)
    } finally {
      setBusy("")
      await load()
    }
  }

  const connection = toolConnection(data)
  const connected = connection === "connected"
  const tools = useMemo(() => {
    const q = query.trim().toLowerCase()
    const rows = data?.catalog?.tools ?? []
    if (!q) return rows
    return rows.filter((tool) =>
      `${tool.name} ${tool.title} ${tool.actions.join(" ")} ${tool.requires.join(" ")}`.toLowerCase().includes(q),
    )
  }, [data?.catalog?.tools, query])
  const totalActions = (data?.catalog?.tools ?? []).reduce((sum, tool) => sum + tool.actions.length, 0)

  return (
    <div className="settings-section tools-panel">
      <div className="tools-hero">
        <div>
          <h3>{t("Installed tools")}</h3>
          <p className="settings-note">
            {t("The model calls these tools automatically when they are useful. No manual invocation is needed.")}
          </p>
        </div>
        <span className={`pill ${connected ? "pill-completed" : "pill-error"}`}>
          {connected ? t("Connected") : connection === "unknown" ? t("Unknown") : t("Disconnected")}
        </span>
      </div>

      <div className="tools-meta">
        <div>
          <span>{t("Tool server")}</span>
          <code dir="ltr">{data?.server ?? "opencode-chat-tools"}</code>
        </div>
        <div>
          <span>{t("Actions")}</span>
          <code>{num(totalActions)}</code>
        </div>
        <div>
          <span>{t("Config file")}</span>
          <code dir="ltr" title={data?.configPath ?? ""}>{data?.configPath ?? "—"}</code>
        </div>
      </div>

      <div className="settings-actions tools-actions-bar">
        <input
          className="tools-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("Search tools")}
          aria-label={t("Search tools")}
        />
        <button type="button" onClick={() => void refresh()} disabled={busy !== ""}>
          {busy === "refresh" ? t("Refreshing…") : t("Refresh status")}
        </button>
        <button type="button" className="settings-save" onClick={() => void reconnect()} disabled={busy !== ""}>
          {busy === "reconnect" ? t("Reconnecting…") : t("Reconnect")}
        </button>
      </div>

      {err && <div className="settings-error">{err}</div>}
      {data?.error && <div className="settings-error">{data.error}</div>}

      {loading ? (
        <div className="settings-empty">{t("Loading…")}</div>
      ) : tools.length === 0 ? (
        <div className="settings-empty">{t("No tools found")}</div>
      ) : (
        <div className="tools-list">
          {tools.map((tool) => (
            <details className="tools-item" key={tool.name}>
              <summary>
                <span className="tools-item-title">{t(tool.title)}</span>
                <code className="tools-item-name" dir="ltr">{tool.name}</code>
                <span className="tools-item-count">{num(tool.actions.length)} {t("Actions")}</span>
                {tool.requires.length > 0 && (
                  <span className="tools-item-req" dir="ltr">{tool.requires.join(" · ")}</span>
                )}
              </summary>
              <div className="tools-actions">
                {tool.actions.map((action) => (
                  <code key={action} dir="ltr">{action}</code>
                ))}
              </div>
            </details>
          ))}
        </div>
      )}
    </div>
  )
}

function Mcp({ cfg, reload }: { cfg: Record<string, any>; reload: () => Promise<void> }) {
  const { t } = useI18n()
  const [rows, setRows] = useState<McpEntry[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState("")
  const [url, setUrl] = useState("")

  const load = useCallback(async () => {
    try {
      const res = await get<{ data: McpEntry[] }>("/api/mcp")
      setRows(res.data ?? [])
    } catch (e: any) {
      setErr(e.message)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const act = async (name: string, verb: string) => {
    try {
      await post(`/api/experimental/mcp/${encodeURIComponent(name)}/${verb}`, {})
      void load()
    } catch (e: any) {
      setErr(e.message)
    }
  }

  const addRemote = async () => {
    if (!title(name) || !title(url)) { setErr(t("Name and url are required")); return }
    try {
      await appPost("/app/config/write", {
        patch: { mcp: { servers: { [title(name)]: { type: "remote", url: title(url) } } } },
      })
      setAdding(false)
      setName("")
      setUrl("")
      await load()
      await reload()
    } catch (e: any) {
      setErr(e.message)
    }
  }

  return (
    <div className="settings-section">
      <div className="settings-actions">
        <button type="button" onClick={() => setAdding((v) => !v)}>{adding ? t("Close form") : t("Add remote server")}</button>
        <button type="button" onClick={() => void load()}>{t("Reload")}</button>
      </div>
      {adding && (
        <div className="settings-inline-form">
          <input dir="ltr" placeholder="name" value={name} onChange={(e) => setName(e.target.value)} />
          <input dir="ltr" placeholder="https://server/mcp" value={url} onChange={(e) => setUrl(e.target.value)} />
          <button type="button" className="settings-save" onClick={addRemote}>{t("Add")}</button>
        </div>
      )}
      {err && <div className="settings-error">{err}</div>}
      {rows.length === 0 ? (
        <div className="settings-empty">{t("No server registered")}</div>
      ) : (
        <div className="settings-list">
          {rows.map((s) => (
            <div key={s.name} className="settings-row">
              <code dir="ltr">{s.name}</code>
              <span className={`pill ${s.status?.status === "connected" ? "pill-completed" : "pill-error"}`}>{s.status?.status ?? t("Unknown")}</span>
              {s.status?.status === "connected" ? (
                <button type="button" onClick={() => void act(s.name, "disconnect")}>{t("Disconnect")}</button>
              ) : (
                <button type="button" onClick={() => void act(s.name, "connect")}>{t("Connect")}</button>
              )}
            </div>
          ))}
        </div>
      )}
      <p className="settings-note">{t("Local (command) servers are in the Advanced tab under the mcp key.")}</p>
    </div>
  )
}

function Plugins() {
  const { t } = useI18n()
  const [rows, setRows] = useState<PluginEntry[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [log, setLog] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await get<{ data: PluginEntry[] }>("/api/plugin")
      setRows(res.data ?? [])
    } catch (e: any) {
      setErr(e.message)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const runCheck = async () => {
    setBusy(true)
    setErr(null)
    setLog(null)
    try {
      const res = await fetch("/oc/api/plugin/check", { method: "POST", headers: { "content-type": "application/json" } })
      const text = await res.text()
      setLog(text.slice(0, 2000))
      await load()
    } catch (e: any) {
      setErr(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="settings-section">
      <div className="settings-actions">
        <button type="button" onClick={runCheck} disabled={busy}>{busy ? t("Checking plugins…") : t("Check for plugin updates")}</button>
        <button type="button" onClick={() => void load()}>{t("Reload")}</button>
      </div>
      {err && <div className="settings-error">{err}</div>}
      {log && <pre dir="ltr" className="settings-json">{log}</pre>}
      {rows.length === 0 ? (
        <div className="settings-empty">{t("No plugins registered")}</div>
      ) : (
        <div className="settings-list">
          {rows.map((p) => (
            <div key={p.id} className="settings-row">
              <code dir="ltr">{p.id}</code>
              <span className="settings-muted">{p.source?.type === "builtin" ? t("Built-in") : p.source?.target ?? t("Bundle")}</span>
              <span className={`pill ${p.state?.status === "active" ? "pill-completed" : "pill-error"}`}>{p.state?.status ?? "—"}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
