import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import {
  CACHE_DIR,
  ToolError,
  ensureDir,
  formatBytes,
  parseNumber,
  resolvePath,
  runProcess,
  safeName,
  stamp,
} from "./core.mjs"

let ffmpegPathCache = null

export async function ffmpegPath() {
  if (ffmpegPathCache) return ffmpegPathCache
  const configured = process.env.FFMPEG_PATH
  if (configured && fs.existsSync(configured)) {
    ffmpegPathCache = configured
    return configured
  }
  try {
    const mod = await import("ffmpeg-static")
    const candidate = mod.default || mod
    if (candidate && fs.existsSync(candidate)) {
      ffmpegPathCache = candidate
      return candidate
    }
  } catch {}
  for (const candidate of ["ffmpeg", "C:\\ffmpeg\\bin\\ffmpeg.exe"]) {
    if (candidate.includes("\\")) {
      if (fs.existsSync(candidate)) {
        ffmpegPathCache = candidate
        return candidate
      }
    } else {
      const { which } = await import("./core.mjs")
      const found = which(candidate)
      if (found) {
        ffmpegPathCache = found
        return found
      }
    }
  }
  throw new ToolError("ffmpeg was not found. Set FFMPEG_PATH or install ffmpeg.", "NO_FFMPEG")
}

async function ffmpeg(args, options = {}) {
  const exe = await ffmpegPath()
  const res = await runProcess(exe, ["-hide_banner", "-y", ...args], { timeout: options.timeout || 110_000, cwd: options.cwd || process.cwd() })
  if (res.code !== 0) {
    throw new ToolError(`ffmpeg failed (${res.code}): ${(res.stderr || res.stdout).slice(-1800)}`, "FFMPEG_FAILED")
  }
  return res
}

function outputPath(input, suffix, ext, explicit) {
  if (explicit) return resolvePath(explicit, { createParent: true })
  const base = safeName(path.basename(input, path.extname(input)))
  return path.join(CACHE_DIR, `${base}-${suffix}-${stamp()}.${ext}`)
}

function parseProbe(stderr) {
  const text = String(stderr || "")
  const duration = text.match(/Duration:\s*(\d+):(\d+):([\d.]+)/)
  const video = text.match(/Stream #\d+:\d+.*?Video:\s*([^,\n]+)(?:.*?,\s*(\d{2,5})x(\d{2,5}))?/i)
  const audio = text.match(/Stream #\d+:\d+.*?Audio:\s*([^,\n]+)(?:.*?,\s*(\d+)\s*Hz)?(?:.*?,\s*(\d+)\s*channels)?/i)
  const bitrate = text.match(/bitrate:\s*(\d+)\s*kb\/s/i)
  const size = text.match(/video:(\d+)(?:kB|KiB)/i)
  return {
    duration: duration ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]) : null,
    video: video ? { codec: video[1].trim(), width: video[2] ? Number(video[2]) : null, height: video[3] ? Number(video[3]) : null } : null,
    audio: audio ? { codec: audio[1].trim(), sampleRate: audio[2] ? Number(audio[2]) : null, channels: audio[3] ? Number(audio[3]) : null } : null,
    bitrateKbps: bitrate ? Number(bitrate[1]) : null,
    videoKiB: size ? Number(size[1]) : null,
  }
}

export async function mediaInfo(file) {
  const input = resolvePath(file, { mustExist: true })
  const exe = await ffmpegPath()
  const res = await runProcess(exe, ["-hide_banner", "-i", input], { timeout: 30_000 })
  const stat = await fsp.stat(input)
  return { path: input, bytes: stat.size, ...parseProbe(res.stderr), raw: res.stderr.slice(-4000) }
}

export async function mediaProcess(args) {
  const action = args.action
  const input = args.path ? resolvePath(args.path, { mustExist: true }) : null
  if (action === "info") return await mediaInfo(args.path)
  if (!input) throw new ToolError("path is required", "BAD_INPUT")

  if (action === "convert") {
    if (!args.output) throw new ToolError("convert needs output", "BAD_INPUT")
    const out = resolvePath(args.output, { createParent: true })
    await ffmpeg(["-i", input, ...(args.args ? String(args.args).split(/\s+/).filter(Boolean) : []), out])
    return { path: out, bytes: (await fsp.stat(out)).size }
  }

  if (action === "extract_frame" || action === "thumbnail") {
    const at = String(args.at || args.time || "00:00:01")
    const out = outputPath(input, action, "jpg", args.output)
    await ensureDir(path.dirname(out))
    const scale = action === "thumbnail" ? ["-vf", `scale=${Number(args.width || 640)}:-2`] : []
    await ffmpeg(["-ss", at, "-i", input, "-frames:v", "1", ...scale, "-q:v", String(Number(args.quality || 3)), out])
    return { path: out, bytes: (await fsp.stat(out)).size, at }
  }

  if (action === "resize") {
    const width = parseNumber(args.width, -2)
    const height = parseNumber(args.height, -2)
    if (width === -2 && height === -2) throw new ToolError("resize needs width or height", "BAD_INPUT")
    const out = outputPath(input, "resized", path.extname(input).slice(1) || "mp4", args.output)
    await ffmpeg(["-i", input, "-vf", `scale=${width}:${height}`, "-c:a", "copy", out])
    return { path: out, bytes: (await fsp.stat(out)).size }
  }

  if (action === "compress") {
    const crf = Math.max(0, Math.min(51, Number(args.crf || 28)))
    const out = outputPath(input, `crf${crf}`, args.format || (path.extname(input).slice(1) || "mp4"), args.output)
    await ffmpeg(["-i", input, "-vcodec", "libx264", "-crf", String(crf), "-preset", args.preset || "medium", "-acodec", "aac", "-b:a", args.audioBitrate || "128k", out])
    return { path: out, bytes: (await fsp.stat(out)).size, crf }
  }

  if (action === "trim" || action === "clip") {
    const start = String(args.start || "00:00:00")
    const end = args.end ? String(args.end) : null
    const duration = args.duration ? String(args.duration) : null
    const out = outputPath(input, "trim", path.extname(input).slice(1) || "mp4", args.output)
    const seek = ["-ss", start, "-i", input]
    const endArgs = ["-to", end] // relative to post-seek position
    const durationArgs = duration ? ["-t", duration] : []
    if (args.reencode) await ffmpeg([...seek, ...(end ? endArgs : durationArgs), "-c:v", "libx264", "-c:a", "aac", out])
    else await ffmpeg([...seek, ...(end ? endArgs : durationArgs), "-c", "copy", out])
    return { path: out, bytes: (await fsp.stat(out)).size }
  }

  if (action === "extract_audio") {
    const out = outputPath(input, "audio", args.format || "mp3", args.output)
    await ffmpeg(["-i", input, "-vn", "-acodec", args.codec || "libmp3lame", "-q:a", String(Number(args.quality || 2)), out])
    return { path: out, bytes: (await fsp.stat(out)).size }
  }

  if (action === "mute") {
    const out = outputPath(input, "muted", path.extname(input).slice(1) || "mp4", args.output)
    await ffmpeg(["-i", input, "-an", "-c:v", "copy", out])
    return { path: out, bytes: (await fsp.stat(out)).size }
  }

  if (action === "replace_audio") {
    if (!args.audio) throw new ToolError("replace_audio needs audio path", "BAD_INPUT")
    const audio = resolvePath(args.audio, { mustExist: true })
    const out = outputPath(input, "newaudio", path.extname(input).slice(1) || "mp4", args.output)
    await ffmpeg(["-i", input, "-i", audio, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-shortest", out])
    return { path: out, bytes: (await fsp.stat(out)).size }
  }

  if (action === "gif") {
    const out = outputPath(input, "anim", "gif", args.output)
    const start = Number(args.start || 0)
    const duration = Number(args.duration || 4)
    const fps = Number(args.fps || 12)
    const width = Number(args.width || 640)
    await ffmpeg(["-ss", String(start), "-t", String(duration), "-i", input, "-vf", `fps=${fps},scale=${width}:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse`, "-loop", "0", out])
    return { path: out, bytes: (await fsp.stat(out)).size }
  }

  if (action === "subtitles") {
    if (!args.subtitles) throw new ToolError("subtitles needs a subtitle file", "BAD_INPUT")
    const subtitle = resolvePath(args.subtitles, { mustExist: true }).replace(/\\/g, "/").replace(/:/g, "\\:")
    const out = outputPath(input, "subtitled", path.extname(input).slice(1) || "mp4", args.output)
    await ffmpeg(["-i", input, "-vf", `subtitles='${subtitle}'`, "-c:a", "copy", out])
    return { path: out, bytes: (await fsp.stat(out)).size }
  }

  if (action === "speed") {
    const speed = Math.max(0.25, Math.min(4, Number(args.speed || 1.5)))
    const out = outputPath(input, `speed${speed}`, path.extname(input).slice(1) || "mp4", args.output)
    const audioFilter = speed >= 0.5 && speed <= 2 ? `atempo=${speed}` : null
    await ffmpeg(["-i", input, "-filter:v", `setpts=${1 / speed}*PTS`, ...(audioFilter ? ["-filter:a", audioFilter] : ["-an"]), out])
    return { path: out, bytes: (await fsp.stat(out)).size }
  }

  if (action === "normalize_audio") {
    const out = outputPath(input, "normalized", path.extname(input).slice(1) || "mp3", args.output)
    await ffmpeg(["-i", input, "-af", "loudnorm=I=-16:TP=-1.5:LRA=11", out])
    return { path: out, bytes: (await fsp.stat(out)).size }
  }

  if (action === "scene_detect") {
    const exe = await ffmpegPath()
    const res = await runProcess(exe, ["-hide_banner", "-i", input, "-filter:v", `select='gt(scene,${Number(args.threshold || 0.35)})',showinfo`, "-f", "null", "-"], { timeout: 90_000 })
    const times = [...res.stderr.matchAll(/pts_time:([\d.]+)/g)].map((m) => Number(m[1]))
    return { scenes: times.length, times }
  }

  if (action === "silence_detect") {
    const exe = await ffmpegPath()
    const res = await runProcess(exe, ["-hide_banner", "-i", input, "-af", `silencedetect=noise=${args.noise || "-35dB"}:d=${args.duration || 0.5}`, "-f", "null", "-"], { timeout: 90_000 })
    const starts = [...res.stderr.matchAll(/silence_start:\s*([\d.]+)/g)].map((m) => Number(m[1]))
    const ends = [...res.stderr.matchAll(/silence_end:\s*([\d.]+)/g)].map((m) => Number(m[1]))
    return { intervals: starts.map((start, i) => ({ start, end: ends[i] ?? null })) }
  }

  if (action === "merge") {
    const files = Array.isArray(args.files) ? args.files : []
    if (files.length < 2) throw new ToolError("merge needs at least two files", "BAD_INPUT")
    const out = resolvePath(args.output || path.join(CACHE_DIR, `merged-${stamp()}.mp4`), { createParent: true })
    await ensureDir(path.dirname(out))
    const list = path.join(path.dirname(out), `concat-${Date.now()}.txt`)
    await fsp.writeFile(
      list,
      files.map((file) => `file '${resolvePath(file, { mustExist: true }).replace(/'/g, "'\\''").replace(/\\/g, "/")}'`).join("\n"),
      "utf8",
    )
    await ffmpeg(["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", out])
    await fsp.unlink(list).catch(() => {})
    return { path: out, bytes: (await fsp.stat(out)).size, files: files.length }
  }

  throw new ToolError(`unknown media action: ${action}`, "BAD_INPUT")
}

export async function textToSpeech(args) {
  const text = String(args.text || "").trim()
  if (!text) throw new ToolError("text is required", "BAD_INPUT")
  const out = resolvePath(args.output || path.join(CACHE_DIR, `speech-${stamp()}.wav`), { createParent: true })
  await ensureDir(path.dirname(out))
  if (process.platform !== "win32") throw new ToolError("local TTS uses Windows SAPI; set OPENCODE_CHAT_TTS_API_URL for a provider", "UNSUPPORTED")
  const escaped = text.replace(/'/g, "''")
  const script = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Rate = ${Number(args.rate || 0)}; $s.Volume = ${Number(args.volume || 100)}; $s.SetOutputToWaveFile('${out.replace(/'/g, "''")}'); $s.Speak('${escaped}'); $s.Dispose()`
  const { powershell } = await import("./core.mjs")
  const res = await powershell(script, { timeout: 90_000 })
  if (res.code !== 0) throw new ToolError(`TTS failed: ${res.stderr.slice(0, 800)}`, "TTS_FAILED")
  return { path: out, bytes: (await fsp.stat(out)).size }
}

export async function speechToText(args) {
  const input = resolvePath(args.path, { mustExist: true })
  const endpoint = process.env.OPENCODE_CHAT_STT_API_URL || (process.env.OPENAI_API_KEY ? "https://api.openai.com/v1/audio/transcriptions" : null)
  const key = process.env.OPENCODE_CHAT_STT_API_KEY || process.env.OPENAI_API_KEY
  if (!endpoint || !key) {
    throw new ToolError(
      "speech-to-text needs OPENCODE_CHAT_STT_API_URL + OPENCODE_CHAT_STT_API_KEY (or OPENAI_API_KEY), or a local whisper CLI.",
      "PROVIDER_NOT_CONFIGURED",
    )
  }
  const form = new FormData()
  form.append("file", new Blob([await fsp.readFile(input)]), path.basename(input))
  form.append("model", process.env.OPENCODE_CHAT_STT_MODEL || "whisper-1")
  const res = await fetch(endpoint, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(120_000) })
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new ToolError(`transcription provider error: ${data?.error?.message || res.status}`, "PROVIDER_ERROR")
  return { text: data.text || data.transcription || "", language: data.language || null, raw: data }
}

export async function videoGenerate(args) {
  const endpoint = process.env.OPENCODE_CHAT_VIDEO_API_URL
  const key = process.env.OPENCODE_CHAT_VIDEO_API_KEY
  if (!endpoint || !key) {
    throw new ToolError(
      "video generation needs an external provider. Set OPENCODE_CHAT_VIDEO_API_URL and OPENCODE_CHAT_VIDEO_API_KEY.",
      "PROVIDER_NOT_CONFIGURED",
    )
  }
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ prompt: args.prompt, duration: args.duration, size: args.size }),
    signal: AbortSignal.timeout(180_000),
  })
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new ToolError(data?.error?.message || `provider status ${res.status}`, "PROVIDER_ERROR")
  return data
}
