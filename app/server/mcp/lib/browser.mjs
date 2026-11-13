import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { ToolError, TMP_DIR, WORKSPACE, delay, ensureDir, parseBool, resolvePath, safeName, truncate, unique } from "./core.mjs"

let puppeteerModule
let browserPromise
const pages = new Map()

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean)

export async function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    try {
      await fsp.access(candidate)
      return candidate
    } catch {}
  }
  throw new ToolError(
    "Chrome/Edge was not found. Set CHROME_PATH to a Chromium executable to use browser tools.",
    "NO_BROWSER",
  )
}

async function getPuppeteer() {
  if (!puppeteerModule) puppeteerModule = (await import("puppeteer-core")).default
  return puppeteerModule
}

export async function getBrowser(options = {}) {
  if (!browserPromise) {
    browserPromise = (async () => {
      const puppeteer = await getPuppeteer()
      const executablePath = await findChrome()
      const browser = await puppeteer.launch({
        executablePath,
        headless: options.headless === false ? false : true,
        defaultViewport: options.viewport || { width: 1440, height: 900 },
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-background-timer-throttling",
          "--disable-backgrounding-occluded-windows",
          "--disable-renderer-backgrounding",
          "--disable-features=Translate,BackForwardCache",
        ],
      })
      browser.on("disconnected", () => {
        browserPromise = null
        pages.clear()
      })
      return browser
    })().catch((error) => {
      browserPromise = null
      throw error
    })
  }
  return browserPromise
}

export async function getPage(name = "default", options = {}) {
  const key = String(name || "default")
  const existing = pages.get(key)
  if (existing && !existing.isClosed()) return existing
  const browser = await getBrowser(options)
  const page = await browser.newPage()
  page.setDefaultTimeout(options.timeout ?? 30_000)
  page.setDefaultNavigationTimeout(options.navigationTimeout ?? 45_000)
  const logs = []
  const errors = []
  page.on("console", (message) => {
    if (logs.length < 200) logs.push({ type: message.type(), text: message.text().slice(0, 1000) })
  })
  page.on("pageerror", (error) => {
    if (errors.length < 100) errors.push(String(error?.message ?? error))
  })
  page.on("requestfailed", (request) => {
    if (errors.length < 100) errors.push(`${request.method()} ${request.url()} — ${request.failure()?.errorText || "failed"}`)
  })
  page.__ochat = { logs, errors }
  pages.set(key, page)
  return page
}

export async function closeBrowser() {
  if (!browserPromise) return
  try {
    const browser = await browserPromise
    await browser.close()
  } catch {}
  browserPromise = null
  pages.clear()
}

export async function closePage(name = "default") {
  const page = pages.get(String(name || "default"))
  if (page) {
    if (!page.isClosed()) await page.close()
    pages.delete(String(name || "default"))
  }
}

function pageMeta(page) {
  return { ...(page.__ochat || { logs: [], errors: [] }) }
}

export async function navigate(args) {
  const page = await getPage(args.session)
  const response = await page.goto(args.url, { waitUntil: args.waitUntil || "domcontentloaded", timeout: args.timeout || 45_000 })
  if (args.waitFor) await waitFor(page, args.waitFor, args.timeout || 30_000)
  const title = await page.title()
  const url = page.url()
  const text = await page.evaluate(() => document.body?.innerText || "")
  return { status: response?.status() ?? null, url, title, text: truncate(text, 20_000), ...pageMeta(page) }
}

export async function snapshot(args) {
  const page = await getPage(args.session)
  if (args.url) await page.goto(args.url, { waitUntil: "domcontentloaded", timeout: args.timeout || 45_000 })
  if (args.selector) {
    const element = await page.$(args.selector)
    if (!element) throw new ToolError(`selector not found: ${args.selector}`, "NOT_FOUND")
    if ((args.format || "text") === "html") return { html: truncate(await element.evaluate((el) => el.outerHTML), 60_000) }
    return { text: truncate(await element.evaluate((el) => el.innerText), 60_000), ...pageMeta(page) }
  }
  const data = await page.evaluate(() => ({
    url: location.href,
    title: document.title,
    text: document.body?.innerText || "",
    html: document.documentElement?.outerHTML || "",
    links: [...document.querySelectorAll("a[href]")].slice(0, 500).map((a) => ({ text: (a.textContent || "").trim().slice(0, 200), href: a.href })),
    forms: [...document.querySelectorAll("form")].slice(0, 40).map((form) => ({
      action: form.action,
      method: form.method,
      fields: [...form.querySelectorAll("input,select,textarea")].map((el) => ({
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute("type") || "",
        name: el.getAttribute("name") || "",
        id: el.id || "",
        placeholder: el.getAttribute("placeholder") || "",
      })),
    })),
  }))
  const format = args.format || "text"
  if (format === "html") return { ...data, html: truncate(data.html, 100_000), ...pageMeta(page) }
  if (format === "links") return { url: data.url, title: data.title, links: data.links, ...pageMeta(page) }
  return { url: data.url, title: data.title, text: truncate(data.text, 60_000), forms: data.forms, ...pageMeta(page) }
}

export async function screenshot(args) {
  const page = await getPage(args.session)
  if (args.url) await page.goto(args.url, { waitUntil: "domcontentloaded", timeout: args.timeout || 45_000 })
  let buffer
  if (args.selector) {
    const element = await page.$(args.selector)
    if (!element) throw new ToolError(`selector not found: ${args.selector}`, "NOT_FOUND")
    buffer = await element.screenshot({ type: "png" })
  } else {
    buffer = await page.screenshot({ fullPage: parseBool(args.fullPage, false), type: "png" })
  }
  let saved = null
  if (args.path) {
    const target = resolvePath(args.path, { createParent: true })
    await fsp.writeFile(target, buffer)
    saved = target
  }
  return {
    buffer,
    saved,
    url: page.url(),
    title: await page.title(),
    size: buffer.length,
  }
}

async function waitFor(page, expression, timeout = 30_000) {
  const value = String(expression || "")
  const started = Date.now()
  while (Date.now() - started < timeout) {
    try {
      if (await page.evaluate((needle) => (document.body?.innerText || "").includes(needle), value)) return true
    } catch {}
    await delay(250)
  }
  throw new ToolError(`timed out waiting for text: ${value}`, "TIMEOUT")
}

export async function interact(args) {
  const page = await getPage(args.session)
  const action = args.action
  if (args.url) await page.goto(args.url, { waitUntil: "domcontentloaded", timeout: args.timeout || 45_000 })
  const timeout = args.timeout || 30_000

  if (action === "click") {
    if (args.selector) {
      await page.waitForSelector(args.selector, { timeout })
      await page.click(args.selector)
    } else if (Number.isFinite(Number(args.x)) && Number.isFinite(Number(args.y))) {
      await page.mouse.click(Number(args.x), Number(args.y))
    } else {
      throw new ToolError("click requires selector or x/y", "BAD_INPUT")
    }
    return { clicked: true, url: page.url(), title: await page.title(), ...pageMeta(page) }
  }

  if (action === "type") {
    if (!args.selector) throw new ToolError("type requires selector", "BAD_INPUT")
    await page.waitForSelector(args.selector, { timeout })
    const element = await page.$(args.selector)
    if (args.clear) await element.click({ clickCount: 3 }).catch(() => {})
    if (args.clear) await page.keyboard.press("Backspace")
    await page.type(args.selector, String(args.text ?? ""), { delay: args.delay ?? 10 })
    return { typed: String(args.text ?? "").length, ...pageMeta(page) }
  }

  if (action === "press") {
    const keys = args.keys || args.text || "Enter"
    for (const key of String(keys).split(/[+,]/).map((k) => k.trim()).filter(Boolean)) {
      if (key.includes("+")) {
        await page.keyboard.down(key.split("+")[0])
        await page.keyboard.press(key.split("+").slice(1).join("+"))
        await page.keyboard.up(key.split("+")[0])
      } else {
        await page.keyboard.press(key === "Space" ? " " : key)
      }
    }
    return { pressed: keys, ...pageMeta(page) }
  }

  if (action === "scroll") {
    const amount = Number(args.y ?? args.amount ?? 700)
    if (args.selector) {
      await page.$eval(args.selector, (el, delta) => el.scrollBy(0, delta), amount)
    } else {
      await page.evaluate((delta) => window.scrollBy(0, delta), amount)
    }
    return { scrolled: amount, ...pageMeta(page) }
  }

  if (action === "hover") {
    if (!args.selector) throw new ToolError("hover requires selector", "BAD_INPUT")
    await page.hover(args.selector)
    return { hovered: args.selector, ...pageMeta(page) }
  }

  if (action === "select") {
    if (!args.selector) throw new ToolError("select requires selector", "BAD_INPUT")
    const values = await page.$eval(args.selector, (el) => [...el.options].map((o) => ({ value: o.value, label: o.textContent })))
    const chosen = await page.select(args.selector, String(args.text ?? args.value ?? ""))
    return { selected: chosen, options: values, ...pageMeta(page) }
  }

  if (action === "upload") {
    if (!args.selector || !args.path) throw new ToolError("upload requires selector and path", "BAD_INPUT")
    const element = await page.$(args.selector)
    if (!element) throw new ToolError(`selector not found: ${args.selector}`, "NOT_FOUND")
    await element.uploadFile(resolvePath(args.path, { mustExist: true }))
    return { uploaded: args.path, ...pageMeta(page) }
  }

  if (action === "wait") {
    if (args.selector) await page.waitForSelector(args.selector, { timeout })
    else if (args.text) await waitFor(page, args.text, timeout)
    else await delay(Number(args.y ?? args.amount ?? 1000))
    return { waited: true, ...pageMeta(page) }
  }

  if (action === "evaluate") {
    if (!args.text) throw new ToolError("evaluate requires text (JavaScript expression)", "BAD_INPUT")
    const value = await page.evaluate(async (code) => {
      // eslint-disable-next-line no-new-func
      const fn = new Function(`return (async () => { ${code} })()`)
      return await fn()
    }, args.text)
    return { result: truncate(value, 60_000), ...pageMeta(page) }
  }

  if (action === "form_fill") {
    let fields = args.fields
    if (typeof fields === "string") {
      try {
        fields = JSON.parse(fields)
      } catch {
        throw new ToolError("fields must be a JSON object of selector -> value", "BAD_INPUT")
      }
    }
    if (!fields || typeof fields !== "object") throw new ToolError("fields must be an object", "BAD_INPUT")
    const filled = []
    for (const [selector, value] of Object.entries(fields)) {
      try {
        const tag = await page.$eval(selector, (el) => el.tagName.toLowerCase())
        if (tag === "select") await page.select(selector, String(value))
        else {
          await page.click(selector, { clickCount: 3 })
          await page.keyboard.press("Backspace")
          await page.type(selector, String(value), { delay: 5 })
        }
        filled.push({ selector, value, ok: true })
      } catch (error) {
        filled.push({ selector, error: String(error?.message ?? error) })
      }
    }
    return { filled, ...pageMeta(page) }
  }

  if (action === "drag") {
    const from = args.selector ? await page.$(args.selector) : null
    const fromBox = from ? await from.boundingBox() : null
    const startX = Number(args.x ?? fromBox?.x ?? 0) + (fromBox?.width ? fromBox.width / 2 : 0)
    const startY = Number(args.y ?? fromBox?.y ?? 0) + (fromBox?.height ? fromBox.height / 2 : 0)
    const target = args.selector2 ? await page.$(args.selector2) : null
    const targetBox = target ? await target.boundingBox() : null
    const endX = Number(args.x2 ?? targetBox?.x ?? 0) + (targetBox?.width ? targetBox.width / 2 : 0)
    const endY = Number(args.y2 ?? targetBox?.y ?? 0) + (targetBox?.height ? targetBox.height / 2 : 0)
    await page.mouse.move(startX, startY)
    await page.mouse.down()
    await page.mouse.move(endX, endY, { steps: 12 })
    await page.mouse.up()
    return { dragged: { startX, startY, endX, endY }, ...pageMeta(page) }
  }

  if (action === "pdf") {
    const target = resolvePath(args.path || path.join(TMP_DIR, `page-${Date.now()}.pdf`), { createParent: true })
    await ensureDir(path.dirname(target))
    await page.pdf({ path: target, format: args.format || "A4", printBackground: true })
    return { path: target, bytes: (await fsp.stat(target)).size, ...pageMeta(page) }
  }

  if (action === "set_viewport") {
    await page.setViewport({ width: Number(args.width || 1440), height: Number(args.height || 900), deviceScaleFactor: Number(args.scale || 1) })
    return { viewport: { width: Number(args.width || 1440), height: Number(args.height || 900) } }
  }

  if (action === "tabs") {
    const browser = await getBrowser()
    return {
      tabs: (await browser.pages()).map((p, i) => ({ index: i, url: p.url(), title: p.__ochat?.title || "" })),
      active: page.url(),
    }
  }

  if (action === "new_tab") {
    const page2 = await getPage(`${args.session || "default"}-${Date.now()}`)
    if (args.url) await page2.goto(args.url, { waitUntil: "domcontentloaded" })
    return { opened: page2.url(), session: `${args.session || "default"}-${Date.now()}` }
  }

  if (action === "close") {
    await closePage(args.session)
    return { closed: args.session || "default" }
  }

  if (action === "cookies") {
    const cookies = await page.cookies()
    return { cookies }
  }

  if (action === "performance") {
    const metrics = await page.metrics().catch(() => ({}))
    const nav = await page.evaluate(() => {
      const entries = performance.getEntriesByType("navigation")
      const navEntry = entries[0]
      return navEntry
        ? {
            domContentLoaded: navEntry.domContentLoadedEventEnd,
            load: navEntry.loadEventEnd,
            transferSize: navEntry.transferSize,
            encodedBodySize: navEntry.encodedBodySize,
            duration: navEntry.duration,
          }
        : null
    })
    return { url: page.url(), metrics, navigation: nav, ...pageMeta(page) }
  }

  if (action === "accessibility") {
    const snapshot = await page.accessibility?.snapshot?.({ interestingOnly: true }).catch(() => null)
    return { url: page.url(), accessibility: snapshot }
  }

  if (action === "download") {
    if (!args.selector && !args.url) throw new ToolError("download requires selector or url", "BAD_INPUT")
    const client = await page.createCDPSession()
    const target = resolvePath(args.path || path.join(TMP_DIR, `download-${Date.now()}`), { createParent: true })
    await client.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: path.dirname(target) })
    if (args.selector) await page.click(args.selector)
    else await page.goto(args.url, { waitUntil: "domcontentloaded" })
    const started = Date.now()
    let found = null
    while (Date.now() - started < (args.timeout || 30_000)) {
      const files = await fsp.readdir(path.dirname(target)).catch(() => [])
      const latest = files
        .map((name) => path.join(path.dirname(target), name))
        .filter((name) => !name.endsWith(".crdownload"))
        .sort((a, b) => {
          try {
            return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs
          } catch {
            return 0
          }
        })[0]
      if (latest) {
        found = latest
        break
      }
      await delay(400)
    }
    if (!found) throw new ToolError("download did not finish", "TIMEOUT")
    return { path: found, bytes: (await fsp.stat(found)).size }
  }

  throw new ToolError(`unknown browser action: ${action}`, "BAD_INPUT")
}

export async function browserCleanup() {
  await closeBrowser().catch(() => {})
}
