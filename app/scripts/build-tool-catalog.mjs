// Regenerates the catalog snapshot served by GET /app/tools.
// Run from app/: node scripts/build-tool-catalog.mjs
import fsp from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { SERVER_NAME, SERVER_VERSION } from "../server/mcp/lib/core.mjs"
import { TOOLS } from "../server/mcp/tools/catalog.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const target = path.join(root, "data", "tool-catalog.json")
const payload = { version: SERVER_VERSION, server: SERVER_NAME, tools: TOOLS }
await fsp.mkdir(path.dirname(target), { recursive: true })
await fsp.writeFile(target, JSON.stringify(payload, null, 2) + "\n", "utf8")
console.log(`wrote ${target} (${TOOLS.length} tools, ${TOOLS.reduce((n, tool) => n + tool.actions.length, 0)} actions)`)
