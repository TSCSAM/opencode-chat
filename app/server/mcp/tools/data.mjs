import fsp from "node:fs/promises"
import path from "node:path"
import {
  ToolError,
  errorResult,
  jsonResult,
  parseCsv,
  resolvePath,
  textResult,
  toCsv,
} from "../lib/core.mjs"
import {
  chartSvg,
  correlation,
  csvRead,
  csvWrite,
  forecast,
  jsonQuery,
  linearRegression,
  movingAverage,
  stats,
} from "../lib/data.mjs"
import { getPage } from "../lib/browser.mjs"

async function loadRows(args) {
  if (Array.isArray(args.rows)) return { rows: args.rows, headers: args.headers || Object.keys(args.rows[0] || {}) }
  if (args.path) {
    const target = resolvePath(args.path, { mustExist: true })
    const text = await fsp.readFile(target, "utf8")
    if (target.toLowerCase().endsWith(".json")) {
      const data = JSON.parse(text)
      const rows = Array.isArray(data) ? data : data.rows || data.data || []
      return { rows, headers: Object.keys(rows[0] || {}), path: target }
    }
    const parsed = parseCsv(text, args.delimiter)
    return { rows: parsed.rows, headers: parsed.headers, path: target }
  }
  if (args.text) return parseCsv(String(args.text), args.delimiter)
  return { rows: [], headers: [] }
}

export const dataTool = {
  register(server, { z }) {
    server.registerTool(
      "data",
      {
        title: "Data analysis and charts",
        description:
          "Parse/write CSV, query JSON, compute statistics/correlation/regression/forecasts, transform and join datasets, and render bar/line/pie/scatter/doughnut charts to SVG or PNG. Use this automatically for spreadsheets, CSV/JSON analysis, reports and any numeric summary or visualization.",
        inputSchema: {
          action: z.enum(["csv", "json_query", "stats", "correlation", "regression", "forecast", "moving_average", "chart", "transform", "join"]),
          path: z.string().optional(),
          path2: z.string().optional(),
          text: z.string().optional(),
          rows: z.any().optional(),
          headers: z.array(z.string()).optional(),
          delimiter: z.string().optional(),
          column: z.string().optional(),
          column2: z.string().optional(),
          values: z.any().optional(),
          xs: z.any().optional(),
          ys: z.any().optional(),
          query: z.string().optional(),
          operation: z.enum(["filter", "sort", "dedupe", "select", "group"]).optional(),
          where: z.string().optional().describe("Filter expression, e.g. status == 'open' or amount > 100."),
          sortBy: z.string().optional(),
          direction: z.enum(["asc", "desc"]).optional(),
          fields: z.array(z.string()).optional(),
          key: z.string().optional().describe("Join/group key."),
          labelKey: z.string().optional(),
          valueKeys: z.array(z.string()).optional(),
          chartType: z.enum(["bar", "line", "pie", "doughnut", "scatter"]).optional(),
          title: z.string().optional(),
          output: z.string().optional(),
          labels: z.array(z.string()).optional(),
          series: z.any().optional(),
          periods: z.number().int().positive().optional(),
          window: z.number().int().positive().optional(),
          width: z.number().optional(),
          height: z.number().optional(),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      },
      async (args) => {
        try {
          const action = args.action
          if (action === "csv") {
            if (args.output) return jsonResult(await csvWrite(args))
            return jsonResult(await csvRead(args))
          }
          if (action === "json_query") {
            let data
            if (args.path) data = JSON.parse(await fsp.readFile(resolvePath(args.path, { mustExist: true }), "utf8"))
            else if (args.text) data = JSON.parse(args.text)
            else data = args.rows
            return jsonResult({ query: args.query || "$", result: jsonQuery(data, args.query) })
          }
          if (action === "stats") {
            let values = args.values
            if (!values) {
              const loaded = await loadRows(args)
              const column = args.column || loaded.headers.find((h) => loaded.rows.some((row) => Number.isFinite(Number(row[h]))))
              values = loaded.rows.map((row) => row[column])
            }
            return jsonResult(stats(Array.isArray(values) ? values : []))
          }
          if (action === "correlation") {
            return jsonResult({ correlation: correlation(args.xs || [], args.ys || []) })
          }
          if (action === "regression") {
            const model = linearRegression(args.xs || [], args.ys || [])
            return jsonResult(model ? { slope: model.slope, intercept: model.intercept, r2: model.r2, predict: undefined } : null)
          }
          if (action === "forecast") {
            const values = args.values || (await loadRows(args)).rows.map((row) => row[args.column])
            return jsonResult({ forecast: forecast(values || [], args.periods || 3) })
          }
          if (action === "moving_average") {
            const values = args.values || (await loadRows(args)).rows.map((row) => row[args.column])
            return jsonResult({ movingAverage: movingAverage(values || [], args.window || 3) })
          }
          if (action === "chart") {
            let labels = args.labels
            let series = args.series
            if (!labels || !series) {
              const loaded = await loadRows(args)
              labels = loaded.rows.map((row) => String(row[args.labelKey || loaded.headers[0]]))
              const valueKeys = args.valueKeys || loaded.headers.filter((h) => loaded.rows.some((row) => Number.isFinite(Number(row[h]))))
              series = valueKeys.map((key) => ({ name: key, values: loaded.rows.map((row) => Number(row[key]) || 0) }))
            }
            if (typeof series === "string") series = JSON.parse(series)
            const svg = chartSvg(args.chartType || "bar", labels || [], series || [], { title: args.title, width: args.width, height: args.height })
            if (!args.output) return textResult(svg)
            const target = resolvePath(args.output, { createParent: true })
            if (target.toLowerCase().endsWith(".svg")) {
              await fsp.writeFile(target, svg, "utf8")
              return jsonResult({ path: target, format: "svg", bytes: Buffer.byteLength(svg) })
            }
            const page = await getPage("data-chart", { viewport: { width: Number(args.width || 900), height: Number(args.height || 520) } })
            await page.setContent(`<html><body style="margin:0;background:#fff">${svg}</body></html>`, { waitUntil: "load" })
            await page.screenshot({ path: target, type: "png" })
            return jsonResult({ path: target, format: "png", bytes: (await fsp.stat(target)).size })
          }
          if (action === "transform") {
            const loaded = await loadRows(args)
            let rows = loaded.rows
            if (args.operation === "filter" || args.where) {
              const match = String(args.where || args.query || "").match(/^([A-Za-z0-9_ .-]+)\s*(==|!=|>=|<=|>|<|contains)\s*["']?(.*?)["']?$/)
              if (!match) throw new ToolError("where must look like: column == value", "BAD_INPUT")
              const [, key, op, raw] = match
              rows = rows.filter((row) => {
                const value = row[key]
                if (op === "contains") return String(value ?? "").toLowerCase().includes(raw.toLowerCase())
                const a = Number.isFinite(Number(value)) ? Number(value) : value
                const b = Number.isFinite(Number(raw)) ? Number(raw) : raw
                return op === "==" ? a === b : op === "!=" ? a !== b : op === ">" ? a > b : op === "<" ? a < b : op === ">=" ? a >= b : a <= b
              })
            }
            if (args.sortBy) {
              const dir = args.direction === "desc" ? -1 : 1
              rows = [...rows].sort((a, b) => {
                const av = a[args.sortBy]
                const bv = b[args.sortBy]
                const an = Number(av)
                const bn = Number(bv)
                if (Number.isFinite(an) && Number.isFinite(bn)) return (an - bn) * dir
                return String(av).localeCompare(String(bv)) * dir
              })
            }
            if (args.operation === "dedupe") {
              const key = args.key || args.column
              const seen = new Set()
              rows = rows.filter((row) => {
                const value = key ? row[key] : JSON.stringify(row)
                if (seen.has(value)) return false
                seen.add(value)
                return true
              })
            }
            if (args.fields?.length) rows = rows.map((row) => Object.fromEntries(args.fields.map((field) => [field, row[field]])))
            if (args.operation === "group" && (args.key || args.column)) {
              const key = args.key || args.column
              const groups = new Map()
              for (const row of rows) {
                const groupKey = String(row[key])
                if (!groups.has(groupKey)) groups.set(groupKey, [])
                groups.get(groupKey).push(row)
              }
              return jsonResult({ groups: [...groups.entries()].map(([name, items]) => ({ name, count: items.length, items: items.slice(0, 100) })) })
            }
            if (args.output) {
              const target = resolvePath(args.output, { createParent: true })
              await fsp.writeFile(target, args.output.toLowerCase().endsWith(".csv") ? toCsv(rows) : JSON.stringify(rows, null, 2), "utf8")
              return jsonResult({ path: target, rows: rows.length })
            }
            return jsonResult({ rows: rows.slice(0, 2000), count: rows.length })
          }
          if (action === "join") {
            const left = await loadRows(args)
            const right = args.path2 ? await loadRows({ path: args.path2 }) : { rows: [] }
            const key = args.key || args.column
            if (!key) throw new ToolError("key is required", "BAD_INPUT")
            const index = new Map(right.rows.map((row) => [String(row[key]), row]))
            const rows = left.rows.map((row) => ({ ...row, ...(index.get(String(row[key])) || {}) }))
            return jsonResult({ rows: rows.slice(0, 2000), count: rows.length })
          }
          throw new ToolError(`unknown data action: ${action}`, "BAD_INPUT")
        } catch (error) {
          return errorResult(error)
        }
      },
    )
  },
}
