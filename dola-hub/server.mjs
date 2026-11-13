// Dola Hub: a standalone OpenAI-compatible gateway for dola.com with a
// web dashboard, account pool, rotation, API keys and request ledger.
//
//   node server.mjs
//   PORT=8788 HOST=127.0.0.1 PANEL_PASSWORD=... node server.mjs
//
// The panel binds to 127.0.0.1 by default. If you put it on a public
// address, set a strong PANEL_PASSWORD and terminate TLS in front of it.

import { createServer } from "node:http"
import { createHash, randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { createStore } from "./lib/store.mjs"
import { createPool } from "./lib/pool.mjs"
import { createLog } from "./lib/log.mjs"
import { createAuth } from "./lib/auth.mjs"
import { createGateway, HubError } from "./lib/gateway.mjs"
import { createModelCatalog } from "./lib/models.mjs"
import { createDesktopBackend } from "./lib/desktop.mjs"
import {
  accountInfo,
  cookieValue,
  hasSession,
  normalizeCookie,
  streamCompletion,
} from "../packages/dola/dola.mjs"
import { LOGIN_URL, openLoginBrowser } from "../packages/dola/browser.mjs"

const HUB_DIR = fileURLToPath(new URL(".", import.meta.url))
const PUBLIC_DIR = join(HUB_DIR, "public")
const DATA_DIR = process.env.DOLA_HUB_DATA || join(HUB_DIR, "data")
const argv = process.argv.slice(2)
const argOf = (name) => {
  const at = argv.indexOf(name)
  return at >= 0 ? argv[at + 1] : ""
}
const HOST = process.env.HOST || argOf("--host") || "127.0.0.1"
const PORT = Number(process.env.PORT) || Number(argOf("--port")) || 8788
const VERSION = "0.1.0"
const BODY_LIMIT = 16 * 1024 * 1024

const store = createStore({ dataDir: DATA_DIR })
const pool = createPool({ store })
const log = createLog({ dataDir: DATA_DIR })
const auth = createAuth({ store })
const desktop = createDesktopBackend()
const catalog = createModelCatalog({ desktop })
const gateway = createGateway({ store, pool, log, catalog, desktop })

const createdKey = store.ensureDefaultKey()
const startedAt = Date.now()
const browserLogins = new Map()
const loginAttempts = new Map()

// ---- helpers ------------------------------------------------------------

function baseHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff")
  res.setHeader("Referrer-Policy", "no-referrer")
  res.setHeader("X-Frame-Options", "DENY")
}

function sendJson(res, status, body, extra = {}) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
    ...extra,
  })
  res.end(text)
}

function sendError(res, status, message, type = "hub_error") {
  sendJson(res, status, { error: { message: String(message).slice(0, 1000), type } })
}

function readJson(req, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on("data", (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new HubError(`request body is larger than ${limit} bytes`, 413, "payload_too_large"))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8")
        resolve(text ? JSON.parse(text) : {})
      } catch {
        reject(new HubError("request body is not JSON", 400, "invalid_request_error"))
      }
    })
    req.on("error", reject)
  })
}

function requirePanel(req, res) {
  const session = auth.check(req)
  if (!session) {
    sendError(res, 401, "panel login required", "unauthorized")
    return null
  }
  return session
}

function accountIdOf(cookie, info) {
  const sec = cookieValue(cookie, "flow_cur_user_sec_id")
  return (
    (info?.accountId && info.accountId !== "0" ? info.accountId : "") ||
    (sec && sec !== "0" ? sec : "") ||
    "dola-" + createHash("sha256").update(cookie).digest("hex").slice(0, 12)
  )
}

async function signInCookie(cookie, name = "") {
  const clean = normalizeCookie(cookie)
  if (!hasSession(clean)) throw new HubError("Cookie 里没有 sessionid 或 oauth_token", 400, "invalid_cookie")
  const info = await accountInfo({ cookie: clean })
  if (info.lapsed) throw new HubError("Dola 不认这串 Cookie，登录可能已过期", 400, "cookie_expired")
  const accountId = accountIdOf(clean, info)
  const { account, created } = store.addAccount({
    cookie: clean,
    accountId,
    name: String(name || info.name || "").trim(),
  })
  return { account: store.summarizeAccount(account), created }
}

function accountsWithRuntime() {
  const snap = pool.snapshot()
  return store.state.accounts.map((a) => ({
    ...store.summarizeAccount(a),
    ...(snap[a.id] || { inflight: 0, cooldownUntil: 0 }),
  }))
}

function publicSettings() {
  return {
    ...store.state.settings,
    server: {
      host: HOST,
      port: PORT,
      baseUrl: `http://${HOST === "0.0.0.0" ? "<this-machine-ip>" : HOST}:${PORT}/v1`,
      dataDir: DATA_DIR,
      defaultPassword: store.isDefaultPassword(),
      version: VERSION,
    },
  }
}

function startBrowserLogin() {
  return openLoginBrowser({ url: LOGIN_URL }).then((session) => {
    const id = "login_" + randomUUID().replace(/-/g, "").slice(0, 10)
    const entry = { id, status: "waiting", error: "", account: null, createdAt: Date.now() }
    browserLogins.set(id, entry)
    ;(async () => {
      try {
        const cookie = await session.cookies(5 * 60 * 1000)
        if (!cookie) throw new Error("五分钟内没有读到登录会话，请重新发起并在窗口里完成登录")
        const info = await accountInfo({ cookie })
        if (info.lapsed) throw new Error("Dola 不认这次登录会话，请重新登录")
        const accountId = accountIdOf(cookie, info)
        const { account } = store.addAccount({ cookie, accountId, name: info.name || "" })
        entry.status = "done"
        entry.account = store.summarizeAccount(account)
      } catch (e) {
        entry.status = "failed"
        entry.error = String(e?.message ?? e).slice(0, 500)
      } finally {
        await session.close().catch(() => {})
      }
    })()
    return entry
  })
}

// ---- routes -------------------------------------------------------------

async function handle(req, res) {
  baseHeaders(res)
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`)
  const path = url.pathname

  if (path === "/health") {
    return sendJson(res, 200, {
      ok: true,
      version: VERSION,
      accounts: store.state.accounts.length,
      activeAccounts: pool.activeCount(),
      keys: store.state.keys.length,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    })
  }

  if (path === "/v1" || path.startsWith("/v1/")) {
    const key = auth.keyOf(req)
    if (!key) {
      res.setHeader("Access-Control-Allow-Origin", "*")
      res.setHeader("Access-Control-Allow-Headers", "authorization, content-type, x-session-id")
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
      if (req.method === "OPTIONS") {
        res.writeHead(204)
        return res.end()
      }
      return sendError(res, 401, "invalid or missing API key", "unauthorized")
    }
    return gateway.handle(req, res, key, url)
  }

  if (path === "/api/login" && req.method === "POST") {
    const ip = req.socket.remoteAddress || "unknown"
    const now = Date.now()
    const attempt = loginAttempts.get(ip)
    if (attempt && attempt.resetAt > now && attempt.count >= 10)
      return sendError(res, 429, "尝试次数过多，请一分钟后再试", "rate_limited")
    if (!attempt || attempt.resetAt <= now) loginAttempts.set(ip, { count: 0, resetAt: now + 60_000 })
    const body = await readJson(req).catch((e) => e)
    if (body instanceof Error) return sendError(res, body.status || 400, body.message, body.code)
    const token = auth.login(String(body.password ?? ""))
    if (!token) {
      const e = loginAttempts.get(ip)
      if (e) e.count++
      return sendError(res, 401, "密码不对", "unauthorized")
    }
    loginAttempts.delete(ip)
    res.setHeader("Set-Cookie", auth.cookie(token))
    return sendJson(res, 200, { ok: true, defaultPassword: store.isDefaultPassword() })
  }

  if (path === "/api/logout" && req.method === "POST") {
    const session = auth.check(req)
    if (session) auth.logout(session.token)
    res.setHeader("Set-Cookie", auth.clearCookie())
    return sendJson(res, 200, { ok: true })
  }

  if (path === "/api/session" && req.method === "GET") {
    const session = auth.check(req)
    return sendJson(res, 200, {
      authenticated: Boolean(session),
      defaultPassword: store.isDefaultPassword(),
    })
  }

  // everything below needs a panel session
  if (path.startsWith("/api/")) {
    if (!requirePanel(req, res)) return
  }

  if (path === "/api/overview" && req.method === "GET") {
    const stats = log.stats()
    const accounts = accountsWithRuntime()
    // stale-while-revalidate: answer with the current list and refresh the
    // public bundle in the background (the catalog enforces five minutes)
    catalog.refresh().catch(() => {})
    return sendJson(res, 200, {
      ...stats,
      accounts,
      totalAccounts: accounts.length,
      activeAccounts: pool.activeCount(),
      inflight: accounts.reduce((n, a) => n + (a.inflight || 0), 0),
      settings: store.state.settings,
      models: catalog.currentModels(),
      modelStatus: catalog.snapshot(),
      version: VERSION,
      defaultPassword: store.isDefaultPassword(),
    })
  }

  if (path === "/api/models" && req.method === "GET") {
    const snap = await catalog.refresh()
    return sendJson(res, 200, snap)
  }

  if (path === "/api/models/refresh" && req.method === "POST") {
    const snap = await catalog.refresh()
    return sendJson(res, 200, snap)
  }

  if (path === "/api/models/desktop/refresh" && req.method === "POST") {
    await desktop.refresh()
    return sendJson(res, 200, catalog.snapshot())
  }

  if (path === "/api/accounts" && req.method === "GET") {
    return sendJson(res, 200, { accounts: accountsWithRuntime() })
  }

  if (path === "/api/accounts" && req.method === "POST") {
    const body = await readJson(req).catch((e) => e)
    if (body instanceof Error) return sendError(res, body.status || 400, body.message, body.code)
    try {
      const result = await signInCookie(body.cookie, body.name)
      return sendJson(res, 200, result)
    } catch (e) {
      return sendError(res, e.status || 400, e.message, e.code)
    }
  }

  if (path === "/api/accounts/browser" && req.method === "POST") {
    try {
      const entry = await startBrowserLogin()
      return sendJson(res, 200, { id: entry.id })
    } catch (e) {
      return sendError(res, 400, e?.message ?? e, "browser_unavailable")
    }
  }

  const loginMatch = path.match(/^\/api\/accounts\/browser\/([^/]+)$/)
  if (loginMatch && req.method === "GET") {
    const entry = browserLogins.get(decodeURIComponent(loginMatch[1]))
    if (!entry) return sendError(res, 404, "login session not found", "not_found")
    return sendJson(res, 200, {
      id: entry.id,
      status: entry.status,
      error: entry.error,
      account: entry.account,
    })
  }

  const testMatch = path.match(/^\/api\/accounts\/([^/]+)\/test$/)
  if (testMatch && req.method === "POST") {
    const account = store.findAccount(decodeURIComponent(testMatch[1]))
    if (!account) return sendError(res, 404, "account not found", "not_found")
    try {
      const read = await streamCompletion({
        cookie: account.cookie,
        text: "Reply with the single word: ok",
        deepThink: 0,
        region: store.state.settings.region,
        language: store.state.settings.language,
        botId: store.state.settings.botId,
        signal: AbortSignal.timeout(45000),
      })
      pool.success(account)
      return sendJson(res, 200, { ok: true, reply: String(read.text).slice(0, 160) })
    } catch (e) {
      pool.failure(account, e)
      return sendJson(res, 200, { ok: false, error: String(e?.message ?? e).slice(0, 300) })
    }
  }

  const accountMatch = path.match(/^\/api\/accounts\/([^/]+)$/)
  if (accountMatch) {
    const id = decodeURIComponent(accountMatch[1])
    if (req.method === "PATCH") {
      const body = await readJson(req).catch((e) => e)
      if (body instanceof Error) return sendError(res, body.status || 400, body.message, body.code)
      const account = store.updateAccount(id, body)
      if (!account) return sendError(res, 404, "account not found", "not_found")
      if (body.enabled === true) pool.clearCooldown(id)
      return sendJson(res, 200, { account: store.summarizeAccount(account) })
    }
    if (req.method === "DELETE") {
      if (!store.removeAccount(id)) return sendError(res, 404, "account not found", "not_found")
      return sendJson(res, 200, { ok: true })
    }
  }

  if (path === "/api/requests" && req.method === "GET") {
    return sendJson(res, 200, {
      requests: log.list({
        limit: url.searchParams.get("limit") || 100,
        status: url.searchParams.get("status") || "",
        model: url.searchParams.get("model") || "",
        key: url.searchParams.get("key") || "",
      }),
    })
  }

  if (path === "/api/keys" && req.method === "GET") {
    return sendJson(res, 200, { keys: store.publicKeys() })
  }

  if (path === "/api/keys" && req.method === "POST") {
    const body = await readJson(req).catch((e) => e)
    if (body instanceof Error) return sendError(res, body.status || 400, body.message, body.code)
    return sendJson(res, 200, { key: store.addKey({ name: body.name, models: body.models }) })
  }

  const keyMatch = path.match(/^\/api\/keys\/([^/]+)$/)
  if (keyMatch) {
    const id = decodeURIComponent(keyMatch[1])
    if (req.method === "PATCH") {
      const body = await readJson(req).catch((e) => e)
      if (body instanceof Error) return sendError(res, body.status || 400, body.message, body.code)
      const key = store.updateKey(id, body)
      if (!key) return sendError(res, 404, "key not found", "not_found")
      return sendJson(res, 200, { key: { id: key.id, name: key.name, models: key.models, enabled: key.enabled } })
    }
    if (req.method === "DELETE") {
      if (!store.removeKey(id)) return sendError(res, 404, "key not found", "not_found")
      return sendJson(res, 200, { ok: true })
    }
  }

  if (path === "/api/settings" && req.method === "GET") {
    return sendJson(res, 200, publicSettings())
  }

  if (path === "/api/settings" && req.method === "PUT") {
    const body = await readJson(req).catch((e) => e)
    if (body instanceof Error) return sendError(res, body.status || 400, body.message, body.code)
    try {
      const settings = store.updateSettings(body)
      return sendJson(res, 200, { settings })
    } catch (e) {
      return sendError(res, 400, e.message, "invalid_settings")
    }
  }

  if (path === "/api/password" && req.method === "POST") {
    const body = await readJson(req).catch((e) => e)
    if (body instanceof Error) return sendError(res, body.status || 400, body.message, body.code)
    if (!store.verifyPassword(String(body.current ?? "")))
      return sendError(res, 401, "当前密码不对", "unauthorized")
    const next = String(body.next ?? "")
    if (next.length < 6) return sendError(res, 400, "新密码至少 6 位", "invalid_password")
    store.setPassword(next)
    return sendJson(res, 200, { ok: true })
  }

  if (path === "/api/stats/reset" && req.method === "POST") {
    store.resetStats()
    return sendJson(res, 200, { ok: true })
  }

  if (path === "/" || path === "/index.html") {
    try {
      const html = readFileSync(join(PUBLIC_DIR, "index.html"))
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-cache",
        "content-security-policy":
          "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
      })
      return res.end(html)
    } catch (e) {
      return sendError(res, 500, "dashboard is missing: " + e.message, "internal_error")
    }
  }

  if (path === "/favicon.ico") {
    res.writeHead(204)
    return res.end()
  }

  sendError(res, 404, "not found", "not_found")
}

// ---- server -------------------------------------------------------------

const server = createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error("[dola-hub]", e)
    if (!res.headersSent) sendError(res, Number(e?.status) || 500, e?.message ?? "internal error", e?.code ?? "internal_error")
    else {
      try {
        res.end()
      } catch {}
    }
  })
})

const cleanup = setInterval(() => {
  auth.cleanup()
  const at = Date.now()
  for (const [id, entry] of browserLogins) if (at - entry.createdAt > 10 * 60 * 1000) browserLogins.delete(id)
  for (const [ip, entry] of loginAttempts) if (entry.resetAt <= at) loginAttempts.delete(ip)
}, 10 * 60 * 1000)
cleanup.unref()

server.listen(PORT, HOST, () => {
  console.log(`Dola Hub v${VERSION}`)
  console.log(`  panel: http://${HOST === "0.0.0.0" ? "127.0.0.1" : HOST}:${PORT}/`)
  console.log(`  api:   http://${HOST === "0.0.0.0" ? "<this-machine-ip>" : HOST}:${PORT}/v1`)
  console.log(`  data:  ${DATA_DIR}`)
  const ds = desktop.current()
  console.log(`  desktop: ${ds.available ? ds.app.app || ds.app.binary : "not found (web models only)"}`)
  if (createdKey) console.log(`  created API key "${createdKey.name}": ${createdKey.key}`)
  if (store.isDefaultPassword()) console.warn(`  panel password is still "admin"; change it in Settings`)
  if (HOST === "0.0.0.0") console.warn(`  listening on all interfaces; put it behind TLS and a strong panel password`)
})

function shutdown() {
  console.log("\n[dola-hub] saving state and stopping")
  store.flush()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 1500).unref()
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
