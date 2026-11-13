import { ToolError, unique } from "./core.mjs"
import { checkUrl, fetchPage, fetchText, normalizeUrl, searchSuggestions, searchWeb } from "./http.mjs"
import { getPage } from "./browser.mjs"

function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return ""
  }
}

function wordCount(text) {
  return (String(text || "").match(/[A-Za-z0-9\u0600-\u06ff]+/g) || []).length
}

function keywordFrequency(text, limit = 20) {
  const stop = new Set("the a an and or but if then of to in on for with as at by from is are was were be been being this that these those it its we you they he she i not no do does did have has had will would can could should may might".split(" "))
  const freq = new Map()
  for (const word of String(text || "").toLowerCase().match(/[a-z0-9\u0600-\u06ff]{3,}/g) || []) {
    if (stop.has(word)) continue
    freq.set(word, (freq.get(word) || 0) + 1)
  }
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([term, count]) => ({ term, count }))
}

function extractJsonLd(html) {
  const rows = []
  const regex = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  let match
  while ((match = regex.exec(html))) {
    try {
      const parsed = JSON.parse(match[1].trim())
      rows.push(parsed)
    } catch {
      rows.push({ error: "invalid JSON-LD", raw: match[1].slice(0, 300) })
    }
  }
  return rows
}

function robotsInfo(text) {
  const lines = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const sitemaps = lines.filter((line) => /^sitemap:/i.test(line)).map((line) => line.replace(/^sitemap:\s*/i, ""))
  const disallow = lines.filter((line) => /^disallow:/i.test(line)).map((line) => line.replace(/^disallow:\s*/i, ""))
  return { text: lines.slice(0, 300).join("\n"), sitemaps, disallow }
}

export async function seoAudit(url, options = {}) {
  const page = await fetchPage(url, { timeout: 30_000 })
  const meta = page.metadata || {}
  const base = page.finalUrl
  const html = page.text
  const title = meta.title || ""
  const description = meta.description || ""
  const headings = meta.headings || []
  const h1 = headings.filter((h) => h.level === 1)
  const images = meta.images || []
  const missingAlt = images.filter((image) => !String(image.alt || "").trim()).length
  const links = meta.links || []
  const internal = links.filter((link) => domainOf(link.href) === domainOf(base))
  const external = links.filter((link) => link.href.startsWith("http") && domainOf(link.href) !== domainOf(base))
  const words = wordCount(html)
  const robotsUrl = new URL("/robots.txt", base).toString()
  const sitemapUrl = new URL("/sitemap.xml", base).toString()
  const robots = await fetchText(robotsUrl, { timeout: 15_000 }).then((res) => (res.ok ? robotsInfo(res.text) : null)).catch(() => null)
  const sitemap = await fetchText(sitemapUrl, { timeout: 15_000 }).then((res) => (res.ok ? { status: res.status, urls: (res.text.match(/<loc>/g) || []).length, sample: [...res.text.matchAll(/<loc>([^<]+)<\/loc>/g)].slice(0, 20).map((m) => m[1]) } : null)).catch(() => null)
  const issues = []
  if (!title) issues.push({ severity: "high", issue: "Missing <title>" })
  else if (title.length < 30 || title.length > 65) issues.push({ severity: "medium", issue: `Title length is ${title.length} characters (30–65 recommended)` })
  if (!description) issues.push({ severity: "high", issue: "Missing meta description" })
  else if (description.length < 70 || description.length > 165) issues.push({ severity: "medium", issue: `Meta description length is ${description.length} characters (70–165 recommended)` })
  if (h1.length !== 1) issues.push({ severity: "high", issue: `Expected exactly one H1, found ${h1.length}` })
  if (missingAlt) issues.push({ severity: "medium", issue: `${missingAlt} image(s) missing alt text` })
  if (!meta.meta?.viewport) issues.push({ severity: "high", issue: "Missing viewport meta tag" })
  if (!meta.canonical) issues.push({ severity: "medium", issue: "Missing canonical URL" })
  if (!page.contentType.includes("html")) issues.push({ severity: "high", issue: `Unexpected content type: ${page.contentType}` })
  if (page.status >= 400) issues.push({ severity: "high", issue: `HTTP status ${page.status}` })
  if (words < 200) issues.push({ severity: "low", issue: `Only ${words} words of visible text` })
  return {
    url: base,
    status: page.status,
    title: { value: title, length: title.length },
    description: { value: description, length: description.length },
    canonical: meta.canonical,
    language: meta.language,
    headings: headings.slice(0, 50),
    counts: { h1: h1.length, headings: headings.length, words, links: links.length, internalLinks: internal.length, externalLinks: external.length, images: images.length, missingAlt },
    keywords: keywordFrequency(page.text),
    structuredData: extractJsonLd(page.text),
    robots,
    sitemap,
    issues,
    score: Math.max(0, 100 - issues.reduce((sum, issue) => sum + (issue.severity === "high" ? 18 : issue.severity === "medium" ? 8 : 3), 0)),
  }
}

export async function seoKeywords(query) {
  const suggestions = await searchSuggestions(query).catch(() => [])
  const results = await searchWeb(query, { maxResults: 10 }).catch(() => [])
  const text = results.map((r) => `${r.title} ${r.snippet}`).join(" ")
  return { query, suggestions, related: keywordFrequency(text, 30), serp: results.map((r, i) => ({ position: i + 1, ...r })) }
}

export async function serpAnalysis(query, maxResults = 10) {
  const rows = await searchWeb(query, { maxResults })
  return {
    query,
    results: rows.map((row, index) => ({ position: index + 1, ...row, domain: domainOf(row.url) })),
    domains: unique(rows.map((row) => domainOf(row.url))),
  }
}

export async function coreWebVitals(url) {
  const page = await getPage("seo-vitals", { viewport: { width: 1440, height: 900 } })
  await page.goto(url, { waitUntil: "networkidle2", timeout: 45_000 })
  const vitals = await page.evaluate(async () => {
    const result = { lcp: null, cls: null, inp: null, fcp: null, ttfb: null }
    const nav = performance.getEntriesByType("navigation")[0]
    if (nav) {
      result.ttfb = nav.responseStart
      result.fcp = performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? null
    }
    try {
      new PerformanceObserver((list) => {
        const entries = list.getEntries()
        result.lcp = entries.at(-1)?.startTime ?? result.lcp
      }).observe({ type: "largest-contentful-paint", buffered: true })
    } catch {}
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) if (!entry.hadRecentInput) result.cls = (result.cls || 0) + entry.value
      }).observe({ type: "layout-shift", buffered: true })
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 2500))
    return result
  })
  const resources = await page.evaluate(() =>
    performance.getEntriesByType("resource").map((entry) => ({ name: entry.name, type: entry.initiatorType, duration: entry.duration, transferSize: entry.transferSize })).sort((a, b) => b.duration - a.duration).slice(0, 25),
  )
  return { url: page.url(), vitals, slowestResources: resources }
}

export async function brokenLinks(url, options = {}) {
  const page = await fetchPage(url, { timeout: 30_000 })
  const links = unique((page.metadata?.links || []).map((link) => link.href).filter((href) => /^https?:/i.test(href))).slice(0, Math.max(1, Math.min(50, Number(options.maxLinks || 25))))
  const rows = []
  for (const link of links) {
    try {
      const res = await fetchText(link, { method: "GET", timeout: 15_000, maxBytes: 500_000 })
      rows.push({ url: link, status: res.status, ok: res.ok })
    } catch (error) {
      rows.push({ url: link, status: null, ok: false, error: String(error?.message ?? error) })
    }
  }
  return { checked: rows.length, broken: rows.filter((row) => !row.ok), rows }
}

export async function siteStatus(url) {
  return await checkUrl(url)
}
