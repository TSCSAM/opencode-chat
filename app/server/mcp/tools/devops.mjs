import { errorResult, jsonResult } from "../lib/core.mjs"
import { devopsAction } from "../lib/devops.mjs"

export const devopsTool = {
  register(server, { z }) {
    server.registerTool(
      "devops",
      {
        title: "Servers, Docker, Kubernetes and network",
        description:
          "Run SSH/SCP commands, inspect DNS, TCP ports and TLS certificates, and operate Docker or Kubernetes when those CLIs are installed. Also reports which deployment CLIs are available. Use this automatically for remote-server, container, deployment, DNS or TLS work.",
        inputSchema: {
          action: z.enum(["ssh", "scp", "dns", "port", "ssl", "docker", "kubectl", "which"]),
          host: z.string().optional(),
          hostname: z.string().optional(),
          user: z.string().optional(),
          port: z.number().int().positive().optional(),
          key: z.string().optional(),
          command: z.string().optional(),
          path: z.string().optional(),
          remote: z.string().optional(),
          direction: z.enum(["upload", "download"]).optional(),
          subaction: z.string().optional(),
          name: z.string().optional(),
          namespace: z.string().optional(),
          resource: z.string().optional(),
          replicas: z.number().int().positive().optional(),
          cwd: z.string().optional(),
          limit: z.number().int().positive().optional(),
          timeout: z.number().int().positive().optional(),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      },
      async (args) => {
        try {
          return jsonResult(await devopsAction(args))
        } catch (error) {
          return errorResult(error)
        }
      },
    )
  },
}
