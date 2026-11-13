import { errorResult, jsonResult } from "../lib/core.mjs"
import { databaseAction } from "../lib/data.mjs"

export const databaseTool = {
  register(server, { z }) {
    server.registerTool(
      "database",
      {
        title: "SQLite database",
        description:
          "Create and query local SQLite databases: run SQL, inspect tables/schema, insert rows, import CSV/JSON, export data, create tables, back up and restore. Use this automatically for structured local data, logs, inventory, analytics or when a task needs SQL.",
        inputSchema: {
          action: z.enum(["query", "exec", "migrate", "tables", "schema", "insert", "export", "import", "backup", "restore", "create_table"]),
          path: z.string().optional().describe("SQLite database file (created if missing)."),
          path2: z.string().optional().describe("Backup file for restore."),
          query: z.string().optional(),
          sql: z.string().optional(),
          params: z.any().optional(),
          table: z.string().optional(),
          rows: z.any().optional(),
          columns: z.any().optional(),
          format: z.enum(["json", "csv"]).optional(),
          output: z.string().optional(),
          limit: z.number().int().positive().optional(),
          confirm: z.boolean().optional(),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      },
      async (args) => {
        try {
          return jsonResult(await databaseAction(args))
        } catch (error) {
          return errorResult(error)
        }
      },
    )
  },
}
