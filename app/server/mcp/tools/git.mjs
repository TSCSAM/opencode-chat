import { ToolError, errorResult, jsonResult } from "../lib/core.mjs"
import { findGit, gitAction, githubAction } from "../lib/git.mjs"

export const gitTool = {
  register(server, { z }) {
    server.registerTool(
      "git",
      {
        title: "Git and GitHub",
        description:
          "Inspect and operate Git repositories (status, diff, log, branches, checkout, add, commit, push, pull, merge, stash, tags, blame, grep) and the GitHub API (repo, search, issues, pull requests). Use this automatically for version-control or repository tasks. commit/push/reset/clean require confirm:true.",
        inputSchema: {
          action: z.enum([
            "version",
            "init",
            "clone",
            "status",
            "diff",
            "log",
            "show",
            "branches",
            "branch",
            "checkout",
            "add",
            "commit",
            "push",
            "pull",
            "fetch",
            "merge",
            "stash",
            "stash_pop",
            "remotes",
            "tags",
            "blame",
            "grep",
            "reset",
            "clean",
            "config",
            "repo",
            "search_repos",
            "search_code",
            "issues",
            "pulls",
            "create_issue",
            "create_pr",
          ]),
          cwd: z.string().optional(),
          path: z.string().optional(),
          path2: z.string().optional(),
          files: z.any().optional(),
          url: z.string().optional(),
          ref: z.string().optional(),
          name: z.string().optional(),
          message: z.string().optional(),
          remote: z.string().optional(),
          repo: z.string().optional().describe("owner/repository for GitHub."),
          query: z.string().optional(),
          title: z.string().optional(),
          body: z.string().optional(),
          head: z.string().optional(),
          base: z.string().optional(),
          state: z.string().optional(),
          limit: z.number().int().positive().optional(),
          staged: z.boolean().optional(),
          create: z.boolean().optional(),
          hard: z.boolean().optional(),
          noAdd: z.boolean().optional(),
          confirm: z.boolean().optional(),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      },
      async (args) => {
        try {
          const github = ["repo", "search_repos", "search_code", "issues", "pulls", "create_issue", "create_pr"]
          if (github.includes(args.action)) return jsonResult(await githubAction(args))
          return jsonResult(await gitAction(args))
        } catch (error) {
          return errorResult(error)
        }
      },
    )
  },
}
