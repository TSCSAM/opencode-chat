import { Children, isValidElement, memo, useDeferredValue, useEffect, useRef, useState, type ReactNode } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { useI18n } from "../lib/i18n"
import { useImageEditor } from "./ImageEditor"

const REMARK = [remarkGfm]

function fallbackCopy(text: string) {
  const ta = document.createElement("textarea")
  ta.value = text
  ta.setAttribute("readonly", "")
  ta.style.position = "fixed"
  ta.style.top = "-1000px"
  ta.style.opacity = "0"
  document.body.appendChild(ta)
  ta.select()
  try {
    if (!document.execCommand("copy")) throw new Error("copy failed")
  } finally {
    ta.remove()
  }
}

function CopyButton({ text }: { text: string }) {
  const { t } = useI18n()
  const [status, setStatus] = useState<"idle" | "done" | "failed">("idle")
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current) }, [])
  const copy = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(text)
        } catch {
          fallbackCopy(text)
        }
      } else {
        fallbackCopy(text)
      }
      setStatus("done")
    } catch {
      setStatus("failed")
    }
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setStatus("idle"), 1200)
  }
  return (
    <button
      type="button"
      className="copy"
      onClick={() => void copy()}
    >
      {status === "done" ? t("Copied") : status === "failed" ? t("Copy failed") : t("Copy")}
    </button>
  )
}

function langOf(className?: string) {
  const m = /language-([\w+-]+)/.exec(className ?? "")
  return m ? m[1] : ""
}

function rawText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(rawText).join("")
  if (isValidElement<{ children?: ReactNode }>(node)) return rawText(node.props.children)
  return ""
}

function codeNodeProps(children: ReactNode) {
  for (const child of Children.toArray(children)) {
    if (isValidElement(child)) {
      return child.props as { children?: ReactNode; className?: string }
    }
  }
  return null
}

function CodeBlock({ text, className }: { text: string; className?: string }) {
  const lang = langOf(className)
  return (
    <div className="codeblock">
      <div className="codebar">
        <span>{lang || "code"}</span>
        <CopyButton text={text} />
      </div>
      <pre dir="ltr">
        <code className={className}>{text}</code>
      </pre>
    </div>
  )
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  // هنگام streaming متن هر چند میلی‌ثانیه عوض می‌شود؛ نسخهٔ تعویق‌افتاده اجازه
  // می‌دهد React رندرهای میانی را رد کند و تایپ/اسکرول روان بماند.
  const deferred = useDeferredValue(text)
  const { t } = useI18n()
  const imageEditor = useImageEditor()
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={REMARK}
        components={{
          a: ({ node: _node, ...props }: any) => <a {...props} target="_blank" rel="noreferrer noopener" />,
          img: ({ node: _node, src, alt, className, ...props }: any) => {
            const editable = Boolean(imageEditor && typeof src === "string")
            const open = () => {
              if (editable) imageEditor?.openImage(src, typeof alt === "string" ? alt : undefined)
            }
            return (
              <img
                {...props}
                src={src}
                alt={alt ?? ""}
                className={className ? `md-image ${className}` : "md-image"}
                role={editable ? "button" : undefined}
                tabIndex={editable ? 0 : undefined}
                title={editable ? t("Click to edit image") : undefined}
                onClick={
                  editable
                    ? (e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        open()
                      }
                    : undefined
                }
                onKeyDown={
                  editable
                    ? (e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault()
                          open()
                        }
                      }
                    : undefined
                }
              />
            )
          },
          // در نسخهٔ فعلی react-markdown پراپ inline وجود ندارد؛ بنابراین pre
          // خودش بلوک بودن را تشخیص می‌دهد و code فقط برای کد inline است. این‌طور
          // فنس تک‌خطی بدون زبان هم درست به صورت code block نمایش داده می‌شود.
          pre: ({ children }: { children?: ReactNode }) => {
            const props = codeNodeProps(children)
            if (!props) {
              return <pre dir="ltr">{children}</pre>
            }
            return <CodeBlock text={rawText(props.children).replace(/\n$/, "")} className={props.className} />
          },
          code: ({ className, children, node: _node, ...rest }: any) => (
            <code className={className ? `inline ${className}` : "inline"} dir="auto" {...rest}>
              {children}
            </code>
          ),
        }}
      >
        {deferred}
      </ReactMarkdown>
    </div>
  )
})
