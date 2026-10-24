import { useState, type ReactNode } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      className="copy"
      onClick={() => {
        navigator.clipboard?.writeText(text)
        setDone(true)
        window.setTimeout(() => setDone(false), 1200)
      }}
    >
      {done ? "کپی شد" : "کپی"}
    </button>
  )
}

function langOf(className?: string) {
  const m = /language-([\w+-]+)/.exec(className ?? "")
  return m ? m[1] : ""
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: (props) => <a {...props} target="_blank" rel="noreferrer" />,
          pre: ({ children }: { children?: ReactNode }) => <>{children}</>,
          code: ({ className, children, ...rest }: any) => {
            const raw = String(children ?? "").replace(/\n$/, "")
            const lang = langOf(className)
            const isBlock = Boolean(lang) || raw.includes("\n")
            if (!isBlock) {
              return (
                <code className="inline" dir="auto" {...rest}>
                  {children}
                </code>
              )
            }
            return (
              <div className="codeblock">
                <div className="codebar">
                  <span>{lang || "code"}</span>
                  <CopyButton text={raw} />
                </div>
                <pre dir="ltr">
                  <code className={className} {...rest}>
                    {children}
                  </code>
                </pre>
              </div>
            )
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
