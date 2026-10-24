export type SessionInfo = {
  id: string
  title?: string
  projectID?: string
  agent?: string
  model?: { id: string; providerID: string; variant?: string }
  cost?: number
  tokens?: { input?: number; output?: number; reasoning?: number }
  time: { created: number; updated: number }
  location?: { directory: string }
}

export type Part = {
  type: "text" | "reasoning" | "tool" | "compaction"
  text?: string
  id?: string
  name?: string
  state?: any
  time?: any
  status?: "running" | "completed" | "failed"
  error?: string
  __ordinal?: number
}

export type Message = {
  id: string
  type: "user" | "assistant" | "idle" | "system" | string
  text?: string
  files?: { uri: string; name?: string }[]
  content?: Part[]
  time?: { created?: number; completed?: number; streamed?: number }
  agent?: string
  model?: { id: string; providerID: string; variant?: string }
  finish?: string
  error?: any
  cost?: number
  tokens?: any
}

export type PermissionRequest = {
  id: string
  sessionID: string
  action: string
  resources: string[]
  message?: string
  save?: string[]
  metadata?: any
  source?: any
}

export type ModelRef = { id: string; providerID: string; variant?: string }

export type AgentInfo = {
  id: string
  name: string
  description?: string
  mode?: "primary" | "subagent" | "all"
  hidden?: boolean
  color?: string
}

export type CommandInfo = { name: string; description?: string }
export type SkillInfo = { id: string; name: string; description?: string; autoinvoke?: boolean }
export type SavedPermission = { id: string; projectID?: string; action: string; resource: string; time?: { created?: number; updated?: number } }
export type McpEntry = { name: string; status?: { status?: string } }
export type PluginEntry = { id: string; source?: { type?: string; target?: string; version?: string }; state?: { status?: string } }
export type ConfigEntry = { type: string; path?: string; info?: Record<string, any> }

export type MenuItem = { id: string; label: string; hint?: string; group: string }

export type Attachment = { name: string; dataUrl: string }
export type PromptFile = { uri: string; name?: string }

export type FormOption = { value: string; label: string; description?: string }
export type FormFieldShape = {
  key: string
  title?: string
  description?: string
  type: string
  required?: boolean
  hidden?: boolean
  when?: { key: string; op: string; value: any }[]
  options?: FormOption[]
  custom?: boolean
  default?: any
  placeholder?: string
  url?: string
  minItems?: number
  maxItems?: number
}
export type EngineForm = {
  id: string
  sessionID: string
  title: string
  metadata?: any
  fields: FormFieldShape[]
  state?: { status: "pending" | "answered" | "cancelled"; answer?: any; message?: string }
}

export type ModelInfo = {
  id: string
  modelID?: string
  providerID: string
  name: string
  family?: string
  status?: string
  enabled?: boolean
  variants?: { id: string }[]
  limit?: { context?: number; output?: number }
}
