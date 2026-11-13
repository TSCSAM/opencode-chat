import { errorResult, jsonResult } from "../lib/core.mjs"
import { mediaInfo, mediaProcess, speechToText, textToSpeech, videoGenerate } from "../lib/media.mjs"

export const mediaTool = {
  register(server, { z }) {
    server.registerTool(
      "media",
      {
        title: "Video, audio and speech",
        description:
          "Inspect, convert, trim, compress, resize, merge, mute, speed up, generate GIFs/thumbnails/frames, extract or replace audio, burn subtitles, detect scenes/silence, normalize audio, synthesize speech (Windows TTS) and transcribe with a configured provider. Uses bundled ffmpeg. Use this automatically for any video/audio task.",
        inputSchema: {
          action: z.enum([
            "info",
            "convert",
            "extract_frame",
            "thumbnail",
            "resize",
            "compress",
            "trim",
            "extract_audio",
            "mute",
            "replace_audio",
            "gif",
            "subtitles",
            "speed",
            "normalize_audio",
            "scene_detect",
            "silence_detect",
            "merge",
            "tts",
            "stt",
            "video_generate",
          ]),
          path: z.string().optional(),
          path2: z.string().optional(),
          audio: z.string().optional(),
          subtitles: z.string().optional(),
          output: z.string().optional(),
          files: z.array(z.string()).optional(),
          text: z.string().optional(),
          prompt: z.string().optional(),
          format: z.string().optional(),
          at: z.string().optional(),
          start: z.any().optional(),
          end: z.any().optional(),
          duration: z.any().optional(),
          width: z.number().optional(),
          height: z.number().optional(),
          quality: z.number().optional(),
          crf: z.number().optional(),
          preset: z.string().optional(),
          fps: z.number().optional(),
          speed: z.number().optional(),
          rate: z.number().optional(),
          volume: z.number().optional(),
          threshold: z.number().optional(),
          noise: z.string().optional(),
          reencode: z.boolean().optional(),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      },
      async (args) => {
        try {
          if (args.action === "info") return jsonResult(await mediaInfo(args.path))
          if (args.action === "tts") return jsonResult(await textToSpeech(args))
          if (args.action === "stt") return jsonResult(await speechToText(args))
          if (args.action === "video_generate") return jsonResult(await videoGenerate(args))
          return jsonResult(await mediaProcess(args))
        } catch (error) {
          return errorResult(error)
        }
      },
    )
  },
}
