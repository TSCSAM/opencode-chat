import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { ToolError, WORKSPACE, isBinaryBuffer, lineDiff, readTextFile, resolvePath, runProcess, truncate, walkFiles, whichAsync } from "./core.mjs"

async function readProjectFile(file, max = 2_000_000) {
  const target = resolvePath(file, { mustExist: true })
  const buf = await fsp.readFile(target)
  if (isBinaryBuffer(buf)) throw new ToolError("binary file", "BINARY_FILE")
  const text = buf.toString("utf8").slice(0, max)
  return { path: target, text, lines: text.split(/\r?\n/).length, bytes: buf.length }
}

function languageOf(file) {
  return {
    ".ts": "typescript",
    ".tsx": "typescript",
    ".js": "javascript",
    ".jsx": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".py": "python",
    ".rs": "rust",
    ".go": "go",
    ".java": "java",
    ".cs": "csharp",
    ".cpp": "cpp",
    ".c": "c",
    ".rb": "ruby",
    ".php": "php",
    ".html": "html",
    ".css": "css",
    ".json": "json",
    ".md": "markdown",
    ".sh": "shell",
  }[path.extname(file).toLowerCase()] || "text"
}

function outlineText(text, file) {
  const lang = languageOf(file)
  const lines = text.split(/\r?\n/)
  const symbols = []
  const patterns = [
    { kind: "class", regex: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/ },
    { kind: "function", regex: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/ },
    { kind: "const", regex: /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/ },
    { kind: "method", regex: /^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/ },
    { kind: "interface", regex: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/ },
    { kind: "type", regex: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/ },
    { kind: "def", regex: /^\s*def\s+([A-Za-z_][\w]*)/ },
    { kind: "class", regex: /^\s*class\s+([A-Za-z_][\w]*)/ },
    { kind: "func", regex: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)/ },
    { kind: "fn", regex: /^\s*(?:pub\s+)?fn\s+([A-Za-z_][\w]*)/ },
  ]
  if (lang === "json") {
    try {
      const data = JSON.parse(text)
      return { file, language: lang, keys: Object.keys(data).slice(0, 200) }
    } catch {}
  }
  for (let i = 0; i < lines.length; i++) {
    for (const pattern of patterns) {
      const match = lines[i].match(pattern.regex)
      if (match) {
        symbols.push({ line: i + 1, kind: pattern.kind, name: match[1], signature: lines[i].trim().slice(0, 200) })
        break
      }
    }
  }
  return { file, language: lang, lines: lines.length, symbols: symbols.slice(0, 500) }
}

function importList(text) {
  const imports = []
  const regexes = [
    /\bimport\s+(?:[^"']+?\s+from\s+)?["']([^"']+)["']/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bfrom\s+["']([^"']+)["']/g,
    /^\s*import\s+([\w.]+)/gm,
  ]
  for (const regex of regexes) {
    let match
    while ((match = regex.exec(text))) imports.push(match[1])
  }
  return [...new Set(imports)]
}

function complexity(text) {
  const score = (text.match(/\b(if|for|while|case|catch|switch|\?\?|&&|\|\|)\b/g) || []).length
  return { approximateCyclomatic: score + 1, functions: (text.match(/\b(function|=>|def|fn)\b/g) || []).length }
}

function securityFindings(file, text) {
  const checks = [
    { id: "hardcoded-secret", severity: "high", regex: /(api[_-]?key|secret|password|token)\s*[:=]\s*["'][^"']{8,}["']/gi, message: "possible hard-coded credential" },
    { id: "eval", severity: "high", regex: /\beval\s*\(/g, message: "eval() can execute arbitrary code" },
    { id: "shell-injection", severity: "high", regex: /\bexec(?:Sync)?\s*\([^)]*(?:\$\{|\+)/g, message: "command string built dynamically; prefer spawn with an argument array" },
    { id: "inner-html", severity: "medium", regex: /\.innerHTML\s*=/g, message: "innerHTML can introduce XSS; prefer textContent or a sanitizer" },
    { id: "sql-concat", severity: "high", regex: /(SELECT|INSERT|UPDATE|DELETE)[^;]*["']\s*\+/gi, message: "SQL string concatenation; use prepared statements" },
    { id: "http-url", severity: "low", regex: /["']http:\/\/(?!localhost|127\.0\.0\.1)[^"']+["']/g, message: "plain HTTP URL" },
    { id: "tls-disabled", severity: "high", regex: /rejectUnauthorized\s*:\s*false/g, message: "TLS certificate verification disabled" },
    { id: "debug-secret", severity: "medium", regex: /console\.(log|debug)\([^)]*(token|key|secret|password)/gi, message: "secret may be logged" },
  ]
  const rows = []
  for (const check of checks) {
    let match
    while ((match = check.regex.exec(text))) {
      const before = text.slice(0, match.index)
      const line = before.split("\n").length
      rows.push({ file, line, severity: check.severity, id: check.id, message: check.message, match: match[0].replace(/["'][^"']*["']/g, '""').slice(0, 160) })
      if (rows.length > 300) return rows
    }
  }
  return rows
}

async function npm(args, cwd, timeout = 110_000) {
  const npmPath = await whichAsync("npm")
  if (!npmPath) throw new ToolError("npm is not installed", "NO_NPM")
  const res = await runProcess(npmPath, args, { cwd, timeout, shell: process.platform === "win32" })
  return { code: res.code, stdout: truncate(res.stdout, 40_000), stderr: truncate(res.stderr, 20_000), durationMs: res.durationMs }
}

export async function codeAction(args) {
  const cwd = resolvePath(args.cwd || ".", { mustExist: true })
  const action = args.action

  if (action === "project_map") {
    const files = await walkFiles(cwd, { maxFiles: Number(args.maxFiles || 8000) })
    const byExt = {}
    let totalBytes = 0
    let totalLines = 0
    const largest = []
    const codeLanguages = new Set(["typescript", "javascript", "python", "rust", "go", "java", "csharp", "cpp", "c", "ruby", "php", "html", "css", "shell", "json", "markdown"])
    for (const file of files) {
      const ext = path.extname(file.name).toLowerCase() || "(none)"
      byExt[ext] = (byExt[ext] || 0) + 1
      totalBytes += file.size
      if (codeLanguages.has(languageOf(file.path)) && file.size <= 4_000_000) {
        try {
          const buf = await fsp.readFile(file.path)
          if (isBinaryBuffer(buf)) continue
          const lines = buf.toString("utf8").split(/\r?\n/).length
          totalLines += lines
          largest.push({ path: file.relative, lines, bytes: file.size })
        } catch {}
      }
    }
    largest.sort((a, b) => b.lines - a.lines)
    let pkg = null
    try {
      pkg = JSON.parse(await fsp.readFile(path.join(cwd, "package.json"), "utf8"))
    } catch {}
    return {
      cwd,
      files: files.length,
      totalBytes,
      totalLines,
      byExtension: Object.entries(byExt).sort((a, b) => b[1] - a[1]).slice(0, 30),
      largest: largest.slice(0, 25),
      package: pkg ? { name: pkg.name, version: pkg.version, scripts: pkg.scripts || {}, dependencies: Object.keys(pkg.dependencies || {}).length, devDependencies: Object.keys(pkg.devDependencies || {}).length } : null,
    }
  }

  if (action === "outline" || action === "analyze_file") {
    if (!args.path) throw new ToolError("path is required", "BAD_INPUT")
    const file = await readProjectFile(args.path)
    const outline = outlineText(file.text, file.path)
    return {
      ...outline,
      imports: importList(file.text),
      exports: [...file.text.matchAll(/\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type)\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]),
      complexity: complexity(file.text),
      todos: [...file.text.matchAll(/\b(TODO|FIXME|HACK|XXX)\b[^\n]*/g)].map((m) => m[0].slice(0, 200)).slice(0, 50),
    }
  }

  if (action === "symbols" || action === "search") {
    const pattern = String(args.query || args.pattern || "")
    if (!pattern) throw new ToolError("query is required", "BAD_INPUT")
    const files = await walkFiles(cwd, { maxFiles: Number(args.maxFiles || 6000) })
    const regex = new RegExp(pattern, args.regex ? "g" : "gi")
    const results = []
    for (const file of files) {
      if (!["typescript", "javascript", "python", "rust", "go", "java", "csharp", "cpp", "c"].includes(languageOf(file.path))) continue
      if (file.size > 2_000_000) continue
      const text = await fsp.readFile(file.path, "utf8").catch(() => "")
      const lines = text.split(/\r?\n/)
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          results.push({ file: file.relative, line: i + 1, text: lines[i].trim().slice(0, 300) })
          if (results.length >= Number(args.limit || 200)) break
        }
      }
      if (results.length >= Number(args.limit || 200)) break
    }
    return { query: pattern, count: results.length, results }
  }

  if (action === "dependencies" || action === "deps") {
    const pkgPath = path.join(cwd, "package.json")
    let pkg
    try {
      pkg = JSON.parse(await fsp.readFile(pkgPath, "utf8"))
    } catch {
      throw new ToolError("package.json not found in this directory", "NOT_FOUND")
    }
    const files = await walkFiles(cwd, { maxFiles: 4000 })
    const imports = new Map()
    for (const file of files) {
      if (!["typescript", "javascript"].includes(languageOf(file.path))) continue
      const text = await fsp.readFile(file.path, "utf8").catch(() => "")
      for (const spec of importList(text)) {
        const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]
        if (!name || name.startsWith(".")) continue
        imports.set(name, (imports.get(name) || 0) + 1)
      }
    }
    return {
      declared: { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) },
      used: [...imports.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
      undeclared: [...imports.keys()].filter((name) => !(pkg.dependencies?.[name] || pkg.devDependencies?.[name]) && !["node", "fs", "path", "os", "crypto", "http", "https", "url", "util", "stream", "events", "child_process", "assert", "buffer", "net", "tls", "dns", "zlib", "readline", "worker_threads", "node:fs", "node:path"].includes(name)),
    }
  }

  if (action === "security_scan" || action === "secrets") {
    const files = await walkFiles(cwd, { maxFiles: Number(args.maxFiles || 6000) })
    const findings = []
    for (const file of files) {
      if (file.size > 2_000_000) continue
      if (!["typescript", "javascript", "python", "json", "yaml", "shell", "html", "text"].includes(languageOf(file.path))) continue
      const text = await fsp.readFile(file.path, "utf8").catch(() => "")
      findings.push(...securityFindings(file.relative, text))
      if (findings.length >= 300) break
    }
    return { cwd, findings, count: findings.length, high: findings.filter((f) => f.severity === "high").length }
  }

  if (action === "diff") {
    if (!args.path || !args.path2) throw new ToolError("diff needs path and path2", "BAD_INPUT")
    const a = await readProjectFile(args.path)
    const b = await readProjectFile(args.path2)
    return { a: a.path, b: b.path, ...lineDiff(a.text, b.text) }
  }

  if (action === "test" || action === "build" || action === "lint" || action === "typecheck" || action === "run_script") {
    const pkg = JSON.parse(await fsp.readFile(path.join(cwd, "package.json"), "utf8").catch(() => "{}"))
    const script = args.script || { test: "test", build: "build", lint: "lint", typecheck: "typecheck" }[action]
    if (args.script || action === "run_script") {
      if (!script || !pkg.scripts?.[script]) throw new ToolError(`npm script not found: ${script}`, "NOT_FOUND")
      return await npm(["run", script], cwd, Number(args.timeout || 110_000))
    }
    if (action === "typecheck" && !pkg.scripts?.typecheck) {
      const tsc = await whichAsync("tsc")
      if (!tsc) throw new ToolError("tsc is not installed", "NO_TSC")
      const res = await runProcess(tsc, ["--noEmit"], { cwd, timeout: Number(args.timeout || 110_000) })
      return { code: res.code, stdout: truncate(res.stdout, 30_000), stderr: truncate(res.stderr, 20_000) }
    }
    if (!pkg.scripts?.[script]) throw new ToolError(`npm script not found: ${script}`, "NOT_FOUND")
    return await npm(["run", script], cwd, Number(args.timeout || 110_000))
  }

  if (action === "package") {
    const sub = args.subaction || "list"
    const map = {
      install: ["install", ...(Array.isArray(args.packages) ? args.packages : args.packages ? [String(args.packages)] : [])],
      uninstall: ["uninstall", ...(Array.isArray(args.packages) ? args.packages : args.packages ? [String(args.packages)] : [])],
      update: ["update"],
      audit: ["audit", "--json"],
      outdated: ["outdated", "--json"],
      list: ["ls", "--depth=0"],
    }
    const cmd = map[sub]
    if (!cmd) throw new ToolError(`unknown package subaction: ${sub}`, "BAD_INPUT")
    return await npm(cmd, cwd, Number(args.timeout || 110_000))
  }

  throw new ToolError(`unknown code action: ${action}`, "BAD_INPUT")
}
