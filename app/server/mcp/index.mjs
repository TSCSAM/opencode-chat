#!/usr/bin/env node
// Bundled local MCP server for OpenCode Chat.
// It speaks MCP over stdio and exposes a compact set of high-level tools whose
// actions cover files, documents, web/browser, data, media, system and more.
// OpenCode discovers the tools automatically; no slash command is needed.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { SERVER_NAME, SERVER_VERSION, errorResult, jsonResult, textResult } from "./lib/core.mjs"
import { registerToolModules } from "./registry.mjs"
import { closeBrowser } from "./lib/browser.mjs"

const server = new McpServer(
  { name: SERVER_NAME, version: SERVER_VERSION },
  { capabilities: { tools: {} }, instructions: "Use these tools proactively whenever they make a task safer, faster or more complete. Do not wait for the user to name a tool." },
)

// The registry registers every capability module. Keeping this file small makes
// startup fast and lets the MCP client see the complete catalog immediately.
await registerToolModules(server, { z, jsonResult, textResult, errorResult })

process.on("uncaughtException", (error) => {
  console.error("[opencode-chat-tools] uncaught exception:", error)
})
process.on("unhandledRejection", (error) => {
  console.error("[opencode-chat-tools] unhandled rejection:", error)
})

const transport = new StdioServerTransport()
await server.connect(transport)
console.error(`[opencode-chat-tools] v${SERVER_VERSION} ready (workspace: ${process.env.OPENCODE_CHAT_WORKSPACE || process.cwd()})`)

async function shutdown() {
  await closeBrowser().catch(() => {})
  process.exit(0)
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
process.on("beforeExit", () => {
  void closeBrowser().catch(() => {})
})
