import { test } from "node:test"
import assert from "node:assert/strict"
import { createDesktopBackend } from "../lib/desktop.mjs"

const TABLE = {
  "deepseek-v4.1-flash": { label: "DeepSeek V4.1 Flash", name: "DeepSeek V4.1 Flash" },
  auto: { label: "自动", name: "自动" },
}

function fakeDoubao(overrides = {}) {
  return {
    modelList: () => TABLE,
    discover: async () => TABLE,
    ask: async (_prompt, { onUpdate }) => {
      onUpdate?.({ text: "Hi", reasoning: "" })
      return { text: "Hi", reasoning: "" }
    },
    ...overrides,
  }
}

const APP = { app: "豆包工作", binary: "test", dataDir: "" }

test("lists and asks a desktop model", async () => {
  const desktop = createDesktopBackend({ doubao: fakeDoubao(), app: APP })
  assert.equal(desktop.available(), true)
  const current = desktop.current()
  assert.equal(current.models.length, 2)
  assert.equal(current.models[0].backend, "desktop")
  assert.equal(current.models.find((m) => m.id === "deepseek-v4.1-flash").name, "DeepSeek V4.1 Flash")

  const refreshed = await desktop.refresh()
  assert.equal(refreshed.models.length, 2)

  const read = await desktop.ask({ prompt: "hi", model: "deepseek-v4.1-flash", onUpdate: () => {} })
  assert.equal(read.text, "Hi")
})

test("refuses an unknown desktop model", async () => {
  const desktop = createDesktopBackend({ doubao: fakeDoubao(), app: APP })
  await assert.rejects(() => desktop.ask({ prompt: "hi", model: "nope" }), /没有模型/)
})

test("reports an unavailable app", async () => {
  const desktop = createDesktopBackend({
    doubao: fakeDoubao(),
    available: false,
    app: { app: "", binary: "", dataDir: "" },
  })
  assert.equal(desktop.available(), false)
  const current = desktop.current()
  assert.equal(current.models.length, 0)
  assert.match(current.error, /未找到/)
  await assert.rejects(() => desktop.ask({ prompt: "hi", model: "auto" }), /未找到/)
})

test("a failed refresh keeps the previous models", async () => {
  let calls = 0
  const desktop = createDesktopBackend({
    doubao: fakeDoubao({
      discover: async () => {
        calls++
        throw new Error("app busy")
      },
    }),
    app: APP,
  })
  assert.equal(desktop.current().models.length, 2)
  const after = await desktop.refresh()
  assert.equal(calls, 1)
  assert.equal(after.models.length, 2)
  assert.match(after.error, /app busy/)
})
