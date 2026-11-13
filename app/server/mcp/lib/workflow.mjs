import fsp from "node:fs/promises"
import path from "node:path"
import { STATE_FILE, ToolError, delay, ensureDir, nowIso, parseBool, readJson, truncate, writeJson } from "./core.mjs"

let stateQueue = Promise.resolve()
const schedules = new Map()

async function withLock(fn) {
  const next = stateQueue.then(fn, fn)
  stateQueue = next.catch(() => {})
  return next
}

async function loadState() {
  const data = await readJson(STATE_FILE, null)
  if (!data || typeof data !== "object") return { version: 1, tasks: [], plans: [], schedules: [] }
  return { version: 1, tasks: data.tasks || [], plans: data.plans || [], schedules: data.schedules || [] }
}

async function saveState(data) {
  await ensureDir(path.dirname(STATE_FILE))
  await writeJson(STATE_FILE, data)
}

function taskId() {
  return `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
}

export async function workflowAction(args, ctx) {
  return await withLock(async () => {
    const data = await loadState()
    const action = args.action || "list"

    if (action === "task_add" || action === "add") {
      const title = String(args.title || args.text || "").trim()
      if (!title) throw new ToolError("title is required", "BAD_INPUT")
      const task = {
        id: taskId(),
        title,
        status: args.status || "pending",
        priority: args.priority || "medium",
        notes: String(args.notes || ""),
        due: args.due || null,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      }
      data.tasks.push(task)
      await saveState(data)
      return { task, total: data.tasks.length }
    }

    if (action === "task_list" || action === "list") {
      const status = args.status ? String(args.status) : null
      const tasks = data.tasks.filter((task) => !status || task.status === status)
      return { tasks: tasks.slice(0, Math.max(1, Math.min(500, Number(args.limit || 100)))), total: tasks.length }
    }

    if (action === "task_update" || action === "update") {
      const task = data.tasks.find((item) => item.id === args.id)
      if (!task) throw new ToolError(`task not found: ${args.id}`, "NOT_FOUND")
      for (const key of ["title", "status", "priority", "notes", "due"]) {
        if (args[key] !== undefined) task[key] = args[key]
      }
      task.updatedAt = nowIso()
      await saveState(data)
      return { task }
    }

    if (action === "task_delete" || action === "delete") {
      const before = data.tasks.length
      data.tasks = data.tasks.filter((task) => task.id !== args.id)
      if (data.tasks.length === before) throw new ToolError(`task not found: ${args.id}`, "NOT_FOUND")
      await saveState(data)
      return { deleted: args.id, total: data.tasks.length }
    }

    if (action === "plan") {
      const title = String(args.title || "Plan").trim()
      const steps = Array.isArray(args.steps) ? args.steps.map((step, index) => (typeof step === "string" ? { id: index + 1, title: step, status: "pending" } : { id: step.id || index + 1, title: step.title || step.text || "", tool: step.tool, args: step.args, status: step.status || "pending" })) : []
      const plan = { id: `plan_${Date.now().toString(36)}`, title, goal: args.text || args.goal || "", steps, createdAt: nowIso(), updatedAt: nowIso() }
      data.plans.push(plan)
      await saveState(data)
      return { plan }
    }

    if (action === "plan_list") {
      return { plans: data.plans.slice(-50).reverse() }
    }

    if (action === "plan_update") {
      const plan = data.plans.find((item) => item.id === args.id)
      if (!plan) throw new ToolError(`plan not found: ${args.id}`, "NOT_FOUND")
      if (args.steps) plan.steps = args.steps
      if (args.title) plan.title = args.title
      if (args.status) plan.status = args.status
      plan.updatedAt = nowIso()
      await saveState(data)
      return { plan }
    }

    if (action === "run" || action === "workflow") {
      if (!ctx?.callTool) throw new ToolError("workflow dispatcher is unavailable", "INTERNAL")
      let steps = args.steps
      if (typeof steps === "string") {
        try {
          steps = JSON.parse(steps)
        } catch {
          throw new ToolError("steps must be a JSON array", "BAD_INPUT")
        }
      }
      if (!Array.isArray(steps) || !steps.length) throw new ToolError("steps are required", "BAD_INPUT")
      const parallel = parseBool(args.parallel, false) || args.mode === "parallel"
      const retries = Math.max(0, Math.min(5, Number(args.retries || 0)))
      const timeout = Math.max(1000, Math.min(110_000, Number(args.timeout || 110_000)))
      const results = []
      const runStep = async (step, index) => {
        const tool = String(step.tool || step.name || "")
        const toolArgs = step.args && typeof step.args === "object" ? step.args : step.params || {}
        if (!tool) throw new ToolError(`step ${index + 1} has no tool`, "BAD_INPUT")
        let attempt = 0
        while (true) {
          attempt += 1
          try {
            const started = Date.now()
            const result = await Promise.race([
              ctx.callTool(tool, toolArgs),
              new Promise((_, reject) => setTimeout(() => reject(new ToolError(`step ${index + 1} timed out`, "TIMEOUT")), timeout)),
            ])
            return { index: index + 1, tool, ok: !result?.isError, ms: Date.now() - started, result }
          } catch (error) {
            if (attempt > retries) return { index: index + 1, tool, ok: false, attempts: attempt, error: String(error?.message ?? error) }
            await delay(300 * attempt)
          }
        }
      }
      if (parallel) {
        const settled = await Promise.all(steps.map(runStep))
        results.push(...settled)
      } else {
        for (let index = 0; index < steps.length; index++) {
          const result = await runStep(steps[index], index)
          results.push(result)
          if (!result.ok && parseBool(args.stopOnError, true)) break
        }
      }
      return { mode: parallel ? "parallel" : "sequential", results: results.map((row) => ({ ...row, result: row.result ? summarizeResult(row.result) : undefined })), ok: results.every((row) => row.ok) }
    }

    if (action === "schedule_add" || action === "cron_add") {
      const intervalMinutes = Math.max(1, Number(args.intervalMinutes || args.minutes || 60))
      if (!Array.isArray(args.steps) || !args.steps.length) throw new ToolError("steps are required", "BAD_INPUT")
      const schedule = { id: `job_${Date.now().toString(36)}`, title: args.title || "Scheduled workflow", intervalMinutes, steps: args.steps, enabled: true, createdAt: nowIso(), lastRun: null, nextRun: Date.now() + intervalMinutes * 60_000 }
      data.schedules.push(schedule)
      await saveState(data)
      installSchedule(schedule, ctx)
      return { schedule }
    }

    if (action === "schedule_list" || action === "cron_list") {
      return { schedules: data.schedules }
    }

    if (action === "schedule_delete" || action === "cron_delete") {
      const timer = schedules.get(String(args.id))
      if (timer) clearInterval(timer)
      schedules.delete(String(args.id))
      const before = data.schedules.length
      data.schedules = data.schedules.filter((item) => item.id !== args.id)
      if (data.schedules.length === before) throw new ToolError(`schedule not found: ${args.id}`, "NOT_FOUND")
      await saveState(data)
      return { deleted: args.id }
    }

    if (action === "state") {
      return { tasks: data.tasks.length, plans: data.plans.length, schedules: data.schedules.length, path: STATE_FILE }
    }

    throw new ToolError(`unknown workflow action: ${action}`, "BAD_INPUT")
  })
}

function summarizeResult(result) {
  const content = Array.isArray(result?.content) ? result.content : []
  const text = content.filter((part) => part.type === "text").map((part) => part.text).join("\n")
  return truncate(text, 4000)
}

export function installSchedule(schedule, ctx) {
  if (!schedule?.id || !ctx?.callTool) return
  const old = schedules.get(schedule.id)
  if (old) clearInterval(old)
  const timer = setInterval(async () => {
    try {
      await workflowAction({ action: "run", steps: schedule.steps, stopOnError: false }, ctx)
      const data = await loadState()
      const row = data.schedules.find((item) => item.id === schedule.id)
      if (row) {
        row.lastRun = nowIso()
        row.nextRun = Date.now() + row.intervalMinutes * 60_000
        await saveState(data)
      }
    } catch (error) {
      console.error(`[opencode-chat-tools] schedule ${schedule.id} failed:`, error?.message ?? error)
    }
  }, Math.max(60_000, Number(schedule.intervalMinutes || 60) * 60_000))
  timer.unref?.()
  schedules.set(schedule.id, timer)
}

export async function restoreSchedules(ctx) {
  const data = await loadState()
  for (const schedule of data.schedules.filter((item) => item.enabled !== false)) installSchedule(schedule, ctx)
}
