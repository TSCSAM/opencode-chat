import { useEffect, useMemo, useRef, useState } from "react"
import type { Attachment, MenuItem, PromptFile } from "./types"

type Props = {
  busy: boolean
  disabled: boolean
  onSend: (text: string, files: Attachment[], promptFiles: PromptFile[]) => void
  onStop: () => void
  placeholder: string
  slashItems: MenuItem[]
  onSlashPick: (id: string) => void
  workdir: string
}

type Entry = { path: string; type: "file" | "directory" }

export function Composer({ busy, disabled, onSend, onStop, placeholder, slashItems, onSlashPick, workdir }: Props) {
  const [value, setValue] = useState("")
  const [imgs, setImgs] = useState<Attachment[]>([])
  const [files, setFiles] = useState<PromptFile[]>([])
  const [hl, setHl] = useState(0)
  const [closedQuery, setClosedQuery] = useState<string | null>(null)
  const [mResults, setMResults] = useState<Entry[]>([])
  const [mHl, setMHl] = useState(0)
  const [closedMention, setClosedMention] = useState<string | null>(null)
  const [caret, setCaret] = useState(0)
  const ref = useRef<HTMLTextAreaElement>(null)

  const addFiles = (list: File[] | FileList | null) => {
    if (!list) return
    for (const f of Array.from(list)) {
      if (!f.type.startsWith("image/")) continue
      const fr = new FileReader()
      fr.onload = () => {
        if (typeof fr.result === "string") {
          setImgs((prev) => [...prev, { name: f.name || "تصویر", dataUrl: fr.result as string }] as Attachment[])
        }
      }
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
    el.style.height = "auto"
    el.style.height = Math.min(el.scrollHeight, 220) + "px"
  }, [value])

  const upTo = value.slice(0, caret)
  const atIdx = upTo.lastIndexOf("@")
  const between = atIdx >= 0 ? upTo.slice(atIdx + 1) : ""
  const mentionRaw = atIdx >= 0 && !/[\s]/.test(between) ? between : null
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
    const uri = abs.startsWith("/") ? "file://" + abs : "file:///" + (base + "/" + abs).replace(/^\//, "")
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
      void (it ? pick(it) : sendOrQueue())
      return
    }
    void sendOrQueue()
  }

  const sendOrQueue = () => {
    const text = value.trim()
    if ((!text && imgs.length === 0 && files.length === 0) || disabled) return
    const sent = imgs
    const sentFiles = files
    setValue("")
    setImgs([])
    setFiles([])
    setCaret(0)
    setClosedMention(null)
    onSend(text, sent, sentFiles)
  }

  return (
    <div className="composer-wrap">
      {showMenu && (
        <div className="slash-pop" role="listbox" aria-label="منوی کامندها">
          {grouped(filtered).map(([group, items]) => (
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
        <div className="mention-pop" role="listbox" aria-label="انتخاب فایل">
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

      {(imgs.length > 0 || files.length > 0) && (
        <div className="attach-row" aria-label="پیوست‌ها">
          {imgs.map((f, i) => (
            <span key={`i${i}`} className="attach-chip">
              <img src={f.dataUrl} alt="" />
              <span className="attach-name" dir="ltr">{f.name}</span>
              <button
                type="button"
                aria-label="حذف"
                onClick={() => setImgs((prev) => prev.filter((_, j) => j !== i))}
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
                aria-label="حذف"
                onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
              >
                ×
              </button>
            </span>
          ))}
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
            setCaret(e.target.selectionStart ?? e.target.value.length)
          }}
          onKeyUp={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
          onClick={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
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
        {busy && !value.trim() ? (
          <button type="button" className="stop" onClick={onStop} title="توقف">
            <span />
          </button>
        ) : (
          <button
            type="button"
            className={`send ${busy ? "queued" : ""}`}
            onClick={submit}
            disabled={(!value.trim() && imgs.length === 0 && files.length === 0) || disabled}
            title={busy ? "به صف ارسال" : "ارسال"}
          >
            ↑
          </button>
        )}
      </div>
      <div className="composer-hint">Enter ارسال · Shift+Enter خط جدید · / کامندها · @ فایل · Ctrl+V تصویر</div>
    </div>
  )
}

const GROUP_ORDER = ["دستورها", "سفارشی", "مهارت‌ها"]
function grouped(items: MenuItem[]): Array<[string, MenuItem[]]> {
  const map = new Map<string, MenuItem[]>()
  for (const item of items) {
    const row = map.get(item.group) ?? []
    row.push(item)
    map.set(item.group, row)
  }
  for (const g of GROUP_ORDER) if (map.has(g)) map.set(g, [...(map.get(g) ?? [])])
  return [...map.entries()].sort((a, b) => GROUP_ORDER.indexOf(a[0]) - GROUP_ORDER.indexOf(b[0])).slice() as Array<[string, MenuItem[]]>
}
