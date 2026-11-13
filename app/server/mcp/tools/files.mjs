import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import {
  ToolError,
  WORKSPACE,
  assertConfirm,
  assertSafeTarget,
  formatBytes,
  hashText,
  isBinaryBuffer,
  lineDiff,
  resolvePath,
  searchFiles,
  textResult,
  jsonResult,
  errorResult,
  readTextFile,
  writeBinaryFile,
  writeTextFile,
  walkFiles,
} from "../lib/core.mjs"
import { fetchRaw } from "../lib/http.mjs"

async function statRow(target) {
  const stat = await fsp.stat(target)
  return {
    path: target,
    name: path.basename(target),
    type: stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other",
    size: stat.size,
    sizeHuman: formatBytes(stat.size),
    created: stat.birthtime.toISOString(),
    modified: stat.mtime.toISOString(),
    mode: stat.mode,
  }
}

async function listDir(target, recursive, maxDepth, limit) {
  const stat = await fsp.stat(target)
  if (!stat.isDirectory()) return [await statRow(target)]
  const rows = []
  async function visit(dir, depth) {
    if (rows.length >= limit || depth > maxDepth) return
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (rows.length >= limit) return
      const full = path.join(dir, entry.name)
      const info = await fsp.stat(full).catch(() => null)
      if (!info) continue
      rows.push({
        path: full,
        relative: path.relative(target, full),
        name: entry.name,
        type: entry.isDirectory() ? "directory" : "file",
        size: info.size,
        sizeHuman: formatBytes(info.size),
        modified: info.mtime.toISOString(),
      })
      if (recursive && entry.isDirectory()) await visit(full, depth + 1)
    }
  }
  await visit(target, 1)
  return rows
}

export const filesTool = {
  register(server, { z }) {
    server.registerTool(
      "files",
      {
        title: "Files and folders",
        description:
          "Read, write, edit, create, delete, move, copy, list, search, hash and inspect files and folders on disk. Use this automatically for any local file task before falling back to shell commands. Relative paths resolve against the active workspace. Destructive operations require confirm:true.",
        inputSchema: {
          action: z.enum([
            "read",
            "write",
            "append",
            "edit",
            "create",
            "delete",
            "move",
            "rename",
            "copy",
            "list",
            "tree",
            "search",
            "stat",
            "mkdir",
            "hash",
            "compare",
            "download",
            "duplicates",
          ]),
          path: z.string().optional().describe("Source/target path."),
          path2: z.string().optional().describe("Second path for compare/move/copy target."),
          content: z.string().optional().describe("Text to write, append or use as replacement."),
          replacement: z.string().optional().describe("Replacement text for edit."),
          query: z.string().optional().describe("Search pattern."),
          recursive: z.boolean().optional(),
          maxDepth: z.number().int().min(0).max(30).optional(),
          limit: z.number().int().positive().max(5000).optional(),
          overwrite: z.boolean().optional(),
          regex: z.boolean().optional(),
          all: z.boolean().optional().describe("Replace all matches."),
          encoding: z.enum(["utf8", "base64"]).optional(),
          confirm: z.boolean().optional(),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      },
      async (args) => {
        try {
          const action = args.action
          if (action === "read") {
            const target = resolvePath(args.path, { mustExist: true })
            const buf = await fsp.readFile(target)
            if (args.encoding === "base64") return jsonResult({ path: target, base64: buf.toString("base64"), bytes: buf.length })
            if (isBinaryBuffer(buf)) return jsonResult({ path: target, binary: true, bytes: buf.length, hint: "use documents/images/media for binary files" })
            const text = buf.toString("utf8")
            const limit = Number(args.limit || 0)
            const sliced = limit && text.length > limit ? text.slice(0, limit) : text
            return { content: [{ type: "text", text: sliced }], structuredContent: { path: target, bytes: buf.length, truncated: sliced.length < text.length } }
          }
          if (action === "write" || action === "create") {
            const res = await writeTextFile(args.path, args.content ?? "", { overwrite: args.overwrite !== false })
            return jsonResult(res)
          }
          if (action === "append") {
            const target = resolvePath(args.path, { createParent: true })
            await fsp.appendFile(target, String(args.content ?? ""), "utf8")
            return jsonResult(await statRow(target))
          }
          if (action === "edit") {
            const target = resolvePath(args.path, { mustExist: true })
            const before = await fsp.readFile(target, "utf8")
            const needle = String(args.content ?? "")
            if (!needle) throw new ToolError("content is required", "BAD_INPUT")
            const replacement = String(args.replacement ?? "")
            let after
            if (args.regex) {
              const re = new RegExp(needle, args.all ? "g" : "")
              if (!re.test(before)) throw new ToolError("pattern not found", "NOT_FOUND")
              after = before.replace(re, replacement)
            } else {
              if (!before.includes(needle)) throw new ToolError("text not found", "NOT_FOUND")
              after = args.all ? before.split(needle).join(replacement) : before.replace(needle, replacement)
            }
            await fsp.writeFile(target, after, "utf8")
            return jsonResult({ path: target, changed: lineDiff(before, after), bytes: Buffer.byteLength(after) })
          }
          if (action === "delete") {
            assertConfirm(args, "delete")
            const target = resolvePath(args.path, { mustExist: true })
            assertSafeTarget(target, "delete")
            const stat = await fsp.stat(target)
            if (stat.isDirectory()) await fsp.rm(target, { recursive: true, force: false })
            else await fsp.unlink(target)
            return jsonResult({ deleted: target, type: stat.isDirectory() ? "directory" : "file" })
          }
          if (action === "move" || action === "rename") {
            const source = resolvePath(args.path, { mustExist: true })
            if (!args.path2) throw new ToolError("path2 is required", "BAD_INPUT")
            const destination = resolvePath(args.path2, { createParent: true })
            assertSafeTarget(source, "move")
            if (fs.existsSync(destination) && args.overwrite !== true) throw new ToolError(`destination exists: ${destination}`, "EXISTS")
            await fsp.rename(source, destination)
            return jsonResult({ from: source, to: destination })
          }
          if (action === "copy") {
            const source = resolvePath(args.path, { mustExist: true })
            if (!args.path2) throw new ToolError("path2 is required", "BAD_INPUT")
            const destination = resolvePath(args.path2, { createParent: true })
            await fsp.cp(source, destination, { recursive: true, force: args.overwrite === true, errorOnExist: args.overwrite !== true })
            return jsonResult({ from: source, to: destination })
          }
          if (action === "list" || action === "tree") {
            const target = resolvePath(args.path || ".", { mustExist: true })
            const rows = await listDir(target, action === "tree" || args.recursive === true, Number(args.maxDepth ?? (action === "tree" ? 3 : 1)), Number(args.limit || 500))
            return jsonResult({ path: target, rows, count: rows.length, workspace: WORKSPACE })
          }
          if (action === "search") {
            if (!args.query) throw new ToolError("query is required", "BAD_INPUT")
            const rows = await searchFiles(args.path || WORKSPACE, String(args.query), {
              maxResults: Number(args.limit || 200),
              regex: args.regex === true,
            })
            return jsonResult({ query: args.query, count: rows.length, results: rows })
          }
          if (action === "stat") {
            return jsonResult(await statRow(resolvePath(args.path, { mustExist: true })))
          }
          if (action === "mkdir") {
            const target = resolvePath(args.path, { createParent: true })
            await fsp.mkdir(target, { recursive: true })
            return jsonResult({ created: target })
          }
          if (action === "hash") {
            const target = resolvePath(args.path, { mustExist: true })
            const buf = await fsp.readFile(target)
            const { createHash } = await import("node:crypto")
            return jsonResult({ path: target, sha256: createHash("sha256").update(buf).digest("hex"), bytes: buf.length })
          }
          if (action === "compare") {
            if (!args.path2) throw new ToolError("path2 is required", "BAD_INPUT")
            const a = await readTextFile(args.path)
            const b = await readTextFile(args.path2)
            return jsonResult({ a: a.path, b: b.path, ...lineDiff(a.text, b.text) })
          }
          if (action === "download") {
            if (!args.path) throw new ToolError("path (URL) is required", "BAD_INPUT")
            const res = await fetchRaw(args.path, { timeout: 60_000, maxBytes: 100 * 1024 * 1024 })
            if (!args.path2) throw new ToolError("path2 (destination) is required", "BAD_INPUT")
            const saved = await writeBinaryFile(args.path2, res.buffer)
            return jsonResult({ url: res.finalUrl, status: res.status, ...saved })
          }
          if (action === "duplicates") {
            const files = await walkFiles(args.path || WORKSPACE, { maxFiles: Number(args.maxFiles || 6000) })
            const groups = new Map()
            const { createHash } = await import("node:crypto")
            for (const file of files) {
              if (file.size === 0 || file.size > 100 * 1024 * 1024) continue
              const buf = await fsp.readFile(file.path).catch(() => null)
              if (!buf) continue
              const hash = createHash("sha256").update(buf).digest("hex")
              if (!groups.has(hash)) groups.set(hash, [])
              groups.get(hash).push(file)
            }
            const duplicates = [...groups.values()].filter((group) => group.length > 1).map((group) => ({ size: group[0].size, files: group.map((f) => f.path) }))
            return jsonResult({ groups: duplicates.slice(0, 100), count: duplicates.length })
          }
          throw new ToolError(`unknown files action: ${action}`, "BAD_INPUT")
        } catch (error) {
          return errorResult(error)
        }
      },
    )
  },
}
