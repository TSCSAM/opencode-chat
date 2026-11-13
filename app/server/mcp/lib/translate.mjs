import { ToolError } from "./core.mjs"
import { fetchJson } from "./http.mjs"

const LANGUAGE_NAMES = {
  auto: "Auto detect",
  en: "English",
  fa: "Persian",
  ar: "Arabic",
  tr: "Turkish",
  de: "German",
  fr: "French",
  es: "Spanish",
  it: "Italian",
  ru: "Russian",
  zh: "Chinese",
  ja: "Japanese",
  ko: "Korean",
  hi: "Hindi",
  ur: "Urdu",
  pt: "Portuguese",
  nl: "Dutch",
  sv: "Swedish",
  pl: "Polish",
  uk: "Ukrainian",
}

export function languages() {
  return LANGUAGE_NAMES
}

function heuristicLanguage(text) {
  const value = String(text || "")
  if (/[\u0600-\u06ff]/.test(value)) {
    if (/[پچژگ]/.test(value)) return "fa"
    return "ar"
  }
  if (/[\u4e00-\u9fff]/.test(value)) return "zh"
  if (/[\u3040-\u30ff]/.test(value)) return "ja"
  if (/[\uac00-\ud7af]/.test(value)) return "ko"
  if (/[\u0400-\u04ff]/.test(value)) return "ru"
  return "en"
}

export async function translateText(args) {
  const text = String(args.text || "").trim()
  if (!text) throw new ToolError("text is required", "BAD_INPUT")
  const source = args.source && args.source !== "auto" ? args.source : heuristicLanguage(text)
  const target = String(args.target || "en")
  if (source === target) return { text, source, target, provider: "none" }

  const libre = process.env.LIBRETRANSLATE_URL
  if (libre) {
    const { json } = await fetchJson(`${libre.replace(/\/$/, "")}/translate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ q: text, source, target, format: "text", ...(process.env.LIBRETRANSLATE_API_KEY ? { api_key: process.env.LIBRETRANSLATE_API_KEY } : {}) }),
      timeout: 45_000,
    })
    return { text: json.translatedText, source, target, provider: "LibreTranslate", detected: json.detectedLanguage?.language || null }
  }

  const chunks = text.length > 450 ? text.match(/[\s\S]{1,450}/g) || [text] : [text]
  const out = []
  let detected = null
  for (const chunk of chunks) {
    const { json } = await fetchJson(
      `https://api.mymemory.translated.net/get?q=${encodeURIComponent(chunk)}&langpair=${encodeURIComponent(`${source}|${target}`)}`,
      { timeout: 30_000 },
    )
    const translated = json?.responseData?.translatedText
    if (!translated) throw new ToolError(json?.responseDetails || "translation provider returned no text", "TRANSLATE_FAILED")
    out.push(translated)
    detected = json?.matches?.[0]?.source || detected
  }
  return { text: out.join(" "), source, target, provider: "MyMemory", detected }
}

export async function detectLanguage(text) {
  const value = String(text || "")
  if (!value.trim()) throw new ToolError("text is required", "BAD_INPUT")
  const heuristic = heuristicLanguage(value)
  const { json } = await fetchJson(
    `https://api.mymemory.translated.net/get?q=${encodeURIComponent(value.slice(0, 450))}&langpair=${encodeURIComponent("auto|en")}`,
    { timeout: 30_000 },
  ).catch(() => ({ json: null }))
  return { language: json?.matches?.[0]?.source || heuristic, name: LANGUAGE_NAMES[json?.matches?.[0]?.source || heuristic] || "Unknown", heuristic, provider: json ? "MyMemory" : "heuristic" }
}
