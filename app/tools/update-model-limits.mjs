// ابزار به‌روزرسانی کاتالوگ ظرفیت مدل‌ها.
//
// منابع:
//   - opencode  → کاتالوگ رسمی خود پرووایدر: https://opencode.ai/inference/v1/models
//   - بقیه      → models.dev (همان دیتابیسی که موتور OpenCode از آن می‌خواند)
//
// هر مدلی که مشخصاتش را از سایت سازنده‌اش (نه از کاتالوگ واسط) تأیید کرده باشیم،
// در VERIFIED می‌آید. این مقادیر «تأییدشده» هستند و هر بار حتی اگر کاتالوگ
// پرووایدر دوباره همان مقدار پیش‌فرض را برگرداند، دست‌نخورده می‌مانند.
//
// اجرا:  node tools/update-model-limits.mjs
import fsp from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const OUT = path.join(root, "data", "model-limits.json")

const OPENCODE_MODELS_URL = "https://opencode.ai/inference/v1/models"
const MODELS_DEV_URL = "https://models.dev/api.json"

// مقادیری که مستقیماً از سایت سازندهٔ مدل تأیید شده‌اند. کلید: "پرووایدر/مدل".
// این‌ها بر هر داده‌ای که کاتالوگ پرووایدر برمی‌گرداند اولویت دارند.
//
// توجه: نسخه‌های «-free» در OpenCode Zen سقف جداگانه‌ای دارند و با مشخصات
// نسخهٔ کامل/پولی سازنده یکی نیستند (مثلاً DeepSeek V4.1 Flash Free فقط
// 200K/32K است در حالی که نسخهٔ پولی 1M/384K است). بنابراین این مدل‌ها نباید
// در این جدول ثبت شوند؛ مقدارشان از کاتالوگ رسمی OpenCode گرفته می‌شود.
const VERIFIED = {}

// پرووایدرهایی که کاتالوگ کاملشان از models.dev گرفته می‌شود.
const FULL_PROVIDERS = ["opencode", "agentrouter"]

// برای بقیهٔ پرووایدرها فقط مدل‌های شاخص ثبت می‌شوند تا فایل قابل مرور بماند.
// (موتور برای بقیهٔ مدل‌ها خودش دادهٔ درست را از models.dev می‌گیرد.)
const CURATED_PROVIDERS = {
  zai: ["glm-5.3", "glm-5.3-flash", "glm-5.2", "glm-5.1", "glm-5"],
  zhipuai: ["glm-5.3", "glm-5.3-flash", "glm-5.2", "glm-5.1", "glm-5"],
  deepseek: ["deepseek-v4.1-flash", "deepseek-v4-pro", "deepseek-v4-flash"],
  xiaomi: ["mimo-v2.6-flash", "mimo-v2.6-pro", "mimo-v2.5", "mimo-v2.5-pro"],
  minimax: ["MiniMax-M3.1-Flash", "MiniMax-M3", "MiniMax-M2.7", "MiniMax-M2.5"],
  moonshotai: ["kimi-k3", "kimi-k2.7-code", "kimi-k2.6", "kimi-k2.5"],
  nvidia: [
    "nvidia/nemotron-3-ultra-550b-a55b",
    "nvidia/nemotron-3.5-lightning-30b-a3b",
    "nvidia/nemotron-3.5-super-vl-120b-a12b",
    "nvidia/nemotron-3-super-120b-a12b",
  ],
  thinkingmachines: ["thinkingmachines/Inkling-Small", "thinkingmachines/Inkling"],
  longcat: ["LongCat-2.5-Preview", "LongCat-2.0"],
  alibaba: ["qwen3.8-max", "qwen3.6-plus", "qwen3.5-plus", "qwen3.8-flash"],
  anthropic: ["claude-opus-5", "claude-opus-4-8", "claude-sonnet-5", "claude-haiku-5-5"],
  openai: ["gpt-5.6-sol", "gpt-6.1-sol", "gpt-5.4"],
  google: ["gemini-3.8-flash", "gemini-4-argon", "gemini-4-carbon"],
  xai: ["grok-4.7"],
  mistral: ["mistral-large-4"],
}

const PROVIDER_SOURCE = {
  opencode: {
    url: OPENCODE_MODELS_URL,
    label: "کاتالوگ رسمی OpenCode Console",
  },
  agentrouter: { url: MODELS_DEV_URL, label: "models.dev" },
  zai: { url: "https://docs.z.ai/guides/llm", label: "مستندات Z.ai" },
  zhipuai: { url: "https://docs.z.ai/guides/llm", label: "مستندات Z.ai" },
  deepseek: { url: "https://api-docs.deepseek.com", label: "مستندات DeepSeek" },
  xiaomi: { url: "https://platform.xiaomimimo.com/", label: "مستندات Xiaomi MiMo" },
  minimax: { url: "https://platform.minimax.io/", label: "مستندات MiniMax" },
  moonshotai: { url: "https://platform.moonshot.ai/", label: "مستندات Moonshot" },
  nvidia: { url: "https://build.nvidia.com/", label: "مستندات NVIDIA" },
  thinkingmachines: { url: "https://thinkingmachines.ai/", label: "مستندات Thinking Machines" },
  longcat: { url: "https://longcat.chat/", label: "مستندات LongCat" },
  anthropic: { url: "https://docs.anthropic.com/", label: "مستندات Anthropic" },
  openai: { url: "https://platform.openai.com/docs", label: "مستندات OpenAI" },
  google: { url: "https://ai.google.dev/gemini-api/docs", label: "مستندات Google" },
  xai: { url: "https://docs.x.ai/", label: "مستندات xAI" },
  mistral: { url: "https://docs.mistral.ai/", label: "مستندات Mistral" },
  alibaba: { url: "https://www.alibabacloud.com/help/en/model-studio/", label: "مستندات Alibaba Model Studio" },
}

async function getJson(url) {
  const res = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "opencode-chat" },
    signal: AbortSignal.timeout(90000),
  })
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`)
  return res.json()
}

function entryOf(model, fallbackSource) {
  const context = Number(model?.limit?.context)
  const output = Number(model?.limit?.output)
  if (!Number.isFinite(context) || !Number.isFinite(output)) return null
  const entry = { context, output }
  if (fallbackSource) entry.source = fallbackSource
  return entry
}

const catalog = { providers: {} }
const notes = {}

// ورودی‌های دستی فایل قبلی پیش از ساخت کاتالوگ خوانده می‌شوند تا بتوانیم
// توضیح‌های دقیق‌ترِ همان مدل را (تا وقتی عددها عوض نشده‌اند) نگه داریم.
let previous = null
try {
  previous = JSON.parse(await fsp.readFile(OUT, "utf8"))
} catch {}

function formatTokens(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return String(value)
  if (n >= 1_000_000) {
    const millions = n / 1_000_000
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`
  }
  if (n >= 1024 && n % 1024 === 0) return `${n / 1024}K`
  if (n >= 1000) return `${Math.round(n / 1000)}K`
  return String(n)
}

// ۱) کاتالوگ رسمی پرووایدر OpenCode
const oc = await getJson(OPENCODE_MODELS_URL)
const ocModels = Array.isArray(oc?.data) ? oc.data : []
const ocModelsMap = {}
for (const m of ocModels) {
  const entry = entryOf(m)
  if (!entry) continue
  const free = m.id.endsWith("-free") || m.id === "big-pickle"
  if (free) {
    // سقف نسخهٔ رایگان همان چیزی است که Zen سرو می‌کند، نه مشخصات نسخهٔ کامل.
    entry.source = OPENCODE_MODELS_URL
    entry.verified = true
    entry.note = `OpenCode Zen Free: ${formatTokens(entry.context)} context · ${formatTokens(entry.output)} max output`
    const prior = previous?.providers?.opencode?.models?.[m.id]
    if (prior?.verified && prior.context === entry.context && prior.output === entry.output && prior.note) {
      entry.note = prior.note
    }
  }
  ocModelsMap[m.id] = entry
}
catalog.providers.opencode = { models: ocModelsMap }
notes.opencode = `OpenCode Console — کاتالوگ رسمی OpenCode Zen (${Object.keys(ocModelsMap).length} مدل)`

// ۲) بقیهٔ پرووایدرها از models.dev
const dev = await getJson(MODELS_DEV_URL)
for (const [pid, wanted] of Object.entries(CURATED_PROVIDERS)) {
  const provider = dev?.[pid]
  if (!provider?.models) continue
  const models = {}
  for (const id of wanted) {
    const entry = entryOf(provider.models[id])
    if (entry) models[id] = entry
  }
  if (Object.keys(models).length === 0) continue
  catalog.providers[pid] = { models }
  notes[pid] = `models.dev — ${Object.keys(models).length} مدل`
}
for (const pid of FULL_PROVIDERS) {
  if (pid === "opencode") continue
  const provider = dev?.[pid]
  if (!provider?.models) continue
  const models = {}
  for (const [id, model] of Object.entries(provider.models)) {
    const entry = entryOf(model)
    if (entry) models[id] = entry
  }
  if (Object.keys(models).length === 0) continue
  catalog.providers[pid] = { models }
  notes[pid] = `models.dev — ${Object.keys(models).length} مدل`
}

// ۳) مقادیر تأییدشده از سایت سازنده، روی داده‌های کاتالوگ سوار می‌شوند.
// نسخه‌های رایگان Zen هرگز از این مسیر بازنویسی نمی‌شوند.
for (const [key, value] of Object.entries(VERIFIED)) {
  const [pid, id] = key.split("/")
  if (pid === "opencode" && (id.endsWith("-free") || id === "big-pickle")) continue
  if (!catalog.providers[pid]) catalog.providers[pid] = { models: {} }
  catalog.providers[pid].models[id] = { ...value, verified: true }
}

// ۴) ورودی‌های دستی که در فایل قبلی بوده و از کاتالوگ عمومی نمی‌آید حفظ می‌شوند
if (previous?.providers) {
  for (const [pid, provider] of Object.entries(previous.providers)) {
    for (const [id, entry] of Object.entries(provider?.models ?? {})) {
      if (entry?.verified) continue
      const current = catalog.providers[pid]?.models?.[id]
      if (current) continue
      catalog.providers[pid] ??= { models: {} }
      catalog.providers[pid].models[id] = entry
    }
  }
}

const output = {
  version: 1,
  updatedAt: new Date().toISOString().slice(0, 10),
  description:
    "ظرفیت کانتکس و حداکثر خروجی مدل‌ها بر اساس اطلاعات سایت پرووایدر/سازنده. ورودی‌هایی که «verified» دارند مستقیماً از سایت سازنده تأیید شده‌اند.",
  sources: PROVIDER_SOURCE,
  notes,
  providers: catalog.providers,
}

await fsp.writeFile(OUT, JSON.stringify(output, null, 2) + "\n", "utf8")

const total = Object.values(catalog.providers).reduce(
  (sum, p) => sum + Object.keys(p.models).length,
  0,
)
console.log(`model-limits.json نوشته شد: ${total} مدل در ${Object.keys(catalog.providers).length} پرووایدر`)
