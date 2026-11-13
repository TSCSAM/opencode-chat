// Builds the small, clean source archive that is attached to a GitHub release.
// The archive keeps the user-facing layout: the Windows launcher at the top,
// the app in app/ and documentation in docs/. Repository-only files such as
// .github workflows are intentionally left out. node_modules, dist, release,
// caches, logs and local secrets are never included: the launcher installs
// dependencies and builds the app on the user's machine.
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import zlib from "node:zlib"
import { fileURLToPath } from "node:url"

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const projectRoot = path.resolve(appRoot, "..")
const docsRoot = path.join(projectRoot, "docs")
const pkg = JSON.parse(fs.readFileSync(path.join(appRoot, "package.json"), "utf8"))
const version = String(pkg.version || "0.0.0")
const outDir = path.join(projectRoot, "release")
const zipName = `opencode-chat-v${version}-source.zip`
const zipPath = path.join(outDir, zipName)
const sumPath = `${zipPath}.sha256`

const SKIP_DIRS = new Set(["node_modules", "dist", "release", ".git", ".idea", ".vscode", "coverage", "tmp-tools"])
const SKIP_FILES = new Set([
  ".DS_Store",
  "Thumbs.db",
  "desktop.ini",
  ".npmrc",
  "tool-memory.json",
  "tool-state.json",
  // Local user data: provider definitions contain API keys and must never be
  // shipped in a source release.
  "custom-providers.json",
])
const SKIP_EXT = new Set([".log", ".tsbuildinfo", ".zip", ".tmp"])

function shouldSkip(relativePath, isDirectory) {
  const parts = relativePath.split("/")
  if (parts.some((part) => SKIP_DIRS.has(part))) return true
  if (isDirectory) return false
  const base = parts.at(-1)
  if (SKIP_FILES.has(base)) return true
  if (base.startsWith(".env")) return true
  if (base.startsWith("shot-") || base.startsWith("screenshot") || base.startsWith("mcp-image-")) return true
  if (SKIP_EXT.has(path.extname(base).toLowerCase())) return true
  return false
}

function collect(dir, prefix = "") {
  const files = []
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return files
  }
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    const full = path.join(dir, entry.name)
    if (shouldSkip(relative, entry.isDirectory())) continue
    if (entry.isDirectory()) files.push(...collect(full, relative))
    else if (entry.isFile()) files.push({ full, relative })
  }
  return files
}

const launcher = path.join(projectRoot, "Start OpenCode Chat.cmd")
const files = [
  ...(fs.existsSync(launcher) ? [{ full: launcher, relative: "Start OpenCode Chat.cmd" }] : []),
  ...collect(appRoot, "app"),
  ...collect(docsRoot, "docs"),
].sort((a, b) => a.relative.localeCompare(b.relative))

const crcTable = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function dosTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  return { time, day }
}

const now = new Date()
const { time, day } = dosTime(now)
const localParts = []
const centralParts = []
let offset = 0

for (const file of files) {
  const data = fs.readFileSync(file.full)
  const deflated = zlib.deflateRawSync(data, { level: 9 })
  const useDeflate = deflated.length < data.length
  const payload = useDeflate ? deflated : data
  const method = useDeflate ? 8 : 0
  const name = Buffer.from(file.relative.replace(/\\/g, "/"), "utf8")
  const crc = crc32(data)

  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(0x0800, 6)
  local.writeUInt16LE(method, 8)
  local.writeUInt16LE(time, 10)
  local.writeUInt16LE(day, 12)
  local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(payload.length, 18)
  local.writeUInt32LE(data.length, 22)
  local.writeUInt16LE(name.length, 26)
  local.writeUInt16LE(0, 28)
  localParts.push(local, name, payload)

  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(0x0800, 8)
  central.writeUInt16LE(method, 10)
  central.writeUInt16LE(time, 12)
  central.writeUInt16LE(day, 14)
  central.writeUInt32LE(crc, 16)
  central.writeUInt32LE(payload.length, 20)
  central.writeUInt32LE(data.length, 24)
  central.writeUInt16LE(name.length, 28)
  central.writeUInt16LE(0, 30)
  central.writeUInt16LE(0, 32)
  central.writeUInt16LE(0, 34)
  central.writeUInt16LE(0, 36)
  central.writeUInt32LE(0, 38)
  central.writeUInt32LE(offset, 42)
  centralParts.push(central, name)

  offset += local.length + name.length + payload.length
}

const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0)
const end = Buffer.alloc(22)
end.writeUInt32LE(0x06054b50, 0)
end.writeUInt16LE(files.length, 8)
end.writeUInt16LE(files.length, 10)
end.writeUInt32LE(centralSize, 12)
end.writeUInt32LE(offset, 16)

fs.mkdirSync(outDir, { recursive: true })
const zip = Buffer.concat([...localParts, ...centralParts, end])
fs.writeFileSync(zipPath, zip)
const digest = crypto.createHash("sha256").update(zip).digest("hex")
fs.writeFileSync(sumPath, `${digest}  ${zipName}\n`)

console.log(`${zipName}: ${(zip.length / 1024).toFixed(1)} KB (${files.length} files)`)
console.log(`sha256: ${digest}`)
