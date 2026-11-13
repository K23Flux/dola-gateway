// Browser sign-in for dola.com.
//
// Dola signs people in through its web window (Google, Apple, email…).
// This starts a Chrome/Chromium/Edge of its own, on a profile of its own,
// opens the chat page, and waits for the session cookies the window sets
// once the login callback lands. The cookies are read over the DevTools
// protocol (HttpOnly cookies included), so the plugin never asks for a
// password and never needs the browser after sign-in.
//
// A headless machine has no window to sign in through. There the plugin
// offers the paste-a-cookie sign-in instead; DOLA_BROWSER_HEADLESS=1 still
// starts a headless browser for a profile that is already signed in.

import { spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:net"
import { homedir } from "node:os"
import { join } from "node:path"
import { hasSession } from "./dola.mjs"

export const LOGIN_URL = "https://www.dola.com/chat/"

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"))
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason ?? new Error("aborted"))
    }
    signal?.addEventListener?.("abort", onAbort, { once: true })
  })

export function dolaHome(env = process.env, platform = process.platform) {
  if (env.DOLA_HOME) return env.DOLA_HOME
  if (platform === "win32") return join(env.LOCALAPPDATA || homedir(), "magpie-dola")
  if (platform === "darwin") return join(homedir(), "Library", "Application Support", "magpie-dola")
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "magpie-dola")
}

export function findBrowser({ env = process.env, platform = process.platform, exists = existsSync } = {}) {
  if (env.DOLA_BROWSER) return env.DOLA_BROWSER
  const candidates =
    platform === "win32"
      ? [
          join(env.LOCALAPPDATA || "", "Google/Chrome/Application/chrome.exe"),
          join(env.PROGRAMFILES || "", "Google/Chrome/Application/chrome.exe"),
          join(env["PROGRAMFILES(X86)"] || "", "Google/Chrome/Application/chrome.exe"),
          join(env.PROGRAMFILES || "", "Microsoft/Edge/Application/msedge.exe"),
          join(env["PROGRAMFILES(X86)"] || "", "Microsoft/Edge/Application/msedge.exe"),
          join(env.LOCALAPPDATA || "", "Microsoft/Edge/Application/msedge.exe"),
        ]
      : platform === "darwin"
        ? [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
            "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
          ]
        : [
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
            "/snap/bin/chromium",
            "/usr/bin/microsoft-edge",
            "/usr/bin/brave-browser",
          ]
  return candidates.find((path) => path && exists(path)) ?? ""
}

export function browserArgs(profile, port, url, { headless = false, noSandbox = false } = {}) {
  return [
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-features=Translate",
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    "--remote-allow-origins=*",
    ...(headless ? ["--headless=new", "--disable-gpu", "--disable-dev-shm-usage"] : []),
    ...(headless || noSandbox ? ["--no-sandbox"] : []),
    "--new-window",
    url,
  ]
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port
      server.close(() => resolve(port))
    })
  })
}

export async function cdpTarget(port, { fetchImpl = globalThis.fetch } = {}) {
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) })
    if (!res.ok) return null
    const list = await res.json()
    const pages = (Array.isArray(list) ? list : []).filter(
      (t) => t?.type === "page" && typeof t.webSocketDebuggerUrl === "string",
    )
    return pages.find((t) => /dola\.com/i.test(String(t.url ?? ""))) ?? pages[0] ?? null
  } catch {
    return null
  }
}

export function cdpSend(
  webSocketUrl,
  method,
  params = {},
  { timeout = 5000, WebSocketImpl = globalThis.WebSocket } = {},
) {
  return new Promise((resolve, reject) => {
    let ws
    try {
      ws = new WebSocketImpl(webSocketUrl)
    } catch (e) {
      reject(e)
      return
    }
    let done = false
    const finish = (fn, value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try {
        ws.close()
      } catch {}
      fn(value)
    }
    const timer = setTimeout(() => finish(reject, new Error("CDP timed out")), timeout)
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params }))
    ws.onerror = () => finish(reject, new Error("CDP connection failed"))
    ws.onclose = () => finish(reject, new Error("CDP connection closed"))
    ws.onmessage = (event) => {
      let message
      try {
        message = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (message.id !== 1) return
      if (message.error) finish(reject, new Error(message.error.message || "CDP failed"))
      else finish(resolve, message.result)
    }
  })
}

// cookieHeader keeps only dola.com cookies and writes them as a Cookie
// header. HttpOnly cookies (sessionid among them) are included.
export function cookieHeader(cookies) {
  const values = new Map()
  for (const c of Array.isArray(cookies) ? cookies : []) {
    const domain = String(c?.domain ?? "").replace(/^\./, "")
    if (!(domain === "dola.com" || domain.endsWith(".dola.com"))) continue
    if (!c?.name || typeof c.value !== "string" || !c.value) continue
    values.set(String(c.name), c.value)
  }
  return [...values].map(([k, v]) => `${k}=${v}`).join("; ")
}

export async function openLoginBrowser({
  url = LOGIN_URL,
  env = process.env,
  platform = process.platform,
  exists = existsSync,
  spawnImpl = spawn,
  fetchImpl = globalThis.fetch,
  WebSocketImpl = globalThis.WebSocket,
  headless,
  profileDir,
} = {}) {
  const browser = findBrowser({ env, platform, exists })
  if (!browser)
    throw new Error(
      "Chrome, Chromium or Edge was not found. Set DOLA_BROWSER to its path, or use the paste-a-cookie sign-in.",
    )
  const headlessMode =
    headless ?? ["1", "true", "yes"].includes(String(env.DOLA_BROWSER_HEADLESS ?? "").toLowerCase())
  if (platform === "linux" && !headlessMode && !env.DISPLAY && !env.WAYLAND_DISPLAY)
    throw new Error(
      "This machine has no graphical session, so there is no Dola window to sign in through. Use the paste-a-cookie sign-in, or start magpie where a browser can open (SSH X forwarding also works).",
    )

  const port = await freePort()
  let temp = false
  let profile = profileDir || env.DOLA_LOGIN_PROFILE
  if (!profile) {
    const home = dolaHome(env, platform)
    mkdirSync(home, { recursive: true, mode: 0o700 })
    profile = mkdtempSync(join(home, "login-"))
    temp = true
  } else {
    mkdirSync(profile, { recursive: true })
  }

  let child
  try {
    child = spawnImpl(
      browser,
      browserArgs(profile, port, url, {
        headless: headlessMode,
        noSandbox: platform === "linux" && typeof process.getuid === "function" && process.getuid() === 0,
      }),
      { stdio: "ignore", detached: false },
    )
  } catch (e) {
    if (temp)
      try {
        rmSync(profile, { recursive: true, force: true })
      } catch {}
    throw new Error(`Could not start ${browser}: ${e?.message ?? e}`)
  }
  let exited = false
  let spawnError = ""
  child.once?.("error", (e) => {
    spawnError = String(e?.message ?? e)
    exited = true
  })
  child.once?.("exit", () => {
    exited = true
  })

  let closing = null
  const session = {
    profile,
    async cookies(timeoutMs = 5 * 60 * 1000, { signal } = {}) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (signal?.aborted) throw signal.reason ?? new Error("aborted")
        if (exited) {
          if (spawnError) throw new Error(`The browser failed to start: ${spawnError}`)
          return ""
        }
        const target = await cdpTarget(port, { fetchImpl })
        if (target?.webSocketDebuggerUrl) {
          for (const method of ["Network.getAllCookies", "Storage.getCookies"]) {
            try {
              const result = await cdpSend(target.webSocketDebuggerUrl, method, {}, { WebSocketImpl })
              const header = cookieHeader(result?.cookies)
              if (hasSession(header)) return header
              break
            } catch {}
          }
        }
        await sleep(1000, signal)
      }
      return ""
    },
    close() {
      if (closing) return closing
      closing = (async () => {
        if (child.exitCode === null && child.signalCode === null) {
          try {
            child.kill("SIGTERM")
          } catch {}
          await sleep(1500).catch(() => {})
          if (child.exitCode === null && child.signalCode === null)
            try {
              child.kill("SIGKILL")
            } catch {}
        }
        if (temp)
          try {
            rmSync(profile, { recursive: true, force: true })
          } catch {}
      })()
      return closing
    },
  }
  return session
}
