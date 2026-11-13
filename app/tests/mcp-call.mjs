import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const [tool, json, out] = process.argv.slice(2)
if (!tool) {
  console.error("usage: node tests/mcp-call.mjs <tool> '<json args>' [image-output]")
  process.exit(2)
}
let args = {}
try {
  args = json ? JSON.parse(json) : {}
} catch (error) {
  console.error("bad json:", error.message)
  process.exit(2)
}
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, "server", "mcp", "index.mjs")],
  cwd: root,
  env: {
    ...process.env,
    OPENCODE_CHAT_WORKSPACE: path.resolve(root, ".."),
    OPENCODE_CHAT_TOOLS_DATA: path.join(root, "data"),
    CHROME_PATH: process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  },
  stderr: "pipe",
})
transport.stderr?.on("data", (chunk) => process.stderr.write(chunk))
const client = new Client({ name: "mcp-call", version: "1.0.0" })
await client.connect(transport)
const result = await client.callTool({ name: tool, arguments: args })
for (const part of result.content ?? []) {
  if (part.type === "text") console.log(part.text)
  if (part.type === "image") {
    const fs = await import("node:fs/promises")
    const target = out ? path.resolve(process.cwd(), out) : path.join(root, "tests", `mcp-image-${Date.now()}.png`)
    await fs.writeFile(target, Buffer.from(part.data, "base64"))
    console.log(`[image ${part.mimeType} saved to ${target}]`)
  }
}
if (result.isError) process.exitCode = 1
await client.close()
