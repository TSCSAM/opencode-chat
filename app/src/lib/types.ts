import type { PermissionRule } from "./permissions"

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
  permissions?: PermissionRule[] | null
  metadata?: Record<string, unknown>
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

export type Attachment = { name: string; dataUrl: string; size?: number; type?: string }
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

export type ProviderInfo = {
  id: string
  canonical?: string
  integrationID?: string
  name: string
  activation: "auto" | "enabled" | "disabled" | string
  package?: string
  settings?: Record<string, any>
  headers?: Record<string, string>
  body?: Record<string, any>
}

export type IntegrationMethod = {
  type: "key" | "env" | "oauth" | "external" | "command" | string
  id?: string
  label?: string
  names?: string[]
  form?: FormFieldShape[]
}

export type ConnectionStatus = { status: string; message?: string; url?: string }

export type IntegrationConnection =
  | { type: "credential"; id: string; label: string; method: string; status?: ConnectionStatus }
  | { type: "env"; name: string; status?: ConnectionStatus }

export type IntegrationInfo = {
  id: string
  name: string
  metadata?: Record<string, any>
  methods: IntegrationMethod[]
  connections: IntegrationConnection[]
}

export type CredentialEntry = {
  id: string
  integrationID: string
  label: string
  active: boolean
  value: { type?: string; key?: string; methodID?: string; metadata?: Record<string, any> }
}

export type UpdateCheck = {
  current?: string
  latest?: string | null
  available?: boolean
  checkedAt?: number
  error?: string
}
