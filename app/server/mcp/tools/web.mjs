import fsp from "node:fs/promises"
import {
  ToolError,
  errorResult,
  jsonResult,
  resolvePath,
  textResult,
  truncate,
  writeBinaryFile,
} from "../lib/core.mjs"
import {
  checkUrl,
  cheerioLoad,
  crawlSite,
  fetchPage,
  fetchRaw,
  fetchText,
  htmlMetadata,
  htmlToMarkdown,
  htmlToText,
  httpRequest,
  normalizeUrl,
  searchSuggestions,
  searchWeb,
} from "../lib/http.mjs"

function filterLinks(links, options = {}) {
  const rows = links || []
  const query = String(options.query || "").toLowerCase()
  const type = options.linkType || "all"
  return rows.filter((link) => {
    if (query && !`${link.text} ${link.href}`.toLowerCase().includes(query)) return false
    if (type === "internal" && !link.href.startsWith("/") && !link.href.includes(options.domain || "")) return false
    if (type === "external" && options.domain && !link.href.includes(options.domain)) return false
    return true
  })
}

export const webTool = {
  register(server, { z }) {
    server.registerTool(
      "web",
      {
        title: "Web search, fetch and HTTP",
        description:
          "Search the web/news/images/videos/academic papers, fetch and analyze pages, crawl a site, extract links/metadata/tables, inspect sitemap/robots, and make arbitrary REST/GraphQL/HTTP requests. Use this automatically whenever current information, a URL, documentation, a paper or an API is needed. Supports deep research by fetching the top results.",
        inputSchema: {
          action: z.enum(["search", "fetch", "crawl", "http", "status", "links", "metadata", "tables", "sitemap", "robots", "suggest", "research", "download"]),
          query: z.string().optional().describe("Search query."),
          url: z.string().optional().describe("URL to fetch."),
          type: z.enum(["web", "news", "images", "videos", "academic", "document"]).optional(),
          maxResults: z.number().int().positive().max(50).optional(),
          maxPages: z.number().int().positive().max(50).optional(),
          maxDepth: z.number().int().min(0).max(3).optional(),
          method: z.string().optional().describe("HTTP method."),
          headers: z.any().optional().describe("HTTP headers object."),
          body: z.any().optional().describe("Request body (string or JSON)."),
          selector: z.string().optional().describe("CSS selector for extract/dom."),
          format: z.enum(["text", "markdown", "html", "json"]).optional(),
          output: z.string().optional().describe("Download output path."),
          fetchTop: z.number().int().min(0).max(10).optional().describe("For research/search: fetch this many top pages."),
          timeout: z.number().int().positive().optional(),
          limit: z.number().int().positive().optional(),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      },
      async (args) => {
        try {
          const action = args.action
          if (action === "search") {
            let rows = await searchWeb(args.query, { type: args.type, maxResults: args.maxResults })
            if (args.type === "document") {
              rows = rows.map((row) => ({ ...row, url: row.url }))
            }
            if (args.fetchTop) {
              const top = rows.slice(0, args.fetchTop)
              for (const row of top) {
                try {
                  const page = await fetchPage(row.url, { timeout: 20_000 })
                  row.content = truncate(page.markdown || page.text, 12_000)
                  row.pageTitle = page.metadata?.title || row.title
                } catch (error) {
                  row.contentError = String(error?.message ?? error)
                }
              }
            }
            return jsonResult({ query: args.query, type: args.type || "web", count: rows.length, results: rows })
          }
          if (action === "fetch") {
            if (!args.url) throw new ToolError("url is required", "BAD_INPUT")
            const page = await fetchPage(args.url, { timeout: args.timeout || 30_000 })
            const format = args.format || "markdown"
            return jsonResult({
              url: page.finalUrl,
              status: page.status,
              contentType: page.contentType,
              title: page.metadata?.title || "",
              description: page.metadata?.description || "",
              text: format === "text" ? truncate(page.text, 60_000) : undefined,
              markdown: format === "markdown" ? truncate(page.markdown || page.text, 80_000) : undefined,
              html: format === "html" ? truncate(page.text, 100_000) : undefined,
              links: page.metadata?.links?.slice(0, 300),
              images: page.metadata?.images?.slice(0, 100),
              headings: page.metadata?.headings?.slice(0, 100),
            })
          }
          if (action === "crawl") {
            if (!args.url) throw new ToolError("url is required", "BAD_INPUT")
            return jsonResult({ pages: await crawlSite(args.url, { maxPages: args.maxPages, maxDepth: args.maxDepth }) })
          }
          if (action === "http") {
            if (!args.url) throw new ToolError("url is required", "BAD_INPUT")
            return jsonResult(await httpRequest(args))
          }
          if (action === "status") {
            return jsonResult(await checkUrl(args.url))
          }
          if (action === "links" || action === "metadata" || action === "tables") {
            const page = await fetchPage(args.url, { timeout: args.timeout || 30_000 })
            const meta = page.metadata || {}
            if (action === "links") {
              return jsonResult({ url: page.finalUrl, domain: new URL(page.finalUrl).hostname, links: filterLinks(meta.links, { query: args.query, domain: new URL(page.finalUrl).hostname }).slice(0, Number(args.limit || 500)) })
            }
            if (action === "tables") return jsonResult({ url: page.finalUrl, tables: meta.tables || [] })
            return jsonResult({ url: page.finalUrl, ...meta, text: truncate(page.text, 20_000) })
          }
          if (action === "sitemap") {
            const base = normalizeUrl(args.url)
            const url = new URL("/sitemap.xml", base).toString()
            const res = await fetchText(url, { timeout: 30_000 })
            const urls = [...res.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1])
            return jsonResult({ sitemap: url, status: res.status, count: urls.length, urls: urls.slice(0, 1000) })
          }
          if (action === "robots") {
            const base = normalizeUrl(args.url)
            const url = new URL("/robots.txt", base).toString()
            const res = await fetchText(url, { timeout: 20_000 })
            return jsonResult({ robots: url, status: res.status, text: truncate(res.text, 30_000), sitemaps: [...res.text.matchAll(/^sitemap:\s*(.+)$/gim)].map((m) => m[1].trim()) })
          }
          if (action === "suggest") {
            return jsonResult({ query: args.query, suggestions: await searchSuggestions(args.query) })
          }
          if (action === "research") {
            const rows = await searchWeb(args.query, { type: args.type || "web", maxResults: Math.max(5, Number(args.maxResults || 8)) })
            const sources = []
            for (const row of rows.slice(0, Number(args.fetchTop || 4))) {
              try {
                const page = await fetchPage(row.url, { timeout: 25_000 })
                sources.push({ title: page.metadata?.title || row.title, url: page.finalUrl, snippet: row.snippet, content: truncate(page.markdown || page.text, 12_000) })
              } catch (error) {
                sources.push({ title: row.title, url: row.url, snippet: row.snippet, error: String(error?.message ?? error) })
              }
            }
            return jsonResult({ query: args.query, results: rows, sources })
          }
          if (action === "download") {
            if (!args.url || !args.output) throw new ToolError("url and output are required", "BAD_INPUT")
            const res = await fetchRaw(args.url, { timeout: 120_000, maxBytes: 200 * 1024 * 1024 })
            const saved = await writeBinaryFile(args.output, res.buffer)
            return jsonResult({ url: res.finalUrl, status: res.status, contentType: res.contentType, ...saved })
          }
          throw new ToolError(`unknown web action: ${action}`, "BAD_INPUT")
        } catch (error) {
          return errorResult(error)
        }
      },
    )
  },
}
