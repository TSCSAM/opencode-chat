// اتصال رویدادها باید خودش را از یک استریم «مرده» نجات بدهد. سرور OpenCode
// استریم را در صورت کندی مصرف‌کننده قطع می‌کند و رله‌ها هم می‌توانند اتصال را
// بدون بستن پاسخ نگه دارند؛ بنابراین اگر مدت طولانی حتی heartbeat نرسد،
// اتصال را می‌بندیم تا دوباره وصل شود و وضعیت از موتور تازه خوانده شود.
const IDLE_TIMEOUT = 45_000
const WATCHDOG_INTERVAL = 5_000

export function connectEvents(onEvent: (ev: any) => void, onStatus: (ok: boolean) => void) {
  let stopped = false
  let retry = 400
  let current: AbortController | null = null

  const run = async () => {
    while (!stopped) {
      const controller = new AbortController()
      current = controller
      let lastChunk = Date.now()
      // نگهبان باید پیش از fetch هم فعال باشد؛ اگر خودِ اتصال (پاسخ سرور)
      // معلق بماند، هیچ چانکی نمی‌رسد و بدون این کار حلقه برای همیشه گیر می‌کند.
      const watchdog = window.setInterval(() => {
        if (Date.now() - lastChunk > IDLE_TIMEOUT) controller.abort()
      }, WATCHDOG_INTERVAL)
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
        lastChunk = Date.now()

        while (!stopped) {
          const { done, value } = await reader.read()
          if (done) break
          lastChunk = Date.now()
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
      if (watchdog !== undefined) window.clearInterval(watchdog)
      if (current === controller) current = null
      onStatus(false)
      if (stopped) break
      await new Promise((r) => setTimeout(r, retry))
      retry = Math.min(retry * 2, 8000)
    }
  }

  void run()
  return () => {
    stopped = true
    current?.abort()
  }
}
