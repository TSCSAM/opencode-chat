import { useCallback, useEffect, useMemo, useState } from "react"
import { appGet, appPost } from "../lib/api"
import { useI18n } from "../lib/i18n"

type ApiFormat = "chat" | "responses" | "anthropic"

type CustomModel = {
  id: string
  name?: string
  context?: number | null
  output?: number | null
}

type CustomProvider = {
  id: string
  name: string
  baseURL: string
  api: ApiFormat
  apiKey: string
  hasKey?: boolean
  clearKey?: boolean
  enabled: boolean
  models: CustomModel[]
  updatedAt?: string
  isNew?: boolean
}

type ListResponse = { providers?: CustomProvider[]; configPath?: string; error?: string }
type SaveResponse = ListResponse & { ok?: boolean; provider?: CustomProvider; wrote?: boolean }
type ModelsResponse = { ok?: boolean; models?: { id: string; name?: string }[]; error?: string }

const API_OPTIONS: { value: ApiFormat; label: string; hint: string }[] = [
  { value: "anthropic", label: "Anthropic messages (/v1/messages)", hint: "anthropic" },
  { value: "chat", label: "Chat completions (/chat/completions)", hint: "chat" },
  { value: "responses", label: "Responses (/responses)", hint: "responses" },
]

function blankProvider(): CustomProvider {
  return {
    id: "",
    name: "",
    baseURL: "",
    api: "chat",
    apiKey: "",
    hasKey: false,
    enabled: true,
    models: [],
    isNew: true,
  }
}

function toDraft(provider: CustomProvider): CustomProvider {
  return {
    id: provider.id,
    name: provider.name ?? "",
    baseURL: provider.baseURL ?? "",
    api: provider.api ?? "chat",
    apiKey: "",
    hasKey: provider.hasKey,
    clearKey: false,
    enabled: provider.enabled !== false,
    models: (provider.models ?? []).map((model) => ({ ...model })),
    updatedAt: provider.updatedAt,
    isNew: false,
  }
}

function comparable(provider: CustomProvider) {
  return JSON.stringify({
    id: provider.id.trim().toLowerCase(),
    name: provider.name.trim(),
    baseURL: provider.baseURL.trim().replace(/\/+$/, ""),
    api: provider.api,
    enabled: provider.enabled,
    apiKey: provider.apiKey,
    clearKey: provider.clearKey === true,
    models: provider.models
      .map((model) => ({
        id: model.id.trim(),
        name: (model.name ?? "").trim(),
        context: model.context || 0,
        output: model.output || 0,
      }))
      .filter((model) => model.id),
  })
}

export function CustomProviders() {
  const { t, num } = useI18n()
  const [providers, setProviders] = useState<CustomProvider[]>([])
  const [configPath, setConfigPath] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState<CustomProvider | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [fetching, setFetching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await appGet<ListResponse>("/app/custom-providers")
      const list = res?.providers ?? []
      setProviders(list)
      setConfigPath(res?.configPath ?? null)
      setSelectedId((current) => {
        const found = list.find((provider) => provider.id === current)
        if (found) {
          setDraft(toDraft(found))
          return found.id
        }
        if (list.length > 0) {
          setDraft(toDraft(list[0]))
          return list[0].id
        }
        setDraft(null)
        return null
      })
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const saved = useMemo(
    () => providers.find((provider) => provider.id === selectedId) ?? null,
    [providers, selectedId],
  )

  const dirty = useMemo(() => {
    if (!draft) return false
    if (draft.isNew) return true
    if (!saved) return true
    return comparable(draft) !== comparable(toDraft(saved))
  }, [draft, saved])

  const select = (provider: CustomProvider) => {
    setSelectedId(provider.id)
    setDraft(toDraft(provider))
    setError(null)
    setNotice(null)
  }

  const addProvider = () => {
    setSelectedId(null)
    setDraft(blankProvider())
    setError(null)
    setNotice(null)
  }

  const update = (patch: Partial<CustomProvider>) => {
    setDraft((current) => (current ? { ...current, ...patch } : current))
  }

  const updateModel = (index: number, patch: Partial<CustomModel>) => {
    setDraft((current) => {
      if (!current) return current
      const models = current.models.map((model, i) => (i === index ? { ...model, ...patch } : model))
      return { ...current, models }
    })
  }

  const removeModel = (index: number) => {
    setDraft((current) => {
      if (!current) return current
      return { ...current, models: current.models.filter((_, i) => i !== index) }
    })
  }

  const addModel = () => {
    setDraft((current) => {
      if (!current) return current
      return { ...current, models: [...current.models, { id: "", name: "", context: null, output: null }] }
    })
  }

  const fetchModels = async () => {
    if (!draft) return
    if (!draft.baseURL.trim()) {
      setError(t("Enter a base URL first."))
      return
    }
    setFetching(true)
    setError(null)
    setNotice(null)
    try {
      const res = await appPost<ModelsResponse>("/app/custom-providers/models", {
        id: draft.id,
        baseURL: draft.baseURL,
        api: draft.api,
        apiKey: draft.apiKey,
      })
      if (res?.ok === false) throw new Error(res.error ?? t("Fetch models failed"))
      const fetched = res?.models ?? []
      const known = new Set(draft.models.map((model) => model.id.trim()))
      const added: CustomModel[] = []
      for (const model of fetched) {
        if (!model.id || known.has(model.id)) continue
        known.add(model.id)
        added.push({ id: model.id, name: model.name ?? "", context: null, output: null })
      }
      update({ models: [...draft.models, ...added] })
      setNotice(
        added.length > 0
          ? t("{n} models added from the provider.", { n: num(added.length) })
          : t("No new models were returned by the provider."),
      )
    } catch (e: any) {
      setError(t("Fetch models failed: {error}", { error: e?.message ?? e }))
    } finally {
      setFetching(false)
    }
  }

  const save = async () => {
    if (!draft) return
    const id = draft.id.trim().toLowerCase()
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) {
      setError(t("Provider ID is required and may only contain a-z, 0-9, dot, dash and underscore."))
      return
    }
    if (!/^https?:\/\//i.test(draft.baseURL.trim())) {
      setError(t("Base URL must start with http:// or https://."))
      return
    }
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const body = {
        id,
        name: draft.name.trim() || id,
        baseURL: draft.baseURL.trim(),
        api: draft.api,
        apiKey: draft.apiKey,
        hasKey: draft.hasKey,
        clearKey: draft.clearKey === true,
        enabled: draft.enabled,
        models: draft.models
          .map((model) => ({
            id: model.id.trim(),
            name: model.name?.trim() || undefined,
            context: model.context || undefined,
            output: model.output || undefined,
          }))
          .filter((model) => model.id),
      }
      const res = await appPost<SaveResponse>("/app/custom-providers", body)
      if (res?.ok === false) throw new Error(res.error ?? t("Save failed"))
      const list = res?.providers ?? providers
      setProviders(list)
      if (res?.provider) {
        const nextDraft = toDraft(res.provider)
        setSelectedId(res.provider.id)
        setDraft(nextDraft)
      }
      setNotice(t("Provider saved. Its models appear in the model picker."))
      setConfigPath(res?.configPath ?? configPath)
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!draft) return
    if (draft.isNew) {
      setDraft(null)
      setSelectedId(null)
      setError(null)
      setNotice(null)
      return
    }
    const label = draft.name.trim() || draft.id
    if (!window.confirm(t('Delete provider "{name}"?', { name: label }))) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const res = await appPost<SaveResponse>("/app/custom-providers/delete", { id: draft.id })
      const list = res?.providers ?? providers.filter((provider) => provider.id !== draft.id)
      setProviders(list)
      setDraft(list.length > 0 ? toDraft(list[0]) : null)
      setSelectedId(list.length > 0 ? list[0].id : null)
      setNotice(t("Provider deleted"))
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }

  const reset = () => {
    if (!draft) return
    if (draft.isNew) {
      setDraft(null)
      setSelectedId(null)
    } else if (saved) {
      setDraft(toDraft(saved))
    }
    setError(null)
    setNotice(null)
  }

  if (loading) {
    return <div className="settings-section custom-providers">{t("Loading…")}</div>
  }

  return (
    <div className="settings-section custom-providers">
      <div className="cp-head">
        <div>
          <h3 className="cp-title">{t("Custom providers")}</h3>
          <p className="settings-note">
            {t("Manage custom model providers. Once configured, they can be selected during chat.")}
          </p>
        </div>
        <div className="cp-head-actions">
          <button type="button" className="cp-icon-btn" onClick={() => void load()} title={t("Reload")} aria-label={t("Reload")}>
            <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
              <path
                d="M20 11a8 8 0 1 0-2.3 6.7M20 5v6h-6"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <button type="button" className="cp-primary" onClick={addProvider}>
            <span aria-hidden="true">+</span> {t("Add provider")}
          </button>
        </div>
      </div>

      {error && <div className="settings-error">{error}</div>}
      {notice && <div className="settings-ok">{notice}</div>}

      <div className="cp-layout">
        <aside className="cp-list" aria-label={t("Custom providers")}>
          <div className="cp-list-title">{t("Custom providers")}</div>
          {providers.map((provider) => (
            <button
              key={provider.id}
              type="button"
              className={`cp-item ${!draft?.isNew && selectedId === provider.id ? "on" : ""}`}
              onClick={() => select(provider)}
            >
              <span className={`cp-dot ${provider.enabled ? "on" : ""}`} aria-hidden="true" />
              <span className="cp-item-name" dir="auto">
                {provider.name || provider.id}
              </span>
            </button>
          ))}
          {draft?.isNew && (
            <button type="button" className="cp-item on" onClick={() => setSelectedId(null)}>
              <span className="cp-dot draft" aria-hidden="true" />
              <span className="cp-item-name" dir="auto">
                {draft.name.trim() || t("New provider")}
              </span>
            </button>
          )}
          {providers.length === 0 && !draft?.isNew && (
            <div className="cp-list-empty">{t("No custom providers yet.")}</div>
          )}
        </aside>

        <section className="cp-editor">
          {!draft ? (
            <div className="cp-placeholder">
              <div className="cp-placeholder-icon" aria-hidden="true">
                ◇
              </div>
              <p>{t("Select a provider or add a new one.")}</p>
              <button type="button" className="cp-primary" onClick={addProvider}>
                <span aria-hidden="true">+</span> {t("Add provider")}
              </button>
            </div>
          ) : (
            <>
              <header className="cp-editor-head">
                <div className="cp-editor-title">
                  <span className="cp-editor-icon" aria-hidden="true">
                    ◇
                  </span>
                  <h4 dir="auto">{draft.isNew ? t("New provider") : draft.name || draft.id}</h4>
                </div>
                <div className="cp-editor-tools">
                  <label className="cp-switch" title={t("Enabled")}>
                    <input
                      type="checkbox"
                      checked={draft.enabled}
                      onChange={(event) => update({ enabled: event.target.checked })}
                    />
                    <span aria-hidden="true" />
                  </label>
                  <button
                    type="button"
                    className="cp-icon-btn danger"
                    onClick={() => void remove()}
                    title={t("Delete provider")}
                    aria-label={t("Delete provider")}
                  >
                    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                      <path
                        d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.7"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                </div>
              </header>

              <div className="cp-fields">
                <div className="cp-field cp-field-id">
                  <label htmlFor="cp-id">{t("Provider ID")}</label>
                  <input
                    id="cp-id"
                    dir="ltr"
                    value={draft.id}
                    disabled={!draft.isNew}
                    placeholder="my-provider"
                    onChange={(event) => update({ id: event.target.value })}
                  />
                  <span className="cp-hint">
                    {t("Used as the model prefix in chat: {id}/model", { id: draft.id.trim() || "id" })}
                  </span>
                </div>

                <div className="cp-field">
                  <label htmlFor="cp-name">{t("Display name")}</label>
                  <input
                    id="cp-name"
                    dir="auto"
                    value={draft.name}
                    placeholder={t("New provider")}
                    onChange={(event) => update({ name: event.target.value })}
                  />
                </div>

                <div className="cp-field cp-field-wide">
                  <label htmlFor="cp-url">{t("Base URL")}</label>
                  <input
                    id="cp-url"
                    dir="ltr"
                    value={draft.baseURL}
                    placeholder="https://api.example.com/v1"
                    onChange={(event) => update({ baseURL: event.target.value })}
                  />
                </div>

                <div className="cp-field cp-field-wide">
                  <label htmlFor="cp-api">{t("API format")}</label>
                  <select
                    id="cp-api"
                    value={draft.api}
                    onChange={(event) => update({ api: event.target.value as ApiFormat })}
                  >
                    {API_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {t(option.label)}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="cp-field cp-field-wide">
                  <label htmlFor="cp-key">{t("API key (optional)")}</label>
                  <div className="cp-key-row">
                    <input
                      id="cp-key"
                      dir="ltr"
                      type="password"
                      autoComplete="off"
                      value={draft.apiKey}
                      placeholder={draft.hasKey ? t("Saved — leave blank to keep it") : "sk-…"}
                      onChange={(event) => update({ apiKey: event.target.value, clearKey: false })}
                    />
                    {(draft.hasKey || draft.apiKey !== "" || draft.clearKey) && (
                      <button
                        type="button"
                        className="cp-link-btn"
                        onClick={() => update({ apiKey: "", hasKey: false, clearKey: true })}
                      >
                        {t("Clear key")}
                      </button>
                    )}
                  </div>
                  <span className="cp-hint">{t("Stored locally and sent only to this provider.")}</span>
                </div>
              </div>

              <div className="cp-models-head">
                <div>
                  <span className="cp-models-title">{t("Model list")}</span>
                  <span className="cp-models-count">
                    {t("{n} models", { n: num(draft.models.length) })}
                  </span>
                </div>
                <div className="cp-models-actions">
                  <button type="button" onClick={() => void fetchModels()} disabled={fetching || busy}>
                    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                      <path
                        d="M12 3v11m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.7"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                    {fetching ? t("Fetching…") : t("Fetch models")}
                  </button>
                  <button type="button" onClick={addModel} disabled={busy}>
                    <span aria-hidden="true">+</span> {t("Add model")}
                  </button>
                </div>
              </div>

              {draft.models.length === 0 ? (
                <div className="cp-models-empty">
                  <span aria-hidden="true">ⓘ</span>
                  {t("No models are configured. Add a model to use it in chat.")}
                </div>
              ) : (
                <div className="cp-models">
                  <div className="cp-model-row cp-model-head" aria-hidden="true">
                    <span>{t("Model ID")}</span>
                    <span>{t("Display name")}</span>
                    <span>{t("Context window")}</span>
                    <span>{t("Max output")}</span>
                    <span />
                  </div>
                  {draft.models.map((model, index) => (
                    <div className="cp-model-row" key={index}>
                      <input
                        dir="ltr"
                        value={model.id}
                        placeholder="model-id"
                        aria-label={t("Model ID")}
                        onChange={(event) => updateModel(index, { id: event.target.value })}
                      />
                      <input
                        dir="auto"
                        value={model.name ?? ""}
                        placeholder={t("Display name")}
                        aria-label={t("Display name")}
                        onChange={(event) => updateModel(index, { name: event.target.value })}
                      />
                      <input
                        dir="ltr"
                        type="number"
                        min={0}
                        value={model.context ?? ""}
                        placeholder="200000"
                        aria-label={t("Context window")}
                        onChange={(event) =>
                          updateModel(index, { context: event.target.value === "" ? null : Number(event.target.value) })
                        }
                      />
                      <input
                        dir="ltr"
                        type="number"
                        min={0}
                        value={model.output ?? ""}
                        placeholder="32000"
                        aria-label={t("Max output")}
                        onChange={(event) =>
                          updateModel(index, { output: event.target.value === "" ? null : Number(event.target.value) })
                        }
                      />
                      <button
                        type="button"
                        className="cp-icon-btn danger"
                        onClick={() => removeModel(index)}
                        title={t("Remove")}
                        aria-label={t("Remove")}
                      >
                        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                          <path
                            d="M6 6l12 12M18 6 6 18"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinecap="round"
                          />
                        </svg>
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div className="cp-editor-actions">
                <button type="button" className="cp-primary" onClick={() => void save()} disabled={busy || !dirty}>
                  {busy ? t("Saving…") : t("Save provider")}
                </button>
                <button type="button" onClick={reset} disabled={busy || !dirty}>
                  {t("Reset")}
                </button>
                {configPath && (
                  <span className="cp-config-path" dir="ltr" title={configPath}>
                    {configPath}
                  </span>
                )}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  )
}