import fsp from "node:fs/promises"
import path from "node:path"
import {
  ToolError,
  errorResult,
  jsonResult,
  parseBool,
  resolvePath,
  textResult,
  truncate,
} from "../lib/core.mjs"
import { getPage } from "../lib/browser.mjs"
import { htmlMetadata, htmlToMarkdown as webHtmlToMarkdown } from "../lib/http.mjs"
import {
  archiveCreate,
  archiveExtract,
  classifyText,
  compareTexts,
  documentConvert,
  htmlToMarkdown,
  markdownToHtml,
  pdfCreate,
  pdfEdit,
  pdfInfo,
  pdfMerge,
  pdfRead,
  readDocx,
  readPptx,
  readXlsx,
  summarizeText,
  writeDocx,
  writePptx,
  writeXlsx,
} from "../lib/office.mjs"

async function readDocumentFile(file, options = {}) {
  const target = resolvePath(file, { mustExist: true })
  const ext = path.extname(target).toLowerCase()
  if (ext === ".pdf") return { path: target, type: "pdf", ...(await pdfRead(target, options)) }
  if (ext === ".docx") return { path: target, type: "docx", ...(await readDocx(target)) }
  if (ext === ".xlsx" || ext === ".xlsm") return { path: target, type: "xlsx", ...(await readXlsx(target)) }
  if (ext === ".pptx") return { path: target, type: "pptx", ...(await readPptx(target)) }
  if ([".html", ".htm"].includes(ext)) {
    const html = await fsp.readFile(target, "utf8")
    return { path: target, type: "html", html: truncate(html, 100_000), text: await htmlToMarkdown(html), metadata: await htmlMetadata(html, `file:///${target.replace(/\\/g, "/")}`) }
  }
  if ([".md", ".markdown", ".txt", ".json", ".csv", ".xml", ".yaml", ".yml"].includes(ext)) {
    const text = await fsp.readFile(target, "utf8")
    return { path: target, type: ext.slice(1), text: truncate(text, 100_000), bytes: Buffer.byteLength(text) }
  }
  throw new ToolError(`unsupported document type: ${ext || "(no extension)"}`, "UNSUPPORTED")
}

async function htmlToPdf(html, output, options = {}) {
  const target = resolvePath(output, { createParent: true })
  const page = await getPage("document-pdf", { viewport: { width: 1200, height: 1600 } })
  await page.setContent(String(html), { waitUntil: "networkidle2", timeout: 60_000 })
  await page.pdf({ path: target, format: options.format || "A4", printBackground: true, margin: options.margin || { top: "18mm", bottom: "18mm", left: "16mm", right: "16mm" } })
  return { path: target, bytes: (await fsp.stat(target)).size }
}

export const documentsTool = {
  register(server, { z }) {
    server.registerTool(
      "documents",
      {
        title: "Documents, PDF and office files",
        description:
          "Read, create and convert PDF, DOCX, XLSX, PPTX, Markdown, HTML, CSV, JSON, YAML and ZIP files. Actions: read, create_pdf, create_docx, create_xlsx, create_pptx, convert, pdf_info, merge_pdf, edit_pdf, summarize, classify, compare, markdown_to_html, html_to_markdown, archive_create, archive_extract. Use this automatically whenever a task mentions a document, report, spreadsheet, slide deck, PDF or archive.",
        inputSchema: {
          action: z.enum([
            "read",
            "create_pdf",
            "create_docx",
            "create_xlsx",
            "create_pptx",
            "convert",
            "pdf_info",
            "merge_pdf",
            "edit_pdf",
            "summarize",
            "classify",
            "compare",
            "markdown_to_html",
            "html_to_markdown",
            "archive_create",
            "archive_extract",
          ]),
          path: z.string().optional().describe("Input file."),
          path2: z.string().optional().describe("Second file or output path depending on action."),
          output: z.string().optional().describe("Output file."),
          content: z.string().optional().describe("Markdown/HTML/text content."),
          title: z.string().optional(),
          html: z.string().optional().describe("HTML content for create_pdf."),
          blocks: z.any().optional().describe("DOCX blocks array, e.g. [{type:'heading',text:'Title',level:1},{type:'paragraph',text:'...'}]."),
          sheets: z.any().optional().describe("XLSX sheets: [{name,rows:[[...]]}]."),
          slides: z.any().optional().describe("PPTX slides: [{title,bullets,notes}]."),
          rows: z.any().optional().describe("Rows for spreadsheet generation."),
          files: z.array(z.string()).optional().describe("Files to merge/archive."),
          entries: z.any().optional().describe("Archive entries: paths or {path,name}."),
          maxPages: z.number().int().positive().optional(),
          maxSentences: z.number().int().positive().optional(),
          rotate: z.number().optional(),
          removePages: z.array(z.number().int()).optional(),
          confirm: z.boolean().optional(),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      },
      async (args) => {
        try {
          const action = args.action
          if (action === "read") {
            return jsonResult(await readDocumentFile(args.path, { maxPages: args.maxPages }))
          }
          if (action === "create_pdf") {
            if (!args.output) throw new ToolError("output is required", "BAD_INPUT")
            if (args.html) return jsonResult(await htmlToPdf(args.html, args.output))
            const input = args.content || args.blocks || args.path
            return jsonResult(await pdfCreate(args.output, input || "", {}))
          }
          if (action === "create_docx") {
            if (!args.output) throw new ToolError("output is required", "BAD_INPUT")
            let blocks = args.blocks
            if (typeof blocks === "string") {
              try {
                blocks = JSON.parse(blocks)
              } catch {
                blocks = [{ type: "paragraph", text: blocks }]
              }
            }
            if (!blocks && args.content) {
              blocks = String(args.content).split(/\n{2,}/).map((para) => {
                const heading = para.match(/^(#{1,4})\s+(.*)$/)
                if (heading) return { type: "heading", level: heading[1].length, text: heading[2] }
                if (/^[-*]\s+/m.test(para)) return { type: "bullets", items: para.split(/\n/).map((line) => line.replace(/^[-*]\s+/, "")) }
                return { type: "paragraph", text: para.replace(/\n/g, " ") }
              })
            }
            return jsonResult(await writeDocx(args.output, blocks || [], { title: args.title }))
          }
          if (action === "create_xlsx") {
            if (!args.output) throw new ToolError("output is required", "BAD_INPUT")
            let sheets = args.sheets
            if (typeof sheets === "string") sheets = JSON.parse(sheets)
            if (!sheets) {
              let rows = args.rows
              if (typeof rows === "string") rows = JSON.parse(rows)
              sheets = [{ name: args.title || "Sheet1", rows: rows || [] }]
            }
            return jsonResult(await writeXlsx(args.output, sheets, {}))
          }
          if (action === "create_pptx") {
            if (!args.output) throw new ToolError("output is required", "BAD_INPUT")
            let slides = args.slides
            if (typeof slides === "string") slides = JSON.parse(slides)
            return jsonResult(await writePptx(args.output, slides || [], { title: args.title }))
          }
          if (action === "convert") {
            if (!args.output || !args.path) throw new ToolError("path and output are required", "BAD_INPUT")
            return jsonResult(await documentConvert(args.path, args.output))
          }
          if (action === "pdf_info") return jsonResult(await pdfInfo(args.path))
          if (action === "merge_pdf") {
            if (!args.output) throw new ToolError("output is required", "BAD_INPUT")
            return jsonResult(await pdfMerge(args.files || args.path, args.output))
          }
          if (action === "edit_pdf") {
            return jsonResult(await pdfEdit(args.path, args.output || args.path2, { rotate: args.rotate, removePages: args.removePages }))
          }
          if (action === "summarize") {
            const doc = await readDocumentFile(args.path)
            return textResult(summarizeText(doc.text || "", { maxSentences: args.maxSentences || 8 }))
          }
          if (action === "classify") {
            const doc = await readDocumentFile(args.path)
            return jsonResult(classifyText(doc.text || ""))
          }
          if (action === "compare") {
            if (!args.path || !args.path2) throw new ToolError("path and path2 are required", "BAD_INPUT")
            const a = await readDocumentFile(args.path)
            const b = await readDocumentFile(args.path2)
            return jsonResult(compareTexts(a.text || "", b.text || ""))
          }
          if (action === "markdown_to_html") {
            const html = await markdownToHtml(args.content || "", { fullPage: true, title: args.title })
            if (args.output) {
              await fsp.writeFile(resolvePath(args.output, { createParent: true }), html, "utf8")
              return jsonResult({ path: resolvePath(args.output), bytes: Buffer.byteLength(html) })
            }
            return textResult(html)
          }
          if (action === "html_to_markdown") {
            let html = args.html || args.content
            if (!html && args.path) html = await fsp.readFile(resolvePath(args.path, { mustExist: true }), "utf8")
            const md = await htmlToMarkdown(html || "")
            return args.output ? jsonResult({ path: resolvePath(args.output, { createParent: true }), markdown: md }) : textResult(md)
          }
          if (action === "archive_create") {
            if (!args.output) throw new ToolError("output is required", "BAD_INPUT")
            return jsonResult(await archiveCreate(args.output, args.entries || args.files || []))
          }
          if (action === "archive_extract") {
            if (!args.path || !args.output) throw new ToolError("path and output are required", "BAD_INPUT")
            return jsonResult(await archiveExtract(args.path, args.output))
          }
          throw new ToolError(`unknown documents action: ${action}`, "BAD_INPUT")
        } catch (error) {
          return errorResult(error)
        }
      },
    )
  },
}
