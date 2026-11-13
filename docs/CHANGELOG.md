# Changelog / تاریخچهٔ تغییرات

## v1.14.0 — 2026-11-13

### Added

- **One routing policy for all three route types:** the direct connection, cloud relays
  (Vercel, Netlify, Cloudflare) and regional Psiphon exits now share a single route pool.
  A new **Routing policy and rotation** section selects one primary route — automatic,
  direct, any enabled cloud relay, or a specific tunnel region such as `psiphon:US` — and
  keeps the automatic rotation and 429/error failover controls in the same place.
- **Direct connection as a first-class route:** a direct-connection card is always shown
  above the cloud relay list, even when relays are active. It reports availability and the
  last HTTP status, can be selected as the primary route, and joins automatic rotation and
  failover whenever **Allow direct connection** is on.
- **Per-region primary selection for the tunnel:** every ready Psiphon region has a
  **Select as primary** action. The selected region shows a **Selected primary relay** pill
  and is tried before cloud relays and direct for subsequent requests.

### Changed

- **Saving zero tunnel regions is allowed.** Save is enabled whenever the selection is
  dirty, including when every region was unchecked. Saving an empty selection stops active
  clients, clears a tunnel primary that pointed at a removed region, and shows the empty
  state instead of refusing to save.
- Selecting a primary route turns automatic rotation off; enabling automatic rotation
  clears the fixed primary. Selecting direct automatically enables the direct route, and
  disabling direct clears a direct primary.
- A primary route that is temporarily unavailable — for example a tunnel region while it
  reconnects — is preserved while the request fails over. The fallback route becomes the
  primary only when the selected primary is part of the current candidate pool or no
  primary is selected.
- The relay header and pool counts now include the direct connection, and the page
  description names all three route types.
- Release archives now contain only the launcher, `LICENSE` and `app/`. Documentation and
  screenshots stay in the GitHub repository and are not bundled in the download.

### Fixed

- The direct connection is no longer hidden while relay routing is active.
- Requests can fail over in both directions between direct and cloud relays: a 429, 5xx or
  network error on one route moves to the next healthy route, including direct as either
  the source or the destination of the failover.
- A stale tunnel or direct primary is not shown as selected after its route is removed.
- The bundled Git tool finds a user-level Git install through `%LOCALAPPDATA%` instead of
  a hard-coded machine-specific path.
- Version bumped to **1.14.0**.

## v1.13.0 — 2026-11-13

### Added

- **Test a region before connecting it:** every region in the tunnel picker now has a
  compact ⚡ control. It starts a temporary local client for that region with its own data
  directory and SOCKS port, waits for the tunnel, sends a real request through it and
  reports the ping and exit IP. Unreachable regions show the reason inline. The temporary
  client and its data are removed afterward, and the region selection is not changed.
- The probe is serialized so two tests cannot start at once, has a 45-second connection
  timeout, and is cleaned up by Disconnect/Exit as well. A new
  `POST /app/relays/psiphon/probe` endpoint exposes it to the panel.

### Changed

- The region rows keep their existing compact size: the test control fits inside the row
  and the result replaces the ⚡ with a colored check or cross, so cards do not grow.
- The region hint now explains the ⚡ test control.
- Version bumped to **1.13.0**.

## v1.12.0 — 2026-11-13

### Added

- **Local multi-region tunnel route:** the Relays page now runs the official Psiphon
  client once per selected region (up to 18), each with its own data directory and local
  SOCKS port. Every region becomes a route in the relay pool with a real exit IP, latency
  and daily request stats, and can be tested or renewed independently.
- **Two routing modes:** spread requests round-robin across the connected regions, or pin
  all traffic to one region. Region changes and mode changes apply to the running clients
  immediately.
- **Used-up exit handling:** a 429 marks the exit for its provider scope (`OpenCode`,
  `Kilo`, or other), used-up addresses are skipped, and a region can reconnect for a fresh
  address at most 3 times per hour. Renewal runs in the background so a rate-limited
  request fails over to the next region instead of waiting for a minute-long reconnect.
- **Tunnel panel in Relays:** region picker, spread/pinned mode, enable and auto-start
  switches, skip-used-up and auto-renew toggles, server-list update, connect/disconnect,
  per-region status cards, tests, renewal counts and error details, translated to Persian
  and English and responsive on mobile.
- **Server integration:** new `/app/relays/psiphon/*` endpoints, engine URL sync while the
  tunnel is part of the active route pool, clean startup/shutdown of every client process,
  and a graceful fallback when the client is missing or unsupported.
- **Third-party notice:** the bundled unmodified client binaries and signed server list
  ship with their GPL-3.0 license and a source/attribution notice in
  `app/THIRD_PARTY_NOTICES.md`.

### Changed

- The relay header, master switch, connection chip and sidebar badge now include tunnel
  regions in their capacity and health counts.
- The relay stats table adds one row per tunnel region and includes them in the totals.
- The OpenCode service hint no longer says it needs a cloud relay; the local tunnel route
  is also supported.
- `undici` is now an explicit runtime dependency for SOCKS5 agents.
- Version bumped to **1.12.0**.

### Fixed

- A tunnel 429 or connection error no longer blocks the request while the region
  reconnects; the request moves to the next ready region (or returns the last response)
  and renewal finishes in the background.
- Deleting a tunnel route is rejected because tunnel regions are managed by their own
  panel; use Disconnect or remove the region instead.

## v1.11.0 — 2026-11-13

### Added

- **Custom providers settings tab:** a separate, full-width section in Settings for adding
  any OpenAI-, Anthropic- or Responses-compatible endpoint. Each provider has a Base URL,
  an API format (`Anthropic messages`, `Chat completions`, `Responses`), an optional API
  key, an enabled switch and a model list with **Fetch models**, **Add model**, per-model
  context/output limits and delete. Enabled providers are written to the engine config and
  their models appear in the model picker immediately; disabled ones stay in
  `app/data/custom-providers.json` but are removed from the engine. The list endpoint never
  returns saved keys, and a new provider cannot reuse an engine provider ID.
- **Model-limit catalog refresh:** edits to `app/data/model-limits.json` are picked up by
  the running server (mtime check) instead of requiring a restart.

### Changed

- OpenCode Zen free-model limits now match the official catalog at
  `https://opencode.ai/inference/v1/models`: `big-pickle`,
  `mimo-v2.6-flash-free`, `deepseek-v4.1-flash-free` and `glm-5.3-flash-free` are
  **200,000 context / 32,000 output**; the paid `deepseek-v4.1-flash` remains
  **1,000,000 / 384,000**. All other free-model rows were rechecked against the same
  catalog.
- Release archives exclude the local `custom-providers.json` file so provider keys are
  never shipped.
- Version bumped to **1.11.0**.

### Fixed

- Model rows in the custom-provider editor no longer lose focus after the first typed
  character.
- Confirmation and error messages stay visible after saving or deleting a provider.
- The model-limits updater no longer overwrites the free variants with the manufacturer's
  full-model specs, and its OpenCode note no longer contains `undefined`.

## v1.10.0 — 2026-11-13

### Added

- **Multi-project workspace manager:** the single-line workdir field is replaced by a
  **Projects** entry in the sidebar. It opens a modal that lists every project, marks the
  active one, and can open a folder picker with breadcrumbs, drive roots, Home/Desktop/
  Documents/Downloads shortcuts, multi-select checkboxes and a manual path box. Several
  projects can be added at once, switched between, and removed; the list is stored in
  `localStorage` and new chats start in the active folder. Duplicate or re-escaped paths
  (`C:\\Project\\…`) are collapsed to one entry on load and save.
- **Permission modes in the composer:** a **Plan / Ask / Auto / Full** picker next to the
  attach button. Each mode is sent to the engine as a per-session permission ruleset
  (`PATCH /api/session/:id`), so it applies only to that chat. Rules cover native actions
  (`edit`, `shell`, `execute`, `subagent`) and the local tool hub, so MCP file tools cannot
  bypass Plan or Ask. The picker follows the active session's ruleset and updates when the
  permission list changes elsewhere.
- **Attach any file:** a **+** button opens the file dialog for images, PDFs, text,
  Markdown, CSV, JSON, archives and more. Non-image attachments show as chips with name
  and size. `/app/upload` now accepts any file type up to 40 MB.
- **Folder endpoints:** `GET /app/folders` lists a directory with parent, drives and quick
  places; `GET /app/folders/check` validates that a path is an existing directory.

### Changed

- Sidebar workdir editor removed in favour of the Projects modal.
- Version bumped to **1.10.0**.

### Fixed

- Duplicate project rows caused by double-escaped Windows paths are normalized when the
  project list is loaded and saved.

## v1.9.0 — 2026-11-13

### Added

- **Bundled local tool hub (20 MCP tool groups, 264 actions):** files and folders,
  PDF/DOCX/XLSX/PPTX documents, web search/fetch/crawl, Chrome automation, image
  editing/OCR, CSV/JSON/statistics/charts, SQLite, video/audio/TTS, persistent memory,
  Windows computer control, shell/Python/Node, code analysis/tests, Git/GitHub, SSH/DNS/
  Docker/Kubernetes, maps/weather, SEO, email/Slack/Discord/Telegram/webhooks/SMS,
  persistent tasks and workflows, translation, and a catalog of everything installed.
- **Automatic registration:** at startup the hub is merged into the OpenCode config as
  `opencode-chat-tools` with `codemode: false` and an allow rule, preserving existing
  servers, permissions and JSONC comments. The server is reconnected after registration
  so the model sees the direct tool catalog even if the engine was already running.
- **Settings → Tools:** connection status, config path, tool/action browser with search,
  runtime requirements, **Refresh status** and **Reconnect** actions, backed by
  `GET /app/tools`, `POST /app/tools/register` and `POST /app/tools/status`.
- **Friendly MCP tool cards:** tool names such as `opencode-chat-tools_files` render as
  **Files** with the action and target in the summary.
- **Catalog build helper:** `node scripts/build-tool-catalog.mjs` regenerates
  `data/tool-catalog.json` from the tool definitions.

### Changed

- `puppeteer-core` and `zod` are runtime dependencies now, so packaged installs keep
  browser and MCP support without dev dependencies.
- Version bumped to **1.9.0**.
- Documentation now covers the local tool hub, optional provider environment variables,
  and the Settings → Tools reconnect path.

### Fixed

- **Long question forms:** the question card is capped to the viewport and its body
  scrolls internally, so the question header and Submit/Skip buttons stay visible.
  Options use a responsive grid instead of one tall column; six typical questions fit
  at 100% zoom on a 1366×768 screen and the composer stays on screen. Works in English
  LTR, Persian RTL and narrow windows.
- **RTL mobile drawer:** a closed sidebar no longer leaves a visible strip on the left
  side of the screen.

### Notes

- Core capabilities run locally with no API key. External connectors (email, chat,
  GitHub, paid image/video/STT providers, SSH, Docker, Kubernetes) return a clear
  configuration error when their dependency is absent. Git, Docker and Kubernetes are not
  bundled with the app.

## v1.8.0 — 2026-11-13

### Added

- **Point zoom and pan in the image editor:** the editor now zooms from 100% to 800%
  toward the exact image pixel under the pointer. Use the mouse wheel or trackpad,
  pinch on touch screens, the **− / + / Fit** controls, or the `+`, `-` and `0`
  shortcuts. The hand tool, Space-drag, middle-drag and Alt-drag pan the enlarged
  image. Drawing, text placement and saving keep their exact coordinates at every
  zoom level, the page never scrolls while zooming, and panning is clamped so the
  image cannot be lost off-screen. The view re-clamps on window resize or rotation.

### Changed

- **Cleaner project layout:** `Start OpenCode Chat.cmd` is now the only file at the
  top level, next to the folders. Application code lives in `app/` (with
  `src/components/`, `src/lib/`, `src/styles/`, `server/`, `server/relays/`, `data/`,
  `tests/` and `tools/`), documentation in `docs/`, generated archives in `release/`
  and workflows in `.github/`.
- The launcher, local server, build check, model-limits updater, release packager,
  npm scripts and GitHub workflows were updated for the nested layout.
- Source releases now preserve the same top-level layout, so the extracted archive
  opens with the launcher and folders exactly as the project does.

## v1.7.0 — 2026-11-13

### Added

- **Built-in image editor:** clicking an image in a message (or an image attached to the
  composer) opens a full annotation panel with pen, text, rectangle, ellipse and arrow
  tools, a color palette, stroke width, undo/redo, clear, download, and **Save to chat**.
  Edited message images are added to the composer as a ready-to-send attachment; edits to
  an existing attachment replace it in place.
- **Visible Exit control:** the Exit button in the sidebar now has a red power-button
  treatment with a proper icon and label, so it is easy to find at the top of the panel.

## v1.6.0 — 2026-11-13

### Added

- **Exit button in the panel:** the new power button at the top of the sidebar stops the
  server and the OpenCode engine together and shows a “stopped” screen, so the whole app
  can be closed from the browser.
- **Silent Windows launcher:** `Start OpenCode Chat.cmd` now starts the server detached and
  hidden, waits until it is ready, then closes its own console window. The app keeps
  running in the background until **Exit** is pressed.

## v1.5.0 — 2026-11-13

### Added

- **Queued-message tray above the composer:** sending a follow-up while the model is
  reasoning or running tools now shows a compact card with the pending text. By default
  the message waits for the current run and is delivered automatically; **Send now**
  steers it into the running turn immediately, and **Cancel** removes it from the queue.
  The tray supports multiple pending messages and file attachments.

### Changed

- **Relay routing is opt-in:** the relay system starts disabled. It activates only after
  the user turns on **Enable relay system** *and* at least one relay exists. Existing
  installations are migrated once to the disabled state; direct connections remain the
  fallback.

### Fixed

- **No orphaned engine after closing the launcher window:** the server now owns the
  OpenCode engine lifecycle. A detached watchdog stops the registered engine and its
  process tree if the console process disappears, and graceful exits (Ctrl+C, SIGTERM)
  stop the service before shutting down. Duplicate server instances never touch the
  primary instance's engine.

## v1.4.0 — 2026-11-13

### Added

- **Bilingual interface (English / Persian):** English is now the default language. A
  language toggle in the sidebar footer and a selector in **Settings → General** switch
  between English (LTR) and Persian (RTL) instantly.
- **Persian translations for the whole UI:** App shell, sidebar, composer, model and agent
  pickers, tool and question cards, Markdown, limits, providers, relays, settings and
  update panels.
- **Language-aware server messages:** Relay, upload, config and update errors follow the
  client's `accept-language` header, with English as the fallback.
- **RTL styling:** Persian font stacks, logical text alignment, RTL-aware code blocks and
  relay tables.
- `LICENSE`, `.editorconfig`, a bilingual README and GitHub-ready ignore rules.
- **Small source releases:** `npm run release:pack` builds a clean ~200 KB ZIP without
  `node_modules`, `dist`, caches or screenshots; a GitHub workflow attaches it on tags.
- **Self-updating launcher dependencies:** the Windows launcher runs `npm install` when
  `node_modules` is missing or `package-lock.json` is newer, then builds only when needed.

### Changed

- Document language and direction are applied before first paint from the saved `oc-lang`
  preference.
- The project is prepared for publishing on GitHub (clean source tree, no generated files
  tracked).

## v1.3.0 — 2026-11-13

### تازه

- **ظرفیت واقعی مدل‌ها:** فایل `model-limits.json` به‌عنوان مرجع محلی اضافه شد؛ برای
  ۱۳۷ مدل از ۱۷ پرووایدر، پنجرهٔ زمینه و حداکثر توکن خروجی بر اساس مستندات رسمی
  پرووایدر/سازندهٔ مدل ثبت شده است. سه مقدار تأییدشده که موتور اشتباه گزارش می‌کرد
  اصلاح شدند: `glm-5.3-flash-free` → ۱٬۰۴۸٬۵۷۶ / ۱۳۱٬۰۷۲،
  `deepseek-v4.1-flash-free` → ۱٬۰۰۰٬۰۰۰ / ۳۸۴٬۰۰۰ و
  `mimo-v2.6-flash-free` → ۱٬۰۴۸٬۵۷۶ / ۱۳۱٬۰۷۲ (به‌جای ۲۰۰٬۰۰۰ / ۳۲٬۰۰۰).
- **همگام‌سازی خودکار هنگام استارت:** سرور در هر راه‌اندازی مقادیر موتور را با کاتالوگ
  مقایسه می‌کند و فقط مدل‌های متفاوت را در بخش
  `providers.<provider>.models.<model>.limit` فایل `opencode.json` می‌نویسد، سپس موتور
  را بدون ری‌استارت reload می‌کند. اگر آپدیت موتور مقدار پیش‌فرض را برگرداند، استارت
  بعدی دوباره اصلاح می‌کند.
- **تب «ظرفیت مدل‌ها» در تنظیمات:** جدول مدل‌های تحت پایش، وضعیت هماهنگی با کاتالوگ،
  منبع/یادداشت هر مقدار و دکمهٔ «اعمال روی موتور» برای اصلاح دستی.
- **اعمال محلی کاتالوگ در رابط کاربری:** چیپ مصرف زمینه حتی پیش از نوشته‌شدن فایل
  پیکربندی، اعداد درست کاتالوگ را نشان می‌دهد.

### بهبود

- ابزار `tools/update-model-limits.mjs` برای بازتولید کاتالوگ از فهرست مدل‌های OpenCode
  و models.dev، با حفظ مقادیر تأییدشدهٔ دستی.
- نوشتن تنظیمات با `jsonc-parser` انجام می‌شود تا کامنت‌ها و قالب فایل حفظ شوند؛
  همگام‌سازی با قفل داخلی از نوشتن هم‌زمان جلوگیری می‌کند.

## v1.2.1 — 2026-11-13

### رفع باگ

- **خطای کاذب «پورت اشغال است»:** بررسی «قبلاً در حال اجراست» روی `/__config` با مهلت
  ۸۰۰ میلی‌ثانیه انجام می‌شد، ولی همان مسیر منتظر پاسخ موتور می‌ماند (تا ۳ ثانیه). وقتی
  موتور کند بود، بررسی شکست می‌خورد و برنامه می‌گفت پورت را برنامهٔ دیگری گرفته — در
  حالی که خودش صاحب پورت بود. حالا نسخهٔ موتور در پس‌زمینه تازه می‌شود، `/__config`
  هرگز منتظر موتور نمی‌ماند و یک مسیر سبک `/__ping` اضافه شده که بررسی از آن انجام
  می‌شود.
- **مهاجرت خودکار پورت:** اگر پورت ۵۱۷۸ را برنامهٔ دیگری گرفته باشد، پنل خودش یک پورت
  آزاد بعدی را انتخاب می‌کند و آدرس واقعی را در کنسول چاپ می‌کند، به‌جای آنکه از کاربر
  بخواهد `PORT` را دستی تنظیم کند. مسیر رله‌ها هم بعد از تغییر پورت دوباره همگام
  می‌شود.
- **خروج تمیز:** در حالت «قبلاً در حال اجراست» پروسه با کد ۰ خارج می‌شود و پنجرهٔ کنسول
  بی‌مورد باز نمی‌ماند.
- **بنر تکراری:** با مهاجرت پورت، بنر راه‌اندازی دو بار چاپ می‌شد؛ حالا شنوندهٔ
  `listening` فقط یک‌بار ثبت می‌شود.
- **JSON نامعتبر در تنظیمات رله:** بدنهٔ خراب به‌جای خطای ۵۰۰، پاسخ ۴۰۰ با پیام
  درست می‌گیرد.

### تغییرات

- **بیلد خودکار در لانچر:** اگر فایل‌های `src/` جدیدتر از بیلد باشند، لانچر خودش دوباره
  بیلد می‌کند. بررسی با یک اسکریپت کوچک Node انجام می‌شود تا اجرای برنامه به
  PowerShell وابسته نباشد.
- **بازطراحی ظاهری:** عمق محیطی با هالهٔ شعاعی، سطوح شیشه‌ای (blur + هایلایت لبهٔ
  بالا)، کارت‌های بنتو برای پیشنهادهای شروع با آیکون دسته، نوار فرمان شناور با هالهٔ
  فوکوس، نشان‌های `<kbd>` برای میان‌برها، و LED سبز پالسینگ برای نشانگر اتصال رله.

## v1.2.0 — 2026-11-13

### رفع باگ

- **کانفیگ JSONC:** خواندن و نوشتن `opencode.json` حالا کامنت‌ها و ویرگول‌های انتهایی را حفظ می‌کند و بازگردانی baseURL پس از غیرفعال‌کردن رله‌ها درست انجام می‌شود.
- **احترام به `allowDirect`:** وقتی رله‌ها فعال‌اند ولی هیچ رلهٔ مناسبی برای مقصد وجود ندارد، با `allowDirect=false` درخواست مسدود می‌شود و بی‌صدا مستقیم نمی‌رود.
- **پولینگ OAuth و دستور:** خطای موقت شبکه دیگر پولینگ را متوقف نمی‌کند؛ تلاش مجدد خودکار انجام می‌شود و خطا پس از بازیابی پاک می‌شود.
- **اعتبارسنجی رلهٔ دستی:** فقط `https://` مجاز است؛ `http://` صرفاً برای `localhost` و آدرس‌های loopback. آدرس‌هایی مانند `file://` رد می‌شوند.
- **گیت‌وی رله:** query string و hash آدرس بالادستی در URL محلی گیت‌وی حفظ می‌شوند.
- **فایل‌های استاتیک:** asset گم‌شده با پسوند به‌جای `index.html` پاسخ ۴۰۴ می‌گیرد؛ مسیرهای SPA همچنان به index برمی‌گردند.
- **به‌روزرسانی موتور:** بستن صفحه در میانهٔ `opencode upgrade` پروسه را نمی‌کشد و نصب نیمه‌کاره باقی نمی‌ماند.
- **پنهان‌سازی کنسول موتور:** به‌جای اجرای مکرر PowerShell، یک حلقهٔ بلندمدت اجرا می‌شود.
- **دکمهٔ کپی:** نتیجهٔ واقعی کلیپ‌بورد await می‌شود، مسیر جایگزین دارد و در صورت شکست «کپی نشد» نمایش می‌دهد.
- **رویدادهای reducer:** پشتیبانی از `session.message.content.updated`، `session.step.*`، `session.tool.input.*`، `session.tool.progress` و `session.retry.scheduled`.

### تغییرات

- **نام‌گذاری پروژه:** همهٔ ارجاع‌های نام قدیمی در اسکریپت‌های رله، کامنت‌ها و رابط کاربری با `opencode-chat` جایگزین شد. متغیرهای محیطی جدید `OPENCODE_CHAT_RELAY_TOKEN` و `OPENCODE_CHAT_ALLOWED_HOSTS` هستند؛ رله‌های از قبل مستقرشده با نام قدیمی همچنان کار می‌کنند و استقرارهای جدید از نام جدید استفاده می‌کنند.

### سازگاری

- OpenCode core v2.2.5 آزمایش شده است.
- Node.js 20+.

## v1.1.0 — 2026-11-12

### تازه

- **مدیریت کامل پرووایدرها و Integrationها:** خواندن پرووایدرهای فعال و همهٔ Integrationهای موتور، اتصال با کلید API، OAuth، متغیر محیطی، ورود خارجی و دستور، نمایش فرم‌های شرطی و مدیریت credentialها (فعال‌سازی/حذف).
- **همگام‌سازی زندهٔ مدل‌ها:** لیست کامل مدل‌های OpenCode و به‌روزرسانی خودکار با رویدادهای `model.updated`، `models-dev.refreshed`، `provider.updated`، `credential.*` و `integration.updated`؛ مدل‌های Fast دیگر با مدل پایه ادغام نمی‌شوند.
- **ویرایش آخرین پیام:** دکمهٔ ویرایش فقط روی آخرین پیام کاربر، ویرایش در همان حباب، حفظ پیوست‌ها/ایجنت/مهارت‌ها و ارسال مجدد با مکانیزم revert خود هسته. در صورت خطا، متن ویرایش‌شده حفظ می‌شود و امکان بازگرداندن پیام اصلی وجود دارد.
- **بررسی به‌روزرسانی موتور:** بررسی نسخه از npm registry، نمایش «آپدیت در دسترس است» همراه با نسخهٔ فعلی و جدید، بررسی اجباری و مسیر نصب/راه‌اندازی مجدد سرویس.
- **چرخ‌دندهٔ تنظیمات:** دکمهٔ تنظیمات در کارت پایین سایدبار برای باز کردن مستقیم پنل تنظیمات.
- **نمایش شفاف تشخیص خودکار پرووایدر:** پرووایدرهای `activation: auto` با برچسب «در دسترس (تشخیص خودکار)» و اتصال‌های محیطی با برچسب «از محیط موتور» نمایش داده می‌شوند؛ همراه با هشدار که وجود کلید به معنای معتبر بودن آن نیست.

### بهبود

- نمایش بنر **تلاش مجدد خودکار** با شمارهٔ تلاش، پیام خطا و لینک اقدام پیشنهادی موتور.
- اعتبارسنجی فیلدهای الزامی و مقدارهای پیش‌فرض در فرم‌های تعاملی؛ جلوگیری از ارسال پاسخ ناقص.
- جلوگیری از باقی‌ماندن یا نشستن فرم‌های کهنه روی نشست جدید هنگام تغییر سریع جلسه.
- بازگرداندن کارت permission/form در صورت شکست درخواست پاسخ، تا کاربر دوباره بتواند تصمیم بگیرد.
- توقف کامل ارسال در صورت شکست آپلود تصویر؛ متن و پیوست‌ها در Composer باقی می‌مانند.
- نمایش خطای ذخیرهٔ shell در تنظیمات به‌جای نادیده‌گرفتن خطا.
- پیام موفقیت سبز برای export و undo، و اصلاح دانلود فایل Markdown (لغو دیرهنگام blob URL).
- اصلاح رندر code blockهای تک‌خطی و fenceهای بدون زبان؛ کد inline دیگر به‌اشتباه block نمی‌شود.
- نمایش پیام خطای شفاف‌تر برای وضعیت retry و مدیریت بهتر رویدادهای SSE پس از قطع/وصل.

### امنیت

- سخت‌سازی سرور محلی: اتصال فقط به loopback، allowlist برای Host، بررسی Origin و `Sec-Fetch-Site`، الزام JSON برای درخواست‌های تغییردهنده و هدر اختصاصی برای عملیات حساس update/restart.
- افزودن CSP، `X-Content-Type-Options: nosniff`، `X-Frame-Options: DENY`، `Referrer-Policy` و `Cross-Origin-Resource-Policy`.
- محدودیت اندازه برای بدنهٔ درخواست‌های API، تنظیمات و آپلود (413) و جلوگیری از مصرف بی‌رویهٔ حافظه.
- حفظ ساختار JSONC هنگام نوشتن تنظیمات OpenCode و حذف امن کلیدهای حذف‌شده.
- هیچ توکن یا کلید API به مرورگر ارسال نمی‌شود؛ دسترسی به موتور از طریق پروکسی احراز هویت‌شدهٔ سرور محلی انجام می‌شود.

### نصب و ارتقا

- بستهٔ ریلیز این نسخه **فقط سورس تمیز** است: بدون `node_modules`، `dist`، لاگ، کش یا اطلاعات محلی.
- برای ارتقا از نسخهٔ قبلی:

```bash
npm install
npm run build
npm run start
```

- یا فایل سورس را از حالت فشرده خارج کن و `Start OpenCode Chat.cmd` را اجرا کن؛ اولین اجرا وابستگی‌ها را نصب و برنامه را بیلد می‌کند.

### سازگاری

- OpenCode core v2.2.5 آزمایش شده است.
- Node.js 20+.
- Windows، Linux و macOS (لانچر دابل‌کلیکی برای Windows است).
