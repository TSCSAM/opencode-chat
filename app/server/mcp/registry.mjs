import { filesTool } from "./tools/files.mjs"
import { documentsTool } from "./tools/documents.mjs"
import { webTool } from "./tools/web.mjs"
import { browserTool } from "./tools/browser.mjs"
import { imagesTool } from "./tools/images.mjs"
import { dataTool } from "./tools/data.mjs"
import { databaseTool } from "./tools/database.mjs"
import { mediaTool } from "./tools/media.mjs"
import { memoryTool } from "./tools/memory.mjs"
import { systemTools } from "./tools/system.mjs"
import { shellTool } from "./tools/shell.mjs"
import { codeTool } from "./tools/code.mjs"
import { gitTool } from "./tools/git.mjs"
import { devopsTool } from "./tools/devops.mjs"
import { mapsTool } from "./tools/maps.mjs"
import { seoTool } from "./tools/seo.mjs"
import { commsTool } from "./tools/comms.mjs"
import { workflowTool } from "./tools/workflow.mjs"
import { translateTool } from "./tools/translate.mjs"
import { catalogTool } from "./tools/catalog.mjs"
import { restoreSchedules } from "./lib/workflow.mjs"

// Each module exports { register(server, ctx) }. Modules are loaded eagerly so
// tools/list is complete on the first request, but heavy libraries are imported
// lazily inside their handlers.
const MODULES = [
  filesTool,
  documentsTool,
  webTool,
  browserTool,
  imagesTool,
  dataTool,
  databaseTool,
  mediaTool,
  memoryTool,
  systemTools,
  shellTool,
  codeTool,
  gitTool,
  devopsTool,
  mapsTool,
  seoTool,
  commsTool,
  workflowTool,
  translateTool,
  catalogTool,
]

export const HANDLERS = new Map()

export async function registerToolModules(server, ctx) {
  const proxy = Object.create(server)
  proxy.registerTool = function registerTool(name, config, handler) {
    HANDLERS.set(name, handler)
    return server.registerTool(name, config, handler)
  }
  const fullCtx = {
    ...ctx,
    server,
    handlers: HANDLERS,
    callTool: async (name, args) => {
      const handler = HANDLERS.get(String(name))
      if (!handler) {
        return { content: [{ type: "text", text: `Tool error: unknown tool "${name}"` }], isError: true }
      }
      try {
        return await handler(args || {}, {})
      } catch (error) {
        return { content: [{ type: "text", text: `Tool error: ${error?.message ?? error}` }], isError: true }
      }
    },
  }
  for (const module of MODULES) module.register(proxy, fullCtx)
  await restoreSchedules(fullCtx).catch((error) => console.error("[opencode-chat-tools] schedule restore failed:", error?.message ?? error))
}

export const TOOL_MODULES = MODULES
