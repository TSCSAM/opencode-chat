export type PermissionEffect = "allow" | "deny" | "ask"
export type PermissionRule = { action: string; resource: string; effect: PermissionEffect }
export type PermissionMode = "plan" | "ask" | "auto" | "full"

const MCP = "opencode-chat-tools_"

// These MCP modules can write files, run commands or change local state. The
// read-only modules (web, maps, seo, translate, catalog, ...) are intentionally
// left alone so "Ask before changes" does not turn every web search into a
// confirmation card.
const MUTATING_MCP = [
  "files",
  "shell",
  "code",
  "git",
  "devops",
  "documents",
  "database",
  "media",
  "images",
  "system",
  "comms",
  "workflow",
  "memory",
]

const deny = (action: string): PermissionRule => ({ action, resource: "*", effect: "deny" })
const ask = (action: string): PermissionRule => ({ action, resource: "*", effect: "ask" })

// Plan: read and research, never change the machine. Native edits, shells and
// subagents are blocked, and the whole local tool hub is blocked because its
// files/shell tools bypass the native edit permission.
const PLAN_RULES: PermissionRule[] = [
  ...["edit", "shell", "execute", "subagent"].map(deny),
  deny(`${MCP}*`),
]

// Ask: every action that can change files or the machine waits for approval.
const ASK_RULES: PermissionRule[] = [
  ...["edit", "shell", "execute"].map(ask),
  ...MUTATING_MCP.map((name) => ask(`${MCP}${name}`)),
]

// Autonomous: the engine's normal behavior, plus explicit prompts for the
// operations that are hard to undo.
const AUTO_RULES: PermissionRule[] = [
  ask("external_directory"),
  { action: "shell", resource: "rm -rf *", effect: "ask" },
  { action: "shell", resource: "rm -r *", effect: "ask" },
  { action: "shell", resource: "del *", effect: "ask" },
  { action: "shell", resource: "rmdir *", effect: "ask" },
  { action: "shell", resource: "format *", effect: "ask" },
  { action: "shell", resource: "shutdown *", effect: "ask" },
  { action: "shell", resource: "taskkill *", effect: "ask" },
  { action: "shell", resource: "git push *", effect: "ask" },
  { action: "shell", resource: "git reset --hard *", effect: "ask" },
  { action: "shell", resource: "git clean *", effect: "ask" },
]

// Full: the model can act without confirmation, including actions an agent
// normally denies (the session ruleset is appended last and wins).
const FULL_RULES: PermissionRule[] = [{ action: "*", resource: "*", effect: "allow" }]

export const PERMISSION_MODES: {
  id: PermissionMode
  title: string
  description: string
  tone: string
}[] = [
  { id: "plan", title: "Plan mode", description: "Plan before editing.", tone: "plan" },
  { id: "ask", title: "Ask before changes", description: "Ask before file changes.", tone: "ask" },
  { id: "auto", title: "Autonomous mode", description: "Ask when there's risk.", tone: "auto" },
  { id: "full", title: "Full access", description: "Run with fewer confirmations.", tone: "full" },
]

export const DEFAULT_PERMISSION_MODE: PermissionMode = "auto"
export const PERMISSION_STORAGE_KEY = "oc-permission"

export function rulesForMode(mode: PermissionMode): PermissionRule[] {
  switch (mode) {
    case "plan":
      return PLAN_RULES
    case "ask":
      return ASK_RULES
    case "full":
      return FULL_RULES
    default:
      return AUTO_RULES
  }
}

function sameRules(a: PermissionRule[], b: PermissionRule[]) {
  if (a.length !== b.length) return false
  return a.every(
    (rule, i) =>
      rule.action === b[i].action && rule.resource === b[i].resource && rule.effect === b[i].effect,
  )
}

/** Maps an engine session ruleset back to the picker. Unknown/custom rulesets
 *  are shown as Autonomous mode until the user chooses a preset again. */
export function modeFromRuleset(rules?: PermissionRule[] | null): PermissionMode {
  if (!Array.isArray(rules) || rules.length === 0) return DEFAULT_PERMISSION_MODE
  for (const mode of PERMISSION_MODES) {
    if (sameRules(rules, rulesForMode(mode.id))) return mode.id
  }
  return DEFAULT_PERMISSION_MODE
}

export function isPermissionMode(value: unknown): value is PermissionMode {
  return value === "plan" || value === "ask" || value === "auto" || value === "full"
}

export function loadPermissionMode(): PermissionMode {
  try {
    const saved = localStorage.getItem(PERMISSION_STORAGE_KEY)
    return isPermissionMode(saved) ? saved : DEFAULT_PERMISSION_MODE
  } catch {
    return DEFAULT_PERMISSION_MODE
  }
}
