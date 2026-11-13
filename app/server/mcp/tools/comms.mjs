import { errorResult, jsonResult } from "../lib/core.mjs"
import { commsAction } from "../lib/comms.mjs"

export const commsTool = {
  register(server, { z }) {
    server.registerTool(
      "comms",
      {
        title: "Email, chat, webhooks and notifications",
        description:
          "Send email through SMTP, Slack/Discord/Telegram messages, generic webhooks, SMS through Twilio, desktop notifications, and create/parse calendar ICS files. Credentials come from explicit arguments or the matching environment variables. Use this automatically whenever a task asks to notify, email, message or schedule an event.",
        inputSchema: {
          action: z.enum(["email", "slack", "discord", "telegram", "webhook", "sms", "notification", "calendar_create", "calendar_parse"]),
          url: z.string().optional(),
          host: z.string().optional(),
          port: z.number().int().positive().optional(),
          user: z.string().optional(),
          password: z.string().optional(),
          from: z.string().optional(),
          to: z.string().optional(),
          subject: z.string().optional(),
          text: z.string().optional(),
          html: z.string().optional(),
          attachments: z.array(z.string()).optional(),
          payload: z.any().optional(),
          headers: z.any().optional(),
          name: z.string().optional(),
          title: z.string().optional(),
          token: z.string().optional(),
          chatId: z.string().optional(),
          parseMode: z.string().optional(),
          sid: z.string().optional(),
          start: z.string().optional(),
          end: z.string().optional(),
          location: z.string().optional(),
          output: z.string().optional(),
          path: z.string().optional(),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      },
      async (args) => {
        try {
          return jsonResult(await commsAction(args))
        } catch (error) {
          return errorResult(error)
        }
      },
    )
  },
}
