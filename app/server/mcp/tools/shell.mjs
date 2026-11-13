import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { spawn } from "node:child_process"
import { ToolError, WORKSPACE, ensureDir, errorResult, jsonResult, resolvePath, runProcess, textResult, truncate, whichAsync } from "../lib/core.mjs"

function shellCommand(command, args, shell) {
  if (Array.isArray(args) && args.length) return { command, args, shell: false }
  const mode = shell || "auto"
  if (mode === "powershell" || (mode === "auto" && process.platform === "win32")) {
    const ps = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    return { command: ps, args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command], shell: false }
  }
  if (mode === "cmd") return { command: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", command], shell: false }
  return { command: "/bin/sh", args: ["-c", command], shell: false }
}

export const shellTool = {
  register(server, { z }) {
    server.registerTool(
      "shell",
      {
        title: "Terminal, scripts and interpreters",
        description:
          "Run shell/PowerShell commands, Node/TypeScript/Python code or script files, npm scripts and background dev servers with a timeout. Returns exit code, stdout and stderr. Use this automatically for builds, installs, tests, CLIs and any task that needs a real terminal. Prefer files/code tools for file edits.",
        inputSchema: {
          action: z.enum(["run", "powershell", "cmd", "bash", "python", "node", "script", "npm", "which", "background"]),
          command: z.string().optional(),
          args: z.any().optional(),
          code: z.string().optional(),
          path: z.string().optional(),
          cwd: z.string().optional(),
          input: z.string().optional(),
          shell: z.enum(["auto", "powershell", "cmd", "bash"]).optional(),
          timeout: z.number().int().positive().max(110000).optional(),
          env: z.any().optional(),
          name: z.string().optional(),
          log: z.string().optional(),
          argsText: z.string().optional(),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      },
      async (args) => {
        try {
          const cwd = args.cwd ? resolvePath(args.cwd, { mustExist: true }) : WORKSPACE
          if (args.action === "which") {
            const name = String(args.command || args.name || "")
            if (!name) throw new ToolError("command is required", "BAD_INPUT")
            return jsonResult({ command: name, path: await whichAsync(name) })
          }
          if (args.action === "background") {
            const command = String(args.command || "")
            if (!command) throw new ToolError("command is required", "BAD_INPUT")
            const logPath = resolvePath(args.log || path.join(cwd, "opencode-tool-background.log"), { createParent: true })
            await ensureDir(path.dirname(logPath))
            const out = fs.openSync(logPath, "a")
            const built = shellCommand(command, args.args, args.shell)
            const child = spawn(built.command, built.args, { cwd, detached: true, windowsHide: true, stdio: ["ignore", out, out], env: { ...process.env, ...(args.env || {}) } })
            child.unref()
            return jsonResult({ pid: child.pid, log: logPath, command })
          }
          if (args.action === "python") {
            const python = await whichAsync("python")
            if (!python) throw new ToolError("python is not installed", "NO_PYTHON")
            let script = args.code
            let argv = []
            if (!script && args.path) {
              script = null
              argv = [resolvePath(args.path, { mustExist: true })]
            } else {
              argv = ["-c", String(script || "")]
            }
            const res = await runProcess(python, argv, { cwd, timeout: args.timeout || 110_000, input: args.input, env: args.env })
            return jsonResult({ code: res.code, stdout: truncate(res.stdout, 60_000), stderr: truncate(res.stderr, 30_000), durationMs: res.durationMs })
          }
          if (args.action === "node") {
            let argv
            if (args.path) argv = [resolvePath(args.path, { mustExist: true })]
            else argv = ["-e", String(args.code || "")]
            const res = await runProcess(process.execPath, argv, { cwd, timeout: args.timeout || 110_000, input: args.input, env: args.env })
            return jsonResult({ code: res.code, stdout: truncate(res.stdout, 60_000), stderr: truncate(res.stderr, 30_000), durationMs: res.durationMs })
          }
          if (args.action === "npm") {
            const npm = await whichAsync("npm")
            if (!npm) throw new ToolError("npm is not installed", "NO_NPM")
            const argv = Array.isArray(args.args) ? args.args.map(String) : String(args.command || args.argsText || "run").split(/\s+/).filter(Boolean)
            const res = await runProcess(npm, argv, { cwd, timeout: args.timeout || 110_000, shell: process.platform === "win32", env: args.env })
            return jsonResult({ code: res.code, stdout: truncate(res.stdout, 60_000), stderr: truncate(res.stderr, 30_000), durationMs: res.durationMs })
          }
          if (args.action === "script") {
            if (!args.path) throw new ToolError("path is required", "BAD_INPUT")
            const target = resolvePath(args.path, { mustExist: true })
            const ext = path.extname(target).toLowerCase()
            let command = target
            let argv = Array.isArray(args.args) ? args.args.map(String) : []
            if (ext === ".js" || ext === ".mjs" || ext === ".cjs") command = process.execPath
            else if (ext === ".py") command = await whichAsync("python")
            else if (ext === ".ps1") command = "powershell"
            if (!command) throw new ToolError("could not resolve an interpreter for this script", "NO_INTERPRETER")
            if (ext === ".ps1") argv = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", target, ...argv]
            else if (command !== target) argv = [target, ...argv]
            const res = await runProcess(command, argv, { cwd, timeout: args.timeout || 110_000, input: args.input, env: args.env })
            return jsonResult({ code: res.code, stdout: truncate(res.stdout, 60_000), stderr: truncate(res.stderr, 30_000), durationMs: res.durationMs })
          }
          const command = String(args.command || args.code || "")
          if (!command) throw new ToolError("command is required", "BAD_INPUT")
          const mode = args.action === "run" ? args.shell || "auto" : args.action
          const built = shellCommand(command, args.args, mode)
          const res = await runProcess(built.command, built.args, { cwd, timeout: args.timeout || 110_000, input: args.input, env: args.env })
          return jsonResult({ code: res.code, stdout: truncate(res.stdout, 60_000), stderr: truncate(res.stderr, 30_000), durationMs: res.durationMs, cwd })
        } catch (error) {
          return errorResult(error)
        }
      },
    )
  },
}
