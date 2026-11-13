// Starts the app in a hidden, detached process and returns once it is ready.
//
// The old launcher kept the console window alive for the whole session. This
// script lets Start OpenCode Chat.cmd close immediately while the server keeps
// running; the Exit button in the panel stops the server and the engine.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const dirArg = process.argv.slice(2).find((arg) => arg.startsWith("--dir="))
const port = Number(process.env.PORT || 5178)
const statusFile = path.join(
  os.tmpdir(),
  `opencode-chat-launch-${process.pid}-${Date.now()}.json`,
)
const logFile = path.join(os.tmpdir(), "opencode-chat-server.log")
const startedAt = new Date()

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function readStatus() {
  try {
    return JSON.parse(fs.readFileSync(statusFile, "utf8"))
  } catch {
    return null
  }
}

async function healthy(url) {
  try {
    const res = await fetch(`${url}/__ping`, { signal: AbortSignal.timeout(1200) })
    return res.ok
  } catch {
    return false
  }
}

async function existingApp() {
  for (let offset = 0; offset < 5; offset++) {
    const url = `http://127.0.0.1:${port + offset}`
    if (await healthy(url)) return url
  }
  return null
}

function tailLog(lines = 25) {
  try {
    return fs.readFileSync(logFile, "utf8").trimEnd().split(/\r?\n/).slice(-lines).join("\n")
  } catch {
    return ""
  }
}

let logFd
try {
  fs.writeFileSync(logFile, `\n--- launch ${startedAt.toISOString()} ---\n`)
  logFd = fs.openSync(logFile, "a")
} catch {
  logFd = "ignore"
}

const child = spawn(
  process.execPath,
  [path.join(root, "server", "server.mjs"), "--prod", "--open", ...(dirArg ? [dirArg] : [])],
  {
    cwd: root,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, OPENCODE_CHAT_STATUS_FILE: statusFile },
  },
)

let exited = false
let exitCode = null
child.on("error", () => {
  exited = true
  exitCode = 1
})
child.on("exit", (code) => {
  exited = true
  exitCode = code
})
child.unref()

let readyUrl = null
const deadline = Date.now() + 120_000
while (Date.now() < deadline) {
  const status = readStatus()
  if (status?.url && (await healthy(status.url))) {
    readyUrl = status.url
    break
  }
  if (exited) {
    readyUrl = await existingApp()
    break
  }
  await sleep(250)
}

try {
  fs.unlinkSync(statusFile)
} catch {}

if (readyUrl) {
  console.log("")
  console.log(`  OpenCode Chat is running at ${readyUrl}`)
  console.log("  This window closes automatically. Use Exit in the app to stop everything.")
  console.log("")
  process.exit(0)
}

console.error("")
console.error("  OpenCode Chat did not become ready.")
if (exited) console.error(`  Launcher exit code: ${exitCode}`)
const tail = tailLog()
if (tail) {
  console.error("")
  console.error(tail)
}
console.error("")
console.error(`  Log: ${logFile}`)
process.exit(1)
