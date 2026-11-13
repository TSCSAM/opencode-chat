import puppeteer from "puppeteer-core"
import fsp from "node:fs/promises"

await fsp.mkdir("tests/tmp-tools", { recursive: true })
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  headless: "new",
  defaultViewport: { width: 1280, height: 900 },
})
const page = await browser.newPage()
await page.evaluateOnNewDocument(() => localStorage.setItem("oc-lang", "fa"))
await page.goto("http://127.0.0.1:5178", { waitUntil: "networkidle2", timeout: 60_000 })
await new Promise((resolve) => setTimeout(resolve, 1200))
await page.click(".foot-settings")
await new Promise((resolve) => setTimeout(resolve, 700))
const opened = await page.evaluate(() => {
  const button = [...document.querySelectorAll(".settings-tabs button")].find((el) => el.textContent?.trim() === "ابزارها")
  if (!button) return false
  button.click()
  return true
})
await new Promise((resolve) => setTimeout(resolve, 1000))
const state = await page.evaluate(() => ({
  dir: document.documentElement.dir,
  title: document.querySelector(".tools-hero h3")?.textContent ?? "",
  status: document.querySelector(".tools-hero .pill")?.textContent ?? "",
  tools: document.querySelectorAll(".tools-item").length,
  actions: document.querySelector(".tools-meta code")?.textContent ?? "",
}))
console.log(JSON.stringify({ opened, ...state }, null, 2))
await page.screenshot({ path: "tests/tmp-tools/tools-fa.png", fullPage: true })
await browser.close()
