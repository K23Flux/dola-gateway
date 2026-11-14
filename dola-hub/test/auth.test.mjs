import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStore } from "../lib/store.mjs"
import { createAuth, parseCookies } from "../lib/auth.mjs"

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "dola-hub-auth-"))
  const store = createStore({ dataDir: dir, env: { PANEL_PASSWORD: "pw" } })
  return { store, auth: createAuth({ store }), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test("changing the panel password can revoke every session", () => {
  const { auth, cleanup } = setup()
  try {
    const first = auth.login("pw")
    const second = auth.login("pw")
    assert.ok(auth.check({ headers: { cookie: "dola_session=" + first } }))
    assert.ok(auth.check({ headers: { cookie: "dola_session=" + second } }))
    auth.clearAll()
    assert.equal(auth.check({ headers: { cookie: "dola_session=" + first } }), null)
    assert.equal(auth.check({ headers: { cookie: "dola_session=" + second } }), null)
  } finally {
    cleanup()
  }
})

test("a malformed cookie value does not throw", () => {
  assert.deepEqual(parseCookies("dola_session=%; other=ok"), { dola_session: "%", other: "ok" })
  assert.equal(createAuth({ store: { verifyPassword: () => false } }).check({ headers: { cookie: "dola_session=%" } }), null)
})

test("session cookies can be marked Secure behind TLS", () => {
  const { auth, cleanup } = setup()
  try {
    const token = auth.login("pw")
    assert.match(auth.cookie(token), /HttpOnly; SameSite=Strict/)
    assert.match(auth.cookie(token, { secure: true }), /; Secure$/)
    assert.match(auth.clearCookie({ secure: true }), /; Secure$/)
  } finally {
    cleanup()
  }
})
