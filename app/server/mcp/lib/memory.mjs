import fsp from "node:fs/promises"
import path from "node:path"
import { MEMORY_FILE, ToolError, ensureDir, nowIso, resolvePath, unique } from "./core.mjs"

let queue = Promise.resolve()

async function withLock(fn) {
  const next = queue.then(fn, fn)
  queue = next.catch(() => {})
  return next
}

async function load() {
  try {
    const text = await fsp.readFile(MEMORY_FILE, "utf8")
    const data = JSON.parse(text)
    return { version: 1, entries: Array.isArray(data.entries) ? data.entries : [] }
  } catch {
    return { version: 1, entries: [] }
  }
}

async function save(data) {
  await ensureDir(path.dirname(MEMORY_FILE))
  const temp = `${MEMORY_FILE}.tmp`
  await fsp.writeFile(temp, JSON.stringify(data, null, 2) + "\n", "utf8")
  await fsp.rename(temp, MEMORY_FILE)
}

function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .match(/[a-z0-9\u0600-\u06ff]{2,}/g) || []
}

function score(entry, queryTokens) {
  if (!queryTokens.length) return 0
  const hay = `${entry.text} ${(entry.tags || []).join(" ")} ${entry.source || ""}`.toLowerCase()
  let total = 0
  for (const token of queryTokens) {
    const count = hay.split(token).length - 1
    if (count) total += 1 + Math.log(count)
  }
  return total / Math.sqrt(queryTokens.length)
}

export async function memoryAction(args) {
  return await withLock(async () => {
    const data = await load()
    const action = args.action || "search"
    if (action === "add" || action === "write") {
      const text = String(args.text || "").trim()
      if (!text) throw new ToolError("text is required", "BAD_INPUT")
      const entry = {
        id: `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
        text: text.slice(0, 100_000),
        tags: Array.isArray(args.tags) ? args.tags.map(String).slice(0, 20) : String(args.tags || "").split(",").map((s) => s.trim()).filter(Boolean),
        source: String(args.source || "agent"),
        createdAt: nowIso(),
        updatedAt: nowIso(),
      }
      data.entries.push(entry)
      await save(data)
      return { added: entry, total: data.entries.length }
    }
    if (action === "search" || action === "retrieve" || action === "get") {
      const query = String(args.query || args.text || "").trim()
      const limit = Math.max(1, Math.min(100, Number(args.limit || 8)))
      if (!query) {
        return { entries: data.entries.slice(-limit).reverse(), total: data.entries.length }
      }
      const tokens = unique(tokenize(query))
      const scored = data.entries
        .map((entry) => ({ ...entry, score: score(entry, tokens) }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score || String(b.updatedAt).localeCompare(String(a.updatedAt)))
        .slice(0, limit)
      return { query, entries: scored, total: data.entries.length }
    }
    if (action === "list") {
      const limit = Math.max(1, Math.min(500, Number(args.limit || 50)))
      return { entries: data.entries.slice(-limit).reverse(), total: data.entries.length }
    }
    if (action === "update") {
      const id = String(args.id || "")
      const entry = data.entries.find((item) => item.id === id)
      if (!entry) throw new ToolError(`memory not found: ${id}`, "NOT_FOUND")
      if (args.text !== undefined) entry.text = String(args.text).slice(0, 100_000)
      if (args.tags !== undefined) entry.tags = Array.isArray(args.tags) ? args.tags.map(String) : String(args.tags).split(",").map((s) => s.trim()).filter(Boolean)
      if (args.source !== undefined) entry.source = String(args.source)
      entry.updatedAt = nowIso()
      await save(data)
      return { updated: entry }
    }
    if (action === "delete" || action === "forget") {
      const id = String(args.id || "")
      const before = data.entries.length
      data.entries = data.entries.filter((entry) => entry.id !== id)
      if (data.entries.length === before) throw new ToolError(`memory not found: ${id}`, "NOT_FOUND")
      await save(data)
      return { deleted: id, total: data.entries.length }
    }
    if (action === "clear") {
      if (args.confirm !== true) throw new ToolError("clear requires confirm: true", "CONFIRM_REQUIRED")
      data.entries = []
      await save(data)
      return { cleared: true }
    }
    if (action === "stats") {
      const tags = {}
      for (const entry of data.entries) for (const tag of entry.tags || []) tags[tag] = (tags[tag] || 0) + 1
      return { total: data.entries.length, tags, bytes: Buffer.byteLength(JSON.stringify(data)), path: MEMORY_FILE }
    }
    if (action === "context") {
      const limit = Math.max(1, Math.min(200, Number(args.limit || 30)))
      const selected = data.entries.slice(-limit)
      return {
        text: selected.map((entry) => `- ${entry.text}${entry.tags?.length ? ` [${entry.tags.join(", ")}]` : ""}`).join("\n"),
        entries: selected.length,
      }
    }
    throw new ToolError(`unknown memory action: ${action}`, "BAD_INPUT")
  })
}
