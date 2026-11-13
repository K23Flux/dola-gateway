// Request ledger for the dashboard. Entries carry no prompts and no
// cookies: key name, model, account id, status, latency and estimated
// tokens only. Kept in memory for the UI and appended to a JSONL file.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { join } from "node:path"

export function createLog({ dataDir, maxMemory = 500, maxBytes = 5 * 1024 * 1024 } = {}) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const file = join(dataDir, "requests.jsonl")
  const entries = []

  function load() {
    if (!existsSync(file)) return
    let text = ""
    try {
      if (statSync(file).size > maxBytes) {
        // too big to replay; start the in-memory view empty, the file
        // rotates on the next write
        return
      }
      text = readFileSync(file, "utf8")
    } catch {
      return
    }
    const lines = text.split("\n").filter(Boolean).slice(-maxMemory)
    for (const line of lines) {
      try {
        const e = JSON.parse(line)
        if (e && typeof e === "object") entries.push(e)
      } catch {}
    }
  }

  function rotate() {
    try {
      if (!existsSync(file) || statSync(file).size <= maxBytes) return
      const old = file + ".1"
      rmSync(old, { force: true })
      renameSync(file, old)
    } catch {}
  }

  function append(entry) {
    try {
      rotate()
      appendFileSync(file, JSON.stringify(entry) + "\n", { mode: 0o600 })
    } catch {}
  }

  function record(data = {}) {
    const entry = {
      id: "req_" + randomUUID().replace(/-/g, "").slice(0, 10),
      ts: new Date().toISOString(),
      key: "",
      model: "",
      account: "",
      status: 200,
      durationMs: 0,
      promptTokens: 0,
      completionTokens: 0,
      error: "",
      ...data,
    }
    entries.push(entry)
    if (entries.length > maxMemory) entries.splice(0, entries.length - maxMemory)
    append(entry)
    return entry
  }

  function list({ limit = 100, status = "", model = "", key = "" } = {}) {
    let out = entries.slice().reverse()
    if (status === "ok") out = out.filter((e) => Number(e.status) < 400)
    else if (status === "error") out = out.filter((e) => Number(e.status) >= 400)
    if (model) out = out.filter((e) => e.model === model)
    if (key) out = out.filter((e) => e.key === key)
    return out.slice(0, Math.max(1, Math.min(1000, Number(limit) || 100)))
  }

  const localDay = (d) => {
    const x = new Date(d)
    return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`
  }

  function stats(now = new Date()) {
    const today = localDay(now)
    const todayEntries = entries.filter((e) => localDay(e.ts) === today)
    const success = todayEntries.filter((e) => Number(e.status) < 400).length
    const latency = todayEntries.map((e) => Number(e.durationMs) || 0)
    const hourly = Array(24).fill(0)
    const models = new Map()
    for (const e of todayEntries) {
      const h = new Date(e.ts).getHours()
      if (h >= 0 && h < 24) hourly[h]++
      const m = e.model || "unknown"
      models.set(m, (models.get(m) || 0) + 1)
    }
    return {
      requestsToday: todayEntries.length,
      successToday: success,
      failureToday: todayEntries.length - success,
      successRate: todayEntries.length ? success / todayEntries.length : 0,
      avgLatencyMs: latency.length ? Math.round(latency.reduce((a, b) => a + b, 0) / latency.length) : 0,
      hourly,
      models: [...models].map(([id, count]) => ({ id, count })).sort((a, b) => b.count - a.count),
      recent: entries.slice(-10).reverse(),
    }
  }

  load()

  return { record, list, stats, entries, file }
}
