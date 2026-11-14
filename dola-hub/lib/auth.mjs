// Panel sessions and gateway API keys. Sessions are in memory (a restart
// signs the browser out); API keys live in the store.

import { randomBytes } from "node:crypto"

export function parseCookies(header = "") {
  const out = {}
  for (const part of String(header).split(";")) {
    const at = part.indexOf("=")
    if (at < 0) continue
    const k = part.slice(0, at).trim()
    const v = part.slice(at + 1).trim()
    if (!k) continue
    try {
      out[k] = decodeURIComponent(v)
    } catch {
      out[k] = v
    }
  }
  return out
}

export function createAuth({ store, ttlMs = 7 * 24 * 60 * 60 * 1000 } = {}) {
  const sessions = new Map()

  function login(password) {
    if (!store.verifyPassword(password)) return null
    const token = randomBytes(32).toString("hex")
    sessions.set(token, { expires: Date.now() + ttlMs, createdAt: Date.now() })
    return token
  }

  function check(req) {
    const token = parseCookies(req.headers?.cookie).dola_session
    if (!token) return null
    const s = sessions.get(token)
    if (!s) return null
    if (s.expires <= Date.now()) {
      sessions.delete(token)
      return null
    }
    return { token, ...s }
  }

  function logout(token) {
    if (token) sessions.delete(token)
  }

  function clearAll() {
    sessions.clear()
  }

  function cookie(token, { secure = false } = {}) {
    return `dola_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(ttlMs / 1000)}${secure ? "; Secure" : ""}`
  }

  function clearCookie({ secure = false } = {}) {
    return `dola_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? "; Secure" : ""}`
  }

  function keyOf(req) {
    const header = String(req.headers?.authorization || "")
    const m = header.match(/^Bearer\s+(.+)$/i)
    if (!m) return null
    return store.findKey(m[1].trim())
  }

  function cleanup() {
    const at = Date.now()
    for (const [token, s] of sessions) if (s.expires <= at) sessions.delete(token)
  }

  return { login, check, logout, clearAll, cookie, clearCookie, keyOf, cleanup, sessions }
}
