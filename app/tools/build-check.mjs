// Prints "1" when the production bundle is missing or older than the newest
// file under src/; prints nothing otherwise.
//
// "Start OpenCode Chat.cmd" uses this to rebuild automatically, so the launcher
// always serves the latest sources. Node is used instead of PowerShell because
// the launcher already requires Node and this avoids spawning a second,
// comparatively slow, interpreter on every start.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

// This script lives in app/tools; the bundle and sources are in the app root.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const bundle = path.join(root, "dist", "index.html")
const sources = path.join(root, "src")

let builtAt = 0
try {
  builtAt = fs.statSync(bundle).mtimeMs
} catch {
  console.log("1")
  process.exit(0)
}

let newest = 0
const walk = (dir) => {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full)
      continue
    }
    try {
      const mtime = fs.statSync(full).mtimeMs
      if (mtime > newest) newest = mtime
    } catch {
      // فایلی که در همان لحظه پاک شده، مهم نیست.
    }
  }
}
walk(sources)

console.log(newest > builtAt ? "1" : "")
