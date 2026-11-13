import fs from "node:fs"
import path from "node:path"
import { ToolError, WORKSPACE, parseBool, resolvePath, runProcess, truncate, whichAsync } from "./core.mjs"
import { fetchJson } from "./http.mjs"

let gitCache

export async function findGit() {
  if (gitCache !== undefined) return gitCache
  const candidates = [
    process.env.GIT_PATH,
    "C:\\Program Files\\Git\\cmd\\git.exe",
    "C:\\Program Files (x86)\\Git\\cmd\\git.exe",
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "Programs", "Git", "cmd", "git.exe")
      : "",
  ].filter(Boolean)
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      gitCache = candidate
      return candidate
    }
  }
  gitCache = await whichAsync("git")
  return gitCache
}

async function git(args, options = {}) {
  const exe = await findGit()
  if (!exe) throw new ToolError("git is not installed or not on PATH. Install Git for Windows, then retry.", "NO_GIT")
  const cwd = resolvePath(options.cwd || ".", { mustExist: true })
  const res = await runProcess(exe, args, { cwd, timeout: options.timeout || 60_000 })
  if (res.code !== 0) throw new ToolError(`git ${args.join(" ")} failed: ${(res.stderr || res.stdout).slice(0, 2000)}`, "GIT_FAILED")
  return { ...res, cwd }
}

export async function gitAction(args) {
  const action = args.action
  const cwd = args.cwd || "."
  if (action === "version") {
    const exe = await findGit()
    return { installed: Boolean(exe), path: exe || null }
  }
  if (action === "init") {
    await git(["init"], { cwd })
    return { initialized: true, cwd: resolvePath(cwd) }
  }
  if (action === "clone") {
    if (!args.url) throw new ToolError("clone needs url", "BAD_INPUT")
    const target = resolvePath(args.path || path.basename(args.url).replace(/\.git$/, ""), { createParent: true })
    const res = await git(["clone", String(args.url), target], { cwd: args.cwd || "." })
    return { path: target, output: truncate(res.stderr || res.stdout, 4000) }
  }
  if (action === "status") {
    const res = await git(["status", "--short", "--branch"], { cwd })
    return { cwd: res.cwd, status: res.stdout.trim() || "clean" }
  }
  if (action === "diff") {
    const argsList = ["diff", ...(parseBool(args.staged, false) ? ["--cached"] : []), ...(args.path ? ["--", String(args.path)] : [])]
    const res = await git(argsList, { cwd })
    return { diff: truncate(res.stdout, 60_000), stat: (await git(["diff", "--stat", ...(parseBool(args.staged, false) ? ["--cached"] : [])], { cwd })).stdout.trim() }
  }
  if (action === "log") {
    const limit = Math.max(1, Math.min(200, Number(args.limit || 20)))
    const res = await git(["log", `-${limit}`, "--pretty=format:%h|%ad|%an|%s", "--date=iso"], { cwd })
    return { commits: res.stdout.split(/\r?\n/).filter(Boolean).map((line) => { const [hash, date, author, subject] = line.split("|"); return { hash, date, author, subject } }) }
  }
  if (action === "show") {
    const res = await git(["show", "--stat", "--oneline", String(args.ref || "HEAD")], { cwd })
    return { output: truncate(res.stdout, 60_000) }
  }
  if (action === "branches" || action === "branch") {
    if (args.name && args.create) {
      await git(["branch", String(args.name)], { cwd })
      return { created: args.name }
    }
    const res = await git(["branch", "-a"], { cwd })
    return { branches: res.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) }
  }
  if (action === "checkout") {
    if (!args.ref) throw new ToolError("checkout needs ref", "BAD_INPUT")
    const flags = args.create ? ["-b"] : []
    const res = await git(["checkout", ...flags, String(args.ref)], { cwd })
    return { output: truncate(res.stderr || res.stdout, 3000), ref: args.ref }
  }
  if (action === "add") {
    const files = Array.isArray(args.files) ? args.files.map(String) : args.files ? [String(args.files)] : ["."]
    await git(["add", ...files], { cwd })
    return { added: files }
  }
  if (action === "commit") {
    if (!args.message) throw new ToolError("commit needs message", "BAD_INPUT")
    if (!parseBool(args.confirm, false)) throw new ToolError("commit requires confirm: true", "CONFIRM_REQUIRED")
    if (!parseBool(args.noAdd, false)) await git(["add", "-A"], { cwd })
    const res = await git(["commit", "-m", String(args.message)], { cwd })
    return { output: truncate(res.stdout || res.stderr, 4000) }
  }
  if (action === "push") {
    if (!parseBool(args.confirm, false)) throw new ToolError("push requires confirm: true", "CONFIRM_REQUIRED")
    const res = await git(["push", ...(args.remote ? [String(args.remote)] : []), ...(args.ref ? [String(args.ref)] : [])], { cwd })
    return { output: truncate(res.stderr || res.stdout, 4000) }
  }
  if (action === "pull") {
    const res = await git(["pull", ...(args.remote ? [String(args.remote)] : []), ...(args.ref ? [String(args.ref)] : [])], { cwd })
    return { output: truncate(res.stdout || res.stderr, 4000) }
  }
  if (action === "fetch") {
    const res = await git(["fetch", ...(args.remote ? [String(args.remote)] : [])], { cwd })
    return { output: truncate(res.stderr || res.stdout, 2000) }
  }
  if (action === "merge") {
    if (!args.ref) throw new ToolError("merge needs ref", "BAD_INPUT")
    const res = await git(["merge", String(args.ref)], { cwd })
    return { output: truncate(res.stdout || res.stderr, 5000) }
  }
  if (action === "stash") {
    const res = await git(["stash", ...(args.message ? ["push", "-m", String(args.message)] : [])], { cwd })
    return { output: truncate(res.stdout, 3000) }
  }
  if (action === "stash_pop") {
    const res = await git(["stash", "pop"], { cwd })
    return { output: truncate(res.stdout || res.stderr, 3000) }
  }
  if (action === "remotes") {
    const res = await git(["remote", "-v"], { cwd })
    return { remotes: res.stdout.split(/\r?\n/).filter(Boolean) }
  }
  if (action === "tags") {
    const res = await git(["tag", "--sort=-creatordate"], { cwd })
    return { tags: res.stdout.split(/\r?\n/).filter(Boolean).slice(0, 100) }
  }
  if (action === "blame") {
    if (!args.path) throw new ToolError("blame needs path", "BAD_INPUT")
    const res = await git(["blame", "--line-porcelain", String(args.path)], { cwd })
    return { output: truncate(res.stdout, 40_000) }
  }
  if (action === "grep") {
    if (!args.query) throw new ToolError("grep needs query", "BAD_INPUT")
    const res = await git(["grep", "-n", "-I", String(args.query)], { cwd })
    return { output: truncate(res.stdout, 30_000) }
  }
  if (action === "reset") {
    if (!parseBool(args.confirm, false)) throw new ToolError("reset requires confirm: true", "CONFIRM_REQUIRED")
    const mode = args.hard ? "--hard" : "--mixed"
    const res = await git(["reset", mode, String(args.ref || "HEAD")], { cwd })
    return { output: truncate(res.stdout || res.stderr, 3000) }
  }
  if (action === "clean") {
    if (!parseBool(args.confirm, false)) throw new ToolError("clean requires confirm: true", "CONFIRM_REQUIRED")
    const res = await git(["clean", "-fd"], { cwd })
    return { output: truncate(res.stdout, 3000) }
  }
  if (action === "config") {
    const res = await git(["config", "--list"], { cwd })
    return { config: res.stdout.split(/\r?\n/).filter((line) => !/token|password|secret/i.test(line)).slice(0, 200) }
  }
  throw new ToolError(`unknown git action: ${action}`, "BAD_INPUT")
}

export async function githubAction(args) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  if (!token) throw new ToolError("GitHub integration needs GITHUB_TOKEN (or GH_TOKEN) in the environment.", "PROVIDER_NOT_CONFIGURED")
  const api = async (endpoint, options = {}) => {
    const res = await fetchJson(`https://api.github.com${endpoint}`, {
      method: options.method || "GET",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "OpenCodeChatTools/1.9",
        ...(options.body ? { "content-type": "application/json" } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      timeout: 30_000,
    })
    return res.json
  }
  const action = args.action
  if (action === "repo") {
    if (!args.repo) throw new ToolError("repo is required", "BAD_INPUT")
    const data = await api(`/repos/${args.repo}`)
    return { fullName: data.full_name, description: data.description, stars: data.stargazers_count, forks: data.forks_count, openIssues: data.open_issues_count, defaultBranch: data.default_branch, url: data.html_url }
  }
  if (action === "search_repos") {
    const data = await api(`/search/repositories?q=${encodeURIComponent(args.query || "")}&per_page=${Math.min(30, Number(args.limit || 10))}`)
    return { items: (data.items || []).map((item) => ({ fullName: item.full_name, description: item.description, stars: item.stargazers_count, url: item.html_url, language: item.language })) }
  }
  if (action === "search_code") {
    const data = await api(`/search/code?q=${encodeURIComponent(args.query || "")}&per_page=${Math.min(30, Number(args.limit || 10))}`)
    return { items: (data.items || []).map((item) => ({ name: item.name, path: item.path, repo: item.repository?.full_name, url: item.html_url })) }
  }
  if (action === "issues") {
    if (!args.repo) throw new ToolError("repo is required", "BAD_INPUT")
    const state = args.state || "open"
    const data = await api(`/repos/${args.repo}/issues?state=${encodeURIComponent(state)}&per_page=${Math.min(50, Number(args.limit || 20))}`)
    return { issues: (data || []).filter((item) => !item.pull_request).map((item) => ({ number: item.number, title: item.title, state: item.state, user: item.user?.login, labels: item.labels?.map((l) => l.name), url: item.html_url, created: item.created_at })) }
  }
  if (action === "pulls") {
    if (!args.repo) throw new ToolError("repo is required", "BAD_INPUT")
    const data = await api(`/repos/${args.repo}/pulls?state=${encodeURIComponent(args.state || "open")}&per_page=${Math.min(50, Number(args.limit || 20))}`)
    return { pulls: (data || []).map((item) => ({ number: item.number, title: item.title, state: item.state, user: item.user?.login, head: item.head?.ref, base: item.base?.ref, url: item.html_url, draft: item.draft })) }
  }
  if (action === "create_issue") {
    if (!args.repo || !args.title) throw new ToolError("repo and title are required", "BAD_INPUT")
    const data = await api(`/repos/${args.repo}/issues`, { method: "POST", body: { title: args.title, body: args.body || "" } })
    return { number: data.number, url: data.html_url }
  }
  if (action === "create_pr") {
    if (!args.repo || !args.title || !args.head || !args.base) throw new ToolError("repo, title, head and base are required", "BAD_INPUT")
    const data = await api(`/repos/${args.repo}/pulls`, { method: "POST", body: { title: args.title, head: args.head, base: args.base, body: args.body || "" } })
    return { number: data.number, url: data.html_url }
  }
  throw new ToolError(`unknown GitHub action: ${action}`, "BAD_INPUT")
}
