import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { ToolError, escapeHtml, parseCsv, resolvePath, toCsv } from "./core.mjs"

function rowsToObjects(headers, rows) {
  return rows.map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ""])))
}

export function csvRead(args) {
  if (args.text) return parseCsv(String(args.text), args.delimiter)
  const target = resolvePath(args.path, { mustExist: true })
  return fsp.readFile(target, "utf8").then((text) => ({ ...parseCsv(text, args.delimiter), path: target }))
}

export async function csvWrite(args) {
  const target = resolvePath(args.output, { createParent: true })
  let rows = args.rows
  if (typeof rows === "string") {
    try {
      rows = JSON.parse(rows)
    } catch {
      rows = parseCsv(rows).rows
    }
  }
  if (!Array.isArray(rows)) throw new ToolError("rows must be an array", "BAD_INPUT")
  const text = toCsv(rows, args.headers)
  await fsp.writeFile(target, text, "utf8")
  return { path: target, rows: rows.length, bytes: Buffer.byteLength(text) }
}

export function jsonQuery(value, query) {
  const expr = String(query || "$").trim()
  if (expr === "$" || expr === "") return value
  const parts = expr.replace(/^\$\.?/, "").replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean)
  let current = value
  for (const key of parts) {
    if (current === undefined || current === null) return null
    current = current[key]
  }
  return current
}

export function stats(values) {
  const nums = values
    .map((value) => (typeof value === "number" ? value : Number(String(value).replace(/[$,%\s]/g, ""))))
    .filter((value) => Number.isFinite(value))
  if (!nums.length) return { count: 0, error: "no numeric values" }
  const sorted = [...nums].sort((a, b) => a - b)
  const n = nums.length
  const sum = nums.reduce((a, b) => a + b, 0)
  const mean = sum / n
  const variance = nums.reduce((a, b) => a + (b - mean) ** 2, 0) / n
  const percentile = (p) => {
    const index = (n - 1) * p
    const lo = Math.floor(index)
    const hi = Math.ceil(index)
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (index - lo)
  }
  const counts = new Map()
  for (const value of nums) counts.set(value, (counts.get(value) || 0) + 1)
  const mode = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
  const q1 = percentile(0.25)
  const q3 = percentile(0.75)
  return {
    count: n,
    sum,
    mean,
    median: percentile(0.5),
    mode,
    min: sorted[0],
    max: sorted.at(-1),
    range: sorted.at(-1) - sorted[0],
    variance,
    stddev: Math.sqrt(variance),
    q1,
    q3,
    iqr: q3 - q1,
    p90: percentile(0.9),
    p95: percentile(0.95),
    p99: percentile(0.99),
  }
}

export function correlation(xs, ys) {
  const pairs = xs.map((x, i) => [Number(x), Number(ys[i])]).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y))
  if (pairs.length < 2) return null
  const mx = pairs.reduce((a, [x]) => a + x, 0) / pairs.length
  const my = pairs.reduce((a, [, y]) => a + y, 0) / pairs.length
  let numerator = 0
  let dx = 0
  let dy = 0
  for (const [x, y] of pairs) {
    numerator += (x - mx) * (y - my)
    dx += (x - mx) ** 2
    dy += (y - my) ** 2
  }
  return dx && dy ? numerator / Math.sqrt(dx * dy) : null
}

export function linearRegression(xs, ys) {
  const pairs = xs.map((x, i) => [Number(x), Number(ys[i])]).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y))
  if (pairs.length < 2) return null
  const n = pairs.length
  const sx = pairs.reduce((a, [x]) => a + x, 0)
  const sy = pairs.reduce((a, [, y]) => a + y, 0)
  const sxx = pairs.reduce((a, [x]) => a + x * x, 0)
  const sxy = pairs.reduce((a, [x, y]) => a + x * y, 0)
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx)
  const intercept = (sy - slope * sx) / n
  return { slope, intercept, predict: (x) => intercept + slope * x, r2: correlation(xs, ys) ** 2 }
}

export function movingAverage(values, window = 3) {
  const nums = values.map(Number).filter(Number.isFinite)
  const out = []
  for (let i = 0; i < nums.length; i++) {
    const slice = nums.slice(Math.max(0, i - window + 1), i + 1)
    out.push(slice.reduce((a, b) => a + b, 0) / slice.length)
  }
  return out
}

export function forecast(values, periods = 3) {
  const nums = values.map(Number).filter(Number.isFinite)
  const regression = linearRegression(nums.map((_, i) => i), nums)
  if (!regression) return []
  return Array.from({ length: Math.max(1, Math.min(60, periods)) }, (_, i) => regression.predict(nums.length + i))
}

export function chartSvg(type, labels, series, options = {}) {
  const width = Number(options.width || 900)
  const height = Number(options.height || 520)
  const padding = { left: 60, right: 30, top: 40, bottom: 60 }
  const plotW = width - padding.left - padding.right
  const plotH = height - padding.top - padding.bottom
  const all = series.flatMap((s) => s.values.map(Number)).filter(Number.isFinite)
  const min = Math.min(0, ...all)
  const max = Math.max(1, ...all)
  const x = (i) => padding.left + (labels.length <= 1 ? plotW / 2 : (i / (labels.length - 1)) * plotW)
  const y = (v) => padding.top + plotH - ((v - min) / (max - min || 1)) * plotH
  const colors = ["#2563eb", "#dc2626", "#16a34a", "#d97706", "#7c3aed", "#0891b2"]
  const esc = escapeHtml
  let body = ""
  if (type === "pie" || type === "doughnut") {
    const values = series[0]?.values.map(Number) || []
    const total = values.reduce((a, b) => a + Math.max(0, b), 0) || 1
    let angle = -Math.PI / 2
    const cx = width / 2
    const cy = height / 2
    const r = Math.min(plotW, plotH) / 2
    values.forEach((value, i) => {
      const slice = (Math.max(0, value) / total) * Math.PI * 2
      const x1 = cx + r * Math.cos(angle)
      const y1 = cy + r * Math.sin(angle)
      const x2 = cx + r * Math.cos(angle + slice)
      const y2 = cy + r * Math.sin(angle + slice)
      const large = slice > Math.PI ? 1 : 0
      body += `<path d="M${cx},${cy} L${x1},${y1} A${r},${r} 0 ${large} 1 ${x2},${y2} Z" fill="${colors[i % colors.length]}" opacity="0.9"/>`
      body += `<text x="${cx + r * 0.7 * Math.cos(angle + slice / 2)}" y="${cy + r * 0.7 * Math.sin(angle + slice / 2)}" fill="#fff" font-size="13" text-anchor="middle">${esc(labels[i] || "")}</text>`
      angle += slice
    })
  } else {
    // grid and axes
    for (let i = 0; i <= 5; i++) {
      const gy = padding.top + (i / 5) * plotH
      const value = max - (i / 5) * (max - min)
      body += `<line x1="${padding.left}" y1="${gy}" x2="${width - padding.right}" y2="${gy}" stroke="#e5e7eb"/>`
      body += `<text x="${padding.left - 10}" y="${gy + 4}" fill="#6b7280" font-size="12" text-anchor="end">${value.toFixed(value >= 10 ? 0 : 1)}</text>`
    }
    labels.forEach((label, i) => {
      const lx = x(i)
      body += `<text x="${lx}" y="${height - 25}" fill="#6b7280" font-size="12" text-anchor="middle">${esc(String(label).slice(0, 18))}</text>`
    })
    series.forEach((s, si) => {
      const values = s.values.map(Number)
      const color = s.color || colors[si % colors.length]
      if (type === "bar") {
        const barWidth = Math.max(3, (plotW / Math.max(1, labels.length)) * 0.65 / Math.max(1, series.length))
        values.forEach((value, i) => {
          const bx = x(i) - (barWidth * series.length) / 2 + si * barWidth
          const by = y(value)
          body += `<rect x="${bx}" y="${by}" width="${barWidth - 2}" height="${padding.top + plotH - by}" fill="${color}" rx="2"/>`
        })
      } else if (type === "scatter") {
        values.forEach((value, i) => {
          body += `<circle cx="${x(i)}" cy="${y(value)}" r="4" fill="${color}"/>`
        })
      } else {
        const points = values.map((value, i) => `${x(i)},${y(value)}`).join(" ")
        body += `<polyline fill="none" stroke="${color}" stroke-width="2.5" points="${points}"/>`
        values.forEach((value, i) => {
          body += `<circle cx="${x(i)}" cy="${y(value)}" r="3" fill="${color}"/>`
        })
      }
    })
    let legendX = padding.left
    series.forEach((s, i) => {
      body += `<rect x="${legendX}" y="12" width="12" height="12" fill="${s.color || colors[i % colors.length]}" rx="2"/>`
      body += `<text x="${legendX + 18}" y="23" fill="#374151" font-size="12">${esc(s.name || `Series ${i + 1}`)}</text>`
      legendX += 150
    })
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#ffffff"/><text x="${padding.left}" y="26" font-size="18" font-weight="700" fill="#111827">${esc(options.title || "Chart")}</text>${body}</svg>`
}

export async function databaseAction(args) {
  let DatabaseSync
  try {
    ;({ DatabaseSync } = await import("node:sqlite"))
  } catch {
    throw new ToolError(
      `SQLite needs the built-in node:sqlite module (Node.js 22.5 or newer). Current Node: ${process.version}`,
      "NO_SQLITE",
    )
  }
  const dbPath = args.path ? resolvePath(args.path, { createParent: true }) : ":memory:"
  if (dbPath !== ":memory:" && !fs.existsSync(dbPath)) await fsp.writeFile(dbPath, Buffer.alloc(0))
  const db = new DatabaseSync(dbPath)
  try {
    const action = args.action || "query"
    if (action === "tables") {
      const rows = db.prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
      return { path: dbPath, tables: rows.map((row) => ({ ...row })) }
    }
    if (action === "schema") {
      const table = args.table ? String(args.table) : null
      const sql = table ? "SELECT sql FROM sqlite_master WHERE name = ? AND type IN ('table','view')" : "SELECT name, sql FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'"
      const rows = table ? db.prepare(sql).all(table) : db.prepare(sql).all()
      return { path: dbPath, schema: rows.map((row) => ({ ...row })) }
    }
    if (action === "query" || action === "sql") {
      const sql = String(args.query || args.sql || "").trim()
      if (!sql) throw new ToolError("query is required", "BAD_INPUT")
      const params = Array.isArray(args.params) ? args.params : []
      const isRead = /^\s*(select|pragma|with|explain)\b/i.test(sql)
      if (isRead) {
        const stmt = db.prepare(sql)
        const rows = stmt.all(...params).map((row) => ({ ...row }))
        return { path: dbPath, rows, count: rows.length }
      }
      const stmt = db.prepare(sql)
      const result = stmt.run(...params)
      return { path: dbPath, changes: result.changes, lastInsertRowid: result.lastInsertRowid }
    }
    if (action === "exec" || action === "migrate") {
      const sql = String(args.sql || args.query || "").trim()
      if (!sql) throw new ToolError("sql is required", "BAD_INPUT")
      if (/^\s*(drop|truncate)\b/i.test(sql) && args.confirm !== true) throw new ToolError("destructive SQL requires confirm: true", "CONFIRM_REQUIRED")
      db.exec(sql)
      return { path: dbPath, ok: true }
    }
    if (action === "insert") {
      if (!args.table) throw new ToolError("table is required", "BAD_INPUT")
      const rows = Array.isArray(args.rows) ? args.rows : []
      if (!rows.length) throw new ToolError("rows are required", "BAD_INPUT")
      const columns = Object.keys(rows[0])
      const placeholders = columns.map(() => "?").join(",")
      const stmt = db.prepare(`INSERT INTO ${quoteIdent(args.table)} (${columns.map(quoteIdent).join(",")}) VALUES (${placeholders})`)
      let count = 0
      for (const row of rows) {
        stmt.run(...columns.map((column) => row[column]))
        count += 1
      }
      return { path: dbPath, inserted: count }
    }
    if (action === "export") {
      if (!args.table) throw new ToolError("table is required", "BAD_INPUT")
      const rows = db.prepare(`SELECT * FROM ${quoteIdent(args.table)} LIMIT ?`).all(Number(args.limit || 10000)).map((row) => ({ ...row }))
      const format = args.format || "json"
      if (format === "csv") return { table: args.table, rows, csv: toCsv(rows) }
      return { table: args.table, rows }
    }
    if (action === "import") {
      if (!args.table || !args.path) throw new ToolError("table and path are required", "BAD_INPUT")
      const text = await fsp.readFile(resolvePath(args.path, { mustExist: true }), "utf8")
      let rows
      if (String(args.path).toLowerCase().endsWith(".json")) {
        rows = JSON.parse(text)
      } else {
        rows = parseCsv(text).rows
      }
      if (!Array.isArray(rows) || !rows.length) throw new ToolError("import file has no rows", "BAD_INPUT")
      const columns = Object.keys(rows[0])
      db.exec(`CREATE TABLE IF NOT EXISTS ${quoteIdent(args.table)} (${columns.map((c) => `${quoteIdent(c)} TEXT`).join(",")})`)
      const stmt = db.prepare(`INSERT INTO ${quoteIdent(args.table)} (${columns.map(quoteIdent).join(",")}) VALUES (${columns.map(() => "?").join(",")})`)
      for (const row of rows) stmt.run(...columns.map((column) => row[column] ?? null))
      return { path: dbPath, table: args.table, imported: rows.length }
    }
    if (action === "backup") {
      const out = resolvePath(args.output || `${dbPath}.backup-${Date.now()}`, { createParent: true })
      await fsp.copyFile(dbPath, out)
      return { path: out, bytes: (await fsp.stat(out)).size }
    }
    if (action === "restore") {
      if (!args.path2) throw new ToolError("path2 (backup file) is required", "BAD_INPUT")
      if (args.confirm !== true) throw new ToolError("restore requires confirm: true", "CONFIRM_REQUIRED")
      await fsp.copyFile(resolvePath(args.path2, { mustExist: true }), dbPath)
      return { path: dbPath, restored: true }
    }
    if (action === "create_table") {
      if (!args.table || !Array.isArray(args.columns)) throw new ToolError("table and columns are required", "BAD_INPUT")
      const defs = args.columns.map((column) => {
        if (typeof column === "string") return quoteIdent(column)
        const type = String(column.type || "TEXT").toUpperCase()
        return `${quoteIdent(column.name)} ${type}${column.primaryKey ? " PRIMARY KEY" : ""}${column.notNull ? " NOT NULL" : ""}`
      })
      db.exec(`CREATE TABLE IF NOT EXISTS ${quoteIdent(args.table)} (${defs.join(",")})`)
      return { path: dbPath, table: args.table, created: true }
    }
    throw new ToolError(`unknown database action: ${action}`, "BAD_INPUT")
  } finally {
    db.close()
  }
}

function quoteIdent(value) {
  return `"${String(value).replace(/"/g, '""')}"`
}
