import { useCallback, useEffect, useMemo, useState } from "react"
import { appPost, del, get, patch, post } from "./api"
import type { AgentInfo, ConfigEntry, McpEntry, PluginEntry, SavedPermission } from "./types"

const EXCLUDED = new Set(["theme", "keybinds", "tooltips", "$schema"])

type TabKey = "general" | "perms" | "mcp" | "plugins" | "advanced"

const TABS: { key: TabKey; label: string }[] = [
  { key: "general", label: "عمومی" },
  { key: "perms", label: "دسترسی‌ها" },
  { key: "mcp", label: "سرورهای MCP" },
  { key: "plugins", label: "افزونه‌ها" },
  { key: "advanced", label: "پیشرفته" },
]

function title(v: any) {
  return String(v).replace(/^\s+|\s+$/g, "")
}

export function Settings({ onClose }: { onClose: () => void }) {
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
      if (!doc) throw new Error("فایل تنظیمات موتور پیدا نشد")
      setCfgPath(doc.path!)
      setCfg(doc.info ?? {})
    } catch (e: any) {
      setError(e.message)
    }
  }, [])

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
      if (res?.ok === false) throw new Error(res.error ?? "ذخیره ناموفق بود")
      if (shellDraft.trim() !== (shell || "")) {
        await patch("/api/experimental/config", { shell: shellDraft.trim() === "" ? null : shellDraft.trim() }).catch(() => null)
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
      setError(`JSON نامعتبر: ${e.message}`)
      return
    }
    for (const k of EXCLUDED) delete parsed[k]
    if (typeof parsed !== "object" || Array.isArray(parsed)) {
      setError("تنظیمات باید یک آبجکت JSON باشد")
      return
    }
    setSaving(true)
    setError(null)
    try {
      const res = await appPost<{ ok?: boolean; error?: string }>("/app/config/write", { patch: parsed })
      if (res?.ok === false) throw new Error(res.error ?? "ذخیره ناموفق بود")
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
      <div className="settings" role="dialog" aria-label="تنظیمات OpenCode">
        <div className="settings-head">
          <h2>تنظیمات OpenCode</h2>
          <button type="button" className="settings-close" onClick={onClose} aria-label="بستن">×</button>
        </div>
        <div className="settings-tabs">
          {TABS.map((t) => (
            <button key={t.key} type="button" className={tab === t.key ? "on" : ""} onClick={() => { setTab(t.key); setAdvancedOpen(false); setAdvancedDraft(null) }}>
              {t.label}
            </button>
          ))}
        </div>

        {error && <div className="settings-error">{error}</div>}

        <div className="settings-body">
          {tab === "general" && (
            <div className="settings-section">
              <label className="frow">
                <span>نام کاربری</span>
                <input dir="auto" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="بدون نام" />
              </label>
              <label className="frow">
                <span>اشتراک‌گذاری گفت‌وگو (share)</span>
                <select value={share} onChange={(e) => setShare(e.target.value)}>
                  <option value="">پیش‌فرض</option>
                  <option value="manual">دستی</option>
                  <option value="auto">خودکار</option>
                  <option value="disabled">غیرفعال</option>
                </select>
              </label>
              <label className="frow">
                <span>رفتار آپدیت</span>
                <select value={updateMode} onChange={(e) => setUpdateMode(e.target.value)}>
                  <option value="">پیش‌فرض</option>
                  <option value="notify">فقط اطلاع بده</option>
                  <option value="auto">خودکار</option>
                  <option value="disable">غیرفعال</option>
                </select>
              </label>
              <label className="frow">
                <span>شل (shell)</span>
                <input dir="ltr" value={shellDraft} onChange={(e) => setShellDraft(e.target.value)} placeholder="powershell" />
              </label>
              <label className="frow">
                <span>مدل پیش‌فرض</span>
                <input dir="ltr" value={modelDraft} onChange={(e) => setModelDraft(e.target.value)} placeholder="opencode/glm-5.3-flash-free" />
              </label>
              <label className="frow">
                <span>ایجنت پیش‌فرض</span>
                <select value={agentDraft} onChange={(e) => setAgentDraft(e.target.value)}>
                  <option value="">پیش‌فرض موتور</option>
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
              </label>
              <label className="frow">
                <span>ادرس سازمانی (enterprise)</span>
                <input dir="ltr" value={enterpriseUrl} onChange={(e) => setEnterpriseUrl(e.target.value)} placeholder="https://…" />
              </label>
              <div className="settings-foot">
                <span className="cfg-path" dir="ltr" title={cfgPath ?? ""}>{cfgPath}</span>
                <button type="button" className="settings-save" onClick={saveGeneral} disabled={saving}>
                  {saving ? "در حال ذخیره…" : "ذخیره"}
                </button>
              </div>
            </div>
          )}

          {tab === "perms" && <Perms />}
          {tab === "mcp" && <Mcp cfg={cfg} reload={loadConfig} />}
          {tab === "plugins" && <Plugins />}

          {tab === "advanced" && (
            <div className="settings-section">
              {!advancedOpen ? (
                <>
                  <p className="settings-note">
                    کل تنظیمات موتور به‌صورت JSON. کلیدهای ظاهری (تم/کیبایند) از نمایش حذف شده‌اند.
                    نمایش در قالب document <code dir="ltr">{cfgPath}</code>:
                  </p>
                  <div className="settings-actions">
                    <button type="button" onClick={() => { setAdvancedDraft(advancedValue); setAdvancedOpen(true) }}>ویرایش JSON</button>
                    <button type="button" onClick={() => { void navigator.clipboard?.writeText(advancedValue) }}>کپی</button>
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
                      {saving ? "در حال ذخیره…" : "ذخیره روی فایل"}
                    </button>
                    <button type="button" onClick={() => { setAdvancedDraft(null); setAdvancedOpen(false) }}>بی‌خیال</button>
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
      <p className="settings-note">دسترسی‌های «همیشه اجازه بده‌» که در کارت‌های تأیید ذخیره شده‌اند. حذف = پرسیدن دوباره.</p>
      {err && <div className="settings-error">{err}</div>}
      {rows.length === 0 ? (
        <div className="settings-empty">دسترسی ذخیره‌شده‌ای نیست</div>
      ) : (
        <div className="settings-list">
          {rows.map((p) => (
            <div key={p.id} className="settings-row">
              <code dir="ltr">{p.action} {p.resource ? `· ${p.resource}` : ""}</code>
              <button type="button" onClick={() => void remove(p.id)}>حذف</button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function Mcp({ cfg, reload }: { cfg: Record<string, any>; reload: () => Promise<void> }) {
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
    if (!title(name) || !title(url)) { setErr("نام و url لازم است"); return }
    try {
      await appPost("/app/config/write", {
        patch: { mcp: { [title(name)]: { type: "remote", url: title(url) } } },
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
        <button type="button" onClick={() => setAdding((v) => !v)}>{adding ? "بستن فرم" : "افزودن سرور remote"}</button>
        <button type="button" onClick={() => void load()}>بازخوانی</button>
      </div>
      {adding && (
        <div className="settings-inline-form">
          <input dir="ltr" placeholder="name" value={name} onChange={(e) => setName(e.target.value)} />
          <input dir="ltr" placeholder="https://server/mcp" value={url} onChange={(e) => setUrl(e.target.value)} />
          <button type="button" className="settings-save" onClick={addRemote}>افزودن</button>
        </div>
      )}
      {err && <div className="settings-error">{err}</div>}
      {rows.length === 0 ? (
        <div className="settings-empty">سروری ثبت نشده</div>
      ) : (
        <div className="settings-list">
          {rows.map((s) => (
            <div key={s.name} className="settings-row">
              <code dir="ltr">{s.name}</code>
              <span className={`pill ${s.status?.status === "connected" ? "pill-completed" : "pill-error"}`}>{s.status?.status ?? "نامعلوم"}</span>
              {s.status?.status === "connected" ? (
                <button type="button" onClick={() => void act(s.name, "disconnect")}>قطع</button>
              ) : (
                <button type="button" onClick={() => void act(s.name, "connect")}>اتصال</button>
              )}
            </div>
          ))}
        </div>
      )}
      <p className="settings-note">سرورهای local (command) را در تب پیشرفته زیر کلید <code dir="ltr">mcp</code> ببینید.</p>
    </div>
  )
}

function Plugins() {
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
        <button type="button" onClick={runCheck} disabled={busy}>{busy ? "… در حال چک" : "بررسی به‌روزرسانی افزونه‌ها"}</button>
        <button type="button" onClick={() => void load()}>بازخوانی</button>
      </div>
      {err && <div className="settings-error">{err}</div>}
      {log && <pre dir="ltr" className="settings-json">{log}</pre>}
      {rows.length === 0 ? (
        <div className="settings-empty">افزونه‌ای ثبت نشده</div>
      ) : (
        <div className="settings-list">
          {rows.map((p) => (
            <div key={p.id} className="settings-row">
              <code dir="ltr">{p.id}</code>
              <span className="settings-muted">{p.source?.type === "builtin" ? "داخلی" : p.source?.target ?? "بسته"}</span>
              <span className={`pill ${p.state?.status === "active" ? "pill-completed" : "pill-error"}`}>{p.state?.status ?? "—"}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
