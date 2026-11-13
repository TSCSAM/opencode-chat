import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import {
  CACHE_DIR,
  ToolError,
  ensureDir,
  formatBytes,
  imageResult,
  mimeFromExt,
  parseBool,
  parseNumber,
  resolvePath,
  safeName,
  stamp,
} from "./core.mjs"
import { getPage } from "./browser.mjs"

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".svg"])

export async function imageDataUrl(file) {
  const target = resolvePath(file, { mustExist: true })
  const ext = path.extname(target).toLowerCase()
  if (!IMAGE_EXTS.has(ext)) throw new ToolError(`not a supported image: ${ext}`, "BAD_IMAGE")
  const buf = await fsp.readFile(target)
  if (buf.length > 40 * 1024 * 1024) throw new ToolError("image is larger than 40 MB", "TOO_LARGE")
  return { path: target, dataUrl: `data:${mimeFromExt(target)};base64,${buf.toString("base64")}`, bytes: buf.length }
}

async function imagePage() {
  const page = await getPage("image-tools", { viewport: { width: 1600, height: 1000 } })
  return page
}

async function runCanvas(dataUrl, code) {
  const page = await imagePage()
  return await page.evaluate(
    async ({ dataUrl, code }) => {
      const img = new Image()
      img.crossOrigin = "anonymous"
      img.decoding = "sync"
      await new Promise((resolve, reject) => {
        img.onload = () => resolve()
        img.onerror = () => reject(new Error("could not decode image"))
        img.src = dataUrl
      })
      const canvas = document.createElement("canvas")
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight
      const ctx = canvas.getContext("2d", { willReadFrequently: true })
      ctx.drawImage(img, 0, 0)
      // eslint-disable-next-line no-new-func
      const fn = new Function("canvas", "ctx", "img", `return (async () => { ${code} })()`)
      return await fn(canvas, ctx, img)
    },
    { dataUrl, code },
  )
}

function decodeDataUrl(dataUrl) {
  const match = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl || "")
  if (!match) throw new ToolError("image operation did not return a data URL", "IMAGE_FAILED")
  return { mime: match[1], buffer: Buffer.from(match[2], "base64") }
}

export async function imageInfo(file) {
  const { path: target, dataUrl, bytes } = await imageDataUrl(file)
  const info = await runCanvas(
    dataUrl,
    `
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
    const colors = new Map()
    for (let i = 0; i < data.length; i += 4 * Math.max(1, Math.floor(data.length / 4 / 4000))) {
      const key = [data[i], data[i+1], data[i+2]].map(v => Math.min(255, Math.round(v / 32) * 32)).join(",")
      colors.set(key, (colors.get(key) || 0) + 1)
    }
    const top = [...colors.entries()].sort((a,b) => b[1]-a[1]).slice(0, 8).map(([key,count]) => ({ rgb: key.split(",").map(Number), count }))
    return { width: img.naturalWidth, height: img.naturalHeight, aspect: +(img.naturalWidth / img.naturalHeight).toFixed(3), dominant: top }
    `,
  )
  return { path: target, bytes, mime: mimeFromExt(target), ...info }
}

export async function imageProcess(args) {
  const action = args.action
  const source = await imageDataUrl(args.path)
  const output = args.output ? resolvePath(args.output, { createParent: true }) : null
  if (action === "info") return await imageInfo(args.path)

  if (action === "ocr") {
    return await imageOcr(args.path, args)
  }

  let code = ""
  let mime = args.format ? `image/${String(args.format).replace("jpg", "jpeg")}` : mimeFromExt(source.path)
  if (action === "resize" || action === "thumbnail") {
    const maxWidth = parseNumber(args.width, 0)
    const maxHeight = parseNumber(args.height, 0)
    if (!maxWidth && !maxHeight) throw new ToolError("resize needs width and/or height", "BAD_INPUT")
    code = `
      const sw = img.naturalWidth, sh = img.naturalHeight
      let w = ${maxWidth || "Math.round(sw * (" + (maxHeight || 0) + " / sh))"}, h = ${maxHeight || "Math.round(sh * (" + (maxWidth || 0) + " / sw))"}
      if (${maxWidth || 0} && ${maxHeight || 0}) {
        const scale = Math.min(${maxWidth || 0} / sw, ${maxHeight || 0} / sh)
        w = Math.max(1, Math.round(sw * scale)); h = Math.max(1, Math.round(sh * scale))
      }
      const out = document.createElement("canvas"); out.width = w; out.height = h
      const octx = out.getContext("2d"); octx.imageSmoothingEnabled = true; octx.imageSmoothingQuality = "high"
      octx.drawImage(canvas, 0, 0, w, h)
      return out.toDataURL("${mime}", ${args.quality ? Number(args.quality) / 100 : 0.92})
    `
  } else if (action === "crop") {
    const x = Math.max(0, parseNumber(args.x, 0))
    const y = Math.max(0, parseNumber(args.y, 0))
    const w = parseNumber(args.width, 0)
    const h = parseNumber(args.height, 0)
    if (!w || !h) throw new ToolError("crop needs width and height", "BAD_INPUT")
    code = `
      const out = document.createElement("canvas"); out.width = ${w}; out.height = ${h}
      out.getContext("2d").drawImage(canvas, ${x}, ${y}, ${w}, ${h}, 0, 0, ${w}, ${h})
      return out.toDataURL("${mime}", 0.95)
    `
  } else if (action === "rotate") {
    const degrees = parseNumber(args.degrees, 90)
    code = `
      const rad = (${degrees} * Math.PI) / 180
      const w = Math.abs(Math.cos(rad) * canvas.width) + Math.abs(Math.sin(rad) * canvas.height)
      const h = Math.abs(Math.sin(rad) * canvas.width) + Math.abs(Math.cos(rad) * canvas.height)
      const out = document.createElement("canvas"); out.width = Math.ceil(w); out.height = Math.ceil(h)
      const octx = out.getContext("2d"); octx.translate(out.width/2, out.height/2); octx.rotate(rad); octx.drawImage(canvas, -canvas.width/2, -canvas.height/2)
      return out.toDataURL("${mime}", 0.95)
    `
  } else if (action === "flip") {
    const horizontal = args.direction !== "vertical"
    code = `
      const out = document.createElement("canvas"); out.width = canvas.width; out.height = canvas.height
      const octx = out.getContext("2d")
      octx.translate(${horizontal ? "out.width" : "0"}, ${horizontal ? "0" : "out.height"})
      octx.scale(${horizontal ? "-1" : "1"}, ${horizontal ? "1" : "-1"})
      octx.drawImage(canvas, 0, 0)
      return out.toDataURL("${mime}", 0.95)
    `
  } else if (action === "compress" || action === "convert") {
    const quality = Math.min(1, Math.max(0.05, parseNumber(args.quality, 80) / 100))
    code = `return canvas.toDataURL("${mime}", ${quality})`
  } else if (action === "grayscale" || action === "blur" || action === "brightness" || action === "contrast" || action === "saturate") {
    const filter = {
      grayscale: "grayscale(1)",
      blur: `blur(${parseNumber(args.amount, 3)}px)`,
      brightness: `brightness(${parseNumber(args.amount, 120)}%)`,
      contrast: `contrast(${parseNumber(args.amount, 120)}%)`,
      saturate: `saturate(${parseNumber(args.amount, 150)}%)`,
    }[action]
    code = `
      const out = document.createElement("canvas"); out.width = canvas.width; out.height = canvas.height
      const octx = out.getContext("2d"); octx.filter = ${JSON.stringify(filter)}; octx.drawImage(canvas, 0, 0)
      return out.toDataURL("${mime}", 0.95)
    `
  } else if (action === "watermark" || action === "annotate") {
    const ops = action === "watermark" ? [{ type: "text", text: args.text || "OpenCode Chat", x: args.x ?? 20, y: args.y ?? 40, size: args.size || 28, color: args.color || "#ffffff", opacity: 0.65 }] : Array.isArray(args.operations) ? args.operations : [{ type: "text", text: args.text || "", x: args.x ?? 20, y: args.y ?? 40, size: args.size || 24, color: args.color || "#ff0000" }]
    code = `
      const out = document.createElement("canvas"); out.width = canvas.width; out.height = canvas.height
      const octx = out.getContext("2d"); octx.drawImage(canvas, 0, 0)
      const ops = ${JSON.stringify(ops)}
      for (const op of ops) {
        octx.save(); octx.globalAlpha = op.opacity ?? 1
        if (op.type === "text") {
          octx.fillStyle = op.color || "#ff0000"; octx.font = (op.bold ? "bold " : "") + (op.size || 24) + "px " + (op.font || "Segoe UI, Tahoma, sans-serif")
          octx.textBaseline = "top"; octx.fillText(String(op.text || ""), op.x || 0, op.y || 0)
        } else if (op.type === "rect" || op.type === "ellipse") {
          octx.strokeStyle = op.color || "#ff0000"; octx.lineWidth = op.width || 3
          if (op.fill) { octx.fillStyle = op.fill; if (op.type === "rect") octx.fillRect(op.x||0, op.y||0, op.w||100, op.h||100); else { octx.beginPath(); octx.ellipse((op.x||0)+(op.w||100)/2, (op.y||0)+(op.h||100)/2, Math.abs((op.w||100)/2), Math.abs((op.h||100)/2), 0, 0, Math.PI*2); octx.fill() } }
          if (op.type === "rect") octx.strokeRect(op.x||0, op.y||0, op.w||100, op.h||100); else { octx.beginPath(); octx.ellipse((op.x||0)+(op.w||100)/2, (op.y||0)+(op.h||100)/2, Math.abs((op.w||100)/2), Math.abs((op.h||100)/2), 0, 0, Math.PI*2); octx.stroke() }
        } else if (op.type === "line" || op.type === "arrow") {
          octx.strokeStyle = op.color || "#ff0000"; octx.lineWidth = op.width || 3
          octx.beginPath(); octx.moveTo(op.x1||0, op.y1||0); octx.lineTo(op.x2||100, op.y2||100); octx.stroke()
          if (op.type === "arrow") {
            const angle = Math.atan2((op.y2||100)-(op.y1||0), (op.x2||100)-(op.x1||0)); const size = 12
            octx.beginPath(); octx.moveTo(op.x2||100, op.y2||100); octx.lineTo((op.x2||100)-size*Math.cos(angle-Math.PI/6), (op.y2||100)-size*Math.sin(angle-Math.PI/6)); octx.lineTo((op.x2||100)-size*Math.cos(angle+Math.PI/6), (op.y2||100)-size*Math.sin(angle+Math.PI/6)); octx.closePath(); octx.fillStyle = op.color || "#ff0000"; octx.fill()
          }
        }
        octx.restore()
      }
      return out.toDataURL("${mime}", 0.95)
    `
  } else if (action === "remove_background") {
    const tolerance = Math.min(255, Math.max(0, parseNumber(args.tolerance, 32)))
    code = `
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height)
      const d = data.data
      const corners = [[0,0], [canvas.width-1,0], [0,canvas.height-1], [canvas.width-1,canvas.height-1]].map(([x,y]) => { const i=(y*canvas.width+x)*4; return [d[i],d[i+1],d[i+2]] })
      const bg = corners.reduce((a,c) => [a[0]+c[0],a[1]+c[1],a[2]+c[2]], [0,0,0]).map(v => v/4)
      for (let i=0; i<d.length; i+=4) { const dist = Math.sqrt((d[i]-bg[0])**2 + (d[i+1]-bg[1])**2 + (d[i+2]-bg[2])**2); if (dist <= ${tolerance}) d[i+3] = 0 }
      ctx.putImageData(data, 0, 0)
      return canvas.toDataURL("image/png")
    `
    mime = "image/png"
  } else if (action === "compare") {
    const second = await imageDataUrl(args.path2)
    const page = await imagePage()
    const result = await page.evaluate(
      async ({ a, b }) => {
        const load = (src) => new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = src })
        const [ia, ib] = await Promise.all([load(a), load(b)])
        const w = Math.max(ia.naturalWidth, ib.naturalWidth), h = Math.max(ia.naturalHeight, ib.naturalHeight)
        const ca = document.createElement("canvas"); ca.width = w; ca.height = h; const xa = ca.getContext("2d"); xa.drawImage(ia, 0, 0)
        const cb = document.createElement("canvas"); cb.width = w; cb.height = h; const xb = cb.getContext("2d"); xb.drawImage(ib, 0, 0)
        const da = xa.getImageData(0,0,w,h).data, db = xb.getImageData(0,0,w,h).data
        const out = document.createElement("canvas"); out.width = w; out.height = h; const xo = out.getContext("2d"); const img = xo.createImageData(w,h); const dd = img.data
        let diff = 0, minX=w, minY=h, maxX=0, maxY=0
        for (let i=0; i<da.length; i+=4) {
          const delta = Math.abs(da[i]-db[i]) + Math.abs(da[i+1]-db[i+1]) + Math.abs(da[i+2]-db[i+2]) + Math.abs(da[i+3]-db[i+3])
          if (delta > 24) { diff++; const p=i/4, x=p%w, y=Math.floor(p/w); if(x<minX)minX=x; if(y<minY)minY=y; if(x>maxX)maxX=x; if(y>maxY)maxY=y; dd[i]=255; dd[i+1]=60; dd[i+2]=60; dd[i+3]=255 } else { dd[i]=230; dd[i+1]=235; dd[i+2]=240; dd[i+3]=255 }
        }
        xo.putImageData(img,0,0)
        return { diffPixels: diff, totalPixels: w*h, percent: +(100*diff/(w*h)).toFixed(3), bounds: diff ? { x:minX, y:minY, width:maxX-minX+1, height:maxY-minY+1 } : null, image: out.toDataURL("image/png") }
      },
      { a: source.dataUrl, b: second.dataUrl },
    )
    const diffBuf = decodeDataUrl(result.image).buffer
    if (output) await fsp.writeFile(output, diffBuf)
    return { ...result, image: undefined, output: output || null, diffBuffer: diffBuf }
  } else {
    throw new ToolError(`unknown image action: ${action}`, "BAD_INPUT")
  }

  const dataUrl = await runCanvas(source.dataUrl, code)
  const decoded = decodeDataUrl(dataUrl)
  const target = output || path.join(CACHE_DIR, `${safeName(path.basename(source.path, path.extname(source.path)))}-${action}-${stamp()}.${mime.includes("jpeg") ? "jpg" : mime.split("/")[1]}`)
  await ensureDir(path.dirname(target))
  await fsp.writeFile(target, decoded.buffer)
  return {
    path: target,
    bytes: decoded.buffer.length,
    width: null,
    height: null,
    action,
    source: source.path,
    mime: decoded.mime,
    buffer: decoded.buffer,
  }
}

export async function imageOcr(file, options = {}) {
  const target = resolvePath(file, { mustExist: true })
  if (process.platform !== "win32") {
    throw new ToolError("OCR currently uses the built-in Windows OCR engine; set up tesseract for other platforms", "UNSUPPORTED")
  }
  const script = `
Add-Type -AssemblyName System.Runtime.WindowsRuntime
[Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder,Windows.Foundation,ContentType=WindowsRuntime] | Out-Null
[Windows.Storage.StorageFile,Windows.Foundation,ContentType=WindowsRuntime] | Out-Null
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($task, $type) {
  $asTask = $asTaskGeneric.MakeGenericMethod($type)
  $netTask = $asTask.Invoke($null, @($task))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync(${`'${target.replace(/'/g, "''")}'`})) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if ($null -eq $engine) { throw "Windows OCR language pack is not installed" }
$ocr = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
$out = [pscustomobject]@{ text = $ocr.Text; language = $engine.RecognizerLanguage.LanguageTag; lines = @($ocr.Lines | ForEach-Object { $_.Text }) }
$out | ConvertTo-Json -Depth 4 -Compress
`
  const { powershell } = await import("./core.mjs")
  const res = await powershell(script, { timeout: 45_000 })
  if (res.code !== 0) throw new ToolError(`Windows OCR failed: ${res.stderr.slice(0, 1200)}`, "OCR_FAILED")
  try {
    return JSON.parse(res.stdout.trim())
  } catch {
    throw new ToolError(`OCR returned invalid output: ${res.stdout.slice(0, 500)}`, "OCR_FAILED")
  }
}

export async function imageGenerate(args) {
  const endpoint = process.env.OPENCODE_CHAT_IMAGE_API_URL || "https://api.openai.com/v1/images/generations"
  const key = process.env.OPENCODE_CHAT_IMAGE_API_KEY || process.env.OPENAI_API_KEY
  const model = process.env.OPENCODE_CHAT_IMAGE_MODEL || "gpt-image-1"
  if (!key) {
    throw new ToolError(
      "image generation needs an API key. Set OPENCODE_CHAT_IMAGE_API_KEY (and optionally OPENCODE_CHAT_IMAGE_API_URL / OPENCODE_CHAT_IMAGE_MODEL).",
      "PROVIDER_NOT_CONFIGURED",
    )
  }
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model, prompt: args.prompt, size: args.size || "1024x1024", n: 1, response_format: "b64_json" }),
    signal: AbortSignal.timeout(120_000),
  })
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new ToolError(`image provider error: ${data?.error?.message || res.status}`, "PROVIDER_ERROR")
  const b64 = data?.data?.[0]?.b64_json
  const url = data?.data?.[0]?.url
  let buffer
  if (b64) buffer = Buffer.from(b64, "base64")
  else if (url) buffer = Buffer.from(await (await fetch(url)).arrayBuffer())
  else throw new ToolError("image provider returned no image", "PROVIDER_ERROR")
  const target = resolvePath(args.output || path.join(CACHE_DIR, `generated-${stamp()}.png`), { createParent: true })
  await fsp.writeFile(target, buffer)
  return { path: target, bytes: buffer.length, provider: endpoint, model }
}

export async function imageVisionPayload(file, caption) {
  const { path: target, dataUrl, bytes } = await imageDataUrl(file)
  return { ...imageResult(Buffer.from(dataUrl.split(",")[1], "base64"), mimeFromExt(target), caption || `${path.basename(target)} (${formatBytes(bytes)})`), path: target }
}
