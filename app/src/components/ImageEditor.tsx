import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react"
import { useI18n } from "../lib/i18n"

type Tool = "pan" | "pen" | "text" | "rect" | "ellipse" | "arrow"
type Point = { x: number; y: number }

type PenOp = { tool: "pen"; color: string; width: number; points: Point[] }
type ShapeOp = { tool: "rect" | "ellipse" | "arrow"; color: string; width: number; from: Point; to: Point }
type TextOp = { tool: "text"; color: string; x: number; y: number; text: string; size: number }
type Op = PenOp | ShapeOp | TextOp

type History = { ops: Op[]; redo: Op[] }

type EditorContextValue = {
  openImage: (src: string, name?: string) => void
}

const EditorContext = createContext<EditorContextValue | null>(null)

export function useImageEditor() {
  return useContext(EditorContext)
}

export const ImageEditorProvider = EditorContext.Provider

const COLORS = ["#ff4d4f", "#ffb020", "#ffe066", "#3fb950", "#4c9aff", "#b392f0", "#ffffff", "#111111"]

type SaveImage = { dataUrl: string; name: string }

type Props = {
  src: string
  name?: string
  saveLabel?: string
  hint?: string
  onClose: () => void
  onSave: (image: SaveImage) => void | Promise<void>
}

function editedName(name?: string) {
  const base = String(name || "image")
    .replace(/\.[^.\\/]+$/, "")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .trim()
  return `${base || "image"}-edited.png`
}

function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ""))
    reader.onerror = () => reject(reader.error ?? new Error("read failed"))
    reader.readAsDataURL(blob)
  })
}

function drawOp(ctx: CanvasRenderingContext2D, op: Op) {
  ctx.save()
  ctx.strokeStyle = op.color
  ctx.fillStyle = op.color
  ctx.lineJoin = "round"
  ctx.lineCap = "round"

  if (op.tool === "text") {
    ctx.font = `600 ${op.size}px "Vazirmatn", "Segoe UI", Tahoma, sans-serif`
    ctx.textBaseline = "top"
    ctx.shadowColor = "rgba(0, 0, 0, 0.55)"
    ctx.shadowBlur = Math.max(2, op.size * 0.08)
    op.text.split(/\r?\n/).forEach((line, index) => {
      ctx.fillText(line, op.x, op.y + index * op.size * 1.25)
    })
    ctx.restore()
    return
  }

  ctx.lineWidth = op.width
  if (op.tool === "pen") {
    if (op.points.length === 0) {
      ctx.restore()
      return
    }
    ctx.beginPath()
    ctx.moveTo(op.points[0].x, op.points[0].y)
    if (op.points.length === 1) {
      ctx.lineTo(op.points[0].x + 0.1, op.points[0].y + 0.1)
    } else {
      for (let i = 1; i < op.points.length; i++) ctx.lineTo(op.points[i].x, op.points[i].y)
    }
    ctx.stroke()
    ctx.restore()
    return
  }

  if (op.tool === "rect" || op.tool === "ellipse") {
    const x = Math.min(op.from.x, op.to.x)
    const y = Math.min(op.from.y, op.to.y)
    const w = Math.abs(op.to.x - op.from.x)
    const h = Math.abs(op.to.y - op.from.y)
    ctx.beginPath()
    if (op.tool === "rect") {
      ctx.rect(x, y, w, h)
    } else {
      ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2)
    }
    ctx.stroke()
    ctx.restore()
    return
  }

  // Arrow
  const dx = op.to.x - op.from.x
  const dy = op.to.y - op.from.y
  const angle = Math.atan2(dy, dx)
  const head = Math.max(10, op.width * 3)
  ctx.beginPath()
  ctx.moveTo(op.from.x, op.from.y)
  ctx.lineTo(op.to.x, op.to.y)
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(op.to.x, op.to.y)
  ctx.lineTo(op.to.x - head * Math.cos(angle - Math.PI / 6), op.to.y - head * Math.sin(angle - Math.PI / 6))
  ctx.lineTo(op.to.x - head * Math.cos(angle + Math.PI / 6), op.to.y - head * Math.sin(angle + Math.PI / 6))
  ctx.closePath()
  ctx.fill()
  ctx.restore()
}

function ToolIcon({ name }: { name: string }) {
  const common = {
    width: 19,
    height: 19,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  }
  if (name === "pan") {
    return (
      <svg {...common}>
        <path d="M7.5 11V6.5a1.5 1.5 0 0 1 3 0V10m0-4.5a1.5 1.5 0 0 1 3 0V10m0-3.5a1.5 1.5 0 0 1 3 0V11m0-2.5a1.5 1.5 0 0 1 3 0v5a6 6 0 0 1-6 6h-1.3a5 5 0 0 1-3.8-1.7l-3.6-4.1a1.6 1.6 0 0 1 2.3-2.2l1.9 1.6" />
      </svg>
    )
  }
  if (name === "text") {
    return (
      <svg {...common}>
        <path d="M5 5h14M12 5v14M8 19h8" />
      </svg>
    )
  }
  if (name === "rect") {
    return (
      <svg {...common}>
        <rect x="4" y="5" width="16" height="14" rx="1.5" />
      </svg>
    )
  }
  if (name === "ellipse") {
    return (
      <svg {...common}>
        <ellipse cx="12" cy="12" rx="8.5" ry="6.5" />
      </svg>
    )
  }
  if (name === "arrow") {
    return (
      <svg {...common}>
        <path d="M5 19 19 5M11 5h8v8" />
      </svg>
    )
  }
  if (name === "undo") {
    return (
      <svg {...common}>
        <path d="M9 7 4 12l5 5M4 12h9a6 6 0 0 1 6 6" />
      </svg>
    )
  }
  if (name === "redo") {
    return (
      <svg {...common}>
        <path d="m15 7 5 5-5 5M20 12h-9a6 6 0 0 0-6 6" />
      </svg>
    )
  }
  if (name === "clear") {
    return (
      <svg {...common}>
        <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5M14 11v5" />
      </svg>
    )
  }
  if (name === "download") {
    return (
      <svg {...common}>
        <path d="M12 3v12m0 0 5-5m-5 5-5-5M4 21h16" />
      </svg>
    )
  }
  return (
    <svg {...common}>
      <path d="M4 20l4.2-1 10-10a2.1 2.1 0 0 0-3-3l-10 10L4 20z" />
      <path d="m13.8 6.2 3 3" />
    </svg>
  )
}

const TOOLS: { id: Tool; icon: string }[] = [
  { id: "pan", icon: "pan" },
  { id: "pen", icon: "pen" },
  { id: "text", icon: "text" },
  { id: "rect", icon: "rect" },
  { id: "ellipse", icon: "ellipse" },
  { id: "arrow", icon: "arrow" },
]

export function ImageEditor({ src, name, saveLabel, hint, onClose, onSave }: Props) {
  const { t, num } = useI18n()
  const [tool, setTool] = useState<Tool>("pen")
  const [color, setColor] = useState(COLORS[0])
  const [width, setWidth] = useState(5)
  const [history, setHistory] = useState<History>({ ops: [], redo: [] })
  const [draft, setDraft] = useState<Op | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState("")
  const [saveError, setSaveError] = useState("")
  const [saving, setSaving] = useState(false)
  const [textAt, setTextAt] = useState<{ x: number; y: number; left: number; top: number } | null>(null)
  const [textValue, setTextValue] = useState("")
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [panning, setPanning] = useState(false)
  const [spaceDown, setSpaceDown] = useState(false)

  const imageRef = useRef<HTMLImageElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const textRef = useRef<HTMLInputElement | null>(null)
  const draftRef = useRef<Op | null>(null)
  const startRef = useRef<Point | null>(null)
  const pointsRef = useRef<Point[]>([])
  const textGuard = useRef(false)
  const spaceRef = useRef(false)
  const zoomRef = useRef(1)
  const panRef = useRef<Point>({ x: 0, y: 0 })
  const panDragRef = useRef<{ startX: number; startY: number; panX: number; panY: number } | null>(null)
  const pointersRef = useRef(new Map<number, { x: number; y: number }>())
  const gestureRef = useRef<{
    distance: number
    zoom: number
    localX: number
    localY: number
    baseLeft: number
    baseTop: number
  } | null>(null)

  const reset = useCallback(() => {
    setHistory({ ops: [], redo: [] })
    setDraft(null)
    draftRef.current = null
    startRef.current = null
    pointsRef.current = []
    setTextAt(null)
    setTextValue("")
  }, [])

  useEffect(() => {
    let cancelled = false
    let objectUrl = ""
    setLoaded(false)
    setLoadError("")
    setSaveError("")
    zoomRef.current = 1
    panRef.current = { x: 0, y: 0 }
    setZoom(1)
    setPan({ x: 0, y: 0 })
    reset()

    const load = async () => {
      let source = src
      if (/^https?:/i.test(src)) {
        try {
          const url = new URL(src, window.location.href)
          if (url.origin !== window.location.origin) {
            const res = await fetch(url.href, { credentials: "include" })
            if (res.ok) {
              objectUrl = URL.createObjectURL(await res.blob())
              source = objectUrl
            }
          }
        } catch {}
      }
      if (cancelled) return
      const image = new Image()
      image.decoding = "async"
      image.onload = () => {
        if (cancelled) return
        const max = 2400
        const factor = Math.min(1, max / Math.max(image.naturalWidth || 1, image.naturalHeight || 1))
        const w = Math.max(1, Math.round((image.naturalWidth || 1) * factor))
        const h = Math.max(1, Math.round((image.naturalHeight || 1) * factor))
        const canvas = canvasRef.current
        if (!canvas) return
        canvas.width = w
        canvas.height = h
        imageRef.current = image
        setLoaded(true)
      }
      image.onerror = () => {
        if (!cancelled) setLoadError(t("This image cannot be loaded for editing."))
      }
      image.src = source
    }
    void load()
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [src, reset, t])

  useEffect(() => {
    if (!loaded) return
    const canvas = canvasRef.current
    const image = imageRef.current
    if (!canvas || !image) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
    for (const op of history.ops) drawOp(ctx, op)
    if (draft) drawOp(ctx, draft)
  }, [history.ops, draft, loaded])

  useEffect(() => {
    const previous = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      document.body.style.overflow = previous
    }
  }, [])

  const undo = useCallback(() => {
    setHistory((h) => {
      if (h.ops.length === 0) return h
      const last = h.ops[h.ops.length - 1]
      return { ops: h.ops.slice(0, -1), redo: [...h.redo, last] }
    })
  }, [])

  const redo = useCallback(() => {
    setHistory((h) => {
      if (h.redo.length === 0) return h
      const last = h.redo[h.redo.length - 1]
      return { ops: [...h.ops, last], redo: h.redo.slice(0, -1) }
    })
  }, [])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (textAt) {
          setTextAt(null)
          setTextValue("")
        } else {
          onClose()
        }
        return
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [onClose, redo, textAt, undo])

  const canvasPoint = (e: ReactPointerEvent<HTMLCanvasElement>): Point => {
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    return {
      x: ((e.clientX - rect.left) * canvas.width) / rect.width,
      y: ((e.clientY - rect.top) * canvas.height) / rect.height,
    }
  }

  const strokeFor = () => {
    const canvas = canvasRef.current
    if (!canvas) return width
    const factor = Math.max(0.7, Math.max(canvas.width, canvas.height) / 1000)
    return Math.max(1.5, width * factor)
  }

  const textSize = () => {
    const canvas = canvasRef.current
    if (!canvas) return 28
    return Math.max(20, Math.round(Math.max(canvas.width, canvas.height) * 0.035))
  }

  const clampZoom = (value: number) => Math.min(8, Math.max(1, value))

  const clampPan = (x: number, y: number, z: number) => {
    const stage = stageRef.current
    const wrap = wrapRef.current
    if (!stage || !wrap || z <= 1) return { x: 0, y: 0 }
    const sr = stage.getBoundingClientRect()
    const wr = wrap.getBoundingClientRect()
    const w = wr.width * z
    const h = wr.height * z
    const margin = 48
    const minX = sr.left + margin - (wr.left + w)
    const maxX = sr.right - margin - wr.left
    const minY = sr.top + margin - (wr.top + h)
    const maxY = sr.bottom - margin - wr.top
    return {
      x: Math.min(maxX, Math.max(minX, x)),
      y: Math.min(maxY, Math.max(minY, y)),
    }
  }

  // Keep state and refs in sync: wheel events can fire faster than React renders.
  const applyView = (nextZoom: number, nextPan: Point) => {
    zoomRef.current = nextZoom
    panRef.current = nextPan
    setZoom(nextZoom)
    setPan(nextPan)
  }

  // Zooms while keeping the image pixel under (clientX, clientY) in place.
  const zoomAt = (nextZoom: number, clientX: number, clientY: number) => {
    const wrap = wrapRef.current
    if (!wrap || !loaded) return
    const currentZoom = zoomRef.current
    const currentPan = panRef.current
    const z = clampZoom(nextZoom)
    if (Math.abs(z - currentZoom) < 0.001) return
    const base = wrap.getBoundingClientRect()
    const rx = clientX - base.left
    const ry = clientY - base.top
    const localX = (rx - currentPan.x) / currentZoom
    const localY = (ry - currentPan.y) / currentZoom
    if (z <= 1.0001) {
      applyView(1, { x: 0, y: 0 })
      return
    }
    applyView(z, clampPan(rx - localX * z, ry - localY * z, z))
  }

  const zoomAtCenter = (factor: number) => {
    const stage = stageRef.current
    if (!stage) return
    const rect = stage.getBoundingClientRect()
    zoomAt(zoomRef.current * factor, rect.left + rect.width / 2, rect.top + rect.height / 2)
  }

  const fitImage = () => {
    applyView(1, { x: 0, y: 0 })
  }

  const beginText = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    const stage = stageRef.current
    if (!canvas || !stage) return
    const p = canvasPoint(e)
    const stageRect = stage.getBoundingClientRect()
    const left = Math.max(6, Math.min(e.clientX - stageRect.left, stageRect.width - 216))
    const top = Math.max(6, Math.min(e.clientY - stageRect.top, stageRect.height - 42))
    textGuard.current = false
    setTextValue("")
    setTextAt({ x: p.x, y: p.y, left, top })
    requestAnimationFrame(() => textRef.current?.focus())
  }

  const commitText = useCallback(() => {
    if (textGuard.current) return
    textGuard.current = true
    const value = textValue.trim()
    if (textAt && value) {
      setHistory((h) => ({
        ops: [...h.ops, { tool: "text", color, x: textAt.x, y: textAt.y, text: value, size: textSize() }],
        redo: [],
      }))
    }
    setTextAt(null)
    setTextValue("")
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [color, textAt, textValue])

  const clearDraft = () => {
    startRef.current = null
    pointsRef.current = []
    draftRef.current = null
    setDraft(null)
  }

  const beginPinch = () => {
    const points = Array.from(pointersRef.current.values()).slice(0, 2)
    const wrap = wrapRef.current
    if (points.length < 2 || !wrap) return
    const [a, b] = points
    const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
    const distance = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y))
    const base = wrap.getBoundingClientRect()
    const currentZoom = zoomRef.current
    const currentPan = panRef.current
    panDragRef.current = null
    gestureRef.current = {
      distance,
      zoom: currentZoom,
      localX: (center.x - base.left - currentPan.x) / currentZoom,
      localY: (center.y - base.top - currentPan.y) / currentZoom,
      baseLeft: base.left,
      baseTop: base.top,
    }
    setPanning(true)
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!loaded) return
    e.preventDefault()
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointersRef.current.size >= 2) {
      clearDraft()
      beginPinch()
      try {
        e.currentTarget.setPointerCapture(e.pointerId)
      } catch {}
      return
    }
    if (tool === "pan" || e.button === 1 || spaceRef.current || (e.altKey && e.pointerType !== "touch")) {
      const currentPan = panRef.current
      panDragRef.current = { startX: e.clientX, startY: e.clientY, panX: currentPan.x, panY: currentPan.y }
      setPanning(true)
      try {
        e.currentTarget.setPointerCapture(e.pointerId)
      } catch {}
      return
    }
    if (tool === "text") {
      beginText(e)
      return
    }
    const p = canvasPoint(e)
    startRef.current = p
    pointsRef.current = [p]
    const drawTool = tool as Exclude<Tool, "pan" | "text">
    const op: Op =
      drawTool === "pen"
        ? { tool: "pen", color, width: strokeFor(), points: [p] }
        : { tool: drawTool, color, width: strokeFor(), from: p, to: p }
    draftRef.current = op
    setDraft(op)
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const tracked = pointersRef.current.get(e.pointerId)
    if (tracked) {
      tracked.x = e.clientX
      tracked.y = e.clientY
    }

    const gesture = gestureRef.current
    if (gesture && pointersRef.current.size >= 2) {
      const [a, b] = Array.from(pointersRef.current.values()).slice(0, 2)
      const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      const distance = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y))
      const nextZoom = clampZoom(gesture.zoom * (distance / gesture.distance))
      applyView(
        nextZoom,
        clampPan(
          center.x - gesture.baseLeft - gesture.localX * nextZoom,
          center.y - gesture.baseTop - gesture.localY * nextZoom,
          nextZoom,
        ),
      )
      return
    }

    if (panDragRef.current) {
      const drag = panDragRef.current
      applyView(
        zoomRef.current,
        clampPan(
          drag.panX + (e.clientX - drag.startX),
          drag.panY + (e.clientY - drag.startY),
          zoomRef.current,
        ),
      )
      return
    }

    if (!startRef.current) return
    if (tool === "pan" || tool === "text") return
    const p = canvasPoint(e)
    if (tool === "pen") {
      pointsRef.current.push(p)
      const op: PenOp = { tool: "pen", color, width: strokeFor(), points: [...pointsRef.current] }
      draftRef.current = op
      setDraft(op)
      return
    }
    const op: ShapeOp = { tool, color, width: strokeFor(), from: startRef.current, to: p }
    draftRef.current = op
    setDraft(op)
  }

  const finishPointer = (commit: boolean) => {
    if (!startRef.current) return
    const op = draftRef.current
    startRef.current = null
    pointsRef.current = []
    draftRef.current = null
    setDraft(null)
    if (!commit || !op) return
    if (op.tool === "rect" || op.tool === "ellipse" || op.tool === "arrow") {
      const dx = op.to.x - op.from.x
      const dy = op.to.y - op.from.y
      if (Math.hypot(dx, dy) < 3) return
    }
    setHistory((h) => ({ ops: [...h.ops, op], redo: [] }))
  }

  const endPointer = (commit: boolean) => {
    if (gestureRef.current) {
      if (pointersRef.current.size < 2) {
        gestureRef.current = null
        setPanning(false)
      }
      return
    }
    if (panDragRef.current) {
      panDragRef.current = null
      setPanning(false)
      return
    }
    finishPointer(commit)
  }

  const onPointerUp = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    pointersRef.current.delete(e.pointerId)
    endPointer(true)
  }

  const onPointerCancel = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    pointersRef.current.delete(e.pointerId)
    endPointer(false)
  }

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const factor = Math.exp(-e.deltaY * 0.0015)
      zoomAt(zoomRef.current * factor, e.clientX, e.clientY)
    }
    stage.addEventListener("wheel", onWheel, { passive: false })
    return () => stage.removeEventListener("wheel", onWheel)
    // zoomAt reads the live zoom/pan refs, so the listener can stay registered.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded])

  // Keep the image reachable after a window resize or device rotation.
  useEffect(() => {
    if (!loaded) return
    const onResize = () => {
      const currentZoom = zoomRef.current
      if (currentZoom <= 1) {
        applyView(1, { x: 0, y: 0 })
        return
      }
      applyView(currentZoom, clampPan(panRef.current.x, panRef.current.y, currentZoom))
    }
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded])

  useEffect(() => {
    const typing = (target: EventTarget | null) => {
      const el = target as HTMLElement | null
      return Boolean(
        el &&
          (el.tagName === "INPUT" ||
            el.tagName === "TEXTAREA" ||
            el.tagName === "SELECT" ||
            el.isContentEditable),
      )
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (typing(e.target)) return
      if (e.code === "Space") {
        // Keep Space working as activation for focused toolbar buttons.
        const el = e.target as HTMLElement | null
        if (el?.closest?.("button, a, [role='button']")) return
        if (!spaceRef.current) {
          spaceRef.current = true
          setSpaceDown(true)
        }
        e.preventDefault()
        return
      }
      if (e.key === "+" || e.key === "=") {
        e.preventDefault()
        zoomAtCenter(1.25)
        return
      }
      if (e.key === "-" || e.key === "_") {
        e.preventDefault()
        zoomAtCenter(0.8)
        return
      }
      if (e.key === "0") {
        e.preventDefault()
        fitImage()
      }
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        spaceRef.current = false
        setSpaceDown(false)
      }
    }
    const onBlur = () => {
      spaceRef.current = false
      setSpaceDown(false)
    }
    window.addEventListener("keydown", onKeyDown)
    window.addEventListener("keyup", onKeyUp)
    window.addEventListener("blur", onBlur)
    return () => {
      window.removeEventListener("keydown", onKeyDown)
      window.removeEventListener("keyup", onKeyUp)
      window.removeEventListener("blur", onBlur)
    }
  }, [zoom, pan, loaded])

  const exportBlob = () =>
    new Promise<Blob>((resolve, reject) => {
      const canvas = canvasRef.current
      if (!canvas) {
        reject(new Error("no canvas"))
        return
      }
      try {
        canvas.toBlob((blob) => {
          if (blob) resolve(blob)
          else reject(new Error("empty image"))
        }, "image/png")
      } catch (error) {
        reject(error)
      }
    })

  // If the text tool is active, commit it before exporting so the saved image
  // includes the text the user just typed. The extra frame lets React redraw
  // the canvas even when the input's blur already committed the text.
  const flushText = async () => {
    const pending = Boolean(textAt && textValue.trim())
    if (pending && !textGuard.current) commitText()
    if (pending || textGuard.current) {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    }
  }

  const download = async () => {
    setSaveError("")
    try {
      await flushText()
      const blob = await exportBlob()
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement("a")
      anchor.href = url
      anchor.download = editedName(name)
      anchor.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 1500)
    } catch {
      setSaveError(
        t("This image cannot be saved because it is loaded from another site. Download it and attach it instead."),
      )
    }
  }

  const save = async () => {
    if (!loaded || saving) return
    setSaving(true)
    setSaveError("")
    try {
      await flushText()
      const blob = await exportBlob()
      const dataUrl = await blobToDataUrl(blob)
      await onSave({ dataUrl, name: editedName(name) })
    } catch {
      setSaveError(
        t("This image cannot be saved because it is loaded from another site. Download it and attach it instead."),
      )
    } finally {
      setSaving(false)
    }
  }

  const toolLabel = (id: Tool) => {
    if (id === "pan") return t("Pan")
    if (id === "pen") return t("Pen")
    if (id === "text") return t("Text")
    if (id === "rect") return t("Rectangle")
    if (id === "ellipse") return t("Ellipse")
    return t("Arrow")
  }

  const actionButton = (label: string, disabled: boolean, onClick: () => void, icon: string) => (
    <button
      type="button"
      className="image-tool"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      <ToolIcon name={icon} />
    </button>
  )

  return (
    <div
      className="image-editor-backdrop"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="image-editor" role="dialog" aria-modal="true" aria-label={t("Image editor")}>
        <div className="image-editor-head">
          <div className="image-editor-title">
            <strong>{t("Edit image")}</strong>
            <span dir="auto">{name || t("Image")}</span>
          </div>
          <div className="image-editor-head-actions">
            <div className="image-zoom-controls" role="group" aria-label={t("Zoom")}>
              <button
                type="button"
                className="image-zoom-btn"
                onClick={() => zoomAtCenter(0.8)}
                disabled={!loaded || zoom <= 1}
                title={t("Zoom out")}
                aria-label={t("Zoom out")}
              >
                −
              </button>
              <span className="image-zoom-value" aria-live="polite">
                {num(Math.round(zoom * 100))}%
              </span>
              <button
                type="button"
                className="image-zoom-btn"
                onClick={() => zoomAtCenter(1.25)}
                disabled={!loaded || zoom >= 8}
                title={t("Zoom in")}
                aria-label={t("Zoom in")}
              >
                +
              </button>
              <button
                type="button"
                className="image-zoom-fit"
                onClick={fitImage}
                title={t("Fit to window")}
                aria-label={t("Fit to window")}
              >
                {t("Fit")}
              </button>
            </div>
            <button
              type="button"
              className="image-editor-close"
              onClick={onClose}
              aria-label={t("Close image editor")}
              title={t("Close")}
            >
              ×
            </button>
          </div>
        </div>

        <div className="image-editor-body">
          <div
            ref={stageRef}
            className={`image-editor-stage ${panning ? "is-panning" : ""} ${spaceDown ? "space-pan" : ""}`}
          >
            <div className="image-editor-canvas-wrap" ref={wrapRef}>
              <canvas
                ref={canvasRef}
                data-tool={tool}
                data-panning={panning ? "true" : undefined}
                data-space={spaceDown ? "true" : undefined}
                style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: "0 0" }}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerCancel}
              />
              {!loaded && !loadError && (
                <div className="image-editor-loading">{t("Loading image…")}</div>
              )}
              {loadError && <div className="image-editor-error">{loadError}</div>}
            </div>
            {textAt && (
              <input
                ref={textRef}
                className="image-text-input"
                dir="auto"
                value={textValue}
                placeholder={t("Type here…")}
                style={{ left: textAt.left, top: textAt.top, color }}
                onChange={(e) => setTextValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing) return
                  if (e.key === "Enter") {
                    e.preventDefault()
                    commitText()
                  } else if (e.key === "Escape") {
                    e.preventDefault()
                    setTextAt(null)
                    setTextValue("")
                  }
                }}
                onBlur={() => {
                  if (textGuard.current) return
                  if (textValue.trim()) commitText()
                  else setTextAt(null)
                }}
              />
            )}
          </div>

          <div className="image-editor-tools" role="toolbar" aria-label={t("Image tools")}>
            {TOOLS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`image-tool ${tool === item.id ? "on" : ""}`}
                title={toolLabel(item.id)}
                aria-label={toolLabel(item.id)}
                aria-pressed={tool === item.id}
                onClick={() => {
                  if (textAt) commitText()
                  setTool(item.id)
                }}
              >
                <ToolIcon name={item.icon} />
              </button>
            ))}
            <span className="image-tool-sep" />
            {actionButton(t("Undo"), history.ops.length === 0, undo, "undo")}
            {actionButton(t("Redo"), history.redo.length === 0, redo, "redo")}
            {actionButton(t("Clear"), history.ops.length === 0 && !textAt, () => reset(), "clear")}
            <span className="image-tool-sep" />
            <div className="image-colors" aria-label={t("Color")}>
              {COLORS.map((value) => (
                <button
                  key={value}
                  type="button"
                  className={`image-color ${color === value ? "on" : ""}`}
                  style={{ background: value }}
                  title={`${t("Color")} ${value}`}
                  aria-label={`${t("Color")} ${value}`}
                  onClick={() => setColor(value)}
                />
              ))}
            </div>
            <span className="image-tool-sep" />
            <label className="image-width" title={t("Stroke width")}>
              <span>{num(width)}</span>
              <input
                type="range"
                min={2}
                max={14}
                step={1}
                value={width}
                onChange={(e) => setWidth(Number(e.target.value))}
                aria-label={t("Stroke width")}
              />
            </label>
          </div>
        </div>

        <div className="image-editor-foot">
          <span className="image-editor-hint">
            {hint ?? t("Draw on the image. Scroll or pinch to zoom; hold Space and drag to pan.")}
          </span>
          <div className="image-editor-actions">
            {saveError && <span className="image-editor-save-error">{saveError}</span>}
            <button type="button" className="btn" onClick={onClose}>
              {t("Cancel")}
            </button>
            <button type="button" className="btn" onClick={() => void download()} disabled={!loaded}>
              <ToolIcon name="download" /> {t("Download")}
            </button>
            <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={!loaded || saving}>
              {saving ? t("Saving…") : (saveLabel ?? t("Save to chat"))}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
