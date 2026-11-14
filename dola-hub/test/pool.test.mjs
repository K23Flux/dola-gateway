import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStore } from "../lib/store.mjs"
import { createPool } from "../lib/pool.mjs"

function setup(settings = {}, poolOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dola-hub-pool-"))
  const store = createStore({ dataDir: dir, env: { PANEL_PASSWORD: "pw" } })
  store.updateSettings({ cooldownSeconds: 60, stickyTtlSeconds: 1800, ...settings })
  const pool = createPool({ store, ...poolOptions })
  const cleanup = () => rmSync(dir, { recursive: true, force: true })
  return { store, pool, cleanup }
}

test("round-robin spreads picks over equal accounts", () => {
  const { store, pool, cleanup } = setup()
  try {
    const a = store.addAccount({ cookie: "sessionid=a", accountId: "a" }).account
    const b = store.addAccount({ cookie: "sessionid=b", accountId: "b" }).account
    const picked = []
    for (let i = 0; i < 6; i++) picked.push(pool.pick().id)
    assert.equal(picked.filter((id) => id === a.id).length, 3)
    assert.equal(picked.filter((id) => id === b.id).length, 3)
  } finally {
    cleanup()
  }
})

test("least_inflight picks the idle account", () => {
  const { store, pool, cleanup } = setup({ strategy: "least_inflight" })
  try {
    const a = store.addAccount({ cookie: "sessionid=a", accountId: "a" }).account
    const b = store.addAccount({ cookie: "sessionid=b", accountId: "b" }).account
    pool.acquire(a)
    assert.equal(pool.pick().id, b.id)
    pool.acquire(b)
    pool.acquire(a)
    pool.acquire(b)
    assert.equal(pool.pick(), null)
    pool.release(a)
    assert.equal(pool.pick().id, a.id)
  } finally {
    cleanup()
  }
})

test("priority prefers the lower number", () => {
  const { store, pool, cleanup } = setup({ strategy: "priority" })
  try {
    store.addAccount({ cookie: "sessionid=a", accountId: "a" }).account
    const high = store.addAccount({ cookie: "sessionid=b", accountId: "b" }).account
    store.updateAccount(high.id, { priority: 1 })
    for (let i = 0; i < 4; i++) assert.equal(pool.pick().id, high.id)
  } finally {
    cleanup()
  }
})

test("a rate limit cools an account down and excludes it", () => {
  const { store, pool, cleanup } = setup()
  try {
    const a = store.addAccount({ cookie: "sessionid=a", accountId: "a" }).account
    const b = store.addAccount({ cookie: "sessionid=b", accountId: "b" }).account
    pool.failure(a, { code: "rate_limited", status: 429 })
    assert.ok(a.cooldownUntil > Date.now())
    for (let i = 0; i < 4; i++) assert.equal(pool.pick().id, b.id)
    pool.clearCooldown(a.id)
    assert.equal(a.cooldownUntil, 0)
    const ids = new Set([pool.pick().id, pool.pick().id])
    assert.equal(ids.has(a.id), true)
  } finally {
    cleanup()
  }
})

test("a 401 invalidates an account until revived", () => {
  const { store, pool, cleanup } = setup()
  try {
    const a = store.addAccount({ cookie: "sessionid=a", accountId: "a" }).account
    const b = store.addAccount({ cookie: "sessionid=b", accountId: "b" }).account
    pool.failure(a, { code: "signin_expired", status: 401 })
    assert.equal(a.invalid, true)
    for (let i = 0; i < 4; i++) assert.equal(pool.pick().id, b.id)
    pool.revive(a.id)
    assert.equal(a.invalid, false)
    assert.ok([a.id, b.id].includes(pool.pick().id))
  } finally {
    cleanup()
  }
})

test("sticky sessions keep a conversation on one account", () => {
  const { store, pool, cleanup } = setup()
  try {
    const a = store.addAccount({ cookie: "sessionid=a", accountId: "a" }).account
    store.addAccount({ cookie: "sessionid=b", accountId: "b" }).account
    const first = pool.pick({ sessionKey: "conv-1" }).id
    for (let i = 0; i < 5; i++) assert.equal(pool.pick({ sessionKey: "conv-1" }).id, first)
    assert.equal(first, a.id)
  } finally {
    cleanup()
  }
})

test("disabled accounts are never picked", () => {
  const { store, pool, cleanup } = setup()
  try {
    const a = store.addAccount({ cookie: "sessionid=a", accountId: "a" }).account
    const b = store.addAccount({ cookie: "sessionid=b", accountId: "b" }).account
    store.updateAccount(a.id, { enabled: false })
    for (let i = 0; i < 4; i++) assert.equal(pool.pick().id, b.id)
  } finally {
    cleanup()
  }
})

test("a success revives an invalid account and clears its cooldown", () => {
  const { store, pool, cleanup } = setup()
  try {
    const a = store.addAccount({ cookie: "sessionid=a", accountId: "a" }).account
    pool.failure(a, { code: "signin_expired", status: 401 })
    pool.failure(a, { code: "rate_limited", status: 429 })
    pool.success(a)
    assert.equal(a.invalid, false)
    assert.equal(a.cooldownUntil, 0)
    assert.equal(a.stats.success, 1)
  } finally {
    cleanup()
  }
})

test("sticky sessions are capped and expired entries are pruned", () => {
  let at = 1_000_000
  const { store, pool, cleanup } = setup({}, { maxSticky: 2, now: () => at })
  try {
    store.addAccount({ cookie: "sessionid=a", accountId: "a" })
    store.addAccount({ cookie: "sessionid=b", accountId: "b" })
    pool.pick({ sessionKey: "one", at })
    pool.pick({ sessionKey: "two", at })
    pool.pick({ sessionKey: "three", at })
    assert.equal(pool.stickyCount(), 2)

    at += 1_800_001
    pool.pick({ sessionKey: "four", at })
    assert.equal(pool.stickyCount(), 1)
  } finally {
    cleanup()
  }
})
