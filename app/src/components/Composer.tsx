import { memo, useEffect, useMemo, useRef, useState } from "react"
import type { Attachment, MenuItem, PromptFile } from "../lib/types"
import type { PermissionMode } from "../lib/permissions"
import { useI18n } from "../lib/i18n"
import { ImageEditor } from "./ImageEditor"
import { PermissionPicker } from "./PermissionPicker"

type Props = {
  busy: boolean
  status: string
  disabled: boolean
  onSend: (text: string, files: Attachment[], promptFiles: PromptFile[]) => void | Promise<boolean>
  onStop: () => void
  placeholder: string
  slashItems: MenuItem[]
  onSlashPick: (id: string) => void
  workdir: string
  permission: PermissionMode
  onPermissionChange: (mode: PermissionMode) => void
  permissionBusy?: boolean
  registerAddImage?: (add: (image: Attachment) => void) => void
}

type Entry = { path: string; type: "file" | "directory" }

export const Composer = memo(function Composer({
  busy,
  status,
  disabled,
  onSend,
  onStop,
  placeholder,
  slashItems,
  onSlashPick,
  workdir,
  permission,
  onPermissionChange,
  permissionBusy = false,
  registerAddImage,
}: Props) {
  const { t } = useI18n()
  const [value, setValue] = useState("")
  const [imgs, setImgs] = useState<Attachment[]>([])
  const [docs, setDocs] = useState<Attachment[]>([])
  const [files, setFiles] = useState<PromptFile[]>([])
  const [attachError, setAttachError] = useState<string | null>(null)
  const [editingImage, setEditingImage] = useState<{ index: number; src: string; name: string } | null>(null)
  const [sending, setSending] = useState(false)
  const [hl, setHl] = useState(0)
  const [closedQuery, setClosedQuery] = useState<string | null>(null)
  const [mResults, setMResults] = useState<Entry[]>([])
  const [mHl, setMHl] = useState(0)
  const [closedMention, setClosedMention] = useState<string | null>(null)
  const [caret, setCaret] = useState(0)
  const ref = useRef<HTMLTextAreaElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const setCaretAt = (pos: number) => setCaret((prev) => (prev === pos ? prev : pos))

  // App uses this to drop an edited message image into the composer.
  useEffect(() => {
    if (!registerAddImage) return
    registerAddImage((image) => {
      setImgs((prev) => [...prev, image])
      requestAnimationFrame(() => ref.current?.focus())
    })
  }, [registerAddImage])

  const addFiles = (list: File[] | FileList | null) => {
    if (!list) return
    setAttachError(null)
    for (const f of Array.from(list)) {
      if (f.size > 25 * 1024 * 1024) {
        setAttachError(t("\"{name}\" is larger than 25 MB and was not attached.", { name: f.name }))
        continue
      }
      const isImage =
        f.type.startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp|svg|avif)$/i.test(f.name)
      const fr = new FileReader()
      fr.onload = () => {
        if (typeof fr.result !== "string") return
        const item: Attachment = {
          name: f.name || (isImage ? t("Image") : t("File")),
          dataUrl: fr.result,
          size: f.size,
          type: f.type || (isImage ? "image/*" : "application/octet-stream"),
        }
        if (isImage) setImgs((prev) => [...prev, item])
        else setDocs((prev) => [...prev, item])
      }
      fr.onerror = () => setAttachError(t("Could not read \"{name}\".", { name: f.name }))
      fr.readAsDataURL(f)
    }
  }

  const onPaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items
    if (!items) return
    const imageFiles: File[] = []
    for (const it of Array.from(items)) {
      if (it.kind === "file" && it.type.startsWith("image/")) {
        const f = it.getAsFile()
        if (f) imageFiles.push(f)
      }
    }
    if (imageFiles.length > 0) {
      e.preventDefault()
      addFiles(imageFiles)
    }
  }

  const rawQuery = value.startsWith("/") && !value.slice(1).includes(" ") ? value.slice(1).toLowerCase() : null
  const query = rawQuery !== null && rawQuery === closedQuery ? null : rawQuery
  const filtered = useMemo(() => {
    if (query === null) return []
    return slashItems.filter((i) => {
      if (query === "") return true
      return `${i.label} ${i.hint ?? ""} ${i.id}`.toLowerCase().includes(query)
    })
  }, [query, slashItems])
  const showMenu = filtered.length > 0

  useEffect(() => {
    setHl(0)
    if (rawQuery !== closedQuery) setClosedQuery(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawQuery])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    // خواندن scrollHeight یک layout اجباری است؛ آن را به فریم بعد موکول
    // می‌کنیم تا تایپ هر کاراکتر یک بار دیگر layout را مجبور نکند.
    const frame = requestAnimationFrame(() => {
      el.style.height = "auto"
      el.style.height = Math.min(el.scrollHeight, 220) + "px"
    })
    return () => cancelAnimationFrame(frame)
  }, [value])

  const upTo = value.slice(0, caret)
  const atIdx = upTo.lastIndexOf("@")
  // @ باید در ابتدای متن یا بعد از فاصله باشد؛ وگرنه ایمیل/URL هم منشن باز می‌کند.
  const atBoundary = atIdx === 0 || (atIdx > 0 && /\s/.test(upTo[atIdx - 1]))
  const between = atIdx >= 0 ? upTo.slice(atIdx + 1) : ""
  const mentionRaw = atIdx >= 0 && atBoundary && !/[\s]/.test(between) ? between : null
  const mentionQuery = mentionRaw !== null && mentionRaw === closedMention ? null : mentionRaw
  const mentionOpen = mentionQuery !== null

  useEffect(() => {
    if (mentionRaw !== closedMention) setClosedMention(null)
    setMHl(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mentionRaw])

  useEffect(() => {
    if (!mentionOpen || !workdir) {
      setMResults([])
      return
    }
    const ac = new AbortController()
    const timer = window.setTimeout(async () => {
      const params = new URLSearchParams()
      params.set("location[directory]", workdir)
      params.set("query", mentionQuery ?? "")
      params.set("limit", "12")
      try {
        const res = await fetch(`/oc/api/fs/${mentionQuery ? "find" : "list"}?${params}`, { signal: ac.signal })
        const json = await res.json()
        const rows: Entry[] = (json.data ?? []).filter((e: Entry) => e.type === "file")
        setMResults(rows)
      } catch {
        if (!ac.signal.aborted) setMResults([])
      }
    }, 160)
    return () => {
      ac.abort()
      window.clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mentionQuery, mentionOpen, workdir])

  const pickMention = (entry?: Entry) => {
    if (!entry) return
    const str = value.slice(0, atIdx) + value.slice(caret)
    setValue(str)
    setCaret(atIdx)
    setClosedMention(null)
    if (files.some((f) => f.uri.endsWith(entry.path.replace(/\\/g, "/")))) return
    const base = workdir.replace(/\\/g, "/").replace(/\/+$/, "")
    const abs = entry.path.replace(/\\/g, "/")
    const uri = /^[A-Za-z]:\//.test(abs)
      ? "file:///" + abs
      : abs.startsWith("/")
        ? "file://" + abs
        : "file:///" + (base + "/" + abs).replace(/^\//, "")
    setFiles((prev) => [...prev, { uri, name: entry.path }])
  }

  const pick = (item?: MenuItem) => {
    if (!item) return
    setValue("")
    setClosedQuery(null)
    onSlashPick(item.id)
  }

  const submit = () => {
    if (mentionOpen && mResults.length > 0) {
      pickMention(mResults[Math.min(mHl, mResults.length - 1)])
      return
    }
    if (showMenu) {
      const it = filtered[Math.min(hl, filtered.length - 1)]
      if (it) pick(it)
      else void sendOrQueue()
      return
    }
    void sendOrQueue()
  }

  const sendOrQueue = async () => {
    const text = value.trim()
    if (sending || (!text && imgs.length === 0 && docs.length === 0 && files.length === 0) || disabled) return
    const sent = [...imgs, ...docs]
    const sentFiles = files
    setSending(true)
    // فقط بعد از موفقیت ارسال پاک می‌کنیم تا با خطای شبکه متن/پیوست از دست نرود.
    let ok: boolean | void
    try {
      ok = await onSend(text, sent, sentFiles)
    } catch {
      return
    } finally {
      setSending(false)
    }
    if (ok === false) return
    setValue("")
    setImgs([])
    setDocs([])
    setFiles([])
    setAttachError(null)
    setCaret(0)
    setClosedMention(null)
  }

  return (
    <div className="composer-wrap">
      {showMenu && (
        <div className="slash-pop" role="listbox" aria-label={t("Command menu")}>
          {grouped(filtered, [t("Commands"), t("Custom"), t("Skills")]).map(([group, items]) => (
            <div key={group} className="slash-group">
              <div className="slash-group-title">{group}</div>
              {items.map((item) => {
                const i = filtered.indexOf(item)
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={`slash-item ${i === hl ? "on" : ""}`}
                    onMouseEnter={() => setHl(i)}
                    onMouseDown={(e) => {
                      e.preventDefault()
                      pick(item)
                    }}
                  >
                    <code dir="ltr">/{item.label}</code>
                    {item.hint && <span>{item.hint}</span>}
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      )}

      {mentionOpen && mResults.length > 0 && (
        <div className="mention-pop" role="listbox" aria-label={t("Choose file")}>
          {mResults.map((e, i) => (
            <button
              key={e.path}
              type="button"
              className={`mention-item ${i === mHl ? "on" : ""}`}
              onMouseEnter={() => setMHl(i)}
              onMouseDown={(ev) => {
                ev.preventDefault()
                pickMention(e)
              }}
            >
              <span className="mention-ic" aria-hidden>
                📄
              </span>
              <code dir="ltr">{e.path}</code>
            </button>
          ))}
        </div>
      )}

      {(imgs.length > 0 || docs.length > 0 || files.length > 0) && (
        <div className="attach-row" aria-label={t("Attachments")}>
          {imgs.map((f, i) => (
            <span key={`i${i}`} className="attach-chip">
              <span className="attach-thumb-wrap">
                <img
                  src={f.dataUrl}
                  alt=""
                  className="attach-thumb"
                  role="button"
                  tabIndex={0}
                  title={t("Edit image")}
                  onClick={() => setEditingImage({ index: i, src: f.dataUrl, name: f.name })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault()
                      setEditingImage({ index: i, src: f.dataUrl, name: f.name })
                    }
                  }}
                />
                <span className="attach-edit-badge" aria-hidden>
                  ✎
                </span>
              </span>
              <span className="attach-name" dir="ltr">{f.name}</span>
              <button
                type="button"
                aria-label={t("Remove")}
                onClick={() => setImgs((prev) => prev.filter((_, j) => j !== i))}
              >
                ×
              </button>
            </span>
          ))}
          {docs.map((f, i) => (
            <span key={`d${i}`} className="attach-chip file">
              <span className="mention-ic" aria-hidden>
                📄
              </span>
              <span className="attach-name" dir="ltr">{f.name}</span>
              {typeof f.size === "number" && <span className="attach-size">{formatSize(f.size)}</span>}
              <button
                type="button"
                aria-label={t("Remove")}
                onClick={() => setDocs((prev) => prev.filter((_, j) => j !== i))}
              >
                ×
              </button>
            </span>
          ))}
          {files.map((f, i) => (
            <span key={`f${i}`} className="attach-chip file">
              <span className="mention-ic" aria-hidden>
                📄
              </span>
              <span className="attach-name" dir="ltr">{f.name}</span>
              <button
                type="button"
                aria-label={t("Remove")}
                onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {attachError && (
        <div className="composer-error" role="alert">
          {attachError}
        </div>
      )}

      {status && (
        <div className="composer-status" role="status" aria-live="polite">
          <span className="composer-status-dot" aria-hidden />
          <span>{status}</span>
        </div>
      )}

      <div
        className={`composer ${busy ? "is-busy" : ""}`}
        onDragOver={(e) => {
          e.preventDefault()
          e.currentTarget.classList.add("drag")
        }}
        onDragLeave={(e) => {
          e.currentTarget.classList.remove("drag")
        }}
        onDrop={(e) => {
          e.preventDefault()
          e.currentTarget.classList.remove("drag")
          addFiles(e.dataTransfer?.files ?? null)
        }}
      >
        <textarea
          ref={ref}
          dir="auto"
          rows={1}
          value={value}
          disabled={disabled}
          placeholder={placeholder}
          onChange={(e) => {
            setValue(e.target.value)
            setCaretAt(e.target.selectionStart ?? e.target.value.length)
          }}
          onKeyUp={(e) => setCaretAt(e.currentTarget.selectionStart ?? 0)}
          onClick={(e) => setCaretAt(e.currentTarget.selectionStart ?? 0)}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if (mentionOpen && mResults.length > 0) {
              if (e.key === "ArrowDown") {
                e.preventDefault()
                setMHl((h) => Math.min(h + 1, mResults.length - 1))
                return
              }
              if (e.key === "ArrowUp") {
                e.preventDefault()
                setMHl((h) => Math.max(h - 1, 0))
                return
              }
              if (e.key === "Escape") {
                e.preventDefault()
                if (mentionRaw !== null) setClosedMention(mentionRaw)
                return
              }
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                pickMention(mResults[Math.min(mHl, mResults.length - 1)])
                return
              }
            }
            if (showMenu && e.key === "ArrowDown") {
              e.preventDefault()
              setHl((h) => Math.min(h + 1, filtered.length - 1))
              return
            }
            if (showMenu && e.key === "ArrowUp") {
              e.preventDefault()
              setHl((h) => Math.max(h - 1, 0))
              return
            }
            if (showMenu && e.key === "Escape") {
              e.preventDefault()
              setClosedQuery(rawQuery)
              return
            }
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
        />
        <div className="composer-tools">
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              addFiles(e.target.files)
              e.target.value = ""
            }}
          />
          <button
            type="button"
            className="composer-plus"
            disabled={disabled}
            onClick={() => fileInput.current?.click()}
            title={t("Attach files or images")}
            aria-label={t("Attach files or images")}
          >
            +
          </button>
          <PermissionPicker
            mode={permission}
            busy={permissionBusy}
            disabled={disabled}
            onChange={onPermissionChange}
          />
          <span className="composer-tools-spacer" />
          {busy && (
            <button type="button" className="stop" onClick={onStop} title={t("Stop")}>
              <span />
            </button>
          )}
          {(!busy || value.trim() || imgs.length > 0 || docs.length > 0 || files.length > 0) && (
            <button
              type="button"
              className={`send ${busy ? "queued" : ""}`}
              onClick={submit}
              disabled={sending || (!value.trim() && imgs.length === 0 && docs.length === 0 && files.length === 0) || disabled}
              title={busy ? t("Queue message") : t("Send")}
            >
              ↑
            </button>
          )}
        </div>
      </div>
      <div className="composer-hint">
        <span className="hint-group">
          <kbd>Enter</kbd>
          <span>{t("Send")}</span>
        </span>
        <span className="hint-group">
          <kbd>Shift</kbd>
          <kbd>Enter</kbd>
          <span>{t("New line")}</span>
        </span>
        <span className="hint-group">
          <kbd>/</kbd>
          <span>{t("Commands")}</span>
        </span>
        <span className="hint-group">
          <kbd>@</kbd>
          <span>{t("File")}</span>
        </span>
        <span className="hint-group">
          <kbd>Ctrl</kbd>
          <kbd>V</kbd>
          <span>{t("Image")}</span>
        </span>
      </div>

      {editingImage && (
        <ImageEditor
          src={editingImage.src}
          name={editingImage.name}
          saveLabel={t("Apply changes")}
          hint={t("Edit the attached image, then apply the changes.")}
          onClose={() => setEditingImage(null)}
          onSave={(image) => {
            setImgs((prev) =>
              prev.map((item, i) =>
                i === editingImage.index ? { ...item, dataUrl: image.dataUrl, name: image.name } : item,
              ),
            )
            setEditingImage(null)
          }}
        />
      )}
    </div>
  )
})

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function grouped(items: MenuItem[], order: string[]): Array<[string, MenuItem[]]> {
  const map = new Map<string, MenuItem[]>()
  for (const item of items) {
    const row = map.get(item.group) ?? []
    row.push(item)
    map.set(item.group, row)
  }
  for (const g of order) if (map.has(g)) map.set(g, [...(map.get(g) ?? [])])
  return [...map.entries()].sort((a, b) => {
    const ai = order.indexOf(a[0])
    const bi = order.indexOf(b[0])
    return (ai === -1 ? order.length : ai) - (bi === -1 ? order.length : bi)
  })
}
