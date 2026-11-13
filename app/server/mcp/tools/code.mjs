import { errorResult, jsonResult } from "../lib/core.mjs"
import { codeAction } from "../lib/code.mjs"

export const codeTool = {
  register(server, { z }) {
    server.registerTool(
      "code",
      {
        title: "Codebase analysis, tests and packages",
        description:
          "Map a project, outline files, find symbols/references, inspect dependencies, scan for security issues/secrets, compare files, run tests/build/lint/typecheck/npm scripts and package operations. Use this automatically before modifying a codebase, when reviewing code, or when verifying a change.",
        inputSchema: {
          action: z.enum(["project_map", "outline", "analyze_file", "symbols", "search", "dependencies", "security_scan", "secrets", "diff", "test", "build", "lint", "typecheck", "run_script", "package"]),
          cwd: z.string().optional(),
          path: z.string().optional(),
          path2: z.string().optional(),
          query: z.string().optional(),
          pattern: z.string().optional(),
          regex: z.boolean().optional(),
          limit: z.number().int().positive().optional(),
          maxFiles: z.number().int().positive().optional(),
          script: z.string().optional(),
          timeout: z.number().int().positive().optional(),
          subaction: z.enum(["install", "uninstall", "update", "audit", "outdated", "list"]).optional(),
          packages: z.any().optional(),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      },
      async (args) => {
        try {
          return jsonResult(await codeAction(args))
        } catch (error) {
          return errorResult(error)
        }
      },
    )
  },
}
