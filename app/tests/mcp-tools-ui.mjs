import puppeteer from "puppeteer-core"
import fsp from "node:fs/promises"

await fsp.mkdir("tests/tmp-tools", { recursive: true })
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  headless: "new",
  defaultViewport: { width: 1280, height: 900 },
})
const page = await browser.newPage()
const errors = []
page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`))
page.on("console", (message) => {
  if (message.type() === "error") errors.push(`console: ${message.text().slice(0, 300)}`)
})
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
await page.goto("http://127.0.0.1:5178", { waitUntil: "networkidle2", timeout: 60_000 })
await sleep(1500)
await page.click(".foot-settings")
await sleep(700)
const clicked = await page.evaluate(() => {
  const button = [...document.querySelectorAll(".settings-tabs button")].find((el) => el.textContent?.trim() === "Tools")
  if (!button) return false
  button.click()
  return true
})
if (!clicked) throw new Error("Tools tab not found")
await sleep(1200)
const state = await page.evaluate(() => ({
  title: document.querySelector(".tools-hero h3")?.textContent ?? "",
  status: document.querySelector(".tools-hero .pill")?.textContent ?? "",
  meta: [...document.querySelectorAll(".tools-meta > div")].map((el) => el.textContent?.trim() ?? ""),
  tools: [...document.querySelectorAll(".tools-item")].map((el) => ({
    title: el.querySelector(".tools-item-title")?.textContent ?? "",
    name: el.querySelector(".tools-item-name")?.textContent ?? "",
    count: el.querySelector(".tools-item-count")?.textContent ?? "",
  })),
  actions: document.querySelectorAll(".tools-actions code").length,
  errors: document.querySelector(".settings-error")?.textContent ?? "",
}))
console.log(JSON.stringify(state, null, 2))
const reconnected = await page.evaluate(() => {
  const button = [...document.querySelectorAll(".tools-actions-bar button")].find((el) => el.textContent?.trim() === "Reconnect")
  if (!button) return false
  button.click()
  return true
})
await sleep(5000)
const after = await page.evaluate(() => ({
  status: document.querySelector(".tools-hero .pill")?.textContent ?? "",
  error: document.querySelector(".settings-error")?.textContent ?? "",
}))
console.log("reconnect clicked:", reconnected, "status after:", after)
console.log("errors:", errors.length ? errors.slice(0, 5) : "none")
await page.screenshot({ path: "tests/tmp-tools/tools-panel.png", fullPage: true })
await browser.close()
