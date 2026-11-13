import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { ToolError, formatBytes, lineDiff, normalizeNewlines, parseCsv, resolvePath, safeName, toCsv, truncate } from "./core.mjs"

let jszipModule
async function JSZipCtor() {
  if (!jszipModule) jszipModule = (await import("jszip")).default
  return jszipModule
}

const escapeXml = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")

function stripXmlTags(value) {
  return String(value ?? "").replace(/<[^>]+>/g, "")
}

function colName(index) {
  let n = Number(index)
  let out = ""
  n += 1
  while (n > 0) {
    const rem = (n - 1) % 26
    out = String.fromCharCode(65 + rem) + out
    n = Math.floor((n - 1) / 26)
  }
  return out
}

function colIndex(name) {
  const letters = String(name || "").replace(/[^A-Z]/gi, "").toUpperCase()
  let total = 0
  for (const ch of letters) total = total * 26 + (ch.charCodeAt(0) - 64)
  return total - 1
}

async function zipFiles(entries, outFile) {
  const JSZip = await JSZipCtor()
  const zip = new JSZip()
  for (const [name, content] of Object.entries(entries)) zip.file(name, content)
  const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } })
  const target = resolvePath(outFile, { createParent: true })
  await fsp.writeFile(target, buf)
  return { path: target, bytes: buf.length }
}

async function readZip(file) {
  const JSZip = await JSZipCtor()
  const target = resolvePath(file, { mustExist: true })
  const buf = await fsp.readFile(target)
  return JSZip.loadAsync(buf)
}

// ---------------------------------------------------------------------------
// DOCX
// ---------------------------------------------------------------------------

function docxParagraph(text, options = {}) {
  const style = options.style ? `<w:pPr><w:pStyle w:val="${escapeXml(options.style)}"/></w:pPr>` : ""
  const bold = options.bold ? "<w:rPr><w:b/></w:rPr>" : ""
  const italic = options.italic ? "<w:rPr><w:i/></w:rPr>" : ""
  const runs = String(text ?? "")
    .split("\n")
    .map((line, index) => `${index ? "<w:br/>" : ""}<w:t xml:space="preserve">${escapeXml(line)}</w:t>`)
    .join("")
  return `<w:p>${style}<w:r>${bold}${italic}${runs}</w:r></w:p>`
}

function docxTable(table) {
  const headers = Array.isArray(table.headers) ? table.headers : []
  const rows = Array.isArray(table.rows) ? table.rows : []
  const all = headers.length ? [headers, ...rows] : rows
  const trs = all
    .map((row) => {
      const cells = (Array.isArray(row) ? row : [row])
        .map((cell) => `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr>${docxParagraph(String(cell ?? ""))}</w:tc>`)
        .join("")
      return `<w:tr>${cells}</w:tr>`
    })
    .join("")
  return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/></w:tblPr>${trs}</w:tbl>`
}

export async function writeDocx(file, blocks, options = {}) {
  const body = []
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (!block) continue
    if (typeof block === "string") {
      body.push(docxParagraph(block))
      continue
    }
    if (block.type === "heading" || block.type === "title") {
      const level = Math.max(1, Math.min(4, Number(block.level || 1)))
      body.push(docxParagraph(block.text || block.content || "", { style: `Heading${level}` }))
    } else if (block.type === "paragraph" || block.type === "text") {
      body.push(docxParagraph(block.text || block.content || "", {}))
    } else if (block.type === "bullets" || block.type === "list") {
      for (const item of block.items || block.text || []) body.push(docxParagraph(`• ${item}`, { style: "ListParagraph" }))
    } else if (block.type === "quote") {
      body.push(docxParagraph(block.text || "", { italic: true }))
    } else if (block.type === "table") {
      body.push(docxTable(block))
    } else if (block.type === "pagebreak") {
      body.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>')
    } else if (block.type === "image") {
      body.push(docxParagraph(`[image: ${block.path || block.alt || "embedded image"}]`))
    } else {
      body.push(docxParagraph(block.text || JSON.stringify(block)))
    }
  }
  if (!body.length) body.push(docxParagraph(""))
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<w:body>${body.join("")}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>`
  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:sz w:val="22"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="240" w:after="120"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="30"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading4"><w:name w:val="heading 4"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="720"/></w:pPr></w:style>
<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:color="auto"/><w:left w:val="single" w:sz="4" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:color="auto"/><w:right w:val="single" w:sz="4" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:color="auto"/></w:tblBorders></w:tblPr></w:style>
</w:styles>`
  const entries = {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`,
    "word/document.xml": documentXml,
    "word/styles.xml": stylesXml,
    "word/_rels/document.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>
`,
    "docProps/core.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:title>${escapeXml(options.title || "Document")}</dc:title><dc:creator>${escapeXml(options.author || "OpenCode Chat")}</dc:creator>
</cp:coreProperties>`,
    "docProps/app.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>OpenCode Chat</Application></Properties>`,
  }
  return await zipFiles(entries, file)
}

export async function readDocx(file) {
  const zip = await readZip(file)
  const doc = zip.file("word/document.xml")
  if (!doc) throw new ToolError("not a valid DOCX file (word/document.xml missing)", "BAD_DOCX")
  const xml = await doc.async("string")
  const paragraphs = []
  const tables = []
  const pRegex = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g
  let match
  while ((match = pRegex.exec(xml))) {
    const inner = match[1]
    const texts = []
    const tRegex = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g
    let t
    while ((t = tRegex.exec(inner))) texts.push(stripXmlTags(unescapeXml(t[1])))
    const styleMatch = inner.match(/<w:pStyle\s+w:val="([^"]+)"/)
    const text = texts.join("")
    if (text.trim()) paragraphs.push({ text, style: styleMatch?.[1] || "" })
  }
  const tableRegex = /<w:tbl\b[^>]*>([\s\S]*?)<\/w:tbl>/g
  while ((match = tableRegex.exec(xml))) {
    const rows = []
    const trRegex = /<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/g
    let tr
    while ((tr = trRegex.exec(match[1]))) {
      const cells = []
      const tcRegex = /<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/g
      let tc
      while ((tc = tcRegex.exec(tr[1]))) {
        const texts = []
        const tRegex = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g
        let t
        while ((t = tRegex.exec(tc[1]))) texts.push(stripXmlTags(unescapeXml(t[1])))
        cells.push(texts.join(""))
      }
      rows.push(cells)
    }
    tables.push(rows)
  }
  return { paragraphs, text: paragraphs.map((p) => p.text).join("\n"), tables }
}

function unescapeXml(value) {
  return String(value || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
}

// ---------------------------------------------------------------------------
// XLSX
// ---------------------------------------------------------------------------

function xlsxCell(ref, value, styleIndex = 0) {
  if (value === null || value === undefined || value === "") return ""
  const style = styleIndex ? ` s="${styleIndex}"` : ""
  if (typeof value === "number" && Number.isFinite(value)) return `<c r="${ref}"${style}><v>${value}</v></c>`
  if (typeof value === "boolean") return `<c r="${ref}"${style} t="b"><v>${value ? 1 : 0}</v></c>`
  const text = String(value)
  if (text.startsWith("=") && text.length > 1) return `<c r="${ref}"${style}><f>${escapeXml(text.slice(1))}</f></c>`
  return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`
}

export async function writeXlsx(file, sheets, options = {}) {
  const list = Array.isArray(sheets) ? sheets : [{ name: options.sheetName || "Sheet1", rows: sheets || [] }]
  if (!list.length) throw new ToolError("at least one sheet is required", "BAD_INPUT")
  const entries = {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${list.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("\n")}
</Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
    "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${list.map((sheet, i) => `<sheet name="${escapeXml(String(sheet.name || `Sheet${i + 1}`).slice(0, 31))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets>
</workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${list.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("\n")}
<Relationship Id="rId${list.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
    "xl/styles.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>
</styleSheet>`,
  }
  list.forEach((sheet, si) => {
    const rows = Array.isArray(sheet.rows) ? sheet.rows : []
    const xmlRows = rows
      .map((row, ri) => {
        const cells = Array.isArray(row) ? row : Object.values(row || {})
        return `<row r="${ri + 1}">${cells.map((value, ci) => xlsxCell(`${colName(ci)}${ri + 1}`, value, ri === 0 && options.boldHeader !== false ? 1 : 0)).join("")}</row>`
      })
      .join("")
    const maxCols = rows.reduce((max, row) => Math.max(max, Array.isArray(row) ? row.length : Object.keys(row || {}).length), 0)
    entries[`xl/worksheets/sheet${si + 1}.xml`] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<dimension ref="A1:${colName(Math.max(0, maxCols - 1))}${Math.max(1, rows.length)}"/>
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetData>${xmlRows}</sheetData>
</worksheet>`
  })
  return await zipFiles(entries, file)
}

export async function readXlsx(file) {
  const zip = await readZip(file)
  const workbook = zip.file("xl/workbook.xml")
  if (!workbook) throw new ToolError("not a valid XLSX file", "BAD_XLSX")
  const wbXml = await workbook.async("string")
  const relsXml = (await zip.file("xl/_rels/workbook.xml.rels")?.async("string")) || ""
  const rels = {}
  const relRegex = /<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"[^>]*\/>/g
  let rel
  while ((rel = relRegex.exec(relsXml))) rels[rel[1]] = rel[2].replace(/^\/?(xl\/)?/, "")
  const sharedXml = (await zip.file("xl/sharedStrings.xml")?.async("string")) || ""
  const shared = []
  const siRegex = /<si\b[^>]*>([\s\S]*?)<\/si>/g
  let si
  while ((si = siRegex.exec(sharedXml))) {
    const texts = []
    const tRegex = /<t\b[^>]*>([\s\S]*?)<\/t>/g
    let t
    while ((t = tRegex.exec(si[1]))) texts.push(unescapeXml(stripXmlTags(t[1])))
    shared.push(texts.join(""))
  }
  const sheets = []
  const sheetRegex = /<sheet\b[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"[^>]*\/>/g
  let sheet
  while ((sheet = sheetRegex.exec(wbXml))) {
    const name = unescapeXml(sheet[1])
    const target = rels[sheet[2]] || `worksheets/sheet${sheets.length + 1}.xml`
    const sheetFile = zip.file(target.startsWith("xl/") ? target : `xl/${target}`) || zip.file(`xl/${target}`)
    if (!sheetFile) {
      sheets.push({ name, rows: [] })
      continue
    }
    const xml = await sheetFile.async("string")
    const rows = []
    const rowRegex = /<row\b[^>]*>([\s\S]*?)<\/row>/g
    let row
    while ((row = rowRegex.exec(xml))) {
      const values = []
      const cellRegex = /<c\b([^>]*)>([\s\S]*?)<\/c>/g
      let cell
      while ((cell = cellRegex.exec(row[1]))) {
        const attrs = cell[1]
        const ref = attrs.match(/\br="([A-Z]+)\d+"/)?.[1] || colName(values.length)
        const type = attrs.match(/\bt="([^"]+)"/)?.[1] || ""
        const inner = cell[2]
        const formula = inner.match(/<f\b[^>]*>([\s\S]*?)<\/f>/)?.[1]
        let value = inner.match(/<v\b[^>]*>([\s\S]*?)<\/v>/)?.[1]
        const inline = inner.match(/<is\b[^>]*>([\s\S]*?)<\/is>/)?.[1]
        if (inline) value = unescapeXml(stripXmlTags(inline))
        else if (type === "s") value = shared[Number(value)] ?? ""
        else if (type === "b") value = value === "1"
        else if (type === "str") value = unescapeXml(stripXmlTags(value || ""))
        else if (value !== undefined) value = Number(value)
        if (formula) value = { formula: unescapeXml(formula), value }
        const index = colIndex(ref)
        while (values.length < index) values.push("")
        values[index] = value
      }
      rows.push(values)
    }
    sheets.push({ name, rows })
  }
  return { sheets }
}

// ---------------------------------------------------------------------------
// PPTX
// ---------------------------------------------------------------------------

export async function writePptx(file, slides, options = {}) {
  const PptxGenJS = (await import("pptxgenjs")).default
  const pptx = new PptxGenJS()
  pptx.layout = options.layout || "LAYOUT_WIDE"
  pptx.author = options.author || "OpenCode Chat"
  pptx.subject = options.subject || ""
  pptx.title = options.title || "Presentation"
  for (const item of Array.isArray(slides) ? slides : []) {
    const slide = pptx.addSlide()
    if (item.background) slide.background = { color: String(item.background).replace("#", "") }
    if (item.title) {
      slide.addText(String(item.title), {
        x: 0.6,
        y: 0.35,
        w: 12,
        h: 0.8,
        fontSize: Number(item.titleSize || 30),
        bold: true,
        color: options.titleColor || "1F2937",
        breakLine: false,
      })
    }
    if (item.subtitle) {
      slide.addText(String(item.subtitle), { x: 0.65, y: 1.1, w: 12, h: 0.5, fontSize: 16, color: "64748B" })
    }
    if (Array.isArray(item.bullets) && item.bullets.length) {
      slide.addText(
        item.bullets.map((text) => ({ text: String(text), options: { bullet: true, breakLine: true } })),
        { x: 0.8, y: item.subtitle ? 1.8 : 1.35, w: 11.8, h: 5.2, fontSize: Number(item.fontSize || 20), color: options.textColor || "334155", breakLine: false },
      )
    }
    if (item.text) {
      slide.addText(String(item.text), { x: 0.8, y: 1.5, w: 11.8, h: 5, fontSize: Number(item.fontSize || 20), color: options.textColor || "334155" })
    }
    if (item.notes) slide.addNotes(String(item.notes))
  }
  const target = resolvePath(file, { createParent: true })
  await pptx.writeFile({ fileName: target })
  const stat = await fsp.stat(target)
  return { path: target, bytes: stat.size, slides: Array.isArray(slides) ? slides.length : 0 }
}

export async function readPptx(file) {
  const zip = await readZip(file)
  const names = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/slide(\d+)/)[1]) - Number(b.match(/slide(\d+)/)[1]))
  const slides = []
  for (const name of names) {
    const xml = await zip.file(name).async("string")
    const texts = []
    const tRegex = /<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g
    let t
    while ((t = tRegex.exec(xml))) texts.push(unescapeXml(stripXmlTags(t[1])))
    const notesFile = zip.file(name.replace("slides/slide", "notesSlides/notesSlide"))
    const notes = notesFile ? await notesFile.async("string") : ""
    const noteTexts = []
    const nRegex = /<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g
    let n
    while ((n = nRegex.exec(notes))) noteTexts.push(stripXmlTags(unescapeXml(n[1])))
    slides.push({ index: slides.length + 1, text: texts.join("\n"), notes: noteTexts.join("\n") })
  }
  return { slides }
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

export async function pdfRead(file, options = {}) {
  const target = resolvePath(file, { mustExist: true })
  const data = new Uint8Array(await fsp.readFile(target))
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs")
  const doc = await pdfjs.getDocument({ data, useWorkerFetch: false, isEvalSupported: false, disableFontFace: true }).promise
  const numPages = doc.numPages
  const maxPages = Math.min(numPages, Number(options.maxPages || numPages))
  const pages = []
  let fullText = ""
  for (let i = 1; i <= maxPages; i++) {
    const page = await doc.getPage(i)
    const content = await page.getTextContent()
    const text = content.items.map((item) => ("str" in item ? item.str : "")).join(" ")
    pages.push({ page: i, text: text.replace(/\s+/g, " ").trim() })
    fullText += `\n\n--- Page ${i} ---\n${text}`
  }
  const meta = await doc.getMetadata().catch(() => null)
  try {
    if (typeof doc.destroy === "function") await doc.destroy()
    else if (typeof doc._transport?.destroy === "function") await doc._transport.destroy()
  } catch {}
  return { pages, text: fullText.trim(), numPages, metadata: meta?.info || null }
}

export async function pdfCreate(file, input, options = {}) {
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib")
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const pages = Array.isArray(input) ? input : [input]
  const width = Number(options.width || 595.28)
  const height = Number(options.height || 841.89)
  const fontSize = Number(options.fontSize || 11)
  const margin = Number(options.margin || 48)
  const lineHeight = fontSize * 1.4
  for (const pageInput of pages) {
    const page = doc.addPage([width, height])
    const text = typeof pageInput === "string" ? pageInput : pageInput?.text || ""
    const lines = []
    for (const rawLine of normalizeNewlines(text).split("\n")) {
      let current = ""
      for (const word of rawLine.split(/\s+/)) {
        const candidate = current ? `${current} ${word}` : word
        if (font.widthOfTextAtSize(candidate, fontSize) > width - margin * 2 && current) {
          lines.push(current)
          current = word
        } else current = candidate
      }
      lines.push(current)
    }
    let y = height - margin
    for (const line of lines) {
      if (y < margin) {
        const next = doc.addPage([width, height])
        y = height - margin
        next.drawText(line, { x: margin, y, size: fontSize, font, color: rgb(0.1, 0.12, 0.16) })
      } else {
        page.drawText(line, { x: margin, y, size: fontSize, font, color: rgb(0.1, 0.12, 0.16) })
      }
      y -= lineHeight
    }
  }
  const bytes = await doc.save()
  const target = resolvePath(file, { createParent: true })
  await fsp.writeFile(target, bytes)
  return { path: target, bytes: bytes.length, pages: doc.getPageCount() }
}

export async function pdfEdit(file, outFile, options = {}) {
  const { PDFDocument, degrees } = await import("pdf-lib")
  const target = resolvePath(file, { mustExist: true })
  const doc = await PDFDocument.load(await fsp.readFile(target))
  if (options.removePages?.length) {
    const list = options.removePages.map((n) => Number(n) - 1).filter((n) => n >= 0 && n < doc.getPageCount()).sort((a, b) => b - a)
    for (const index of list) doc.removePage(index)
  }
  if (options.rotate) {
    for (const page of doc.getPages()) page.setRotation(degrees((page.getRotation().angle + Number(options.rotate)) % 360))
  }
  const out = resolvePath(outFile || target.replace(/\.pdf$/i, "-edited.pdf"), { createParent: true })
  await fsp.writeFile(out, await doc.save())
  return { path: out, pages: doc.getPageCount(), bytes: (await fsp.stat(out)).size }
}

export async function pdfMerge(files, outFile) {
  const { PDFDocument } = await import("pdf-lib")
  const merged = await PDFDocument.create()
  for (const file of files || []) {
    const doc = await PDFDocument.load(await fsp.readFile(resolvePath(file, { mustExist: true })))
    const pages = await merged.copyPages(doc, doc.getPageIndices())
    for (const page of pages) merged.addPage(page)
  }
  const out = resolvePath(outFile, { createParent: true })
  await fsp.writeFile(out, await merged.save())
  return { path: out, pages: merged.getPageCount(), bytes: (await fsp.stat(out)).size }
}

export async function pdfInfo(file) {
  const { PDFDocument } = await import("pdf-lib")
  const doc = await PDFDocument.load(await fsp.readFile(resolvePath(file, { mustExist: true })))
  return {
    pages: doc.getPageCount(),
    title: doc.getTitle(),
    author: doc.getAuthor(),
    subject: doc.getSubject(),
    creator: doc.getCreator(),
    producer: doc.getProducer(),
    creationDate: doc.getCreationDate(),
    modificationDate: doc.getModificationDate(),
    sizes: doc.getPages().map((page, i) => ({ page: i + 1, width: page.getWidth(), height: page.getHeight(), rotation: page.getRotation().angle })),
  }
}

// ---------------------------------------------------------------------------
// Markdown / HTML / archives / generic conversion
// ---------------------------------------------------------------------------

export async function markdownToHtml(markdown, options = {}) {
  const { marked } = await import("marked")
  const html = await marked.parse(String(markdown || ""), { gfm: true, breaks: false })
  if (options.fullPage) {
    return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeXml(options.title || "Document")}</title><style>body{font:16px/1.7 system-ui,Segoe UI,Tahoma,sans-serif;max-width:900px;margin:40px auto;padding:0 20px;color:#1f2937}pre{background:#f3f4f6;padding:12px;border-radius:8px;overflow:auto}code{font-family:Consolas,monospace}table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:6px}blockquote{border-left:4px solid #ddd;margin-left:0;padding-left:16px;color:#555}</style></head><body>${html}</body></html>`
  }
  return html
}

export async function htmlToMarkdown(html) {
  const TurndownService = (await import("turndown")).default
  return new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" }).turndown(String(html || ""))
}

export async function archiveCreate(outFile, entries) {
  const JSZip = await JSZipCtor()
  const zip = new JSZip()
  const list = Array.isArray(entries) ? entries : []
  for (const entry of list) {
    if (typeof entry === "string") {
      const target = resolvePath(entry, { mustExist: true })
      const stat = await fsp.stat(target)
      if (stat.isDirectory()) {
        const files = await import("./core.mjs").then(({ walkFiles }) => walkFiles(target, { maxFiles: 5000 }))
        for (const file of files) zip.file(path.relative(target, file.path).replace(/\\/g, "/"), await fsp.readFile(file.path))
      } else {
        zip.file(path.basename(target), await fsp.readFile(target))
      }
    } else if (entry && typeof entry === "object" && entry.path) {
      zip.file(String(entry.name || path.basename(entry.path)).replace(/\\/g, "/"), await fsp.readFile(resolvePath(entry.path, { mustExist: true })))
    }
  }
  const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" })
  const target = resolvePath(outFile, { createParent: true })
  await fsp.writeFile(target, buf)
  return { path: target, bytes: buf.length, entries: Object.keys(zip.files).length }
}

export async function archiveExtract(file, outDir) {
  const zip = await readZip(file)
  const target = resolvePath(outDir, { createParent: true })
  await fsp.mkdir(target, { recursive: true })
  let count = 0
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue
    const safe = path.normalize(name).replace(/^(\.\.(\/|\\|$))+/, "")
    const destination = path.join(target, safe)
    if (!destination.startsWith(target + path.sep)) throw new ToolError(`unsafe archive path: ${name}`, "ZIP_SLIP")
    await fsp.mkdir(path.dirname(destination), { recursive: true })
    await fsp.writeFile(destination, await entry.async("nodebuffer"))
    count += 1
  }
  return { path: target, files: count }
}

export async function documentConvert(input, outFile, options = {}) {
  const source = resolvePath(input, { mustExist: true })
  const ext = path.extname(source).toLowerCase()
  const dest = path.extname(outFile).toLowerCase()
  if (ext === ".docx") {
    const doc = await readDocx(source)
    if (dest === ".md") {
      const md = doc.paragraphs.map((p) => (/^Heading/.test(p.style) ? `${"#".repeat(Number(p.style.replace(/\D/g, "")) || 1)} ${p.text}` : p.text)).join("\n\n")
      await fsp.writeFile(resolvePath(outFile, { createParent: true }), md, "utf8")
      return { path: resolvePath(outFile), format: "markdown", bytes: Buffer.byteLength(md) }
    }
    if (dest === ".txt") {
      await fsp.writeFile(resolvePath(outFile, { createParent: true }), doc.text, "utf8")
      return { path: resolvePath(outFile), format: "text", bytes: Buffer.byteLength(doc.text) }
    }
    if (dest === ".html") {
      const html = await markdownToHtml(doc.paragraphs.map((p) => (/^Heading/.test(p.style) ? `${"#".repeat(Number(p.style.replace(/\D/g, "")) || 1)} ${p.text}` : p.text)).join("\n\n"), { fullPage: true })
      await fsp.writeFile(resolvePath(outFile, { createParent: true }), html, "utf8")
      return { path: resolvePath(outFile), format: "html", bytes: Buffer.byteLength(html) }
    }
  }
  if (ext === ".xlsx" && [".csv", ".json"].includes(dest)) {
    const data = await readXlsx(source)
    const rows = data.sheets[0]?.rows || []
    const headers = rows[0] || []
    const objects = rows.slice(1).map((row) => Object.fromEntries(headers.map((h, i) => [String(h || colName(i)), row[i] ?? ""])))
    const text = dest === ".json" ? JSON.stringify(objects, null, 2) : toCsv(objects, headers)
    await fsp.writeFile(resolvePath(outFile, { createParent: true }), text, "utf8")
    return { path: resolvePath(outFile), format: dest.slice(1), bytes: Buffer.byteLength(text) }
  }
  if (ext === ".pdf" && [".txt", ".md"].includes(dest)) {
    const pdf = await pdfRead(source)
    await fsp.writeFile(resolvePath(outFile, { createParent: true }), pdf.text, "utf8")
    return { path: resolvePath(outFile), format: dest.slice(1), bytes: Buffer.byteLength(pdf.text) }
  }
  if (ext === ".md" && [".html", ".docx", ".pdf", ".txt"].includes(dest)) {
    const md = await fsp.readFile(source, "utf8")
    if (dest === ".html") {
      const html = await markdownToHtml(md, { fullPage: true })
      await fsp.writeFile(resolvePath(outFile, { createParent: true }), html, "utf8")
      return { path: resolvePath(outFile), format: "html", bytes: Buffer.byteLength(html) }
    }
    if (dest === ".txt") {
      const text = md.replace(/[#*_>`~\-]/g, "")
      await fsp.writeFile(resolvePath(outFile, { createParent: true }), text, "utf8")
      return { path: resolvePath(outFile), format: "text", bytes: Buffer.byteLength(text) }
    }
    if (dest === ".docx") {
      const blocks = md.split(/\n{2,}/).map((para) => {
        const heading = para.match(/^(#{1,4})\s+(.*)$/)
        if (heading) return { type: "heading", level: heading[1].length, text: heading[2] }
        if (/^[-*]\s+/m.test(para)) return { type: "bullets", items: para.split(/\n/).map((l) => l.replace(/^[-*]\s+/, "")) }
        return { type: "paragraph", text: para.replace(/\n/g, " ") }
      })
      return await writeDocx(outFile, blocks)
    }
  }
  throw new ToolError(`conversion ${ext} -> ${dest} is not supported by the local converter`, "UNSUPPORTED")
}

export function summarizeText(text, options = {}) {
  const maxSentences = Math.max(1, Math.min(30, Number(options.maxSentences || 8)))
  const clean = normalizeNewlines(String(text || "")).replace(/\s+/g, " ").trim()
  const sentences = clean.match(/[^.!?؟]+[.!?؟]+|[^.!?؟]+$/g) || [clean]
  const stop = new Set("the a an and or but if then of to in on for with as at by from is are was were be been being this that these those it its we you they he she i not no do does did have has had will would can could should may might".split(" "))
  const freq = new Map()
  for (const word of clean.toLowerCase().match(/[a-z0-9\u0600-\u06ff]+/g) || []) {
    if (word.length < 3 || stop.has(word)) continue
    freq.set(word, (freq.get(word) || 0) + 1)
  }
  const scored = sentences.map((sentence, index) => {
    const words = sentence.toLowerCase().match(/[a-z0-9\u0600-\u06ff]+/g) || []
    const score = words.reduce((sum, word) => sum + (freq.get(word) || 0), 0) / Math.max(4, words.length)
    return { sentence: sentence.trim(), score, index }
  })
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, maxSentences)
    .sort((a, b) => a.index - b.index)
    .map((s) => s.sentence)
    .join(" ")
}

export function classifyText(text) {
  const categories = {
    finance: ["invoice", "payment", "revenue", "budget", "bank", "tax", "price", "cost", "profit", "account"],
    legal: ["contract", "agreement", "clause", "liability", "court", "law", "legal", "terms", "privacy"],
    technical: ["api", "server", "code", "install", "error", "database", "network", "config", "function", "bug"],
    marketing: ["campaign", "customer", "brand", "seo", "social", "audience", "content", "conversion"],
    hr: ["employee", "salary", "leave", "recruit", "interview", "policy", "benefit", "position"],
    medical: ["patient", "diagnosis", "treatment", "medicine", "clinic", "symptom", "dose"],
    education: ["student", "course", "lesson", "exam", "teacher", "school", "assignment"],
  }
  const hay = String(text || "").toLowerCase()
  return Object.entries(categories)
    .map(([category, words]) => ({ category, score: words.reduce((sum, word) => sum + (hay.split(word).length - 1), 0) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
}

export function compareTexts(a, b) {
  const diff = lineDiff(a, b)
  return { ...diff, similarity: 1 - (diff.added + diff.removed) / Math.max(1, Math.max(String(a).split("\n").length, String(b).split("\n").length)) }
}

export { colName, colIndex, escapeXml }
