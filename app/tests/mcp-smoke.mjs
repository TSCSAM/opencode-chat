import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, "server", "mcp", "index.mjs")],
  cwd: root,
  env: { ...process.env, OPENCODE_CHAT_WORKSPACE: path.resolve(root, ".."), OPENCODE_CHAT_TOOLS_DATA: path.join(root, "data") },
  stderr: "pipe",
})
transport.stderr?.on("data", (chunk) => process.stderr.write(chunk))

const client = new Client({ name: "mcp-smoke", version: "1.0.0" })
await client.connect(transport)
const listed = await client.listTools()
console.log("tools:", listed.tools.map((tool) => tool.name).join(", "))
for (const name of process.argv.slice(2).length ? process.argv.slice(2) : ["system"]) {
  const result = await client.callTool({ name, arguments: { action: "info" } })
  const text = (result.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n")
  console.log(`--- ${name} ---`)
  console.log(text.slice(0, 1500))
}
await client.close()
