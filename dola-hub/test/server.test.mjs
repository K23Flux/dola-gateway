import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { createStore } from "../lib/store.mjs"

const serverFile = fileURLToPath(new URL("../server.mjs", import.meta.url))

async function withServer(options, run) {
  const dir = mkdtempSync(join(tmpdir(), "dola-hub-server-"))
  let child
  let exited
  try {
    if (options.storedPassword) {
      const store = createStore({ dataDir: dir, env: { PANEL_PASSWORD: options.storedPassword } })
      store.addAccount({ cookie: "sessionid=fake-test-cookie", accountId: "test-account" })
      store.addKey({ name: "preserved-key" })
      store.flush()
    }
    const reservation = createServer()
    reservation.listen(0, "127.0.0.1")
    await once(reservation, "listening")
    const port = reservation.address().port
    await new Promise((resolve) => reservation.close(resolve))
    const env = { ...process.env, DOLA_HUB_DATA: dir, HOST: options.host || "127.0.0.1", PORT: String(port) }
    delete env.PANEL_PASSWORD
    delete env.DOLA_HUB_TRUST_PROXY
    delete env.DOLA_HUB_DESKTOP
    if (options.password !== undefined) env.PANEL_PASSWORD = options.password
    if (options.trustProxy) env.DOLA_HUB_TRUST_PROXY = "1"
    child = spawn(process.execPath, [serverFile], { env, stdio: ["ignore", "pipe", "pipe"] })
    exited = once(child, "exit")
    let output = ""
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("server startup timed out")), 10000)
      child.stdout.on("data", (chunk) => {
        output += chunk
        if (output.includes("  panel:")) { clearTimeout(timer); resolve() }
      })
      child.stderr.on("data", (chunk) => { output += chunk })
      child.once("error", (error) => { clearTimeout(timer); reject(error) })
      child.once("exit", () => { clearTimeout(timer); resolve() })
    })
    await run({
      base: `http://127.0.0.1:${port}`,
      child, output, dir,
      login: (password, headers = {}) => fetch(`http://127.0.0.1:${port}/api/login`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ password }),
      }),
    })
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM")
    if (exited) await exited
    rmSync(dir, { recursive: true, force: true })
  }
}

test("legacy default is migrated and persisted without losing accounts or keys", { timeout: 15000 }, async () => {
  await withServer({ storedPassword: "admin", password: "replacement-test-password" }, async ({ login, dir }) => {
    assert.equal((await login("admin")).status, 401)
    assert.equal((await login("replacement-test-password")).status, 200)
    const disk = createStore({ dataDir: dir, env: {} })
    assert.equal(disk.verifyPassword("admin"), false)
    assert.equal(disk.verifyPassword("replacement-test-password"), true)
    assert.equal(disk.state.accounts[0].accountId, "test-account")
    assert.equal(disk.state.keys[0].name, "preserved-key")
  })
})

test("legacy default refuses startup without a usable replacement", { timeout: 30000 }, async () => {
  for (const password of [undefined, "admin", "short"]) {
    await withServer({ storedPassword: "admin", password }, async ({ child, output }) => {
      assert.equal(child.exitCode, 1)
      assert.match(output, /refusing to start/)
    })
  }
})

test("fresh installation refuses explicitly configured admin", { timeout: 15000 }, async () => {
  await withServer({ password: "admin" }, async ({ child }) => {
    assert.equal(child.exitCode, 1)
  })
})

test("environment replacement does not overwrite an existing custom password", { timeout: 15000 }, async () => {
  await withServer({ storedPassword: "existing-test-password", password: "replacement-test-password" }, async ({ login }) => {
    assert.equal((await login("existing-test-password")).status, 200)
    assert.equal((await login("replacement-test-password")).status, 401)
  })
})

test("non-loopback binding works without trusting forwarded headers", { timeout: 15000 }, async () => {
  await withServer({ password: "test-panel-password", host: "0.0.0.0" }, async ({ login }) => {
    const response = await login("test-panel-password", { "x-forwarded-proto": "https" })
    assert.equal(response.status, 200)
    assert.doesNotMatch(response.headers.get("set-cookie"), /; Secure/)
  })
})

test("trusted HTTPS proxy adds Secure only for HTTPS forwarded requests", { timeout: 15000 }, async () => {
  await withServer({ password: "test-panel-password", trustProxy: true }, async ({ login }) => {
    const tls = await login("test-panel-password", { "x-forwarded-proto": "https" })
    assert.equal(tls.status, 200)
    assert.match(tls.headers.get("set-cookie"), /; Secure/)
    const plain = await login("test-panel-password")
    assert.equal(plain.status, 200)
    assert.doesNotMatch(plain.headers.get("set-cookie"), /; Secure/)
  })
})
