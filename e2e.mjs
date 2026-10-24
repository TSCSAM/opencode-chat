import puppeteer from "puppeteer-core"

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  headless: "new",
  defaultViewport: { width: 1440, height: 900 },
})
const page = await browser.newPage()
const errors = []
page.on("pageerror", (e) => errors.push("pageerror: " + e.message))
page.on("console", (m) => {
  if (m.type() === "error" && !m.text().includes("404")) errors.push(m.text().slice(0, 200))
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const activeSession = () => page.evaluate(() => document.querySelector(".app")?.getAttribute("data-session") ?? null)
const readToast = () => page.$eval(".toast", (e) => e.textContent.trim()).catch(() => null)

await page.goto("http://127.0.0.1:5178", { waitUntil: "networkidle2" })
await new Promise((r) => setTimeout(r, 1200))
const dsBefore = await activeSession()

await page.click(".new-chat")
await sleep(900)
const ds0 = await activeSession()
const appVersion = await page.$eval(".app-version", (e) => e.textContent.trim()).catch(() => null)
console.log("0) new disposable session:", ds0, "(fresh:", ds0 !== dsBefore, ") | panel version:", JSON.stringify(appVersion), "(pattern:", /\d+\.\d+\.\d+/.test(appVersion ?? "") ? "ok" : "MISSING", ")")

const agentChip1 = await page.$$eval(".chat-head .chip.agent", (els) => els.map((e) => e.textContent.trim()))
console.log("1) agent chip:", JSON.stringify(agentChip1))
await page.click(".chat-head .chip.agent")
await sleep(400)
const agentRows = await page.$$eval(".agent-pop .agent-row", (els) => els.map((e) => e.textContent.trim()))
console.log("   picker rows:", JSON.stringify(agentRows))
const planBtn = await page.evaluateHandle(() => [...document.querySelectorAll(".agent-pop .agent-row")].find((e) => e.textContent.includes("plan")))
if (planBtn && (await planBtn.asElement())) {
  await planBtn.asElement().click()
  await sleep(700)
}
const agentChip2 = await page.$$eval(".chat-head .chip.agent", (els) => els.map((e) => e.textContent.trim()))
console.log("   after pick:", JSON.stringify(agentChip2))

await page.click(".composer textarea")
await page.type(".composer textarea", "بدون هیچ ابزاری، فقط یک تابع پایتون جمع دو عدد بنویس و دو خط توضیح بده.")
await page.keyboard.press("Enter")
let busy = null
for (let i = 0; i < 40; i++) {
  busy = await page.$(".stop")
  if (busy) break
  await sleep(500)
}
console.log("2) busy:", !!busy)
await page.click(".composer textarea")
await page.type(".composer textarea", "یک سلام کوتاه فارسی هم اضافه کن")
await page.keyboard.press("Enter")
await sleep(1500)
const usersWhileBusy = await page.$$eval(".row.user", (els) => els.length)
console.log("   user bubbles while busy:", usersWhileBusy, "(expect 2 → queued view)")
for (let i = 0; i < 120; i++) {
  if (!(await page.$(".stop"))) break
  await sleep(500)
}
const finalUsers = await page.$$eval(".row.user", (els) => els.length)
const toast2 = await readToast()
console.log("   after run — user bubbles:", finalUsers, "(expect 2 → queue delivered)", toast2 ? `toast: ${toast2}` : "")

await page.hover(".session-list .session.active")
await sleep(300)
const pen = await page.$(".session-list .session.active .s-icon")
console.log("3) rename icon present:", !!pen)
if (pen) {
  await pen.click()
  await sleep(300)
  await page.$eval(".rename-form input", (el) => {
    el.value = ""
    el.focus()
  })
  await page.type(".rename-form input", "e2e-renamed")
  await page.keyboard.press("Enter")
  await sleep(900)
  const titles = await page.$$eval(".session-title", (els) => els.map((e) => e.textContent.trim()))
  console.log("   renamed found:", titles.includes("e2e-renamed"))
}
await page.hover(".session-list .session.active")
await sleep(250)
const delBtn = await page.$(".session-list .session.active .s-icon.danger")
if (delBtn) {
  await delBtn.click()
  await sleep(300)
  const confirming = await page.$eval(".session-list .session.active .s-icon.danger", (e) => e.textContent.trim()).catch(() => "")
  console.log("   confirm state:", confirming || "(row already gone)")
  await page.hover(".session-list .session.active").catch(() => {})
  const del2 = await page.$(".session-list .session.active .s-icon.danger")
  if (del2) await del2.click()
  await sleep(1200)
  const titles = await page.$$eval(".session-title", (els) => els.map((e) => e.textContent.trim()))
  console.log("   deleted, renamed gone:", !titles.includes("e2e-renamed"))
  const dsAfterDel = await activeSession()
  console.log("   active after delete:", dsAfterDel, "(changed from disposable:", dsAfterDel !== ds0, ")")
}

const list = await page.evaluate(async () => {
  const r = await fetch("/oc/api/session?limit=50").then((r) => r.json())
  const sessions = []
  for (const s of (r.data ?? [])) {
    const m = await fetch(`/oc/api/session/${s.id}/message?limit=200&order=desc`).then((r) => r.json())
    sessions.push({ id: s.id, title: s.title, n: (m.data ?? []).length })
  }
  return sessions
})
const long = list.find((s) => s.n >= 200)
console.log("4) long session:", long ? `${long.id} n=${long.n}` : "none")
if (long) {
  const idx = list.findIndex((s) => s.id === long.id)
  const clicked = await page.evaluate((i) => {
    const rows = document.querySelectorAll(".session-list .session")
    const row = rows[i]
    if (!row) return null
    const main = row.querySelector(".session-main") ?? row
    main.click()
    return row.querySelector(".session-title")?.textContent ?? ""
  }, idx)
  console.log("   clicked row:", JSON.stringify(clicked))
  for (let i = 0; i < 30; i++) {
    if ((await activeSession()) === long.id) break
    await sleep(400)
  }
  const cur = await activeSession()
  console.log("   active session now:", cur, "match:", cur === long.id)
  await sleep(1500)
  const toast4 = await readToast()
  if (toast4) console.log("   toast:", toast4)
  const rows1 = await page.$$eval(".thread .row", (els) => els.length)
  const btn = await page.$(".load-older")
  console.log("   rows first page:", rows1, "older btn:", !!btn)
  if (btn) {
    await page.evaluate(() => document.querySelector(".load-older")?.click())
    await sleep(2500)
    const btn2 = await page.$(".load-older")
    const rows2 = await page.$$eval(".thread .row", (els) => els.length)
    console.log("   rows after load-older:", rows2, "(grew:", rows2 > rows1, ") still-has-more:", !!btn2)
  }
} else {
  console.log("4) long session not in list")
}

try {
  await page.click(".composer textarea")
  await page.type(".composer textarea", "/")
  await sleep(500)
  const groups1 = await page.$$eval(".slash-group-title", (els) => els.map((e) => e.textContent.trim()))
  const items1 = await page.$$eval(".slash-item", (els) => els.length)
  console.log("5) slash menu groups:", JSON.stringify(groups1), "items:", items1)
  await page.type(".composer textarea", "mo")
  await sleep(350)
  const moItems = await page.$$eval(".slash-item", (els) => els.map((e) => e.querySelector("code")?.textContent ?? ""))
  console.log("   filter 'mo':", JSON.stringify(moItems))
  await page.keyboard.press("Enter")
  await sleep(600)
  const modelPop = await page.$(".model-pop")
  console.log("   model picker opened:", !!modelPop)
  if (modelPop) await page.keyboard.press("Escape")
  await sleep(250)

  await page.click(".composer textarea")
  await page.type(".composer textarea", "/settings")
  await sleep(450)
  await page.keyboard.press("Enter")
  await sleep(1100)
  const tabs = await page.$$eval(".settings-tabs button", (els) => els.map((e) => e.textContent.trim()))
  console.log("   settings tabs:", JSON.stringify(tabs))
  const genField = await page.$$(".settings-section .frow")
  console.log("   general fields:", genField.length)
  await page.evaluate(() => document.querySelectorAll(".settings-tabs button")[3]?.click())
  await sleep(700)
  const plugRows = await page.$$eval(".settings-row", (els) => els.length)
  console.log("   plugin rows:", plugRows)
  await page.evaluate(() => document.querySelector(".settings-close")?.click())
  await sleep(300)

  await page.evaluate(() => document.querySelector(".foot-version")?.click())
  await sleep(500)
  const updPop = await page.$(".update-pop")
  console.log("   update panel:", !!updPop)
  if (updPop) await page.evaluate(() => document.querySelector(".upd-close")?.click())
} catch (e) {
  console.log("5) step error:", String(e).slice(0, 160))
}

try {
  await sleep(800)
  const chip = await page.$(".chip.usage")
  if (chip) {
    const label = await page.$eval(".chip.usage .chip-label", (e) => e.textContent.trim())
    console.log("6) usage chip:", JSON.stringify(label))
    await page.evaluate(() => document.querySelector(".chip.usage")?.click())
    await sleep(500)
    const rows = await page.$$eval(".usage-row code", (els) => els.map((e) => e.textContent.trim()))
    console.log("   popover values:", JSON.stringify(rows))
    await page.evaluate(() => document.querySelector(".chip.usage")?.click())
  } else {
    console.log("6) usage chip absent")
  }
} catch (e) {
  console.log("6) step error:", String(e).slice(0, 140))
}

try {
  const up = await page.evaluate(async () => {
    const r = await fetch("/app/upload", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "probe.png",
        dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGP4z8AAAAMIxWTt8aoAAAAASUVORK5CYII=",
      }),
    })
    return r.json()
  })
  console.log("7) /app/upload:", JSON.stringify({ ok: up?.ok, file: up?.path?.slice(-34), bytes: up?.bytes }))

  await page.evaluate(() => {
    const b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGP4z8AAAAMIxWTt8aoAAAAASUVORK5CYII="
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    const file = new File([bytes], "shot.png", { type: "image/png" })
    const dt = new DataTransfer()
    dt.items.add(file)
    window.__pasteSeen = -99
    const ta = document.querySelector(".composer textarea")
    ta?.addEventListener("paste", (ev) => {
      window.__pasteSeen = ev.clipboardData?.items?.length ?? -1
    })
    let ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true })
    ta?.dispatchEvent(ev)
    let n = 0
    const tryParse = () => {
      const chips = document.querySelectorAll(".attach-chip").length
      if (chips > 0) return
      if (n === 0) {
        ev = new Event("paste", { bubbles: true })
        Object.defineProperty(ev, "clipboardData", { value: dt })
        ta?.dispatchEvent(ev)
      }
      n++
    }
    setTimeout(tryParse, 700)
  })
  await sleep(1000)
  const seen = await page.evaluate(() => window.__pasteSeen)
  console.log("   native paste listener saw items:", seen)
  const chips = await page.$$eval(".attach-chip", (els) => els.length)
  console.log("   attach chips after Ctrl+V:", chips, "(expect 1)")
  await page.evaluate(() => document.querySelector(".attach-chip button")?.click())
  await sleep(300)
  const chips2 = await page.$$eval(".attach-chip", (els) => els.length)
  console.log("   after remove:", chips2, "(expect 0)")
} catch (e) {
  console.log("7) step error:", String(e).slice(0, 140))
}

try {
  const tid = await page.evaluate(async () => {
    const r = await fetch("/oc/api/session?limit=30").then((r) => r.json())
    for (const s of r.data ?? []) {
      try {
        const fl = await fetch(`/oc/api/session/${s.id}/form`).then((r) => r.json())
        for (const f of fl.data ?? []) {
          const d = await fetch(`/oc/api/session/${s.id}/form/${f.id}`).then((r) => r.json())
          if (d.data?.state?.status === "pending") return s.id
        }
      } catch {}
    }
    return null
  })
  if (tid) {
    let pendingForm = false
    for (let t = 0; t < 10 && !pendingForm; t++) {
      pendingForm = await page.evaluate(async (id) => {
        try {
          const r = await fetch(`/oc/api/session/${id}/form`).then((r) => r.json())
          const list = r.data ?? []
          for (const f of list) {
            const d = await fetch(`/oc/api/session/${id}/form/${f.id}`).then((r) => r.json())
            if (d.data?.state?.status === "pending") return true
          }
        } catch {}
        return false
      }, tid)
      if (!pendingForm) await sleep(1500)
    }
    if (!pendingForm) {
      console.log("8) no pending form on that session (already answered) — skipping qcard render assert")
    } else {
    let ok = false
    for (let t = 0; t < 10 && !ok; t++) {
      ok = await page.evaluate(async (id) => {
        const r = await fetch("/oc/api/session?limit=50").then((r) => r.json())
        const idx = (r.data ?? []).findIndex((s) => s.id === id)
        const row = document.querySelectorAll(".session-list .session")[idx]
        row?.querySelector(".session-main")?.click()
        return document.querySelector(".app")?.getAttribute("data-session") === id
      }, tid)
      if (!ok) await sleep(1200)
    }
    console.log("8) session with pending question opened:", ok, tid)
    if (ok) {
      let qc = false
      for (let i = 0; i < 24 && !qc; i++) {
        qc = await page.$(".qcard")
        if (!qc) await sleep(500)
      }
      const fields = await page.$$eval(".qfield", (els) => els.length)
      const opts = await page.$$eval(".qopt", (els) => els.map((e) => e.textContent.trim()))
      const customs = await page.$$eval(".qcustom", (els) => els.length)
      const toolTitle = await page.$$eval(".tool-title", (els) => els.find((e) => e.textContent === "سؤال")?.textContent ?? null)
      const toolSummary = await page.$eval(".tool .tool-summary", (e) => e.textContent.trim()).catch(() => null)
      console.log("   qcard:", !!qc, "| fields:", fields, "| customs:", customs, "| tool title:", toolTitle)
      console.log("   tool summary:", JSON.stringify(toolSummary))
      console.log("   options:", JSON.stringify(opts))
    }
    } // end pending-render branch
  } else {
    console.log("8) pending-question session not found")
  }
} catch (e) {
  console.log("8) step error", String(e).slice(0, 140))
}

// ---------- 9) /export + /undo on the disposable session ----------
try {
  await page.evaluate(() => document.querySelector(".new-chat")?.click())
  await sleep(900)
  const sid = await page.$eval(".app", (e) => e.getAttribute("data-session"))
  await page.click(".composer textarea")
  await page.type(".composer textarea", "/export")
  await sleep(400)
  await page.keyboard.press("Enter")
  await sleep(900)
  const emptyToast = await page.$eval(".toast", (e) => e.textContent.trim()).catch(() => null)
  console.log("9) export on empty session:", JSON.stringify(emptyToast))

  await page.click(".composer textarea")
  await page.type(".composer textarea", "say OK")
  await page.keyboard.press("Enter")
  let haveReply = false
  for (let i = 0; i < 70 && !haveReply; i++) {
    await sleep(1000)
    haveReply = await page.evaluate(() =>
      [...document.querySelectorAll(".row.assistant .msg-body")].some((r) => (r.textContent ?? "").trim().length > 0),
    )
  }
  console.log("   reply arrived:", haveReply)
  await page.click(".composer textarea")
  await page.type(".composer textarea", "/export")
  await sleep(400)
  await page.keyboard.press("Enter")
  await sleep(900)
  const expToast = await page.$eval(".toast", (e) => e.textContent.trim()).catch(() => null)
  console.log("   export toast:", JSON.stringify(expToast))
  const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => null)).catch(() => null)
  if (clip !== null && clip !== undefined) console.log("   clipboard head:", JSON.stringify(clip.slice(0, 80)))

  await page.click(".composer textarea")
  await page.type(".composer textarea", "/undo")
  await sleep(400)
  await page.keyboard.press("Enter")
  let cleared = false
  for (let i = 0; i < 12 && !cleared; i++) {
    await sleep(1000)
    cleared = await page.evaluate(() => document.querySelectorAll(".row.user, .row.assistant").length === 0)
  }
  const undoToast = await page.$eval(".toast", (e) => e.textContent.trim()).catch(() => null)
  console.log("   undo cleared:", cleared, "| toast:", JSON.stringify(undoToast))
} catch (e) {
  console.log("9) step error:", String(e).slice(0, 140))
}

// ---------- 10) @file mention ----------
try {
  await page.click(".composer textarea")
  await page.type(".composer textarea", "look at @pack")
  await sleep(900)
  const items = await page.$$eval(".mention-item code", (els) => els.map((e) => e.textContent))
  console.log("10) mention results:", JSON.stringify(items.slice(0, 5)))
  await page.keyboard.press("Enter")
  await sleep(400)
  const chips = await page.$$eval(".attach-chip.file .attach-name", (els) => els.map((e) => e.textContent))
  console.log("   chip after pick:", JSON.stringify(chips))
  await page.evaluate(() => document.querySelector(".attach-chip.file button")?.click())
  await sleep(300)
  const chips2 = await page.$$eval(".attach-chip.file", (els) => els.length)
  console.log("   after remove:", chips2, "(expect 0)")
  const sid0 = await page.$eval(".app", (e) => e.getAttribute("data-session"))
  if (sid0) await fetch(`http://127.0.0.1:5178/oc/api/session/${sid0}`, { method: "DELETE" })
} catch (e) {
  console.log("10) step error:", String(e).slice(0, 140))
}

await page.screenshot({ path: "shot-e2e.png" })
console.log("errors:", errors.length ? errors : "none")
await browser.close()
