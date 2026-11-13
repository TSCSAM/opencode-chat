import { memo, useEffect, useMemo, useRef } from "react"
import type { AgentInfo } from "../lib/types"
import { useI18n } from "../lib/i18n"

type Props = {
  agents: AgentInfo[]
  value: string | null
  onPick: (id: string | null) => void
  onClose: () => void
}

export const AgentPicker = memo(function AgentPicker({ agents, value, onPick, onClose }: Props) {
  const { t } = useI18n()
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const down = (e: MouseEvent) => {
      const target = e.target as Node
      if (box.current && !box.current.contains(target) && !box.current.parentElement?.contains(target)) onClose()
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

  const list = useMemo(() => agents.filter((a) => a.mode !== "subagent" && !a.hidden), [agents])

  return (
    <div className="model-pop agent-pop" ref={box}>
      <div className="model-pop-head">
        <span className="pop-title">{t("Agent")}</span>
        <span className="model-count">{list.length}</span>
      </div>
      <div className="model-list">
        <button
          type="button"
          className={`agent-row ${!value ? "current" : ""}`}
          onClick={() => onPick(null)}
        >
          <span className="agent-name">{t("Default")}</span>
          <span className="agent-desc">{t("OpenCode engine agent")}</span>
          {!value && <span className="mcheck">✓</span>}
        </button>
        {list.map((a) => (
          <button
            key={a.id}
            type="button"
            className={`agent-row ${a.id === value ? "current" : ""}`}
            onClick={() => onPick(a.id)}
          >
            <span className="agent-name">{a.name}</span>
            {a.description && <span className="agent-desc">{a.description}</span>}
            {a.id === value && <span className="mcheck">✓</span>}
          </button>
        ))}
        {list.length === 0 && <div className="model-empty">{t("No agents found")}</div>}
      </div>
    </div>
  )
})
