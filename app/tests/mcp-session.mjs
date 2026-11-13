import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import fsp from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, "server", "mcp", "index.mjs")],
  cwd: root,
  env: { ...process.env, OPENCODE_CHAT_WORKSPACE: path.resolve(root, ".."), OPENCODE_CHAT_TOOLS_DATA: path.join(root, "data"), CHROME_PATH: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" },
  stderr: "pipe",
})
transport.stderr?.on("data", (chunk) => process.stderr.write(chunk))
const client = new Client({ name: "mcp-session", version: "1.0.0" })
await client.connect(transport)
const call = async (name, args) => {
  const result = await client.callTool({ name, arguments: args })
  return result
}
const text = (result) => (result.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n")
console.log("--- navigate ---")
console.log(text(await call("browser", { action: "navigate", url: "https://example.com" })).slice(0, 600))
console.log("--- evaluate ---")
console.log(text(await call("browser", { action: "evaluate", text: "return { title: document.title, h: document.body.innerText.length }" })))
console.log("--- screenshot ---")
const shot = await call("browser", { action: "screenshot", fullPage: true })
const image = (shot.content ?? []).find((part) => part.type === "image")
if (!image) throw new Error("screenshot returned no image")
const target = path.join(root, "tests", "tmp-tools", "browser-session.png")
await fsp.mkdir(path.dirname(target), { recursive: true })
await fsp.writeFile(target, Buffer.from(image.data, "base64"))
console.log("saved:", target, "bytes:", (await fsp.stat(target)).size)
console.log("--- image info ---")
console.log(text(await call("images", { action: "info", path: target })))
console.log("--- browser performance ---")
console.log(text(await call("browser", { action: "performance" })).slice(0, 1200))
await client.close()
