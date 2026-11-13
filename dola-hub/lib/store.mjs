// State for the Dola hub: accounts, API keys, settings and the panel
// password. One JSON file, written atomically, mode 600. Cookies live only
// here and are never sent back by the panel API.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto"
import { join } from "node:path"

export const DEFAULT_SETTINGS = {
  strategy: "round_robin",
  maxAttempts: 3,
  cooldownSeconds: 60,
  stickyTtlSeconds: 1800,
  region: "AU",
  language: "en",
  botId: "7339470689562525703",
  maxConcurrencyPerAccount: 2,
}

const STRATEGIES = new Set(["round_robin", "least_inflight", "random", "priority"])
const nowIso = () => new Date().toISOString()

function hashPassword(password, salt) {
  return scryptSync(String(password), salt, 64).toString("hex")
}

function sameSecret(a, b) {
  const x = Buffer.from(String(a))
  const y = Buffer.from(String(b))
  return x.length === y.length && timingSafeEqual(x, y)
}

export function createStore({ dataDir, env = process.env } = {}) {
  if (!dataDir) throw new Error("createStore needs dataDir")
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const file = join(dataDir, "state.json")

  let state
  let timer = null
  let loaded = false

  function fresh(initialPassword) {
    const salt = randomBytes(16).toString("hex")
    return {
      version: 1,
      panel: {
        salt,
        hash: hashPassword(initialPassword, salt),
        default: initialPassword === "admin",
      },
      settings: { ...DEFAULT_SETTINGS },
      accounts: [],
      keys: [],
    }
  }

  function load() {
    if (existsSync(file)) {
      const text = readFileSync(file, "utf8")
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch (e) {
        throw new Error(`data/state.json is not JSON (${e.message}); fix or move it before starting`)
      }
      if (!parsed || typeof parsed !== "object") throw new Error("data/state.json is not an object")
      state = {
        version: 1,
        panel: parsed.panel && typeof parsed.panel === "object" ? parsed.panel : fresh("admin").panel,
        settings: { ...DEFAULT_SETTINGS, ...(parsed.settings && typeof parsed.settings === "object" ? parsed.settings : {}) },
        accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [],
        keys: Array.isArray(parsed.keys) ? parsed.keys : [],
      }
    } else {
      state = fresh(env.PANEL_PASSWORD || "admin")
      saveNow()
    }
    loaded = true
  }

  function saveNow() {
    const text = JSON.stringify(state, null, 2)
    const tmp = file + ".tmp"
    writeFileSync(tmp, text, { mode: 0o600 })
    try {
      chmodSync(tmp, 0o600)
    } catch {}
    renameSync(tmp, file)
    try {
      chmodSync(file, 0o600)
    } catch {}
  }

  function save() {
    if (!loaded) return
    clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      try {
        saveNow()
      } catch (e) {
        console.error("could not save data/state.json:", e.message)
      }
    }, 120)
    timer.unref?.()
  }

  function flush() {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (loaded) saveNow()
  }

  load()

  function verifyPassword(password) {
    if (!state.panel?.salt || !state.panel?.hash) return false
    return sameSecret(hashPassword(password, state.panel.salt), state.panel.hash)
  }

  function setPassword(password) {
    const salt = randomBytes(16).toString("hex")
    state.panel = { salt, hash: hashPassword(password, salt), default: password === "admin" }
    save()
  }

  function isDefaultPassword() {
    return state.panel?.default === true
  }

  function ensureDefaultKey() {
    if (state.keys.length) return null
    const key = addKey({ name: "default", models: [] })
    return key
  }

  function summarizeAccount(a) {
    return {
      id: a.id,
      accountId: a.accountId,
      name: a.name || a.accountId,
      enabled: a.enabled !== false,
      priority: Number(a.priority) || 100,
      weight: Number(a.weight) || 1,
      maxConcurrency: Number(a.maxConcurrency) || state.settings.maxConcurrencyPerAccount,
      createdAt: a.createdAt || "",
      updatedAt: a.updatedAt || "",
      lastUsedAt: a.lastUsedAt || null,
      invalid: a.invalid === true,
      cooldownUntil: Number(a.cooldownUntil) || 0,
      note: a.note || "",
      stats: {
        requests: Number(a.stats?.requests) || 0,
        success: Number(a.stats?.success) || 0,
        failure: Number(a.stats?.failure) || 0,
      },
    }
  }

  function addAccount({ cookie, accountId, name = "", note = "" }) {
    const at = nowIso()
    const existing = state.accounts.find((a) => a.accountId === accountId)
    if (existing) {
      existing.cookie = cookie
      if (name) existing.name = name
      if (note) existing.note = note
      existing.invalid = false
      existing.cooldownUntil = 0
      existing.enabled = true
      existing.updatedAt = at
      save()
      return { account: existing, created: false }
    }
    const account = {
      id: "acc_" + randomUUID().replace(/-/g, "").slice(0, 10),
      accountId,
      name: name || accountId,
      cookie,
      enabled: true,
      priority: 100,
      weight: 1,
      maxConcurrency: state.settings.maxConcurrencyPerAccount,
      createdAt: at,
      updatedAt: at,
      lastUsedAt: null,
      invalid: false,
      cooldownUntil: 0,
      note,
      stats: { requests: 0, success: 0, failure: 0 },
    }
    state.accounts.push(account)
    save()
    return { account, created: true }
  }

  function findAccount(id) {
    return state.accounts.find((a) => a.id === id) || null
  }

  function updateAccount(id, patch = {}) {
    const a = findAccount(id)
    if (!a) return null
    if (typeof patch.name === "string") a.name = patch.name.trim().slice(0, 80)
    if (typeof patch.note === "string") a.note = patch.note.trim().slice(0, 200)
    if (typeof patch.enabled === "boolean") a.enabled = patch.enabled
    if (patch.priority != null) a.priority = clampInt(patch.priority, 1, 999, 100)
    if (patch.weight != null) a.weight = clampInt(patch.weight, 1, 100, 1)
    if (patch.maxConcurrency != null) a.maxConcurrency = clampInt(patch.maxConcurrency, 1, 50, state.settings.maxConcurrencyPerAccount)
    a.updatedAt = nowIso()
    save()
    return a
  }

  function removeAccount(id) {
    const at = state.accounts.findIndex((a) => a.id === id)
    if (at < 0) return false
    state.accounts.splice(at, 1)
    save()
    return true
  }

  function addKey({ name = "key", models = [] } = {}) {
    const key = {
      id: "key_" + randomUUID().replace(/-/g, "").slice(0, 10),
      name: String(name || "key").trim().slice(0, 60) || "key",
      key: "sk-dola-" + randomBytes(24).toString("hex"),
      models: Array.isArray(models) ? models.map((m) => String(m).trim()).filter(Boolean).slice(0, 50) : [],
      enabled: true,
      createdAt: nowIso(),
      stats: { requests: 0, success: 0, failure: 0 },
    }
    state.keys.push(key)
    save()
    return key
  }

  function findKey(token) {
    if (!token) return null
    return state.keys.find((k) => k.enabled !== false && sameSecret(k.key, token)) || null
  }

  function findKeyById(id) {
    return state.keys.find((k) => k.id === id) || null
  }

  function updateKey(id, patch = {}) {
    const k = findKeyById(id)
    if (!k) return null
    if (typeof patch.name === "string") k.name = patch.name.trim().slice(0, 60) || k.name
    if (typeof patch.enabled === "boolean") k.enabled = patch.enabled
    if (Array.isArray(patch.models)) k.models = patch.models.map((m) => String(m).trim()).filter(Boolean).slice(0, 50)
    save()
    return k
  }

  function removeKey(id) {
    const at = state.keys.findIndex((k) => k.id === id)
    if (at < 0) return false
    state.keys.splice(at, 1)
    save()
    return true
  }

  function updateSettings(patch = {}) {
    const next = { ...state.settings }
    if (patch.strategy != null) {
      if (!STRATEGIES.has(patch.strategy)) throw new Error("strategy is not one of round_robin, least_inflight, random, priority")
      next.strategy = patch.strategy
    }
    if (patch.maxAttempts != null) next.maxAttempts = clampInt(patch.maxAttempts, 1, 10, 3)
    if (patch.cooldownSeconds != null) next.cooldownSeconds = clampInt(patch.cooldownSeconds, 5, 3600, 60)
    if (patch.stickyTtlSeconds != null) next.stickyTtlSeconds = clampInt(patch.stickyTtlSeconds, 0, 86400, 1800)
    if (patch.region != null) next.region = String(patch.region).trim().toUpperCase().slice(0, 8) || "AU"
    if (patch.language != null) next.language = String(patch.language).trim().slice(0, 16) || "en"
    if (patch.botId != null) next.botId = String(patch.botId).trim().slice(0, 40) || DEFAULT_SETTINGS.botId
    if (patch.maxConcurrencyPerAccount != null)
      next.maxConcurrencyPerAccount = clampInt(patch.maxConcurrencyPerAccount, 1, 50, 2)
    state.settings = next
    save()
    return next
  }

  function resetStats() {
    for (const a of state.accounts) a.stats = { requests: 0, success: 0, failure: 0 }
    for (const k of state.keys) k.stats = { requests: 0, success: 0, failure: 0 }
    save()
  }

  function publicKeys() {
    return state.keys.map((k) => ({
      id: k.id,
      name: k.name,
      key: k.key,
      models: k.models,
      enabled: k.enabled !== false,
      createdAt: k.createdAt,
      stats: k.stats,
    }))
  }

  return {
    get state() {
      return state
    },
    get file() {
      return file
    },
    get dataDir() {
      return dataDir
    },
    verifyPassword,
    setPassword,
    isDefaultPassword,
    ensureDefaultKey,
    summarizeAccount,
    addAccount,
    findAccount,
    updateAccount,
    removeAccount,
    addKey,
    findKey,
    findKeyById,
    updateKey,
    removeKey,
    publicKeys,
    updateSettings,
    resetStats,
    save,
    flush,
  }
}

function clampInt(value, min, max, fallback) {
  const n = Math.trunc(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}
