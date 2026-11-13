import { ToolError, truncate, unique } from "./core.mjs"

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 OpenCodeChatTools/1.9"
const MAX_BYTES = 8_000_000

export function normalizeUrl(input, base) {
  let raw = String(input || "").trim()
  if (!raw) throw new ToolError("url is required", "BAD_INPUT")
  if (base) {
    try {
      raw = new URL(raw, base).toString()
    } catch {}
  }
  let url
  try {
    url = new URL(raw)
  } catch {
    url = new URL(`https://${raw}`)
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new ToolError(`unsupported URL protocol: ${url.protocol}`, "BAD_URL")
  }
  if (url.hostname === "169.254.169.254" || url.hostname === "metadata.google.internal") {
    throw new ToolError("cloud metadata endpoints are blocked", "SSRF_BLOCKED")
  }
  return url
}

async function readLimited(response, maxBytes = MAX_BYTES) {
  const reader = response.body?.getReader()
  if (!reader) return Buffer.from(await response.arrayBuffer())
  const chunks = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      try {
        await reader.cancel()
      } catch {}
      throw new ToolError(`response exceeds ${maxBytes} bytes`, "TOO_LARGE")
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks)
}

export async function fetchRaw(url, options = {}) {
  const target = normalizeUrl(url, options.base)
  const headers = {
    "user-agent": options.userAgent || UA,
    accept: options.accept || "*/*",
    ...(options.headers || {}),
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeout ?? 25_000)
  try {
    const res = await fetch(target, {
      method: options.method || "GET",
      headers,
      body: options.body,
      redirect: options.redirect || "follow",
      signal: controller.signal,
      ...(options.fetchOptions || {}),
    })
    const maxBytes = options.maxBytes ?? MAX_BYTES
    const buf = options.stream ? null : await readLimited(res, maxBytes)
    return {
      url: res.url || target.toString(),
      status: res.status,
      ok: res.ok,
      headers: Object.fromEntries(res.headers.entries()),
      contentType: res.headers.get("content-type") || "",
      buffer: buf,
      text: buf ? buf.toString("utf8") : "",
      finalUrl: res.url || target.toString(),
    }
  } catch (error) {
    if (error?.name === "AbortError") throw new ToolError(`request timed out: ${target}`, "TIMEOUT")
    throw new ToolError(`request failed: ${error?.message ?? error}`, "FETCH_FAILED")
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchText(url, options = {}) {
  const res = await fetchRaw(url, { ...options, maxBytes: options.maxBytes ?? 3_000_000 })
  return res
}

export async function fetchJson(url, options = {}) {
  const res = await fetchText(url, { ...options, accept: "application/json,text/plain,*/*" })
  try {
    return { ...res, json: JSON.parse(res.text) }
  } catch {
    throw new ToolError(`expected JSON from ${url}, got ${res.contentType || "unknown content"}`, "BAD_JSON")
  }
}

let cheerioModule
export async function cheerioLoad(html, options = {}) {
  if (!cheerioModule) cheerioModule = await import("cheerio")
  const load = cheerioModule.load || cheerioModule.default?.load
  return load(String(html || ""), options)
}

export function decodeEntities(text) {
  return String(text || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
}

export async function htmlToText(html) {
  const $ = await cheerioLoad(html)
  $("script, style, noscript, svg, canvas, iframe, template").remove()
  $("br").replaceWith("\n")
  $("p, div, section, article, header, footer, li, tr, h1, h2, h3, h4, h5, h6").each((_, el) => {
    $(el).append("\n")
  })
  return decodeEntities($.root().text())
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

export async function htmlMetadata(html, pageUrl) {
  const $ = await cheerioLoad(html)
  const meta = {}
  $("meta").each((_, el) => {
    const key = $(el).attr("name") || $(el).attr("property") || $(el).attr("http-equiv")
    const content = $(el).attr("content")
    if (key && content) meta[key.toLowerCase()] = content
  })
  const links = []
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href")
    if (!href) return
    const text = $(el).text().replace(/\s+/g, " ").trim()
    const rel = $(el).attr("rel") || ""
    let absolute = href
    try {
      absolute = new URL(href, pageUrl).toString()
    } catch {}
    links.push({ href: absolute, text: text.slice(0, 180), rel })
  })
  const images = []
  $("img[src]").each((_, el) => {
    let src = $(el).attr("src")
    try {
      src = new URL(src, pageUrl).toString()
    } catch {}
    images.push({ src, alt: $(el).attr("alt") || "", width: $(el).attr("width"), height: $(el).attr("height") })
  })
  return {
    title: $("title").first().text().trim() || meta["og:title"] || "",
    description: meta.description || meta["og:description"] || "",
    canonical: $('link[rel="canonical"]').attr("href") || "",
    language: $("html").attr("lang") || "",
    meta,
    links,
    images,
    headings: $("h1,h2,h3,h4,h5,h6")
      .map((_, el) => ({ level: Number(el.tagName.slice(1)), text: $(el).text().replace(/\s+/g, " ").trim() }))
      .get()
      .filter((h) => h.text)
      .slice(0, 200),
    tables: $("table")
      .map((_, table) => ({
        headers: $(table)
          .find("tr")
          .first()
          .find("th,td")
          .map((__, cell) => $(cell).text().replace(/\s+/g, " ").trim())
          .get(),
        rows: $(table)
          .find("tr")
          .slice(1)
          .map((__, row) => $(row).find("td,th").map((___, cell) => $(cell).text().replace(/\s+/g, " ").trim()).get())
          .get()
          .slice(0, 100),
      }))
      .get()
      .slice(0, 20),
  }
}

export async function htmlToMarkdown(html, pageUrl) {
  const TurndownService = (await import("turndown")).default
  const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" })
  td.addRule("remove scripts", { filter: ["script", "style", "noscript"], replacement: () => "" })
  const absolute = (href) => {
    try {
      return new URL(href, pageUrl).toString()
    } catch {
      return href
    }
  }
  td.addRule("absolute links", {
    filter: "a",
    replacement: (content, node) => {
      const href = node.getAttribute("href")
      return href ? `[${content}](${absolute(href)})` : content
    },
  })
  td.addRule("absolute images", {
    filter: "img",
    replacement: (_, node) => {
      const src = node.getAttribute("src")
      return src ? `![${node.getAttribute("alt") || ""}](${absolute(src)})` : ""
    },
  })
  return td.turndown(String(html || ""))
}

export async function fetchPage(url, options = {}) {
  const res = await fetchText(url, { ...options, accept: "text/html,application/xhtml+xml,text/plain,*/*" })
  const type = res.contentType.toLowerCase()
  if (type.includes("html") || /^\s*</.test(res.text.slice(0, 200))) {
    const metadata = await htmlMetadata(res.text, res.finalUrl)
    const markdown = options.markdown === false ? null : await htmlToMarkdown(res.text, res.finalUrl)
    return { ...res, metadata, markdown, text: await htmlToText(res.text) }
  }
  return { ...res, metadata: null, markdown: null }
}

function bingDecode(value) {
  return decodeEntities(String(value || "").replace(/\\u002f/g, "/").replace(/\\\//g, "/"))
}

export async function searchWeb(query, options = {}) {
  const count = Math.max(1, Math.min(50, Number(options.maxResults || 8)))
  const type = options.type || "web"
  const q = String(query || "").trim()
  if (!q) throw new ToolError("query is required", "BAD_INPUT")

  if (type === "academic") return searchAcademic(q, count)
  if (type === "news") return searchNews(q, count)
  if (type === "images") return searchImages(q, count)
  if (type === "videos") return searchVideos(q, count)

  const clean = (rows) =>
    (rows || []).filter(
      (row) =>
        row?.url &&
        !/duckduckgo\.com\/y\.js|bing\.com\/aclick|doubleclick\.net|googleadservices\.com/i.test(row.url),
    )
  const ddg = clean(await searchDuckDuckGo(q, count).catch(() => null))
  if (ddg.length) return ddg
  return clean(await searchBing(q, count))
}

async function searchDuckDuckGo(query, count) {
  const res = await fetchText(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: { accept: "text/html" },
    timeout: 20_000,
  })
  const $ = await cheerioLoad(res.text)
  const rows = []
  $(".result").each((_, el) => {
    if (rows.length >= count) return
    const link = $(el).find(".result__a").first()
    const href = link.attr("href")
    if (!href) return
    let url = href
    try {
      const parsed = new URL(href, "https://duckduckgo.com")
      const uddg = parsed.searchParams.get("uddg")
      if (uddg) url = uddg
    } catch {}
    rows.push({
      title: link.text().replace(/\s+/g, " ").trim(),
      url,
      snippet: $(el).find(".result__snippet").first().text().replace(/\s+/g, " ").trim(),
      source: "DuckDuckGo",
    })
  })
  return rows
}

async function searchBing(query, count) {
  const res = await fetchText(`https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${count}`, {
    headers: { accept: "text/html", "accept-language": "en-US,en;q=0.8" },
  })
  const $ = await cheerioLoad(res.text)
  const rows = []
  $("#b_results > li.b_algo").each((_, el) => {
    if (rows.length >= count) return
    const link = $(el).find("h2 a").first()
    const url = link.attr("href")
    if (!url) return
    rows.push({
      title: link.text().replace(/\s+/g, " ").trim(),
      url,
      snippet: $(el).find(".b_caption p").first().text().replace(/\s+/g, " ").trim(),
      source: "Bing",
    })
  })
  if (!rows.length) {
    $("li.b_algo h2 a").each((_, el) => {
      if (rows.length >= count) return
      rows.push({ title: $(el).text().trim(), url: $(el).attr("href"), snippet: "", source: "Bing" })
    })
  }
  return rows
}

async function searchNews(query, count) {
  const rss = await fetchText(`https://www.bing.com/news/search?q=${encodeURIComponent(query)}&format=rss`, {
    headers: { accept: "application/rss+xml,text/xml" },
  }).catch(() => null)
  if (rss?.text) {
    const $ = await cheerioLoad(rss.text, { xmlMode: true })
    const rows = []
    $("item").each((_, el) => {
      if (rows.length >= count) return
      rows.push({
        title: $(el).find("title").text().trim(),
        url: $(el).find("link").text().trim(),
        snippet: $(el).find("description").text().replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
        published: $(el).find("pubDate").text().trim(),
        source: $(el).find("source").text().trim() || "Bing News",
      })
    })
    if (rows.length) return rows
  }
  return searchDuckDuckGo(`${query} news`, count)
}

async function searchImages(query, count) {
  const res = await fetchText(`https://www.bing.com/images/search?q=${encodeURIComponent(query)}`, {
    headers: { accept: "text/html", "accept-language": "en-US,en;q=0.8" },
  })
  const $ = await cheerioLoad(res.text)
  const rows = []
  $("a.iusc").each((_, el) => {
    if (rows.length >= count) return
    const raw = $(el).attr("m")
    if (!raw) return
    try {
      const data = JSON.parse(decodeEntities(raw))
      rows.push({ title: data.t || query, url: bingDecode(data.murl), thumbnail: bingDecode(data.turl), source: data.purl || "Bing Images", width: data.mw, height: data.mh })
    } catch {}
  })
  if (rows.length) return rows
  const commons = await fetchJson(
    `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(query)}&gsrnamespace=6&gsrlimit=${count}&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=1200&format=json`,
  ).catch(() => null)
  const pages = commons?.json?.query?.pages || {}
  return Object.values(pages).map((page) => ({
    title: page.title,
    url: page.imageinfo?.[0]?.url,
    thumbnail: page.imageinfo?.[0]?.thumburl,
    source: "Wikimedia Commons",
  }))
}

async function searchVideos(query, count) {
  const res = await fetchText(`https://www.bing.com/videos/search?q=${encodeURIComponent(query)}`, {
    headers: { accept: "text/html" },
  }).catch(() => null)
  const rows = []
  if (res?.text) {
    const $ = await cheerioLoad(res.text)
    $(".mc_vtvc").each((_, el) => {
      if (rows.length >= count) return
      const link = $(el).find("a").first()
      const href = link.attr("href")
      if (!href) return
      rows.push({
        title: $(el).find(".mc_vtvc_title").text().replace(/\s+/g, " ").trim() || link.attr("title") || query,
        url: href.startsWith("http") ? href : `https://www.bing.com${href}`,
        snippet: $(el).find(".mc_vtvc_meta").text().replace(/\s+/g, " ").trim(),
        source: "Bing Videos",
      })
    })
  }
  if (rows.length) return rows
  const yt = await fetchText(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`, { headers: { accept: "text/html" } }).catch(() => null)
  if (yt?.text) {
    const $ = await cheerioLoad(yt.text)
    $("script").each((_, el) => {
      const text = $(el).html() || ""
      if (!text.includes("ytInitialData")) return
      const match = text.match(/ytInitialData\s*=\s*(\{.*?\});/s)
      if (!match) return
      try {
        const data = JSON.parse(match[1])
        const sections = data?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || []
        for (const section of sections) {
          for (const item of section?.itemSectionRenderer?.contents || []) {
            const video = item?.videoRenderer
            if (!video || rows.length >= count) continue
            rows.push({
              title: video.title?.runs?.map((r) => r.text).join("") || query,
              url: `https://www.youtube.com/watch?v=${video.videoId}`,
              snippet: video.detailedMetadataSnippets?.[0]?.snippetText?.runs?.map((r) => r.text).join("") || "",
              duration: video.lengthText?.simpleText || "",
              author: video.ownerText?.runs?.[0]?.text || "",
              source: "YouTube",
            })
          }
        }
      } catch {}
    })
  }
  return rows
}

async function searchAcademic(query, count) {
  const rows = []
  const crossref = await fetchJson(
    `https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=${Math.max(count, 5)}&select=title,URL,author,issued,abstract,DOI`,
    { headers: { "user-agent": `${UA} mailto:opencode-chat@localhost` } },
  ).catch(() => null)
  for (const item of crossref?.json?.message?.items || []) {
    if (rows.length >= count) break
    rows.push({
      title: item.title?.[0] || "",
      url: item.URL || (item.DOI ? `https://doi.org/${item.DOI}` : ""),
      snippet: String(item.abstract || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 500),
      authors: (item.author || []).map((a) => [a.given, a.family].filter(Boolean).join(" ")).join(", "),
      year: item.issued?.["date-parts"]?.[0]?.[0],
      doi: item.DOI,
      source: "Crossref",
    })
  }
  if (rows.length < count) {
    const arxiv = await fetchText(
      `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&start=0&max_results=${count}`,
      { headers: { accept: "application/atom+xml" } },
    ).catch(() => null)
    if (arxiv?.text) {
      const $ = await cheerioLoad(arxiv.text, { xmlMode: true })
      $("entry").each((_, el) => {
        if (rows.length >= count) return
        rows.push({
          title: $(el).find("title").text().replace(/\s+/g, " ").trim(),
          url: $(el).find("id").text().trim(),
          snippet: $(el).find("summary").text().replace(/\s+/g, " ").trim().slice(0, 500),
          authors: $(el).find("author name").map((__, a) => $(a).text()).get().join(", "),
          published: $(el).find("published").text().trim(),
          source: "arXiv",
        })
      })
    }
  }
  return rows
}

export async function searchSuggestions(query) {
  const res = await fetchJson(`https://suggestqueries.google.com/complete/search?client=firefox&q=${encodeURIComponent(query)}`).catch(() => null)
  return Array.isArray(res?.json?.[1]) ? res.json[1].slice(0, 20) : []
}

export async function crawlSite(startUrl, options = {}) {
  const start = normalizeUrl(startUrl)
  const maxPages = Math.max(1, Math.min(50, Number(options.maxPages || 8)))
  const maxDepth = Math.max(0, Math.min(3, Number(options.maxDepth ?? 1)))
  const sameOrigin = options.sameOrigin !== false
  const queue = [{ url: start.toString(), depth: 0 }]
  const seen = new Set()
  const pages = []
  while (queue.length && pages.length < maxPages) {
    const item = queue.shift()
    if (seen.has(item.url)) continue
    seen.add(item.url)
    try {
      const page = await fetchPage(item.url, { timeout: 20_000 })
      pages.push({
        url: page.finalUrl,
        status: page.status,
        title: page.metadata?.title || "",
        description: page.metadata?.description || "",
        text: truncate(page.text, 12_000),
        links: page.metadata?.links?.slice(0, 80) || [],
        depth: item.depth,
      })
      if (item.depth < maxDepth && page.metadata?.links) {
        for (const link of page.metadata.links) {
          try {
            const next = new URL(link.href)
            if (sameOrigin && next.origin !== start.origin) continue
            if (["mailto:", "tel:", "javascript:"].includes(next.protocol)) continue
            next.hash = ""
            if (!seen.has(next.toString())) queue.push({ url: next.toString(), depth: item.depth + 1 })
          } catch {}
        }
      }
    } catch (error) {
      pages.push({ url: item.url, error: String(error?.message ?? error), depth: item.depth })
    }
  }
  return pages
}

export async function httpRequest(args) {
  const headers = args.headers && typeof args.headers === "object" ? args.headers : {}
  let body = args.body
  if (body !== undefined && typeof body !== "string") body = JSON.stringify(body)
  const res = await fetchText(args.url, {
    method: String(args.method || "GET").toUpperCase(),
    headers,
    body,
    timeout: args.timeout || 30_000,
    maxBytes: args.maxBytes || MAX_BYTES,
  })
  const contentType = res.contentType || ""
  let parsed = null
  if (contentType.includes("json") || /^\s*[\[{]/.test(res.text.slice(0, 200))) {
    try {
      parsed = JSON.parse(res.text)
    } catch {}
  }
  return { status: res.status, headers: res.headers, contentType, finalUrl: res.finalUrl, body: parsed ?? truncate(res.text, 60_000) }
}

export async function checkUrl(url) {
  const started = Date.now()
  const res = await fetchText(url, { method: "GET", timeout: 20_000, maxBytes: 1_000_000 })
  return {
    url: res.finalUrl,
    status: res.status,
    ok: res.ok,
    ms: Date.now() - started,
    contentType: res.contentType,
    title: res.contentType.includes("html") ? (await htmlMetadata(res.text, res.finalUrl)).title : "",
  }
}

export function absoluteLinks(links, base) {
  return unique(
    (links || []).map((link) => {
      try {
        return new URL(link, base).toString()
      } catch {
        return null
      }
    }),
  )
}
