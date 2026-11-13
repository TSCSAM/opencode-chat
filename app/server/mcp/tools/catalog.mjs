import { errorResult, jsonResult, whichAsync } from "../lib/core.mjs"

export const TOOLS = [
  {
    name: "files",
    title: "Files and folders",
    actions: ["read", "write", "append", "edit", "create", "delete", "move", "rename", "copy", "list", "tree", "search", "stat", "mkdir", "hash", "compare", "download", "duplicates"],
    requires: [],
  },
  {
    name: "documents",
    title: "PDF, DOCX, XLSX, PPTX, Markdown and archives",
    actions: ["read", "create_pdf", "create_docx", "create_xlsx", "create_pptx", "convert", "pdf_info", "merge_pdf", "edit_pdf", "summarize", "classify", "compare", "markdown_to_html", "html_to_markdown", "archive_create", "archive_extract"],
    requires: [],
  },
  {
    name: "web",
    title: "Web search, fetch, crawl, HTTP and research",
    actions: ["search", "fetch", "crawl", "http", "status", "links", "metadata", "tables", "sitemap", "robots", "suggest", "research", "download"],
    requires: ["internet"],
  },
  {
    name: "browser",
    title: "Chromium browser automation and screenshots",
    actions: ["navigate", "snapshot", "screenshot", "click", "type", "press", "scroll", "hover", "select", "upload", "wait", "evaluate", "form_fill", "drag", "pdf", "set_viewport", "tabs", "new_tab", "close", "cookies", "performance", "accessibility", "download"],
    requires: ["chrome"],
  },
  {
    name: "images",
    title: "Image editing, comparison, OCR and vision",
    actions: ["info", "view", "resize", "crop", "rotate", "flip", "compress", "convert", "grayscale", "blur", "watermark", "annotate", "remove_background", "compare", "ocr", "generate"],
    requires: ["chrome", "windows-ocr"],
  },
  {
    name: "data",
    title: "CSV, JSON, statistics and charts",
    actions: ["csv", "json_query", "stats", "correlation", "regression", "forecast", "moving_average", "chart", "transform", "join"],
    requires: [],
  },
  {
    name: "database",
    title: "SQLite database",
    actions: ["query", "exec", "migrate", "tables", "schema", "insert", "export", "import", "backup", "restore", "create_table"],
    requires: ["node-sqlite"],
  },
  {
    name: "media",
    title: "Video, audio, TTS and transcription",
    actions: ["info", "convert", "extract_frame", "thumbnail", "resize", "compress", "trim", "extract_audio", "mute", "replace_audio", "gif", "subtitles", "speed", "normalize_audio", "scene_detect", "silence_detect", "merge", "tts", "stt", "video_generate"],
    requires: ["ffmpeg"],
  },
  {
    name: "memory",
    title: "Persistent memory",
    actions: ["add", "search", "list", "update", "delete", "clear", "stats", "context"],
    requires: [],
  },
  {
    name: "system",
    title: "Computer use, processes, windows and UI automation",
    actions: ["info", "processes", "services", "env", "disk", "network", "ports", "windows", "focus", "screenshot", "clipboard", "notify", "open", "kill", "power", "ui_tree", "ui_click", "mouse_move", "mouse_click", "mouse_drag", "scroll", "type", "key"],
    requires: ["windows"],
  },
  {
    name: "shell",
    title: "Terminal, Node, Python and scripts",
    actions: ["run", "powershell", "cmd", "bash", "python", "node", "script", "npm", "which", "background"],
    requires: [],
  },
  {
    name: "code",
    title: "Codebase analysis, tests and packages",
    actions: ["project_map", "outline", "analyze_file", "symbols", "search", "dependencies", "security_scan", "secrets", "diff", "test", "build", "lint", "typecheck", "run_script", "package"],
    requires: ["npm"],
  },
  {
    name: "git",
    title: "Git and GitHub",
    actions: ["version", "init", "clone", "status", "diff", "log", "show", "branches", "branch", "checkout", "add", "commit", "push", "pull", "fetch", "merge", "stash", "stash_pop", "remotes", "tags", "blame", "grep", "reset", "clean", "config", "repo", "search_repos", "search_code", "issues", "pulls", "create_issue", "create_pr"],
    requires: ["git", "github-token"],
  },
  {
    name: "devops",
    title: "SSH, DNS, TLS, Docker and Kubernetes",
    actions: ["ssh", "scp", "dns", "port", "ssl", "docker", "kubectl", "which"],
    requires: ["ssh", "docker", "kubectl"],
  },
  {
    name: "maps",
    title: "Geocoding, routes, places, weather and time zones",
    actions: ["geocode", "reverse", "route", "distance", "nearby", "weather", "timezone", "map"],
    requires: ["internet"],
  },
  {
    name: "seo",
    title: "SEO audits, Core Web Vitals and SERP analysis",
    actions: ["audit", "keywords", "serp", "vitals", "broken_links", "status"],
    requires: ["internet", "chrome"],
  },
  {
    name: "comms",
    title: "Email, Slack, Discord, Telegram, webhooks and calendar",
    actions: ["email", "slack", "discord", "telegram", "webhook", "sms", "notification", "calendar_create", "calendar_parse"],
    requires: ["credentials"],
  },
  {
    name: "workflow",
    title: "Tasks, plans, multi-step workflows and schedules",
    actions: ["task_add", "task_list", "task_update", "task_delete", "plan", "plan_list", "plan_update", "run", "schedule_add", "schedule_list", "schedule_delete", "state"],
    requires: [],
  },
  {
    name: "translate",
    title: "Translation and language detection",
    actions: ["translate", "detect", "languages"],
    requires: ["internet"],
  },
  {
    name: "catalog",
    title: "Tool catalog and availability",
    actions: ["list", "status", "providers"],
    requires: [],
  },
]

export const catalogTool = {
  register(server, { z }) {
    server.registerTool(
      "catalog",
      {
        title: "Tool catalog and availability",
        description:
          "List every locally installed capability, its actions and runtime requirements. Call this first when you are unsure which tool can handle a task. The catalog tells you what is available without consuming external services.",
        inputSchema: {
          action: z.enum(["list", "status", "providers"]),
          query: z.string().optional(),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      },
      async (args) => {
        try {
          if (args.action === "list") {
            const query = String(args.query || "").toLowerCase()
            return jsonResult({
              server: "opencode-chat-tools",
              tools: TOOLS.filter((tool) => !query || `${tool.name} ${tool.title} ${tool.actions.join(" ")}`.toLowerCase().includes(query)),
            })
          }
          if (args.action === "providers") {
            return jsonResult({
              env: {
                OPENCODE_CHAT_IMAGE_API_KEY: Boolean(process.env.OPENCODE_CHAT_IMAGE_API_KEY || process.env.OPENAI_API_KEY),
                OPENCODE_CHAT_STT_API_KEY: Boolean(process.env.OPENCODE_CHAT_STT_API_KEY || process.env.OPENAI_API_KEY),
                OPENCODE_CHAT_VIDEO_API_KEY: Boolean(process.env.OPENCODE_CHAT_VIDEO_API_KEY),
                GITHUB_TOKEN: Boolean(process.env.GITHUB_TOKEN || process.env.GH_TOKEN),
                SLACK_WEBHOOK_URL: Boolean(process.env.SLACK_WEBHOOK_URL),
                DISCORD_WEBHOOK_URL: Boolean(process.env.DISCORD_WEBHOOK_URL),
                TELEGRAM_BOT_TOKEN: Boolean(process.env.TELEGRAM_BOT_TOKEN),
                SMTP_HOST: Boolean(process.env.SMTP_HOST),
                LIBRETRANSLATE_URL: Boolean(process.env.LIBRETRANSLATE_URL),
              },
            })
          }
          let sqlite = false
          try {
            await import("node:sqlite")
            sqlite = true
          } catch {}
          const status = {
            chrome: await whichAsync("chrome").catch(() => null) || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
            python: await whichAsync("python"),
            git: await whichAsync("git"),
            docker: await whichAsync("docker"),
            kubectl: await whichAsync("kubectl"),
            ffmpeg: "bundled",
            powershell: process.platform === "win32",
            sqlite,
          }
          return jsonResult({
            platform: process.platform,
            workspace: process.env.OPENCODE_CHAT_WORKSPACE,
            status,
            tools: TOOLS.map((tool) => ({ name: tool.name, title: tool.title, actions: tool.actions.length, requirements: tool.requires })),
          })
        } catch (error) {
          return errorResult(error)
        }
      },
    )
  },
}
