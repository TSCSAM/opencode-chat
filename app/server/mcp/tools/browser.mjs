import {
  ToolError,
  errorResult,
  imageResult,
  jsonResult,
} from "../lib/core.mjs"
import {
  getPage,
  interact,
  navigate,
  screenshot,
  snapshot,
} from "../lib/browser.mjs"

export const browserTool = {
  register(server, { z }) {
    server.registerTool(
      "browser",
      {
        title: "Browser automation",
        description:
          "Drive a real Chromium browser: open pages, click, type, fill forms, upload/download, scroll, hover, select, drag, wait, evaluate JavaScript, take screenshots/PDFs, read accessibility trees and performance metrics. Use this automatically for JavaScript-heavy sites, UI testing, visual checks, login flows or anything that needs interaction beyond a simple fetch.",
        inputSchema: {
          action: z.enum([
            "navigate",
            "snapshot",
            "screenshot",
            "click",
            "type",
            "press",
            "scroll",
            "hover",
            "select",
            "upload",
            "wait",
            "evaluate",
            "form_fill",
            "drag",
            "pdf",
            "set_viewport",
            "tabs",
            "new_tab",
            "close",
            "cookies",
            "performance",
            "accessibility",
            "download",
          ]),
          url: z.string().optional(),
          selector: z.string().optional(),
          selector2: z.string().optional(),
          text: z.string().optional().describe("Text to type, option value, JavaScript expression, or body text."),
          keys: z.string().optional().describe("Keyboard keys, e.g. Enter or Control+A."),
          fields: z.any().optional().describe("Form fields object: selector -> value."),
          session: z.string().optional().describe("Named browser page to reuse."),
          path: z.string().optional().describe("Output path or upload source path."),
          format: z.enum(["text", "html", "links", "A4", "Letter"]).optional(),
          x: z.number().optional(),
          y: z.number().optional(),
          x2: z.number().optional(),
          y2: z.number().optional(),
          width: z.number().optional(),
          height: z.number().optional(),
          scale: z.number().optional(),
          amount: z.number().optional(),
          delay: z.number().optional(),
          timeout: z.number().optional(),
          fullPage: z.boolean().optional(),
          clear: z.boolean().optional(),
          waitFor: z.string().optional(),
          waitUntil: z.enum(["load", "domcontentloaded", "networkidle0", "networkidle2"]).optional(),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      },
      async (args) => {
        try {
          if (args.action === "navigate") {
            if (!args.url) throw new ToolError("url is required", "BAD_INPUT")
            return jsonResult(await navigate(args))
          }
          if (args.action === "snapshot") {
            return jsonResult(await snapshot(args))
          }
          if (args.action === "screenshot") {
            const result = await screenshot(args)
            return imageResult(result.buffer, "image/png", `${result.title || "Screenshot"} — ${result.url}${result.saved ? `\nSaved: ${result.saved}` : ""}`)
          }
          if (args.action === "performance" || args.action === "accessibility" || args.action === "tabs" || args.action === "new_tab" || args.action === "close") {
            return jsonResult(await interact(args))
          }
          return jsonResult(await interact(args))
        } catch (error) {
          return errorResult(error)
        }
      },
    )
  },
}
