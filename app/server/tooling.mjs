// Automatic registration of the bundled local MCP tool hub.
//
// OpenCode stores MCP servers under mcp.servers. We merge one local stdio
// server into the user's existing JSONC config, preserving comments, and add
// an allow rule so the model can use these tools without a prompt for every
// read-only call. No credentials are written here.
import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { applyEdits, modify, parse, printParseErrorCode } from "jsonc-parser"

export const TOOL_SERVER_NAME = "opencode-chat-tools"
export const TOOL_SERVER_PERMISSION = `${TOOL_SERVER_NAME}_*`

export function toolServerEntry({ appRoot, workdir }) {
  const serverScript = path.join(appRoot, "server", "mcp", "index.mjs")
  return {
    type: "local",
    command: [process.execPath, serverScript],
    cwd: workdir,
    environment: {
      OPENCODE_CHAT_WORKSPACE: workdir,
      OPENCODE_CHAT_TOOLS_DATA: path.join(appRoot, "data"),
      CHROME_PATH: process.env.CHROME_PATH || "",
    },
    codemode: false,
    disabled: false,
    // The SDK server speaks the classic initialize handshake. Leaving protocol
    // at its default (legacy) avoids the auto-probe starting an extra process.
    timeout: { startup: 30_000, catalog: 30_000, execution: 120_000 },
  }
}

function parseJsonc(text) {
  const errors = []
  const value = parse(text, errors, { allowTrailingComma: true, disallowComments: false })
  if (errors.length) {
    const first = errors[0]
    throw new Error(`${printParseErrorCode(first.error)} at offset ${first.offset}`)
  }
  return value
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

function ensurePermission(config) {
  const permissions = Array.isArray(config.permissions) ? config.permissions : []
  if (permissions.some((rule) => rule?.action === TOOL_SERVER_PERMISSION && rule?.resource === "*")) return permissions
  return [...permissions, { action: TOOL_SERVER_PERMISSION, resource: "*", effect: "allow" }]
}

/**
 * Merge the tool server into an OpenCode config file.
 * Returns { changed, path, server, permissionAdded }.
 */
export async function ensureToolServerRegistered({ cfgPath, appRoot, workdir }) {
  if (!cfgPath) throw new Error("OpenCode config path is not available")
  await fsp.mkdir(path.dirname(cfgPath), { recursive: true })
  let text = ""
  try {
    text = await fsp.readFile(cfgPath, "utf8")
  } catch {}
  let config = {}
  if (text.trim()) {
    config = parseJsonc(text)
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      throw new Error("OpenCode config is not a JSON object")
    }
  }
  const entry = toolServerEntry({ appRoot, workdir })
  const current = config?.mcp?.servers?.[TOOL_SERVER_NAME]
  const permissionAdded = !(
    Array.isArray(config.permissions) &&
    config.permissions.some((rule) => rule?.action === TOOL_SERVER_PERMISSION && rule?.resource === "*")
  )
  const permissions = ensurePermission(config)
  if (sameJson(current, entry) && !permissionAdded) {
    return { changed: false, path: cfgPath, server: entry, permissionAdded: false }
  }

  let out = text
  const formattingOptions = { insertSpaces: true, tabSize: 2, eol: "\n" }
  for (const edit of modify(out || "{}\n", ["mcp", "servers", TOOL_SERVER_NAME], entry, { formattingOptions })) {
    out = applyEdits(out || "{}\n", [edit])
  }
  for (const edit of modify(out, ["permissions"], permissions, { formattingOptions })) {
    out = applyEdits(out, [edit])
  }
  // Never write a config the engine cannot parse.
  const check = parseJsonc(out)
  if (!check?.mcp?.servers?.[TOOL_SERVER_NAME]) throw new Error("tool server merge produced an invalid config")
  const temp = `${cfgPath}.opencode-chat.tmp`
  await fsp.writeFile(temp, out, "utf8")
  await fsp.rename(temp, cfgPath)
  return { changed: true, path: cfgPath, server: entry, permissionAdded }
}

export async function reloadEngineConfig(endpoint, auth, timeout = 5000) {
  try {
    await fetch(`${endpoint}/api/location/reload`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(timeout),
    })
    return true
  } catch {
    return false
  }
}

/**
 * Reconnect the bundled server so an already-running engine picks up the
 * current codemode/tool settings. OpenCode keeps the tool catalog from the
 * original connection; a config reload alone does not refresh it.
 */
export async function restartToolServer(endpoint, auth, timeout = 30_000) {
  const base = `${endpoint}/api/experimental/mcp/${encodeURIComponent(TOOL_SERVER_NAME)}`
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const call = (verb) =>
    fetch(`${base}/${verb}`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(timeout),
    })
  const connection = async () => {
    const entry = await fetchMcpStatus(endpoint, auth)
    const value = entry?.status?.status ?? entry?.status
    return typeof value === "string" ? value : value?.status ?? null
  }

  // The engine may still be loading its config right after startup. Wait for
  // the server entry to appear before reconnecting it. If the handshake does
  // not finish in this window the engine will still connect it from the config
  // on its own; startup must not be held hostage by a slow MCP process.
  let current = await connection()
  for (let i = 0; !current && i < 8; i++) {
    await sleep(500)
    current = await connection()
  }
  try {
    await call("disconnect")
  } catch {}
  await sleep(250)
  try {
    await call("connect")
  } catch {}
  for (let i = 0; i < 8; i++) {
    await sleep(500)
    if ((await connection()) === "connected") return true
  }
  return false
}

export async function fetchMcpStatus(endpoint, auth) {
  try {
    const res = await fetch(`${endpoint}/api/mcp`, {
      headers: { ...auth },
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return null
    const data = await res.json().catch(() => null)
    return (data?.data ?? data ?? []).find?.((entry) => entry?.name === TOOL_SERVER_NAME) ?? null
  } catch {
    return null
  }
}

export async function removeToolServerFromConfig({ cfgPath, appRoot }) {
  if (!cfgPath || !fs.existsSync(cfgPath)) return { changed: false, path: cfgPath }
  const text = await fsp.readFile(cfgPath, "utf8")
  const config = parseJsonc(text)
  if (!config?.mcp?.servers?.[TOOL_SERVER_NAME]) return { changed: false, path: cfgPath }
  const formattingOptions = { insertSpaces: true, tabSize: 2, eol: "\n" }
  let out = text
  for (const edit of modify(out, ["mcp", "servers", TOOL_SERVER_NAME], undefined, { formattingOptions })) {
    out = applyEdits(out, [edit])
  }
  await fsp.writeFile(cfgPath, out, "utf8")
  return { changed: true, path: cfgPath }
}
