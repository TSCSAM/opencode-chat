import puppeteer from "puppeteer-core"

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  headless: "new",
  defaultViewport: { width: 1440, height: 900 },
})
const page = await browser.newPage()
const errors = []
page.on("console", (m) => {
  if (m.type() === "error" && !m.text().includes("404")) errors.push(m.text().slice(0, 300))
})
page.on("pageerror", (e) => errors.push("pageerror: " + e.message))

await page.goto("http://127.0.0.1:5178", { waitUntil: "networkidle2" })
await new Promise((r) => setTimeout(r, 700))
await page.click(".new-chat")
await new Promise((r) => setTimeout(r, 900))

const prompt = "بدون استفاده از هیچ ابزاری، یک تابع پایتون برای جمع دو عدد بنویس و در یک جملهٔ فارسی توضیح بده."
await page.click(".composer textarea")
await page.type(".composer textarea", prompt)
await page.keyboard.press("Enter")

let last = null
for (let i = 0; i < 100; i++) {
  const state = await page.evaluate(() => ({
    busy: !!document.querySelector(".stop"),
    texts: Array.from(document.querySelectorAll(".row.assistant .md")).map((e) => e.textContent.trim()),
    code: Array.from(document.querySelectorAll(".codeblock code")).map((e) => e.textContent),
    codeDir: document.querySelector(".codeblock pre") ? getComputedStyle(document.querySelector(".codeblock pre")).direction : "",
    title: document.querySelector(".chat-title h1")?.textContent ?? "",
  }))
  last = state
  if (state.texts.length && !state.busy) break
  await new Promise((r) => setTimeout(r, 500))
}

console.log("title:", last.title)
console.log("reply:", JSON.stringify((last.texts.at(-1) ?? "").slice(0, 200)))
console.log("code blocks:", last.code.length, "| code direction:", last.codeDir)
console.log("code:", JSON.stringify((last.code[0] ?? "").slice(0, 120)))
console.log("errors:", errors.length ? errors : "none")

const sid = await page.evaluate(() => document.querySelector(".app")?.getAttribute("data-session"))
if (sid) {
  const res = await fetch(`http://127.0.0.1:5178/oc/api/session/${sid}`, { method: "DELETE" }).catch(() => null)
  console.log("cleanup:", res ? res.status : "failed", sid)
}

await page.screenshot({ path: "shot-final.png" })
await browser.close()
