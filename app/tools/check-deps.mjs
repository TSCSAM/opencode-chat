// Prints "1" when the launcher should run npm install, otherwise nothing.
// The marker npm writes after an install is compared with package-lock.json so
// upgrades also download the exact dependency tree they need.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const modules = path.join(root, "node_modules")
const marker = path.join(modules, ".package-lock.json")
const lock = path.join(root, "package-lock.json")

const stat = (file) => {
  try {
    return fs.statSync(file)
  } catch {
    return null
  }
}

if (!stat(path.join(modules, "@opencode", "client")) || !stat(marker)) {
  console.log("1")
  process.exit(0)
}

const lockStat = stat(lock)
if (lockStat && lockStat.mtimeMs > stat(marker).mtimeMs) {
  console.log("1")
}
