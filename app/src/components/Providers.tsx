import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { del, get, post } from "../lib/api"
import { applyModelLimits, loadModelLimitCatalog } from "../lib/modelLimits"
import { useI18n } from "../lib/i18n"
import type {
  CredentialEntry,
  FormFieldShape,
  IntegrationInfo,
  IntegrationMethod,
  ModelInfo,
  ProviderInfo,
} from "../lib/types"

type Props = { onChanged?: () => void }

const METHOD_LABEL: Record<string, string> = {
  key: "API key",
  env: "Environment variable",
  oauth: "OAuth login",
  external: "External login",
  command: "Login command",
}

const ACTIVATION_LABEL: Record<string, string> = {
  auto: "Auto",
  enabled: "Explicit",
  disabled: "Disabled",
}

function unwrap(value: any) {
  return value?.data ?? value
}

function fieldVisible(field: FormFieldShape, answers: Record<string, any>) {
  if (field.hidden) return false
  const conditions = field.when ?? []
  if (conditions.length === 0) return true
  return conditions.every((c) => (c.op === "eq" ? answers[c.key] === c.value : answers[c.key] !== c.value))
}

function initialAnswers(fields?: FormFieldShape[]) {
  const out: Record<string, any> = {}
  for (const field of fields ?? []) {
    if (field.default !== undefined) out[field.key] = field.default
  }
  return out
}

function requiredMissing(fields: FormFieldShape[] | undefined, answers: Record<string, any>, custom: Record<string, string>) {
  for (const field of fields ?? []) {
    if (!fieldVisible(field, answers)) continue
    const customValue = (custom[field.key] ?? "").trim()
    const value = customValue !== "" ? customValue : answers[field.key]
    if (field.required && (value === undefined || value === "" || (Array.isArray(value) && value.length === 0))) {
      return field
    }
  }
  return null
}

function collectAnswers(
  fields: FormFieldShape[] | undefined,
  answers: Record<string, any>,
  custom: Record<string, string>,
) {
  const out: Record<string, any> = {}
  for (const field of fields ?? []) {
    if (!fieldVisible(field, answers)) continue
    const customValue = (custom[field.key] ?? "").trim()
    if (customValue !== "") out[field.key] = customValue
    else if (answers[field.key] !== undefined && answers[field.key] !== "") out[field.key] = answers[field.key]
  }
  return out
}

function useMethodAnswers(method: IntegrationMethod) {
  const [answers, setAnswers] = useState<Record<string, any>>(() => initialAnswers(method.form))
  const [custom, setCustom] = useState<Record<string, string>>({})
  const setAnswer = (key: string, value: any) => setAnswers((prev) => ({ ...prev, [key]: value }))
  const setCustomValue = (key: string, value: string) => setCustom((prev) => ({ ...prev, [key]: value }))
  const missing = () => requiredMissing(method.form, answers, custom)
  const answer = () => collectAnswers(method.form, answers, custom)
  return { answers, custom, setAnswer, setCustom: setCustomValue, missing, answer }
}

function FormFields({
  fields,
  answers,
  onAnswer,
  custom,
  onCustom,
}: {
  fields?: FormFieldShape[]
  answers: Record<string, any>
  onAnswer: (key: string, value: any) => void
  custom: Record<string, string>
  onCustom: (key: string, value: string) => void
}) {
  const { t } = useI18n()
  const visible = (fields ?? []).filter((field) => fieldVisible(field, answers))
  if (visible.length === 0) return null

  return (
    <div className="provider-form">
      {visible.map((field) => {
        const options = field.options ?? []
        const value = answers[field.key]
        return (
          <div key={field.key} className="qfield">
            <div className="qfield-title" dir="auto">
              {field.title ?? field.key}
              {field.required && <span className="qreq"> *</span>}
            </div>
            {field.description && (
              <div className="qfield-desc" dir="auto">
                {field.description}
              </div>
            )}

            {field.type === "multiselect" ? (
              <div className="qopts">
                {options.map((option) => {
                  const picked: string[] = Array.isArray(value) ? value : []
                  const on = picked.includes(option.value)
                  return (
                    <button
                      key={option.value}
                      type="button"
                      className={`qopt ${on ? "on" : ""}`}
                      title={option.description}
                      onClick={() =>
                        onAnswer(
                          field.key,
                          on ? picked.filter((x) => x !== option.value) : [...picked, option.value],
                        )
                      }
                    >
                      <span className="qcheck">{on ? "☑" : "☐"}</span>
                      <span dir="auto">{option.label}</span>
                    </button>
                  )
                })}
              </div>
            ) : options.length > 0 ? (
              <div className="qopts">
                {options.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={`qopt ${value === option.value ? "on" : ""}`}
                    title={option.description}
                    onClick={() => onAnswer(field.key, option.value)}
                  >
                    <span className="qcheck">{value === option.value ? "◉" : "○"}</span>
                    <span dir="auto">{option.label}</span>
                  </button>
                ))}
              </div>
            ) : null}

            {field.custom && options.length > 0 && (
              <input
                dir="auto"
                className="qcustom"
                placeholder={t("Or a custom value…")}
                value={custom[field.key] ?? ""}
                onChange={(e) => onCustom(field.key, e.target.value)}
              />
            )}

            {!field.options?.length && field.type !== "boolean" && field.type !== "external" && (
              <input
                dir={field.type === "number" || field.type === "integer" ? "ltr" : "auto"}
                type={field.type === "number" || field.type === "integer" ? "number" : "text"}
                className="qcustom"
                placeholder={field.placeholder ?? t("Value…")}
                value={value ?? ""}
                onChange={(e) => {
                  if (field.type === "integer") {
                    onAnswer(field.key, e.target.value === "" ? undefined : parseInt(e.target.value, 10))
                  } else if (field.type === "number") {
                    onAnswer(field.key, e.target.value === "" ? undefined : parseFloat(e.target.value))
                  } else {
                    onAnswer(field.key, e.target.value)
                  }
                }}
              />
            )}

            {field.type === "boolean" && (
              <div className="qopts">
                <button type="button" className={`qopt ${value === true ? "on" : ""}`} onClick={() => onAnswer(field.key, true)}>
                  <span className="qcheck">{value === true ? "◉" : "○"}</span>
                  <span>{t("Yes")}</span>
                </button>
                <button type="button" className={`qopt ${value === false ? "on" : ""}`} onClick={() => onAnswer(field.key, false)}>
                  <span className="qcheck">{value === false ? "◉" : "○"}</span>
                  <span>{t("No")}</span>
                </button>
              </div>
            )}

            {field.type === "external" && field.url && (
              <a className="qexternal" dir="ltr" href={field.url} target="_blank" rel="noreferrer noopener">
                {field.title ?? field.url}
              </a>
            )}
          </div>
        )
      })}
    </div>
  )
}

function MethodShell({
  method,
  children,
  error,
  ok,
}: {
  method: IntegrationMethod
  children: ReactNode
  error?: string | null
  ok?: string | null
}) {
  const { t } = useI18n()
  return (
    <div className="provider-method">
      <div className="provider-method-head">
        <strong>{method.label || t(METHOD_LABEL[method.type] ?? method.type)}</strong>
        <span className="provider-method-type">{t(METHOD_LABEL[method.type] ?? method.type)}</span>
      </div>
      {children}
      {ok && <div className="settings-ok">{ok}</div>}
      {error && <div className="settings-error">{error}</div>}
    </div>
  )
}

function KeyMethod({
  integration,
  method,
  onDone,
}: {
  integration: IntegrationInfo
  method: IntegrationMethod
  onDone: () => Promise<void>
}) {
  const { t } = useI18n()
  const form = useMethodAnswers(method)
  const [key, setKey] = useState("")
  const [label, setLabel] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ok, setOk] = useState<string | null>(null)

  const submit = async () => {
    setError(null)
    setOk(null)
    if (!key.trim()) {
      setError(t("Enter the API key"))
      return
    }
    const missing = form.missing()
    if (missing) {
      setError(t("Field \"{name}\" is required", { name: missing.title ?? missing.key }))
      return
    }
    setBusy(true)
    try {
      const answer = form.answer()
      await post(`/api/integration/${encodeURIComponent(integration.id)}/connect/key`, {
        key: key.trim(),
        label: label.trim() || method.label || integration.name,
        ...(Object.keys(answer).length > 0 ? { answer } : {}),
      })
      setKey("")
      setLabel("")
      setOk(t("Key saved and activated"))
      await onDone()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <MethodShell method={method} error={error} ok={ok}>
      <FormFields
        fields={method.form}
        answers={form.answers}
        onAnswer={form.setAnswer}
        custom={form.custom}
        onCustom={form.setCustom}
      />
      <input
        dir="ltr"
        type="password"
        className="qcustom"
        autoComplete="off"
        spellCheck={false}
        placeholder={method.label ? `${method.label}…` : `${t("API key")}…`}
        value={key}
        onChange={(e) => setKey(e.target.value)}
      />
      <input
        dir="auto"
        className="qcustom"
        placeholder={t("Label (optional)")}
        value={label}
        onChange={(e) => setLabel(e.target.value)}
      />
      <div className="settings-actions">
        <button type="button" className="settings-save" onClick={() => void submit()} disabled={busy}>
          {busy ? t("Connecting…") : t("Connect with key")}
        </button>
      </div>
    </MethodShell>
  )
}

function ExternalMethod({
  integration,
  method,
  onDone,
}: {
  integration: IntegrationInfo
  method: IntegrationMethod
  onDone: () => Promise<void>
}) {
  const { t } = useI18n()
  const form = useMethodAnswers(method)
  const [label, setLabel] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ok, setOk] = useState<string | null>(null)

  const submit = async () => {
    setError(null)
    setOk(null)
    const missing = form.missing()
    if (missing) {
      setError(t("Field \"{name}\" is required", { name: missing.title ?? missing.key }))
      return
    }
    if (!method.id) {
      setError(t("This method has no ID"))
      return
    }
    setBusy(true)
    try {
      await post(`/api/integration/${encodeURIComponent(integration.id)}/connect/external`, {
        methodID: method.id,
        label: label.trim() || method.label || integration.name,
        answer: form.answer(),
      })
      setOk(t("Connection established"))
      await onDone()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <MethodShell method={method} error={error} ok={ok}>
      <FormFields
        fields={method.form}
        answers={form.answers}
        onAnswer={form.setAnswer}
        custom={form.custom}
        onCustom={form.setCustom}
      />
      <input
        dir="auto"
        className="qcustom"
        placeholder={t("Label (optional)")}
        value={label}
        onChange={(e) => setLabel(e.target.value)}
      />
      <div className="settings-actions">
        <button type="button" className="settings-save" onClick={() => void submit()} disabled={busy}>
          {busy ? t("Connecting…") : t("Connect")}
        </button>
      </div>
    </MethodShell>
  )
}

type OAuthAttempt = {
  attemptID: string
  url: string
  instructions?: string
  mode?: "auto" | "code" | string
  time?: { created: number; expires: number }
}

type OAuthStatus = { status: string; message?: string; time?: any }

function OAuthMethod({
  integration,
  method,
  onDone,
}: {
  integration: IntegrationInfo
  method: IntegrationMethod
  onDone: () => Promise<void>
}) {
  const { t } = useI18n()
  const form = useMethodAnswers(method)
  const [label, setLabel] = useState("")
  const [attempt, setAttempt] = useState<OAuthAttempt | null>(null)
  const [status, setStatus] = useState<OAuthStatus | null>(null)
  const [code, setCode] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ok, setOk] = useState<string | null>(null)
  const doneRef = useRef(onDone)
  const pollError = useRef<string | null>(null)
  useEffect(() => {
    doneRef.current = onDone
  }, [onDone])

  const start = async () => {
    setError(null)
    setOk(null)
    pollError.current = null
    if (!method.id) {
      setError(t("This method has no ID"))
      return
    }
    const missing = form.missing()
    if (missing) {
      setError(t("Field \"{name}\" is required", { name: missing.title ?? missing.key }))
      return
    }
    setBusy(true)
    try {
      const res = await post<any>(`/api/integration/${encodeURIComponent(integration.id)}/connect/oauth`, {
        methodID: method.id,
        label: label.trim() || method.label || integration.name,
        answer: form.answer(),
      })
      const next = unwrap(res) as OAuthAttempt
      if (!next?.attemptID) throw new Error(t("The engine response has no attemptID"))
      setAttempt(next)
      setStatus({ status: "pending" })
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const check = async (attemptID: string) => {
    const res = await get<any>(
      `/api/integration/${encodeURIComponent(integration.id)}/connect/oauth/${encodeURIComponent(attemptID)}`,
    )
    return unwrap(res) as OAuthStatus
  }

  useEffect(() => {
    if (!attempt?.attemptID) return
    let alive = true
    let timer: number | undefined
    const tick = async () => {
      try {
        const next = await check(attempt.attemptID)
        if (!alive) return
        if (pollError.current) {
          pollError.current = null
          setError(null)
        }
        setStatus(next)
        if (next?.status === "complete") {
          setAttempt(null)
          setStatus(null)
          setOk(t("Login complete"))
          await doneRef.current()
          return
        }
        if (next?.status === "failed" || next?.status === "expired") {
          setAttempt(null)
          setStatus(null)
          setError(next.message || (next.status === "expired" ? t("Login timed out") : t("Login failed")))
          return
        }
        timer = window.setTimeout(tick, 2000)
      } catch (e: any) {
        // یک خطای موقت شبکه نباید polling را برای همیشه متوقف کند.
        if (!alive) return
        const message = e?.message ?? t("Error checking login status")
        pollError.current = message
        setError(message)
        timer = window.setTimeout(tick, 3000)
      }
    }
    timer = window.setTimeout(tick, 1200)
    return () => {
      alive = false
      if (timer) window.clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt?.attemptID, integration.id])

  const complete = async () => {
    if (!attempt) return
    setError(null)
    if (!code.trim()) {
      setError(t("Enter the login code"))
      return
    }
    setBusy(true)
    try {
      await post(
        `/api/integration/${encodeURIComponent(integration.id)}/connect/oauth/${encodeURIComponent(attempt.attemptID)}/complete`,
        { code: code.trim() },
      )
      setCode("")
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const cancel = async () => {
    if (!attempt) return
    try {
      await del(
        `/api/integration/${encodeURIComponent(integration.id)}/connect/oauth/${encodeURIComponent(attempt.attemptID)}`,
      )
      setAttempt(null)
      setStatus(null)
      setOk(t("Login cancelled"))
    } catch (e: any) {
      setError(e.message)
    }
  }

  return (
    <MethodShell method={method} error={error} ok={ok}>
      {!attempt && (
        <>
          <FormFields
            fields={method.form}
            answers={form.answers}
            onAnswer={form.setAnswer}
            custom={form.custom}
            onCustom={form.setCustom}
          />
          <input
            dir="auto"
            className="qcustom"
            placeholder={t("Label (optional)")}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <div className="settings-actions">
            <button type="button" className="settings-save" onClick={() => void start()} disabled={busy}>
              {busy ? t("Starting…") : t("Start login")}
            </button>
          </div>
        </>
      )}

      {attempt && (
        <>
          {attempt.instructions && <div className="provider-note" dir="auto">{attempt.instructions}</div>}
          <a className="provider-oauth-url" dir="ltr" href={attempt.url} target="_blank" rel="noreferrer noopener">
            {attempt.url}
          </a>
          <div className="provider-note">
            {t("Status:")} {status?.status ?? "pending"}
            {status?.message ? ` — ${status.message}` : ""}
          </div>
          {attempt.mode === "code" && (
            <div className="settings-inline-form">
              <input
                dir="ltr"
                className="qcustom"
                placeholder={t("Login code…")}
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
              <button type="button" className="settings-save" onClick={() => void complete()} disabled={busy}>
                {t("Complete")}
              </button>
            </div>
          )}
          <div className="settings-actions">
            <button type="button" onClick={() => void cancel()}>
              {t("Cancel")}
            </button>
          </div>
        </>
      )}
    </MethodShell>
  )
}

type CommandAttempt = { attemptID: string; time?: { created: number; expires: number } }
type CommandStatus = { status: string; message?: string }

function CommandMethod({
  integration,
  method,
  onDone,
}: {
  integration: IntegrationInfo
  method: IntegrationMethod
  onDone: () => Promise<void>
}) {
  const { t } = useI18n()
  const [attempt, setAttempt] = useState<CommandAttempt | null>(null)
  const [status, setStatus] = useState<CommandStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ok, setOk] = useState<string | null>(null)
  const doneRef = useRef(onDone)
  const pollError = useRef<string | null>(null)
  useEffect(() => {
    doneRef.current = onDone
  }, [onDone])

  const start = async () => {
    setError(null)
    setOk(null)
    pollError.current = null
    if (!method.id) {
      setError(t("This method has no ID"))
      return
    }
    setBusy(true)
    try {
      const res = await post<any>(`/api/integration/${encodeURIComponent(integration.id)}/connect/command`, {
        methodID: method.id,
        label: method.label || integration.name,
      })
      const next = unwrap(res) as CommandAttempt
      if (!next?.attemptID) throw new Error(t("The engine response has no attemptID"))
      setAttempt(next)
      setStatus({ status: "pending" })
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (!attempt?.attemptID) return
    let alive = true
    let timer: number | undefined
    const tick = async () => {
      try {
        const res = await get<any>(
          `/api/integration/${encodeURIComponent(integration.id)}/connect/command/${encodeURIComponent(attempt.attemptID)}`,
        )
        const next = unwrap(res) as CommandStatus
        if (!alive) return
        if (pollError.current) {
          pollError.current = null
          setError(null)
        }
        setStatus(next)
        if (next?.status === "complete") {
          setAttempt(null)
          setStatus(null)
          setOk(t("Connection complete"))
          await doneRef.current()
          return
        }
        if (next?.status === "failed" || next?.status === "expired") {
          setAttempt(null)
          setStatus(null)
          setError(next.message || (next.status === "expired" ? t("Execution timed out") : t("Command failed")))
          return
        }
        timer = window.setTimeout(tick, 2000)
      } catch (e: any) {
        // یک خطای موقت شبکه نباید polling را برای همیشه متوقف کند.
        if (!alive) return
        const message = e?.message ?? t("Error checking execution status")
        pollError.current = message
        setError(message)
        timer = window.setTimeout(tick, 3000)
      }
    }
    timer = window.setTimeout(tick, 1200)
    return () => {
      alive = false
      if (timer) window.clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt?.attemptID, integration.id])

  const cancel = async () => {
    if (!attempt) return
    try {
      await del(
        `/api/integration/${encodeURIComponent(integration.id)}/connect/command/${encodeURIComponent(attempt.attemptID)}`,
      )
      setAttempt(null)
      setStatus(null)
      setOk(t("Cancelled"))
    } catch (e: any) {
      setError(e.message)
    }
  }

  return (
    <MethodShell method={method} error={error} ok={ok}>
      {!attempt ? (
        <div className="settings-actions">
          <button type="button" className="settings-save" onClick={() => void start()} disabled={busy}>
            {busy ? t("Starting…") : t("Start")}
          </button>
        </div>
      ) : (
        <>
          <div className="provider-note">
            {t("Status:")} {status?.status ?? "pending"}
            {status?.message ? ` — ${status.message}` : ""}
          </div>
          <div className="settings-actions">
            <button type="button" onClick={() => void cancel()}>
              {t("Cancel")}
            </button>
          </div>
        </>
      )}
    </MethodShell>
  )
}

function EnvMethod({ method }: { method: IntegrationMethod }) {
  const { t } = useI18n()
  return (
    <MethodShell method={method}>
      <div className="provider-note">
        {t("This method uses an environment variable. Set the value in the engine runtime environment:")}
      </div>
      <div className="provider-env-list">
        {(method.names ?? []).map((name) => (
          <code key={name} dir="ltr">
            {name}
          </code>
        ))}
      </div>
    </MethodShell>
  )
}

function MethodCard({
  integration,
  method,
  onDone,
}: {
  integration: IntegrationInfo
  method: IntegrationMethod
  onDone: () => Promise<void>
}) {
  if (method.type === "env") return <EnvMethod method={method} />
  if (method.type === "command") return <CommandMethod integration={integration} method={method} onDone={onDone} />
  if (method.type === "oauth") return <OAuthMethod integration={integration} method={method} onDone={onDone} />
  if (method.type === "external") return <ExternalMethod integration={integration} method={method} onDone={onDone} />
  return <KeyMethod integration={integration} method={method} onDone={onDone} />
}

export function Providers({ onChanged }: Props) {
  const { t, num } = useI18n()
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [integrations, setIntegrations] = useState<IntegrationInfo[]>([])
  const [credentials, setCredentials] = useState<CredentialEntry[]>([])
  const [models, setModels] = useState<ModelInfo[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const [connectedOnly, setConnectedOnly] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [providerRes, integrationRes, credentialRes, modelRes] = await Promise.all([
        get<{ data: ProviderInfo[] }>("/api/provider").catch(() => null),
        get<{ data: IntegrationInfo[] }>("/api/integration"),
        get<any>("/api/credential").catch(() => null),
        get<{ data: ModelInfo[] }>("/api/model").catch(() => null),
      ])
      setProviders(providerRes?.data ?? [])
      setIntegrations(integrationRes.data ?? [])
      setCredentials(Array.isArray(credentialRes) ? credentialRes : credentialRes?.data ?? [])
      // ظرفیت کانتکس/خروجیِ ثبت‌شده در «model-limits.json» روی دادهٔ موتور اعمال
      // می‌شود تا شماره‌ها با سند سازندهٔ مدل بخواند.
      await loadModelLimitCatalog()
      setModels(applyModelLimits(modelRes?.data ?? []))
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const providerByIntegration = useMemo(() => {
    const map = new Map<string, ProviderInfo>()
    for (const provider of providers) map.set(provider.integrationID ?? provider.id, provider)
    return map
  }, [providers])

  const connectedIds = useMemo(
    () => new Set(integrations.filter((i) => i.connections.length > 0).map((i) => i.id)),
    [integrations],
  )

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return integrations
      .filter((integration) => !connectedOnly || connectedIds.has(integration.id) || providerByIntegration.has(integration.id))
      .filter((integration) => !q || `${integration.name} ${integration.id}`.toLowerCase().includes(q))
      .sort((a, b) => {
        const ac = connectedIds.has(a.id) || providerByIntegration.has(a.id) ? 1 : 0
        const bc = connectedIds.has(b.id) || providerByIntegration.has(b.id) ? 1 : 0
        return bc - ac || a.name.localeCompare(b.name)
      })
  }, [integrations, query, connectedOnly, connectedIds, providerByIntegration])

  const selected = selectedId ? integrations.find((i) => i.id === selectedId) ?? null : null
  const activeProvider = selected ? providerByIntegration.get(selected.id) : undefined
  const providerModels = activeProvider ? models.filter((m) => m.providerID === activeProvider.id) : []
  const selectedCredentials = selected ? credentials.filter((c) => c.integrationID === selected.id) : []
  const selectedEnv = selected
    ? selected.connections.filter(
        (c): c is { type: "env"; name: string; status?: { status: string; message?: string; url?: string } } =>
          c.type === "env",
      )
    : []

  const changed = useCallback(async () => {
    await load()
    onChanged?.()
  }, [load, onChanged])

  const activate = async (credential: CredentialEntry) => {
    setBusyId(credential.id)
    setError(null)
    try {
      await post(`/api/credential/${encodeURIComponent(credential.id)}/activate`)
      setNotice(t("Credential \"{name}\" activated", { name: credential.label }))
      await changed()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusyId(null)
    }
  }

  const remove = async (credential: CredentialEntry) => {
    if (!window.confirm(t("Delete credential \"{name}\"?", { name: credential.label }))) return
    setBusyId(credential.id)
    setError(null)
    try {
      await del(`/api/credential/${encodeURIComponent(credential.id)}`)
      setNotice(t("Credential deleted"))
      await changed()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusyId(null)
    }
  }

  if (selected) {
    return (
      <div className="provider-pane">
        <div className="provider-detail-head">
          <button type="button" className="provider-back" onClick={() => { setSelectedId(null); setNotice(null) }}>
            ← {t("Back")}
          </button>
          <div>
            <strong>{selected.name}</strong> <code dir="ltr">{selected.id}</code>
          </div>
        </div>

        {error && <div className="settings-error">{error}</div>}
        {notice && <div className="settings-ok">{notice}</div>}

        <div className="provider-summary">
          {activeProvider ? (
            <>
              <span className={`provider-badge ${activeProvider.activation === "enabled" ? "on" : "auto"}`}>
                {activeProvider.activation === "enabled" ? t("Active") : t("Available (auto-detected)")}
              </span>
              <span className="settings-muted">
                {t("{n} models · activation: {activation}", {
                  n: num(providerModels.length),
                  activation: t(ACTIVATION_LABEL[activeProvider.activation] ?? activeProvider.activation),
                })}
              </span>
            </>
          ) : (
            <span className="settings-muted">{t("Not yet in the engine's available provider list.")}</span>
          )}
        </div>

        {activeProvider?.activation === "auto" && (
          <div className="provider-auto-note" dir="auto">
            {t("OpenCode detected this provider automatically from the engine process environment; “available” does not mean the key is valid.")}
            {selectedEnv.length > 0 && (
              <>
                {" "}
                {t("Environment variable {names} was found in the engine process.", {
                  names: selectedEnv.map((c) => c.name).join(", "),
                })}
              </>
            )}{" "}
            {t("If you did not enable it yourself, remove this variable from the engine environment and restart the service.")}
          </div>
        )}

        {(selectedCredentials.length > 0 || selectedEnv.length > 0) && (
          <div className="provider-section">
            <h4>{t("Registered connections")}</h4>
            <div className="settings-list">
              {selectedCredentials.map((credential) => (
                <div className="settings-row provider-credential" key={credential.id}>
                  <div className="provider-credential-main">
                    <strong>{credential.label}</strong>
                    <span dir="ltr">{credential.value.type ?? credential.value.methodID ?? ""}</span>
                  </div>
                  {credential.active ? (
                    <span className="provider-badge on">{t("Active")}</span>
                  ) : (
                    <button type="button" onClick={() => void activate(credential)} disabled={busyId === credential.id}>
                      {t("Enable")}
                    </button>
                  )}
                  <button type="button" onClick={() => void remove(credential)} disabled={busyId === credential.id}>
                    {t("Delete")}
                  </button>
                </div>
              ))}
              {selectedEnv.map((connection) => (
                <div className="settings-row provider-credential" key={`env:${connection.name}`}>
                  <div className="provider-credential-main">
                    <strong>{t("Environment variable")}</strong>
                    <code dir="ltr">{connection.name}</code>
                  </div>
                  <span className="provider-badge auto" title={t("Read from engine environment")}>
                    {t("Read from engine environment")}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="provider-section">
          <h4>{t("Connection methods")}</h4>
          {selected.methods.length === 0 ? (
            <div className="settings-empty">{t("No connection method is defined for this provider")}</div>
          ) : (
            selected.methods.map((method, index) => (
              <MethodCard
                key={`${selected.id}:${method.type}:${method.id ?? index}`}
                integration={selected}
                method={method}
                onDone={changed}
              />
            ))
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="provider-pane">
      <p className="settings-note">
        {t("Connect providers from the OpenCode core; once connected, their models appear in the model picker automatically.")}
      </p>

      <div className="provider-tools">
        <input
          dir="auto"
          className="provider-search"
          placeholder={t("Search providers…")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button type="button" onClick={() => setConnectedOnly((v) => !v)}>
          {connectedOnly ? t("Show all") : t("Connected only")}
        </button>
        <button type="button" onClick={() => void load()} disabled={loading}>
          {loading ? t("Reading…") : t("Reload")}
        </button>
      </div>

      <div className="provider-active-row">
        <span className="settings-muted">
          {t("{connections} connections · {providers} providers available", {
            connections: num(connectedIds.size),
            providers: num(providers.length),
          })}
        </span>
        {providers.map((provider) => (
          <span
            className={`provider-badge ${provider.activation === "enabled" ? "on" : "auto"}`}
            key={provider.id}
            title={provider.activation === "enabled" ? t("Explicitly enabled") : t("Auto-detected from environment")}
          >
            {provider.name}
            {provider.activation !== "enabled" ? ` · ${t("Auto")}` : ""}
          </span>
        ))}
      </div>

      {error && <div className="settings-error">{error}</div>}
      {notice && <div className="settings-ok">{notice}</div>}

      <div className="provider-list">
        {filtered.map((integration) => {
          const provider = providerByIntegration.get(integration.id)
          const connected = connectedIds.has(integration.id)
          const modelCount = provider ? models.filter((m) => m.providerID === provider.id).length : 0
          return (
            <button
              key={integration.id}
              type="button"
              className={`provider-row ${connected || provider ? "connected" : ""}`}
              onClick={() => {
                setSelectedId(integration.id)
                setNotice(null)
              }}
            >
              <span className="provider-main">
                <strong>{integration.name}</strong>
                <code dir="ltr">{integration.id}</code>
              </span>
              <span className="provider-meta">
                {provider && (
                  <span className={`provider-badge ${provider.activation === "enabled" ? "on" : "auto"}`}>
                    {provider.activation === "enabled" ? t("Active") : t("Available (auto)")}
                  </span>
                )}
                {connected && <span className="provider-badge">{t("Connected")}</span>}
                {modelCount > 0 && <span className="provider-badge models">{t("{n} models", { n: num(modelCount) })}</span>}
                <span className="provider-methods">
                  {integration.methods.map((m) => t(METHOD_LABEL[m.type] ?? m.type)).join(" · ")}
                </span>
              </span>
            </button>
          )
        })}
        {filtered.length === 0 && <div className="settings-empty">{t("No providers found")}</div>}
      </div>
    </div>
  )
}
