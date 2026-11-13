import fs from "node:fs"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  APP_ROOT,
  DATA_DIR,
  IS_WIN,
  TMP_DIR,
  WORKSPACE,
  ToolError,
  assertConfirm,
  ensureDir,
  errorResult,
  formatBytes,
  imageResult,
  jsonResult,
  parseBool,
  parseNumber,
  powershell,
  redactSecrets,
  textResult,
  which,
  whichAsync,
} from "../lib/core.mjs"

const psQuote = (value) => `'${String(value).replace(/'/g, "''")}'`

async function psJson(script, timeout = 30_000) {
  const wrapped = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ${script} | ConvertTo-Json -Depth 8 -Compress`
  const res = await powershell(wrapped, { timeout })
  if (res.code !== 0) {
    throw new ToolError(`PowerShell failed: ${(res.stderr || res.stdout || "unknown error").slice(0, 1200)}`, "POWERSHELL_ERROR")
  }
  const text = (res.stdout || "").trim()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    throw new ToolError(`PowerShell returned invalid JSON: ${text.slice(0, 500)}`, "BAD_POWERSHELL_JSON")
  }
}

const WIN32_WINDOW_TYPE = `
using System;
using System.Text;
using System.Runtime.InteropServices;
public class OchatWin32 {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
`

async function chromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ].filter(Boolean)
  for (const candidate of candidates) {
    try {
      await fsp.access(candidate)
      return candidate
    } catch {}
  }
  return null
}

async function captureScreen(monitor = "all") {
  if (!IS_WIN) throw new ToolError("screen capture is currently implemented for Windows; use browser screenshots on other platforms", "UNSUPPORTED")
  await ensureDir(TMP_DIR)
  const out = path.join(TMP_DIR, `screen-${Date.now()}.png`)
  const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bmp.Size)
$bmp.Save(${psQuote(out)}, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
`
  const res = await powershell(script, { timeout: 20_000 })
  if (res.code !== 0) throw new ToolError(`screen capture failed: ${res.stderr.slice(0, 800)}`, "SCREENSHOT_FAILED")
  const buf = await fsp.readFile(out)
  await fsp.unlink(out).catch(() => {})
  return imageResult(buf, "image/png", `Screen capture (${monitor === "all" ? "all monitors" : monitor}) ${new Date().toISOString()}`)
}

async function windowRows(filter, limit = 80) {
  if (!IS_WIN) throw new ToolError("window management is Windows-only", "UNSUPPORTED")
  const script = `
Add-Type -TypeDefinition @'
${WIN32_WINDOW_TYPE}
'@
$rows = New-Object System.Collections.Generic.List[object]
$cb = [OchatWin32+EnumWindowsProc]{
  param($hWnd, $lParam)
  if ([OchatWin32]::IsWindowVisible($hWnd)) {
    $sb = New-Object System.Text.StringBuilder 512
    [void][OchatWin32]::GetWindowText($hWnd, $sb, $sb.Capacity)
    $title = $sb.ToString()
    if ($title) {
      $r = New-Object OchatWin32+RECT
      [void][OchatWin32]::GetWindowRect($hWnd, [ref]$r)
      $pid = 0
      [void][OchatWin32]::GetWindowThreadProcessId($hWnd, [ref]$pid)
      $proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
      $rows.Add([pscustomobject]@{
        handle = $hWnd.ToInt64()
        title = $title
        process = if ($proc) { $proc.ProcessName } else { "" }
        pid = $pid
        x = $r.Left; y = $r.Top
        width = $r.Right - $r.Left; height = $r.Bottom - $r.Top
      })
    }
  }
  return $true
}
[void][OchatWin32]::EnumWindows($cb, [IntPtr]::Zero)
$rows
`
  let rows = await psJson(script, 25_000)
  if (!Array.isArray(rows)) rows = rows ? [rows] : []
  if (filter) {
    const needle = String(filter).toLowerCase()
    rows = rows.filter((r) => `${r.title} ${r.process}`.toLowerCase().includes(needle))
  }
  return rows.slice(0, limit)
}

async function uiTree(hwnd, limit = 250) {
  if (!IS_WIN) throw new ToolError("UI Automation is Windows-only", "UNSUPPORTED")
  const handle = hwnd ? `[IntPtr]${Number(hwnd)}` : `[System.Windows.Automation.AutomationElement]::FocusedElement.Current.NativeWindowHandle`
  const script = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$handle = ${hwnd ? `[IntPtr]${Number(hwnd)}` : "0"}
if ($handle -eq [IntPtr]::Zero) {
  $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
  if ($focused) { $handle = [IntPtr]$focused.Current.NativeWindowHandle }
}
if ($handle -eq [IntPtr]::Zero) { throw "no active window" }
$root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
$all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
$rows = New-Object System.Collections.Generic.List[object]
$count = [Math]::Min($all.Count, ${Number(limit)})
for ($i = 0; $i -lt $count; $i++) {
  $el = $all.Item($i)
  try {
    $r = $el.Current.BoundingRectangle
    $rows.Add([pscustomobject]@{
      index = $i
      name = $el.Current.Name
      type = $el.Current.ControlType.ProgrammaticName
      automationId = $el.Current.AutomationId
      className = $el.Current.ClassName
      enabled = $el.Current.IsEnabled
      offscreen = $el.Current.IsOffscreen
      x = [int]$r.X; y = [int]$r.Y; width = [int]$r.Width; height = [int]$r.Height
    })
  } catch {}
}
$rows
`
  let rows = await psJson(script, 35_000)
  if (!Array.isArray(rows)) rows = rows ? [rows] : []
  return rows
}

async function uiClick(args) {
  if (!IS_WIN) throw new ToolError("UI Automation is Windows-only", "UNSUPPORTED")
  const hwnd = args.hwnd ? `[IntPtr]${Number(args.hwnd)}` : "0"
  const name = args.name ? psQuote(args.name) : "''"
  const automationId = args.automationId ? psQuote(args.automationId) : "''"
  const script = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
${WIN32_WINDOW_TYPE}
'@
$handle = ${hwnd}
if ($handle -eq [IntPtr]::Zero) {
  $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
  if ($focused) { $handle = [IntPtr]$focused.Current.NativeWindowHandle }
}
if ($handle -eq [IntPtr]::Zero) { throw "no active window" }
$root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
$all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
$name = ${name}
$automationId = ${automationId}
$target = $null
for ($i = 0; $i -lt $all.Count; $i++) {
  $el = $all.Item($i)
  if ($name -and $el.Current.Name -eq $name) { $target = $el; break }
  if ($automationId -and $el.Current.AutomationId -eq $automationId) { $target = $el; break }
}
if ($null -eq $target) { throw "UI element not found" }
$invoked = $false
try {
  $pattern = $target.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
  $pattern.Invoke()
  $invoked = $true
} catch {}
if (-not $invoked) {
  try {
    $pattern = $target.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
    $pattern.Select()
    $invoked = $true
  } catch {}
}
if (-not $invoked) {
  $r = $target.Current.BoundingRectangle
  $x = [int]($r.X + $r.Width / 2)
  $y = [int]($r.Y + $r.Height / 2)
  [void][OchatWin32]::SetCursorPos($x, $y)
  [OchatWin32]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  [OchatWin32]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
}
[pscustomobject]@{ clicked = $true; name = $target.Current.Name; type = $target.Current.ControlType.ProgrammaticName; invoked = $invoked }
`
  return await psJson(script, 35_000)
}

async function focusWindow(args) {
  if (!IS_WIN) throw new ToolError("window management is Windows-only", "UNSUPPORTED")
  const script = `
Add-Type -TypeDefinition @'
${WIN32_WINDOW_TYPE}
'@
$target = $null
$filter = ${psQuote(args.title || args.name || "")}
if (${args.hwnd ? Number(args.hwnd) : 0} -ne 0) {
  $target = [IntPtr]${args.hwnd ? Number(args.hwnd) : 0}
} else {
  $cb = [OchatWin32+EnumWindowsProc]{
    param($hWnd, $lParam)
    if ([OchatWin32]::IsWindowVisible($hWnd)) {
      $sb = New-Object System.Text.StringBuilder 512
      [void][OchatWin32]::GetWindowText($hWnd, $sb, $sb.Capacity)
      if ($sb.ToString().ToLower().Contains($filter.ToLower())) { $script:target = $hWnd; return $false }
    }
    return $true
  }
  [void][OchatWin32]::EnumWindows($cb, [IntPtr]::Zero)
}
if ($target -eq $null -or $target -eq [IntPtr]::Zero) { throw "window not found" }
[void][OchatWin32]::ShowWindow($target, 9)
[void][OchatWin32]::SetForegroundWindow($target)
[pscustomobject]@{ focused = $true; handle = $target.ToInt64() }
`
  return await psJson(script, 20_000)
}

function sendKeysLiteral(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\n/g, "{ENTER}")
    .replace(/([+^%~()[\]{}])/g, "{$1}")
}

function sendKeysChord(keys) {
  const raw = String(keys || "").trim()
  if (!raw) return ""
  const parts = raw.split("+").map((part) => part.trim()).filter(Boolean)
  let prefix = ""
  let key = parts.at(-1) || raw
  const modifiers = parts.slice(0, -1).map((part) => part.toLowerCase())
  if (modifiers.some((m) => ["ctrl", "control"].includes(m))) prefix += "^"
  if (modifiers.some((m) => ["alt", "option"].includes(m))) prefix += "%"
  if (modifiers.some((m) => ["shift"].includes(m))) prefix += "+"
  const map = {
    enter: "{ENTER}",
    return: "{ENTER}",
    tab: "{TAB}",
    esc: "{ESC}",
    escape: "{ESC}",
    backspace: "{BS}",
    delete: "{DEL}",
    del: "{DEL}",
    insert: "{INS}",
    home: "{HOME}",
    end: "{END}",
    pageup: "{PGUP}",
    pagedown: "{PGDN}",
    up: "{UP}",
    down: "{DOWN}",
    left: "{LEFT}",
    right: "{RIGHT}",
    space: " ",
    win: "{LWIN}",
    windows: "{LWIN}",
    f1: "{F1}", f2: "{F2}", f3: "{F3}", f4: "{F4}", f5: "{F5}", f6: "{F6}", f7: "{F7}", f8: "{F8}", f9: "{F9}", f10: "{F10}", f11: "{F11}", f12: "{F12}",
    printscreen: "{PRTSC}",
    capslock: "{CAPSLOCK}",
    numlock: "{NUMLOCK}",
  }
  return prefix + (map[key.toLowerCase()] || key)
}

async function mouseScript(script) {
  const full = `
Add-Type -TypeDefinition @'
${WIN32_WINDOW_TYPE}
'@
Add-Type -AssemblyName System.Windows.Forms
${script}
`
  return await psJson(full, 20_000)
}

export const systemTools = {
  register(server, { z }) {
    const schema = {
      action: z
        .enum([
          "info",
          "processes",
          "services",
          "env",
          "disk",
          "network",
          "ports",
          "windows",
          "focus",
          "screenshot",
          "clipboard",
          "notify",
          "open",
          "kill",
          "power",
          "ui_tree",
          "ui_click",
          "mouse_move",
          "mouse_click",
          "mouse_drag",
          "scroll",
          "type",
          "key",
        ])
        .describe("The system operation to perform."),
      filter: z.string().optional().describe("Filter for process/service/window lists, or clipboard value."),
      limit: z.number().int().positive().max(1000).optional().describe("Maximum number of rows."),
      pid: z.number().int().positive().optional().describe("Process id for kill."),
      name: z.string().optional().describe("Window/UI element name or app name."),
      automationId: z.string().optional().describe("UI Automation id for ui_click."),
      hwnd: z.number().int().positive().optional().describe("Window handle for focus/ui_tree/ui_click."),
      title: z.string().optional().describe("Window title fragment for focus."),
      path: z.string().optional().describe("File/folder/URL for open."),
      text: z.string().optional().describe("Clipboard text or notification body."),
      mode: z.enum(["get", "set"]).optional().describe("Clipboard mode."),
      confirm: z.boolean().optional().describe("Required for kill/power actions."),
      powerAction: z.enum(["lock", "sleep", "restart", "shutdown", "cancel"]).optional().describe("Power action."),
      by: z.enum(["name", "pid"]).optional().describe("Filter mode for kill."),
      button: z.enum(["left", "right", "middle"]).optional(),
      double: z.boolean().optional(),
      x1: z.number().optional(),
      y1: z.number().optional(),
      x2: z.number().optional(),
      y2: z.number().optional(),
      amount: z.number().optional(),
      keys: z.string().optional().describe("Key or combination, e.g. ENTER, TAB, CTRL+S."),
      interval: z.number().optional(),
    }

    server.registerTool(
      "system",
      {
        title: "System and desktop control",
        description:
          "Inspect and control the local computer. Actions: info, processes, services, env, disk, network, ports, windows, focus, screenshot, clipboard, notify, open, kill, power, ui_tree, ui_click, mouse_move, mouse_click, mouse_drag, scroll, type, key. Use screenshot + ui_tree to see the desktop, then ui_click or mouse/keyboard actions to interact. Destructive actions (kill/power) require confirm:true. Call this proactively for OS, process, window, mouse, keyboard or screenshot tasks.",
        inputSchema: schema,
        annotations: { readOnlyHint: false, openWorldHint: false },
      },
      async (args) => {
        try {
          const action = args.action
          if (action === "info") {
            const chrome = await chromePath()
            const ffmpeg = await whichAsync("ffmpeg").catch(() => null)
            return jsonResult({
              platform: process.platform,
              release: os.release(),
              arch: os.arch(),
              hostname: os.hostname(),
              user: os.userInfo().username,
              node: process.version,
              workspace: WORKSPACE,
              appRoot: APP_ROOT,
              dataDir: DATA_DIR,
              cpu: { model: os.cpus()[0]?.model, cores: os.cpus().length, load: os.loadavg() },
              memory: { total: os.totalmem(), free: os.freemem(), used: os.totalmem() - os.freemem() },
              uptime: os.uptime(),
              tools: {
                powershell: IS_WIN,
                chrome,
                ffmpeg: ffmpeg || "bundled ffmpeg-static",
                python: await whichAsync("python"),
                git: await whichAsync("git"),
                node: process.execPath,
              },
            })
          }

          if (action === "processes") {
            const filter = String(args.filter || "").replace(/[^a-zA-Z0-9_ .-]/g, "").slice(0, 80)
            const where = filter ? `| Where-Object { $_.ProcessName -like ${psQuote(`*${filter}*`)} }` : ""
            const script = `Get-Process ${where} | Sort-Object WorkingSet64 -Descending | Select-Object -First ${Number(args.limit || 60)} ProcessName,Id,CPU,WorkingSet64,StartTime | ForEach-Object { [pscustomobject]@{ name=$_.ProcessName; pid=$_.Id; cpu=$_.CPU; memory=$_.WorkingSet64; started=if($_.StartTime){$_.StartTime.ToString('o')}else{$null} } }`
            return jsonResult(await psJson(script, 20_000))
          }

          if (action === "services") {
            const filter = String(args.filter || "").replace(/[^a-zA-Z0-9_ .-]/g, "").slice(0, 80)
            const where = filter ? `| Where-Object { $_.Name -like ${psQuote(`*${filter}*`)} -or $_.DisplayName -like ${psQuote(`*${filter}*`)} }` : ""
            const script = `Get-Service ${where} | Sort-Object Status,Name | Select-Object -First ${Number(args.limit || 120)} Name,DisplayName,Status,StartType | ForEach-Object { [pscustomobject]@{ name=$_.Name; display=$_.DisplayName; status=$_.Status; startType=$_.StartType } }`
            return jsonResult(await psJson(script, 20_000))
          }

          if (action === "env") {
            const filter = String(args.filter || "").toLowerCase()
            const entries = Object.entries(process.env)
              .filter(([key]) => !filter || key.toLowerCase().includes(filter))
              .filter(([key]) => !/^(OPENCODE.*TOKEN|.*API_KEY|.*SECRET|.*PASSWORD)$/i.test(key))
              .slice(0, 200)
            return jsonResult({ env: Object.fromEntries(entries.map(([k, v]) => [k, redactSecrets(String(v ?? ""))])) })
          }

          if (action === "disk") {
            const script = `Get-PSDrive -PSProvider FileSystem | Select-Object Name,Root,Used,Free | ForEach-Object { [pscustomobject]@{ name=$_.Name; root=$_.Root; used=$_.Used; free=$_.Free } }`
            return jsonResult(await psJson(script, 15_000))
          }

          if (action === "network") {
            if (!IS_WIN) return jsonResult({ interfaces: os.networkInterfaces() })
            const script = `Get-NetIPConfiguration | ForEach-Object { [pscustomobject]@{ interface=$_.InterfaceAlias; ipv4=($_.IPv4Address.IPAddress -join ','); gateway=($_.IPv4DefaultGateway.NextHop -join ','); dns=($_.DNSServer.ServerAddresses -join ',') } }`
            return jsonResult(await psJson(script, 20_000))
          }

          if (action === "ports") {
            if (!IS_WIN) {
              const res = await import("node:child_process").then(({ execSync }) => {
                try {
                  return execSync("ss -ltnp 2>/dev/null || netstat -ltn", { encoding: "utf8", timeout: 10_000 })
                } catch {
                  return ""
                }
              })
              return textResult(res || "ss/netstat unavailable")
            }
            const script = `Get-NetTCPConnection | Where-Object { $_.State -eq 'Listen' } | Select-Object -First ${Number(args.limit || 120)} LocalAddress,LocalPort,OwningProcess,State | ForEach-Object { $p=Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue; [pscustomobject]@{ address=$_.LocalAddress; port=$_.LocalPort; pid=$_.OwningProcess; process=if($p){$p.ProcessName}else{''}; state=$_.State } }`
            return jsonResult(await psJson(script, 20_000))
          }

          if (action === "windows") {
            return jsonResult(await windowRows(args.filter, Number(args.limit || 80)))
          }
          if (action === "focus") {
            return jsonResult(await focusWindow(args))
          }
          if (action === "screenshot") {
            return await captureScreen(args.mode || "all")
          }
          if (action === "ui_tree") {
            return jsonResult(await uiTree(args.hwnd, Number(args.limit || 250)))
          }
          if (action === "ui_click") {
            return jsonResult(await uiClick(args))
          }

          if (action === "mouse_move") {
            if (!IS_WIN) throw new ToolError("mouse control is Windows-only", "UNSUPPORTED")
            return jsonResult(await mouseScript(`[void][OchatWin32]::SetCursorPos(${Number(args.x || 0)}, ${Number(args.y || 0)}); [pscustomobject]@{ x=${Number(args.x || 0)}; y=${Number(args.y || 0)} }`))
          }
          if (action === "mouse_click") {
            if (!IS_WIN) throw new ToolError("mouse control is Windows-only", "UNSUPPORTED")
            const flagDown = args.button === "right" ? "0x0008" : args.button === "middle" ? "0x0020" : "0x0002"
            const flagUp = args.button === "right" ? "0x0010" : args.button === "middle" ? "0x0040" : "0x0004"
            const repeat = args.double ? 2 : 1
            return jsonResult(await mouseScript(`
[void][OchatWin32]::SetCursorPos(${Number(args.x || 0)}, ${Number(args.y || 0)})
for ($i=0; $i -lt ${repeat}; $i++) {
  [OchatWin32]::mouse_event(${flagDown}, 0, 0, 0, [UIntPtr]::Zero)
  [OchatWin32]::mouse_event(${flagUp}, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 80
}
[pscustomobject]@{ clicked=$true; button='${args.button || "left"}'; double=${args.double ? "$true" : "$false"}; x=${Number(args.x || 0)}; y=${Number(args.y || 0)} }
`))
          }
          if (action === "mouse_drag") {
            if (!IS_WIN) throw new ToolError("mouse control is Windows-only", "UNSUPPORTED")
            const x1 = Number(args.x1 ?? args.x ?? 0)
            const y1 = Number(args.y1 ?? args.y ?? 0)
            const x2 = Number(args.x2 ?? 0)
            const y2 = Number(args.y2 ?? 0)
            return jsonResult(await mouseScript(`
[void][OchatWin32]::SetCursorPos(${x1}, ${y1})
[OchatWin32]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
$steps = 12
for ($i=1; $i -le $steps; $i++) {
  $x = [int](${x1} + (${x2} - ${x1}) * $i / $steps)
  $y = [int](${y1} + (${y2} - ${y1}) * $i / $steps)
  [void][OchatWin32]::SetCursorPos($x, $y)
  Start-Sleep -Milliseconds 15
}
[OchatWin32]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
[pscustomobject]@{ dragged=$true; from=@(${x1},${y1}); to=@(${x2},${y2}) }
`))
          }
          if (action === "scroll") {
            if (!IS_WIN) throw new ToolError("mouse control is Windows-only", "UNSUPPORTED")
            const amount = Number(args.amount ?? args.y ?? 3)
            return jsonResult(await mouseScript(`[OchatWin32]::mouse_event(0x0800, 0, 0, [uint32](([int64](${amount} * 120)) -band 0xFFFFFFFF), [UIntPtr]::Zero); [pscustomobject]@{ scrolled=${amount} }`))
          }
          if (action === "type") {
            if (!IS_WIN) throw new ToolError("keyboard control is Windows-only", "UNSUPPORTED")
            const text = sendKeysLiteral(args.text || args.name || "")
            return jsonResult(await mouseScript(`[System.Windows.Forms.SendKeys]::SendWait(${psQuote(text)}); [pscustomobject]@{ typed=${String(args.text || args.name || "").length} }`))
          }
          if (action === "key") {
            if (!IS_WIN) throw new ToolError("keyboard control is Windows-only", "UNSUPPORTED")
            const chord = sendKeysChord(args.keys || args.text || "ENTER")
            return jsonResult(await mouseScript(`[System.Windows.Forms.SendKeys]::SendWait(${psQuote(chord)}); [pscustomobject]@{ pressed=${psQuote(String(args.keys || args.text || "ENTER"))} }`))
          }

          if (action === "clipboard") {
            if (!IS_WIN) throw new ToolError("clipboard is Windows-only", "UNSUPPORTED")
            if ((args.mode || "get") === "get") {
              const script = `Get-Clipboard -Raw`
              const res = await powershell(script, { timeout: 10_000 })
              if (res.code !== 0) throw new ToolError(res.stderr.slice(0, 500), "CLIPBOARD_FAILED")
              return textResult(res.stdout)
            }
            const value = String(args.text ?? args.filter ?? "")
            const script = `Set-Clipboard -Value ${psQuote(value)}`
            const res = await powershell(script, { timeout: 10_000 })
            if (res.code !== 0) throw new ToolError(res.stderr.slice(0, 500), "CLIPBOARD_FAILED")
            return textResult(`Copied ${value.length} characters to the clipboard.`)
          }

          if (action === "notify") {
            if (!IS_WIN) throw new ToolError("desktop notifications are Windows-only", "UNSUPPORTED")
            const title = String(args.name || "OpenCode Chat")
            const body = String(args.text || args.filter || "Task finished")
            const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$n = New-Object System.Windows.Forms.NotifyIcon
$n.Icon = [System.Drawing.SystemIcons]::Information
$n.BalloonTipTitle = ${psQuote(title)}
$n.BalloonTipText = ${psQuote(body)}
$n.Visible = $true
$n.ShowBalloonTip(5000)
Start-Sleep -Seconds 5
$n.Dispose()
`
            const res = await powershell(script, { timeout: 12_000 })
            if (res.code !== 0) throw new ToolError(res.stderr.slice(0, 500), "NOTIFY_FAILED")
            return textResult(`Notification shown: ${title} — ${body}`)
          }

          if (action === "open") {
            const target = String(args.path || args.text || "").trim()
            if (!target) throw new ToolError("path is required", "BAD_INPUT")
            if (!/^https?:\/\//i.test(target) && !fs.existsSync(target)) {
              throw new ToolError(`path does not exist: ${target}`, "NOT_FOUND")
            }
            const res = await powershell(`Start-Process -FilePath ${psQuote(target)}`, { timeout: 10_000 })
            if (res.code !== 0) throw new ToolError(res.stderr.slice(0, 500), "OPEN_FAILED")
            return textResult(`Opened ${target}`)
          }

          if (action === "kill") {
            assertConfirm(args, "kill")
            const pid = Number(args.pid)
            if (!Number.isInteger(pid) || pid <= 4) throw new ToolError("a non-system pid is required", "BAD_INPUT")
            const res = await powershell(`Stop-Process -Id ${pid} -Force`, { timeout: 10_000 })
            if (res.code !== 0) throw new ToolError(res.stderr.slice(0, 500), "KILL_FAILED")
            return textResult(`Process ${pid} stopped.`)
          }

          if (action === "power") {
            if (!IS_WIN) throw new ToolError("power control is Windows-only", "UNSUPPORTED")
            const mode = args.powerAction || "lock"
            if (["restart", "shutdown"].includes(mode)) assertConfirm(args, mode)
            const command = {
              lock: `rundll32.exe user32.dll,LockWorkStation`,
              sleep: `powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Application]::SetSuspendState('Suspend',$false,$false)"`,
              restart: `shutdown.exe /r /t 5`,
              shutdown: `shutdown.exe /s /t 5`,
              cancel: `shutdown.exe /a`,
            }[mode]
            if (!command) throw new ToolError(`unknown power action: ${mode}`, "BAD_INPUT")
            const res = await powershell(`Start-Process -FilePath cmd.exe -ArgumentList '/c', ${psQuote(command)} -WindowStyle Hidden`, { timeout: 10_000 })
            if (res.code !== 0) throw new ToolError(res.stderr.slice(0, 500), "POWER_FAILED")
            return textResult(`Power action started: ${mode}`)
          }

          throw new ToolError(`unknown system action: ${action}`, "BAD_INPUT")
        } catch (error) {
          return errorResult(error)
        }
      },
    )
  },
}
