export function connectEvents(onEvent: (ev: any) => void, onStatus: (ok: boolean) => void) {
  let stopped = false
  let retry = 400
  const controller = new AbortController()

  const run = async () => {
    while (!stopped) {
      try {
        const res = await fetch("/oc/api/event", {
          signal: controller.signal,
          headers: { accept: "text/event-stream" },
        })
        if (!res.ok || !res.body) throw new Error(`stream ${res.status}`)
        onStatus(true)
        retry = 400
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buf = ""

        while (!stopped) {
          const { done, value } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })

          let match = buf.match(/\r?\n\r?\n/)
          while (match && match.index !== undefined) {
            const raw = buf.slice(0, match.index)
            buf = buf.slice(match.index + match[0].length)
            const data = raw
              .split(/\r?\n/)
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trimStart())
              .join("\n")
            if (data) {
              try {
                onEvent(JSON.parse(data))
} catch {}
            }
            match = buf.match(/\r?\n\r?\n/)
          }
        }
} catch {}
      onStatus(false)
      if (stopped) break
      await new Promise((r) => setTimeout(r, retry))
      retry = Math.min(retry * 2, 8000)
    }
  }

  void run()
  return () => {
    stopped = true
    controller.abort()
  }
}
