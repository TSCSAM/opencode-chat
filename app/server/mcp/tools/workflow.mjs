import { errorResult, jsonResult } from "../lib/core.mjs"
import { workflowAction } from "../lib/workflow.mjs"

export const workflowTool = {
  register(server, ctx) {
    server.registerTool(
      "workflow",
      {
        title: "Tasks, plans and workflows",
        description:
          "Maintain a persistent task list and plan, run multi-step workflows sequentially or in parallel with retries, and schedule recurring workflows while the app is running. Steps use other tools by name, e.g. [{tool:'web',args:{action:'search',query:'...'}},{tool:'documents',args:{...}}]. Use this automatically for multi-step work, long tasks, checklists or repeated automation.",
        inputSchema: {
          action: ctx.z.enum([
            "task_add",
            "task_list",
            "task_update",
            "task_delete",
            "plan",
            "plan_list",
            "plan_update",
            "run",
            "schedule_add",
            "schedule_list",
            "schedule_delete",
            "state",
          ]),
          title: ctx.z.string().optional(),
          text: ctx.z.string().optional(),
          notes: ctx.z.string().optional(),
          status: ctx.z.string().optional(),
          priority: ctx.z.string().optional(),
          due: ctx.z.string().optional(),
          id: ctx.z.string().optional(),
          goal: ctx.z.string().optional(),
          steps: ctx.z.any().optional(),
          parallel: ctx.z.boolean().optional(),
          mode: ctx.z.enum(["sequential", "parallel"]).optional(),
          retries: ctx.z.number().int().min(0).max(5).optional(),
          stopOnError: ctx.z.boolean().optional(),
          timeout: ctx.z.number().int().positive().optional(),
          intervalMinutes: ctx.z.number().int().positive().optional(),
          minutes: ctx.z.number().int().positive().optional(),
          limit: ctx.z.number().int().positive().optional(),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      },
      async (args) => {
        try {
          return jsonResult(await workflowAction(args, ctx))
        } catch (error) {
          return errorResult(error)
        }
      },
    )
  },
}
