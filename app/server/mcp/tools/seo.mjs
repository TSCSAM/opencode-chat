import { ToolError, errorResult, jsonResult } from "../lib/core.mjs"
import { brokenLinks, coreWebVitals, seoAudit, seoKeywords, serpAnalysis, siteStatus } from "../lib/seo.mjs"

export const seoTool = {
  register(server, { z }) {
    server.registerTool(
      "seo",
      {
        title: "SEO and site audits",
        description:
          "Audit a website (title/meta/headings/images/links/schema/robots/sitemap), inspect broken links, measure Core Web Vitals, research keywords and suggestions, analyze SERP competitors, and check uptime/status. Use this automatically for SEO, website quality, performance or content-gap work.",
        inputSchema: {
          action: z.enum(["audit", "keywords", "serp", "vitals", "broken_links", "status"]),
          url: z.string().optional(),
          query: z.string().optional(),
          maxLinks: z.number().int().positive().optional(),
          maxResults: z.number().int().positive().optional(),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      },
      async (args) => {
        try {
          if (args.action === "audit") return jsonResult(await seoAudit(args.url))
          if (args.action === "keywords") return jsonResult(await seoKeywords(args.query))
          if (args.action === "serp") return jsonResult(await serpAnalysis(args.query, args.maxResults))
          if (args.action === "vitals") return jsonResult(await coreWebVitals(args.url))
          if (args.action === "broken_links") return jsonResult(await brokenLinks(args.url, { maxLinks: args.maxLinks }))
          if (args.action === "status") return jsonResult(await siteStatus(args.url))
          throw new ToolError(`unknown seo action: ${args.action}`, "BAD_INPUT")
        } catch (error) {
          return errorResult(error)
        }
      },
    )
  },
}
