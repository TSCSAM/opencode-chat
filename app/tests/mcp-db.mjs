import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, "server", "mcp", "index.mjs")],
  cwd: root,
  env: {
    ...process.env,
    OPENCODE_CHAT_WORKSPACE: path.resolve(root, ".."),
    OPENCODE_CHAT_TOOLS_DATA: path.join(root, "data"),
  },
  stderr: "pipe",
})
const client = new Client({ name: "mcp-db", version: "1.0.0" })
await client.connect(transport)
const result = await client.callTool({
  name: "database",
  arguments: {
    action: "query",
    path: "app/tests/tmp-tools/final.db",
    sql: "SELECT 1 AS ok",
  },
})
for (const part of result.content ?? []) if (part.type === "text") console.log(part.text)
if (result.isError) process.exitCode = 1
await client.close()
