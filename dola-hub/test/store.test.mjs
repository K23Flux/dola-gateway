import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStore } from "../lib/store.mjs"

function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), "dola-hub-store-"))
  try {
    const store = createStore({ dataDir: dir, env: { PANEL_PASSWORD: "secret-pass" } })
    return fn(store, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test("creates a state file and verifies the panel password", () => {
  withStore((store) => {
    assert.equal(store.verifyPassword("secret-pass"), true)
    assert.equal(store.verifyPassword("wrong"), false)
    assert.equal(store.isDefaultPassword(), false)
    store.setPassword("admin")
    assert.equal(store.isDefaultPassword(), true)
    assert.equal(store.verifyPassword("admin"), true)
  })
})

test("adds, dedupes and removes accounts", () => {
  withStore((store) => {
    const first = store.addAccount({ cookie: "sessionid=a", accountId: "u1", name: "One" })
    assert.equal(first.created, true)
    const again = store.addAccount({ cookie: "sessionid=b", accountId: "u1", name: "One renamed" })
    assert.equal(again.created, false)
    assert.equal(store.state.accounts.length, 1)
    assert.equal(store.state.accounts[0].cookie, "sessionid=b")
    assert.equal(store.state.accounts[0].name, "One renamed")
    assert.equal(store.removeAccount(first.account.id), true)
    assert.equal(store.state.accounts.length, 0)
  })
})

test("updates accounts and clamps values", () => {
  withStore((store) => {
    const { account } = store.addAccount({ cookie: "sessionid=a", accountId: "u1" })
    const updated = store.updateAccount(account.id, { enabled: false, priority: 0, weight: 999, maxConcurrency: 0 })
    assert.equal(updated.enabled, false)
    assert.equal(updated.priority, 1)
    assert.equal(updated.weight, 100)
    assert.equal(updated.maxConcurrency, 1)
  })
})

test("creates keys and finds them by token", () => {
  withStore((store) => {
    const key = store.addKey({ name: "laptop", models: ["dola-fast"] })
    assert.match(key.key, /^sk-dola-[0-9a-f]{48}$/)
    assert.equal(store.findKey(key.key)?.id, key.id)
    assert.equal(store.findKey("sk-dola-nope"), null)
    store.updateKey(key.id, { enabled: false })
    assert.equal(store.findKey(key.key), null)
    assert.equal(store.removeKey(key.id), true)
    assert.equal(store.state.keys.length, 0)
  })
})

test("validates settings", () => {
  withStore((store) => {
    const s = store.updateSettings({ strategy: "least_inflight", maxAttempts: 99, cooldownSeconds: 1, stickyTtlSeconds: -1 })
    assert.equal(s.strategy, "least_inflight")
    assert.equal(s.maxAttempts, 10)
    assert.equal(s.cooldownSeconds, 5)
    assert.equal(s.stickyTtlSeconds, 0)
    assert.throws(() => store.updateSettings({ strategy: "nope" }), /strategy/)
  })
})

test("persists across a reload", () => {
  const dir = mkdtempSync(join(tmpdir(), "dola-hub-store-"))
  try {
    const a = createStore({ dataDir: dir, env: { PANEL_PASSWORD: "pw" } })
    a.addAccount({ cookie: "sessionid=a", accountId: "u1", name: "One" })
    a.addKey({ name: "k", models: [] })
    a.updateSettings({ strategy: "random" })
    a.flush()

    const b = createStore({ dataDir: dir })
    assert.equal(b.state.accounts.length, 1)
    assert.equal(b.state.accounts[0].name, "One")
    assert.equal(b.state.keys.length, 1)
    assert.equal(b.state.settings.strategy, "random")
    assert.equal(b.verifyPassword("pw"), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
