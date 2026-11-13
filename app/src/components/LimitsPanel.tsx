import { useCallback, useEffect, useMemo, useState } from "react"
import { appGet, appPost } from "../lib/api"
import type { ModelLimitRow, ModelLimitState } from "../lib/modelLimits"
import { useI18n } from "../lib/i18n"

// «Model limits» panel: shows which models have a catalog limit that differs
// from what the engine reports and writes the correct values into the engine
// configuration file.
export function ModelLimitsPanel() {
  const { t, num } = useI18n()
  const [state, setState] = useState<ModelLimitState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await appGet<ModelLimitState>("/app/model-limits")
      setState(res)
      setError(null)
    } catch (e: any) {
      setError(e.message)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const apply = async () => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const res = await appPost<{ ok?: boolean; changed?: string[]; error?: string }>(
        "/app/model-limits/apply",
      )
      if (res?.ok === false) throw new Error(res.error ?? t("Apply failed"))
      const changed = res?.changed?.length ?? 0
      setNotice(
        changed > 0
          ? t("{n} models were corrected in engine settings.", { n: num(changed) })
          : t("Everything matches the catalog."),
      )
      await load()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const { pending, matched } = useMemo(() => {
    const rows = state?.rows ?? []
    return {
      pending: rows.filter((r) => r.differs),
      matched: rows.filter((r) => !r.differs),
    }
  }, [state])

  return (
    <div className="settings-section">
      <p className="settings-note">
        {t(
          "Context and max output limits are recorded from the provider/model vendor. Recorded values are written to engine config so the model window and automatic compaction threshold match the vendor documentation.",
        )}
      </p>

      {error && <div className="settings-error">{error}</div>}
      {notice && <div className="settings-ok">{notice}</div>}

      <div className="limits-summary">
        <span className="settings-muted">
          {t("Catalog:")} <code dir="ltr">model-limits.json</code>
          {state?.catalog?.updatedAt
            ? ` · ${t("Updated {date}", { date: state.catalog.updatedAt })}`
            : ""}
        </span>
        <span className="settings-muted">
          {t("{n} models tracked · {pending} need correction", {
            n: num(state?.tracked ?? 0),
            pending: num(pending.length),
          })}
        </span>
      </div>

      <div className="settings-actions">
        <button type="button" onClick={apply} disabled={busy}>
          {busy ? t("Applying…") : t("Apply to engine settings")}
        </button>
        <button type="button" onClick={() => void load()} disabled={busy}>
          {t("Reload")}
        </button>
      </div>

      {pending.length > 0 && (
        <>
          <h4>{t("Needs correction")}</h4>
          <div className="settings-list">
            {pending.map((row) => (
              <LimitRow key={`${row.providerID}/${row.id}`} row={row} />
            ))}
          </div>
        </>
      )}

      {matched.length > 0 && (
        <>
          <h4>{t("Matches catalog ({n})", { n: num(matched.length) })}</h4>
          <div className="settings-list">
            {matched.map((row) => (
              <LimitRow key={`${row.providerID}/${row.id}`} row={row} />
            ))}
          </div>
        </>
      )}

      {state && state.tracked === 0 && (
        <div className="settings-empty">{t("No models to show")}</div>
      )}
    </div>
  )
}

function LimitRow({ row }: { row: ModelLimitRow }) {
  const { t, num } = useI18n()
  const tok = (value: number | undefined | null) =>
    Number.isFinite(value as number) ? num(value) : "—"

  return (
    <div className="settings-row limits-row">
      <code dir="ltr" title={row.note ?? row.source ?? undefined}>
        {row.providerID}/{row.id}
      </code>
      <span className="limits-values" dir="ltr">
        {row.differs ? (
          <>
            <s>
              {tok(row.engineContext)} / {tok(row.engineOutput)}
            </s>
            <span className="limits-arrow">←</span>
            <strong>
              {tok(row.context)} / {tok(row.output)}
            </strong>
          </>
        ) : (
          <strong>
            {tok(row.context)} / {tok(row.output)}
          </strong>
        )}
      </span>
      {row.verified && <span className="provider-badge on">{t("Verified")}</span>}
      {row.source && (
        <a className="limits-source" href={row.source} target="_blank" rel="noreferrer">
          {t("Source")}
        </a>
      )}
    </div>
  )
}
