import dns from "node:dns/promises"
import net from "node:net"
import tls from "node:tls"
import { ToolError, runProcess, truncate, whichAsync } from "./core.mjs"

async function cli(name, args, options = {}) {
  const path = await whichAsync(name)
  if (!path) throw new ToolError(`${name} is not installed or not on PATH`, "CLI_NOT_FOUND")
  const res = await runProcess(path, args, { timeout: options.timeout || 90_000, cwd: options.cwd })
  if (res.code !== 0) throw new ToolError(`${name} failed: ${(res.stderr || res.stdout).slice(0, 2000)}`, "CLI_FAILED")
  return { ...res, output: truncate(res.stdout || res.stderr, 40_000) }
}

export async function devopsAction(args) {
  const action = args.action
  if (action === "dns") {
    if (!args.hostname) throw new ToolError("hostname is required", "BAD_INPUT")
    const [a, aaaa, mx, txt, ns, cname] = await Promise.all([
      dns.resolve4(args.hostname).catch(() => []),
      dns.resolve6(args.hostname).catch(() => []),
      dns.resolveMx(args.hostname).catch(() => []),
      dns.resolveTxt(args.hostname).catch(() => []),
      dns.resolveNs(args.hostname).catch(() => []),
      dns.resolveCname(args.hostname).catch(() => []),
    ])
    return { hostname: args.hostname, a, aaaa, mx, txt: txt.map((row) => row.join("")), ns, cname }
  }
  if (action === "port") {
    const host = args.host || "127.0.0.1"
    const port = Number(args.port)
    if (!Number.isInteger(port)) throw new ToolError("port is required", "BAD_INPUT")
    const started = Date.now()
    const open = await new Promise((resolve) => {
      const socket = net.createConnection({ host, port })
      socket.setTimeout(5000)
      socket.on("connect", () => { socket.destroy(); resolve(true) })
      socket.on("timeout", () => { socket.destroy(); resolve(false) })
      socket.on("error", () => resolve(false))
    })
    return { host, port, open, ms: Date.now() - started }
  }
  if (action === "ssl") {
    const host = args.host
    const port = Number(args.port || 443)
    if (!host) throw new ToolError("host is required", "BAD_INPUT")
    const info = await new Promise((resolve, reject) => {
      const socket = tls.connect({ host, port, servername: host, rejectUnauthorized: false }, () => {
        const cert = socket.getPeerCertificate()
        resolve({ authorized: socket.authorized, authorizationError: socket.authorizationError, subject: cert.subject, issuer: cert.issuer, validFrom: cert.valid_from, validTo: cert.valid_to, fingerprint: cert.fingerprint256, altNames: cert.subjectaltname })
        socket.destroy()
      })
      socket.setTimeout(10_000, () => { socket.destroy(); reject(new ToolError("TLS connection timed out", "TIMEOUT")) })
      socket.on("error", reject)
    })
    return { host, port, ...info }
  }
  if (action === "ssh") {
    if (!args.host) throw new ToolError("host is required", "BAD_INPUT")
    const target = args.user ? `${args.user}@${args.host}` : args.host
    const sshArgs = ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-p", String(Number(args.port || 22))]
    if (args.key) sshArgs.push("-i", String(args.key))
    sshArgs.push(target, String(args.command || "uname -a"))
    const res = await runProcess("ssh", sshArgs, { timeout: Number(args.timeout || 60_000) })
    if (res.code !== 0) throw new ToolError(`ssh failed: ${(res.stderr || res.stdout).slice(0, 2000)}`, "SSH_FAILED")
    return { host: target, output: truncate(res.stdout, 40_000), stderr: res.stderr.slice(0, 4000) }
  }
  if (action === "scp") {
    if (!args.host || !args.path) throw new ToolError("host and path are required", "BAD_INPUT")
    const target = args.user ? `${args.user}@${args.host}` : args.host
    const direction = args.direction || "upload"
    const remote = String(args.remote || "/tmp/opencode-chat-upload")
    const scpArgs = ["-o", "StrictHostKeyChecking=accept-new", "-P", String(Number(args.port || 22))]
    if (args.key) scpArgs.push("-i", String(args.key))
    if (direction === "download") scpArgs.push(`${target}:${remote}`, String(args.path))
    else scpArgs.push(String(args.path), `${target}:${remote}`)
    const res = await runProcess("scp", scpArgs, { timeout: Number(args.timeout || 120_000) })
    if (res.code !== 0) throw new ToolError(`scp failed: ${(res.stderr || res.stdout).slice(0, 2000)}`, "SCP_FAILED")
    return { direction, remote, path: args.path, output: res.stdout }
  }
  if (action === "docker") {
    const sub = args.subaction || "ps"
    const map = {
      ps: ["ps", "-a"],
      images: ["images"],
      logs: ["logs", "--tail", String(Number(args.limit || 200)), String(args.name || "")],
      start: ["start", String(args.name || "")],
      stop: ["stop", String(args.name || "")],
      restart: ["restart", String(args.name || "")],
      exec: ["exec", String(args.name || ""), ...String(args.command || "sh").split(/\s+/)],
      build: ["build", "-t", String(args.name || "app"), String(args.path || ".")],
      compose_up: ["compose", "up", "-d"],
      compose_down: ["compose", "down"],
    }
    const cmd = map[sub]
    if (!cmd) throw new ToolError(`unknown docker subaction: ${sub}`, "BAD_INPUT")
    return await cli("docker", cmd, { cwd: args.cwd })
  }
  if (action === "kubectl") {
    const sub = args.subaction || "get"
    const map = {
      get: ["get", String(args.resource || "pods"), ...(args.name ? [String(args.name)] : []), ...(args.namespace ? ["-n", String(args.namespace)] : [])],
      describe: ["describe", String(args.resource || "pod"), String(args.name || ""), ...(args.namespace ? ["-n", String(args.namespace)] : [])],
      logs: ["logs", String(args.name || ""), "--tail", String(Number(args.limit || 200)), ...(args.namespace ? ["-n", String(args.namespace)] : [])],
      apply: ["apply", "-f", String(args.path || "")],
      delete: ["delete", String(args.resource || "pod"), String(args.name || ""), ...(args.namespace ? ["-n", String(args.namespace)] : [])],
      scale: ["scale", String(args.resource || "deployment"), String(args.name || ""), `--replicas=${Number(args.replicas || 1)}`, ...(args.namespace ? ["-n", String(args.namespace)] : [])],
      contexts: ["config", "get-contexts"],
    }
    const cmd = map[sub]
    if (!cmd) throw new ToolError(`unknown kubectl subaction: ${sub}`, "BAD_INPUT")
    return await cli("kubectl", cmd, { cwd: args.cwd })
  }
  if (action === "which") {
    const names = ["ssh", "scp", "docker", "kubectl", "git", "gh", "cloudflared", "wrangler", "vercel", "netlify", "aws", "gcloud", "az"]
    const rows = {}
    for (const name of names) rows[name] = await whichAsync(name)
    return rows
  }
  throw new ToolError(`unknown devops action: ${action}`, "BAD_INPUT")
}
