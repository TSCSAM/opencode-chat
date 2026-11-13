import fsp from "node:fs/promises"
import { ToolError, nowIso, resolvePath, safeName, stamp } from "./core.mjs"

function requireValue(value, name, envName) {
  if (value) return String(value)
  if (envName && process.env[envName]) return process.env[envName]
  throw new ToolError(`${name} is required (or set ${envName || "the matching env var"})`, "CONFIG_REQUIRED")
}

async function postJson(url, body, headers = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "OpenCodeChatTools/1.9", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  const text = await res.text()
  if (!res.ok) throw new ToolError(`webhook returned ${res.status}: ${text.slice(0, 500)}`, "WEBHOOK_FAILED")
  return { status: res.status, response: text.slice(0, 2000) }
}

export async function commsAction(args) {
  const action = args.action
  if (action === "webhook") {
    const url = requireValue(args.url, "url")
    const payload = args.payload ?? { text: args.text || "OpenCode Chat notification" }
    return await postJson(url, payload, args.headers || {})
  }
  if (action === "slack") {
    const url = requireValue(args.url, "Slack webhook URL", "SLACK_WEBHOOK_URL")
    return await postJson(url, { text: args.text || "" })
  }
  if (action === "discord") {
    const url = requireValue(args.url, "Discord webhook URL", "DISCORD_WEBHOOK_URL")
    return await postJson(url, { content: args.text || "", username: args.name || "OpenCode Chat" })
  }
  if (action === "telegram") {
    const token = requireValue(args.token, "Telegram bot token", "TELEGRAM_BOT_TOKEN")
    const chatId = requireValue(args.chatId, "chat id", "TELEGRAM_CHAT_ID")
    return await postJson(`https://api.telegram.org/bot${token}/sendMessage`, { chat_id: chatId, text: args.text || "", parse_mode: args.parseMode || undefined })
  }
  if (action === "email") {
    const host = requireValue(args.host, "SMTP host", "SMTP_HOST")
    const port = Number(args.port || process.env.SMTP_PORT || 587)
    const user = args.user || process.env.SMTP_USER
    const pass = args.password || process.env.SMTP_PASSWORD
    const from = args.from || process.env.SMTP_FROM || user
    const to = requireValue(args.to, "recipient", "SMTP_TO")
    if (!from) throw new ToolError("from address is required (SMTP_FROM)", "CONFIG_REQUIRED")
    let nodemailer
    try {
      nodemailer = (await import("nodemailer")).default
    } catch {
      throw new ToolError("nodemailer is not installed", "MISSING_DEPENDENCY")
    }
    const transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: user ? { user, pass } : undefined,
      connectionTimeout: 20_000,
    })
    const info = await transporter.sendMail({
      from,
      to,
      subject: args.subject || "OpenCode Chat",
      text: args.text || "",
      html: args.html || undefined,
      attachments: Array.isArray(args.attachments)
        ? await Promise.all(args.attachments.map(async (file) => ({ filename: file.split(/[\\/]/).pop(), content: await fsp.readFile(resolvePath(file, { mustExist: true })) })))
        : undefined,
    })
    return { messageId: info.messageId, accepted: info.accepted, rejected: info.rejected }
  }
  if (action === "sms") {
    const sid = requireValue(args.sid, "Twilio SID", "TWILIO_ACCOUNT_SID")
    const token = requireValue(args.token, "Twilio token", "TWILIO_AUTH_TOKEN")
    const from = requireValue(args.from, "from number", "TWILIO_FROM")
    const to = requireValue(args.to, "to number")
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: "POST",
      headers: { authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ To: to, From: from, Body: args.text || "" }),
      signal: AbortSignal.timeout(30_000),
    })
    const data = await res.json().catch(() => null)
    if (!res.ok) throw new ToolError(`Twilio error: ${data?.message || res.status}`, "SMS_FAILED")
    return { sid: data.sid, status: data.status }
  }
  if (action === "calendar_create") {
    const title = args.title || args.name || "Event"
    const start = args.start ? new Date(args.start) : new Date(Date.now() + 3600_000)
    const end = args.end ? new Date(args.end) : new Date(start.getTime() + 3600_000)
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw new ToolError("invalid start/end date", "BAD_INPUT")
    const fmt = (date) => date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")
    const uid = `${Date.now()}-${Math.random().toString(36).slice(2)}@opencode-chat`
    const ics = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//OpenCode Chat//Tools//EN\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nDTSTAMP:${fmt(new Date())}\r\nDTSTART:${fmt(start)}\r\nDTEND:${fmt(end)}\r\nSUMMARY:${String(title).replace(/[\r\n]/g, " ")}\r\nDESCRIPTION:${String(args.text || "").replace(/[\r\n]/g, "\\n")}\r\nLOCATION:${String(args.location || "").replace(/[\r\n]/g, " ")}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`
    const target = resolvePath(args.output || `${safeName(title)}-${stamp()}.ics`, { createParent: true })
    await fsp.writeFile(target, ics, "utf8")
    return { path: target, bytes: Buffer.byteLength(ics), start: start.toISOString(), end: end.toISOString() }
  }
  if (action === "calendar_parse") {
    const target = resolvePath(args.path, { mustExist: true })
    const text = await fsp.readFile(target, "utf8")
    const events = []
    for (const block of text.split("BEGIN:VEVENT").slice(1)) {
      const get = (key) => block.match(new RegExp(`^${key}(?:;[^:]*)?:(.*)$`, "m"))?.[1]?.trim() || ""
      events.push({ summary: get("SUMMARY"), start: get("DTSTART"), end: get("DTEND"), location: get("LOCATION"), description: get("DESCRIPTION") })
    }
    return { path: target, events }
  }
  if (action === "notification") {
    const { powershell } = await import("./core.mjs")
    const title = String(args.name || "OpenCode Chat").replace(/'/g, "''")
    const body = String(args.text || "").replace(/'/g, "''")
    const script = `Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $n=New-Object System.Windows.Forms.NotifyIcon; $n.Icon=[System.Drawing.SystemIcons]::Information; $n.BalloonTipTitle='${title}'; $n.BalloonTipText='${body}'; $n.Visible=$true; $n.ShowBalloonTip(5000); Start-Sleep -Seconds 5; $n.Dispose()`
    const res = await powershell(script, { timeout: 12_000 })
    if (res.code !== 0) throw new ToolError(res.stderr.slice(0, 800), "NOTIFY_FAILED")
    return { notified: true, title, text: args.text || "" }
  }
  throw new ToolError(`unknown comms action: ${action}`, "BAD_INPUT")
}
