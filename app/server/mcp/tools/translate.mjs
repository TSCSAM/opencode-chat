import { errorResult, jsonResult } from "../lib/core.mjs"
import { detectLanguage, languages, translateText } from "../lib/translate.mjs"

export const translateTool = {
  register(server, { z }) {
    server.registerTool(
      "translate",
      {
        title: "Translation and language detection",
        description:
          "Translate text between languages (English, Persian, Arabic, Turkish, German, French, Spanish and more) and detect the language. Uses LibreTranslate when configured, otherwise the free MyMemory service. Use this automatically whenever content needs translation, localization or language detection.",
        inputSchema: {
          action: z.enum(["translate", "detect", "languages"]),
          text: z.string().optional(),
          source: z.string().optional().describe("Source language code, default auto."),
          target: z.string().optional().describe("Target language code, default en."),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      },
      async (args) => {
        try {
          if (args.action === "languages") return jsonResult(languages())
          if (args.action === "detect") return jsonResult(await detectLanguage(args.text))
          return jsonResult(await translateText(args))
        } catch (error) {
          return errorResult(error)
        }
      },
    )
  },
}
