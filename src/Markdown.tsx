import { Children, isValidElement, useState, type ReactNode } from "react"
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

export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _node, ...props }: any) => <a {...props} target="_blank" rel="noreferrer noopener" />,
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
        {text}
      </ReactMarkdown>
    </div>
  )
}
