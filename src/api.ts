const BASE = "/oc"

export async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  })
  const text = await res.text()
  let data: any = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  if (!res.ok) {
    throw new Error(errorMessage(data, res.status))
  }
  return data as T
}

// بدنهٔ خطای موتور OpenCode معمولاً {_tag, message} است؛ بعضی خطاها فقط _tag
// دارند و بعضی پاسخ‌ها بدنهٔ خالی. زنجیرهٔ fallback نباید به «HTTP 500» بی‌معنا برسد.
function errorMessage(data: any, status: number) {
  const candidates = [data?.message, data?.error, data?.name, data?._tag]
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate
  }
  return `HTTP ${status}`
}

export const get = <T = any>(path: string) => api<T>(path)
export const post = <T = any>(path: string, body?: any) =>
  api<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) })
export const patch = <T = any>(path: string, body?: any) =>
  api<T>(path, { method: "PATCH", body: body === undefined ? undefined : JSON.stringify(body) })
export const del = <T = any>(path: string) => api<T>(path, { method: "DELETE" })

export async function appApi<T = any>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init)
  const text = await res.text()
  let data: any = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  if (!res.ok) {
    throw new Error(errorMessage(data, res.status))
  }
  return data as T
}
export const appGet = <T = any>(path: string) => appApi<T>(path)
export const appPost = <T = any>(path: string, body?: any) =>
  appApi<T>(path, {
    method: "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
