// Keeps the OpenCode background service tied to the app process.
//
// The service is spawned with detached:true, so closing the console window does
// not necessarily kill it. This tiny detached process watches the app PID and
// stops the registered service (and its process tree) when the app disappears.
//
// Usage: node tools/service-watchdog.mjs <parentPid> <serviceRegistrationPath>
import fs from "node:fs"
import { spawnSync } from "node:child_process"

const parentPid = Number(process.argv[2])
const registrationPath = process.argv[3]

if (!Number.isInteger(parentPid) || parentPid <= 0 || !registrationPath) process.exit(0)

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but we are not allowed to signal it.
    return error?.code === "EPERM"
  }
}

function servicePid() {
  try {
    const parsed = JSON.parse(fs.readFileSync(registrationPath, "utf8"))
    return Number(parsed?.pid) || 0
  } catch {
    return 0
  }
}

function killTree(pid) {
  if (!alive(pid)) return
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      })
    } catch {}
    return
  }
  try {
    process.kill(-pid, "SIGTERM")
  } catch {
    try {
      process.kill(pid, "SIGTERM")
    } catch {}
  }
}

const timer = setInterval(() => {
  // The engine may be missing while it restarts or updates. Keep watching for
  // as long as the app is alive so protection is not lost for the rest of the
  // session.
  if (alive(parentPid)) return
  clearInterval(timer)
  killTree(servicePid())
  setTimeout(() => {
    // A final attempt in case taskkill/termination was slow or the service was
    // re-registered with a new PID while we were stopping it.
    killTree(servicePid())
    process.exit(0)
  }, 2500)
}, 1000)
