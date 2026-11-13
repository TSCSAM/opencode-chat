import { appGet } from "./api"
import type { ModelInfo } from "./types"

export type ModelLimitEntry = {
  context: number
  output: number
  source?: string
  note?: string
  verified?: boolean
}

export type ModelLimitCatalog = {
  version: number
  updatedAt: string | null
  description: string | null
  sources: Record<string, { url?: string; label?: string }>
  notes: Record<string, string>
  providers: Record<string, { models: Record<string, ModelLimitEntry> }>
}

export type ModelLimitRow = {
  providerID: string
  id: string
  name: string
  context: number
  output: number
  engineContext: number
  engineOutput: number
  differs: boolean
  verified: boolean
  source: string | null
  note: string | null
}

export type ModelLimitState = {
  catalog: ModelLimitCatalog
  rows: ModelLimitRow[]
  tracked: number
  pending: number
}

let cached: ModelLimitCatalog | null = null
let inflight: Promise<ModelLimitCatalog | null> | null = null

// کاتالوگ یک‌بار خوانده و نگه داشته می‌شود؛ همهٔ بخش‌های رابط از همان استفاده
// می‌کنند تا ظرفیت نمایش‌داده‌شده در همه‌جا یکی باشد.
export async function loadModelLimitCatalog(force = false): Promise<ModelLimitCatalog | null> {
  if (cached && !force) return cached
  if (inflight && !force) return inflight
  inflight = appGet<{ catalog: ModelLimitCatalog | null }>("/app/model-limits")
    .then((body) => {
      cached = body?.catalog ?? null
      return cached
    })
    .catch(() => null)
    .finally(() => {
      inflight = null
    })
  return inflight
}

export function getModelLimitCatalog(): ModelLimitCatalog | null {
  return cached
}

// مقادیر کاتالوگ روی دادهٔ موتور اعمال می‌شود. فقط مدل‌هایی که در کاتالوگ
// هستند تغییر می‌کنند؛ بقیه دست‌نخورده می‌مانند.
export function applyModelLimits(models: ModelInfo[], catalog = cached): ModelInfo[] {
  if (!catalog?.providers) return models
  let touched = false
  const next = models.map((model) => {
    const entry = catalog.providers[model.providerID]?.models?.[model.id]
    if (!entry) return model
    if (model.limit?.context === entry.context && model.limit?.output === entry.output) return model
    touched = true
    return {
      ...model,
      limit: { ...(model.limit ?? {}), context: entry.context, output: entry.output },
    }
  })
  return touched ? next : models
}

export function formatTokens(value: number | undefined | null): string {
  if (!Number.isFinite(value as number)) return "—"
  return (value as number).toLocaleString("en-US")
}
