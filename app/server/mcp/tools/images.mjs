import fsp from "node:fs/promises"
import {
  ToolError,
  errorResult,
  imageResult,
  jsonResult,
  mimeFromExt,
  resolvePath,
} from "../lib/core.mjs"
import { imageGenerate, imageInfo, imageOcr, imageProcess, imageVisionPayload } from "../lib/image.mjs"

export const imagesTool = {
  register(server, { z }) {
    server.registerTool(
      "images",
      {
        title: "Images, screenshots and OCR",
        description:
          "Inspect, view, resize, crop, rotate, flip, compress, convert, annotate, watermark, compare, background-remove and OCR images. Use view to let a vision-capable model see an image. image generation works when OPENCODE_CHAT_IMAGE_API_KEY is configured. Use this automatically for screenshots, photos, diagrams, icons and visual comparisons.",
        inputSchema: {
          action: z.enum([
            "info",
            "view",
            "resize",
            "crop",
            "rotate",
            "flip",
            "compress",
            "convert",
            "grayscale",
            "blur",
            "watermark",
            "annotate",
            "remove_background",
            "compare",
            "ocr",
            "generate",
          ]),
          path: z.string().optional().describe("Input image."),
          path2: z.string().optional().describe("Second image for compare."),
          output: z.string().optional().describe("Output path."),
          prompt: z.string().optional().describe("Image generation prompt."),
          text: z.string().optional().describe("Watermark/annotation text."),
          operations: z.any().optional().describe("Annotation operations array."),
          width: z.number().optional(),
          height: z.number().optional(),
          x: z.number().optional(),
          y: z.number().optional(),
          size: z.number().optional(),
          color: z.string().optional(),
          degrees: z.number().optional(),
          quality: z.number().optional(),
          amount: z.number().optional(),
          tolerance: z.number().optional(),
          format: z.enum(["png", "jpg", "jpeg", "webp"]).optional(),
          direction: z.enum(["horizontal", "vertical"]).optional(),
          returnImage: z.boolean().optional().describe("Return the edited image for vision (default true for view/compare)."),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      },
      async (args) => {
        try {
          if (args.action === "info") return jsonResult(await imageInfo(args.path))
          if (args.action === "ocr") return jsonResult(await imageOcr(args.path))
          if (args.action === "generate") return jsonResult(await imageGenerate(args))
          if (args.action === "view") {
            const payload = await imageVisionPayload(args.path)
            return imageResult(payload.content.find((part) => part.type === "image") ? Buffer.from(payload.content.find((part) => part.type === "image").data, "base64") : Buffer.alloc(0), mimeFromExt(payload.path), `Image: ${payload.path}`)
          }
          if (args.action === "compare") {
            const result = await imageProcess({ ...args, action: "compare" })
            return imageResult(result.diffBuffer, "image/png", `Diff: ${result.percent}% (${result.diffPixels}/${result.totalPixels} pixels)${result.output ? `\nSaved: ${result.output}` : ""}`)
          }
          const result = await imageProcess(args)
          if (args.returnImage === false) {
            const { buffer, ...meta } = result
            return jsonResult(meta)
          }
          return imageResult(result.buffer, result.mime, `${args.action} complete: ${result.path} (${result.bytes} bytes)`)
        } catch (error) {
          return errorResult(error)
        }
      },
    )
  },
}
