import { useEffect, useMemo, useRef, useState } from "react"
import type { ModelInfo, ModelRef } from "./types"

type Props = {
  models: ModelInfo[]
  value: ModelRef | null
  onPick: (ref: ModelRef) => void
  onClose: () => void
}

export function ModelPicker({ models, value, onPick, onClose }: Props) {
  const [query, setQuery] = useState("")
  const [expanded, setExpanded] = useState<string | null>(null)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) onClose()
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("mousedown", down)
    document.addEventListener("keydown", key)
    return () => {
      document.removeEventListener("mousedown", down)
      document.removeEventListener("keydown", key)
    }
  }, [onClose])

  const list = useMemo(() => {
    const q = query.trim().toLowerCase()
    return models
      .filter((m) => m.enabled !== false)
      .filter((m) => !q || `${m.name} ${m.modelID} ${m.providerID}`.toLowerCase().includes(q))
  }, [models, query])

  const isCurrent = (m: ModelInfo) => value?.providerID === m.providerID && value?.id === (m.modelID ?? m.id)

  return (
    <div className="model-pop" ref={box}>
      <div className="model-pop-head">
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="جست‌وجوی مدل…"
          aria-label="جست‌وجوی مدل"
        />
        <span className="model-count">{list.length}</span>
      </div>

      <div className="model-list">
        {list.length === 0 ? (
          <div className="model-empty" key="empty">
            مدلی پیدا نشد
          </div>
        ) : (
          list.map((m) => {
          const id = m.modelID ?? m.id
          const variants = (m.variants ?? []).map((v) => v.id)
          const current = isCurrent(m)
          const open = expanded === id
          return (
            <div key={`${m.providerID}/${id}`} className={`model-row ${current ? "current" : ""}`}>
              <button
                type="button"
                className="model-name"
                onClick={() => {
                  if (variants.length) setExpanded(open ? null : id)
                  else onPick({ id, providerID: m.providerID })
                }}
              >
                <span className="mn">{m.name}</span>
                <span className="mm" dir="ltr">
                  {m.providerID}
                  {variants.length ? ` · ${variants.length} level` : ""}
                </span>
                {current && <span className="mcheck">✓</span>}
              </button>

              {open && (
                <div className="variant-row">
                  <button
                    type="button"
                    className={current && !value?.variant ? "on" : ""}
                    onClick={() => onPick({ id, providerID: m.providerID })}
                  >
                    پیش‌فرض
                  </button>
                  {variants.map((v) => (
                    <button
                      key={v}
                      type="button"
                      className={current && value?.variant === v ? "on" : ""}
                      onClick={() => onPick({ id, providerID: m.providerID, variant: v })}
                    >
                      {v}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )
          })
        )}
      </div>
    </div>
  )
}
