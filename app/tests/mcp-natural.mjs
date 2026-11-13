import puppeteer from "puppeteer-core"
import fsp from "node:fs/promises"

await fsp.mkdir("tests/tmp-tools", { recursive: true })
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  headless: "new",
  defaultViewport: { width: 1440, height: 1000 },
})
const page = await browser.newPage()
const errors = []
page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`))
page.on("console", (message) => {
  if (message.type() === "error") errors.push(`console: ${message.text().slice(0, 300)}`)
})
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
await page.goto("http://127.0.0.1:5178", { waitUntil: "networkidle2", timeout: 60_000 })
await sleep(1200)
await page.click(".new-chat")
await sleep(1000)
const prompt =
  "Open https://example.com in a real browser, save a full-page screenshot to app/tests/tmp-tools/natural-browser.png, and reply with the page title. Do not use shell."
await page.click(".composer textarea")
await page.type(".composer textarea", prompt)
await page.keyboard.press("Enter")

let state = null
for (let i = 0; i < 240; i++) {
  state = await page.evaluate(() => ({
    busy: Boolean(document.querySelector(".stop")),
    assistant: [...document.querySelectorAll(".row.assistant .md")].map((el) => el.textContent.trim()).join("\n"),
    tools: [...document.querySelectorAll(".tool")].map((el) => ({
      title: el.querySelector(".tool-title")?.textContent ?? "",
      summary: el.querySelector(".tool-summary")?.textContent ?? "",
      status: el.querySelector(".pill")?.textContent ?? "",
    })),
  }))
  if (state.assistant && !state.busy && i > 4) break
  await sleep(1000)
}
console.log("assistant:", state?.assistant?.slice(0, 3000))
console.log("tools:", JSON.stringify(state?.tools, null, 2))
console.log("errors:", errors.length ? errors.slice(0, 5) : "none")
await page.screenshot({ path: "tests/tmp-tools/natural-agent.png", fullPage: true }).catch(() => {})
await browser.close()
