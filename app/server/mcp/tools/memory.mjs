import { errorResult, jsonResult } from "../lib/core.mjs"
import { memoryAction } from "../lib/memory.mjs"

export const memoryTool = {
  register(server, { z }) {
    server.registerTool(
      "memory",
      {
        title: "Persistent memory",
        description:
          "Store and retrieve durable notes, decisions, user preferences, project facts and prior findings. Search is lexical and tag-aware. Use this automatically before starting a task to recall relevant context, and after learning something durable that should survive future sessions.",
        inputSchema: {
          action: z.enum(["add", "search", "list", "update", "delete", "clear", "stats", "context"]),
          text: z.string().optional(),
          query: z.string().optional(),
          tags: z.any().optional(),
          source: z.string().optional(),
          id: z.string().optional(),
          limit: z.number().int().positive().max(500).optional(),
          confirm: z.boolean().optional(),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      },
      async (args) => {
        try {
          return jsonResult(await memoryAction(args))
        } catch (error) {
          return errorResult(error)
        }
      },
    )
  },
}
