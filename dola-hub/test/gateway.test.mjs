import { test } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStore } from "../lib/store.mjs"
import { createPool } from "../lib/pool.mjs"
import { createLog } from "../lib/log.mjs"
import { createGateway } from "../lib/gateway.mjs"
import { streamCompletion } from "../../packages/dola/dola.mjs"

function setup(client, { models = [], accounts = [], catalog, desktop } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dola-hub-gw-"))
  const store = createStore({ dataDir: dir, env: { PANEL_PASSWORD: "pw" } })
  const pool = createPool({ store })
  const log = createLog({ dataDir: dir })
  const gateway = createGateway({ store, pool, log, catalog, desktop, client })
  const key = store.addKey({ name: "test", models })
  for (const a of accounts) store.addAccount(a)
  const server = createServer((req, res) => gateway.handle(req, res, key, new URL(req.url, "http://x")))
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const url = `http://127.0.0.1:${server.address().port}`
      resolve({
        url,
        key,
        store,
        pool,
        log,
        close: () =>
          new Promise((r) => {
            server.close(() => {
              store.flush()
              rmSync(dir, { recursive: true, force: true })
              r()
            })
          }),
      })
    })
  })
}

const chat = (url, key, body) =>
  fetch(url + "/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer " + key, "content-type": "application/json" },
    body: JSON.stringify(body),
  })

const helloClient = {
  async streamCompletion({ onUpdate }) {
    onUpdate?.({ text: "Hello", reasoning: "" })
    return { text: "Hello", thinking: "" }
  },
}

test("a non-streamed request becomes an OpenAI completion", async () => {
  const h = await setup(helloClient, { accounts: [{ cookie: "sessionid=a", accountId: "u1" }] })
  try {
    const res = await chat(h.url, h.key.key, { model: "dola-fast", messages: [{ role: "user", content: "hi" }] })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.choices[0].message.content, "Hello")
    assert.equal(body.choices[0].finish_reason, "stop")
    assert.equal(h.log.entries.length, 1)
    assert.equal(h.log.entries[0].account, "u1")
    assert.equal(JSON.stringify(h.log.entries).includes("sessionid"), false)
  } finally {
    await h.close()
  }
})

test("HTTP and SSE errors do not leak upstream content into responses or the ledger", async () => {
  const secret = "private-prompt-sentinel"
  const errorFrame = "event: STREAM_ERROR\ndata: " + JSON.stringify({ error_msg: secret, error_code: secret }) + "\n\n"
  const deltaFrame = "event: STREAM_MSG_NOTIFY\ndata: " + JSON.stringify({ content: { content_block: [{ content: { text_block: { text: "Hello" } } }] } }) + "\n\n"
  for (const scenario of ["http", "sse-before", "sse-after"]) {
    const client = {
      streamCompletion: (options) => streamCompletion({
        ...options,
        fetchImpl: async () => scenario === "http"
          ? new Response(JSON.stringify({ error_code: secret, message: secret }), { status: 500 })
          : new Response((scenario === "sse-after" ? deltaFrame : "") + errorFrame),
      }),
    }
    const h = await setup(client, { accounts: [{ cookie: "sessionid=fake-test-cookie", accountId: "test-account" }] })
    try {
      for (const stream of [false, true]) {
        const response = await chat(h.url, h.key.key, { model: "dola-fast", stream, messages: [{ role: "user", content: secret }] })
        assert.equal(response.status, stream && scenario === "sse-after" ? 200 : 502)
        const body = await response.text()
        assert.match(body, /Dola HTTP 500|Dola stream failed/)
        assert.doesNotMatch(body, new RegExp(secret))
        assert.doesNotMatch(JSON.stringify(h.log.entries), new RegExp(secret))
        assert.equal(h.log.entries.at(-1).status, 502)
        h.pool.clearCooldown(h.store.state.accounts[0].id)
      }
    } finally {
      await h.close()
    }
  }
})

test("a streamed request emits SSE deltas and [DONE]", async () => {
  const h = await setup(helloClient, { accounts: [{ cookie: "sessionid=a", accountId: "u1" }] })
  try {
    const res = await chat(h.url, h.key.key, {
      model: "dola-fast",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    })
    assert.equal(res.status, 200)
    assert.match(res.headers.get("content-type"), /text\/event-stream/)
    const text = await res.text()
    assert.match(text, /"content":"Hello"/)
    assert.match(text, /"finish_reason":"stop"/)
    assert.match(text, /data: \[DONE\]/)
  } finally {
    await h.close()
  }
})

test("a 401 before any delta fails over to another account", async () => {
  const client = {
    async streamCompletion({ cookie, onUpdate }) {
      if (cookie.includes("bad")) {
        const e = new Error("expired")
        e.code = "signin_expired"
        e.status = 401
        throw e
      }
      onUpdate?.({ text: "Good", reasoning: "" })
      return { text: "Good", thinking: "" }
    },
  }
  const h = await setup(client, {
    accounts: [
      { cookie: "sessionid=bad", accountId: "bad" },
      { cookie: "sessionid=good", accountId: "good" },
    ],
  })
  try {
    const res = await chat(h.url, h.key.key, { model: "dola-fast", messages: [{ role: "user", content: "hi" }] })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.choices[0].message.content, "Good")
    assert.equal(h.log.entries.at(-1).account, "good")
    assert.equal(h.store.state.accounts.find((a) => a.accountId === "bad").invalid, true)
  } finally {
    await h.close()
  }
})

test("a 401 from every account is a 401", async () => {
  const client = {
    async streamCompletion() {
      const e = new Error("expired")
      e.code = "signin_expired"
      e.status = 401
      throw e
    },
  }
  const h = await setup(client, { accounts: [{ cookie: "sessionid=a", accountId: "u1" }] })
  try {
    const res = await chat(h.url, h.key.key, { model: "dola-fast", messages: [{ role: "user", content: "hi" }] })
    assert.equal(res.status, 401)
    const body = await res.json()
    assert.equal(body.error.type, "signin_expired")
  } finally {
    await h.close()
  }
})

test("an empty pool is a 503", async () => {
  const h = await setup(helloClient, {})
  try {
    const res = await chat(h.url, h.key.key, { model: "dola-fast", messages: [{ role: "user", content: "hi" }] })
    assert.equal(res.status, 503)
    const body = await res.json()
    assert.equal(body.error.type, "no_account")
  } finally {
    await h.close()
  }
})

test("a key's model allowlist is enforced", async () => {
  const h = await setup(helloClient, {
    models: ["dola-pro"],
    accounts: [{ cookie: "sessionid=a", accountId: "u1" }],
  })
  try {
    const res = await chat(h.url, h.key.key, { model: "dola-fast", messages: [{ role: "user", content: "hi" }] })
    assert.equal(res.status, 403)
    const ok = await chat(h.url, h.key.key, { model: "dola-pro", messages: [{ role: "user", content: "hi" }] })
    assert.equal(ok.status, 200)
  } finally {
    await h.close()
  }
})

test("a desktop model is served by the desktop backend", async () => {
  const desktopModel = {
    id: "deepseek-v4.1-flash",
    name: "DeepSeek V4.1 Flash",
    backend: "desktop",
    desktopId: "deepseek-v4.1-flash",
    context: 0,
  }
  const catalog = {
    currentModels: () => [desktopModel],
    find: (id) => (id === desktopModel.id ? desktopModel : null),
    snapshot: () => ({ models: [desktopModel] }),
  }
  const desktop = {
    ask: async ({ onUpdate }) => {
      onUpdate?.({ text: "DS", reasoning: "" })
      return { text: "DS", reasoning: "" }
    },
  }
  const h = await setup(helloClient, { catalog, desktop })
  try {
    const res = await chat(h.url, h.key.key, {
      model: "deepseek-v4.1-flash",
      messages: [{ role: "user", content: "hi" }],
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.choices[0].message.content, "DS")
    assert.equal(h.log.entries.at(-1).account, "desktop")
  } finally {
    await h.close()
  }
})

test("models lists what the key may use", async () => {
  const h = await setup(helloClient, { models: ["dola-pro"] })
  try {
    const res = await fetch(h.url + "/v1/models", { headers: { authorization: "Bearer " + h.key.key } })
    const body = await res.json()
    assert.deepEqual(body.data.map((m) => m.id), ["dola-pro"])
  } finally {
    await h.close()
  }
})

test("a streamed desktop model writes SSE to the HTTP response", async () => {
  const desktopModel = { id: "desktop-x", name: "Desktop X", backend: "desktop", desktopId: "desktop-x" }
  const catalog = {
    currentModels: () => [desktopModel],
    find: (id) => (id === desktopModel.id ? desktopModel : null),
    snapshot: () => ({ models: [desktopModel] }),
  }
  const desktop = {
    ask: async ({ onUpdate }) => {
      onUpdate?.({ text: "DS", reasoning: "" })
      return { text: "DS", reasoning: "" }
    },
  }
  const h = await setup(helloClient, { catalog, desktop })
  try {
    const res = await chat(h.url, h.key.key, {
      model: "desktop-x",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    })
    assert.equal(res.status, 200)
    assert.match(res.headers.get("content-type"), /text\/event-stream/)
    const text = await res.text()
    assert.match(text, /"content":"DS"/)
    assert.match(text, /data: \[DONE\]/)
  } finally {
    await h.close()
  }
})

test("tool_choice none keeps tool-call text out of tool_calls", async () => {
  const client = {
    async streamCompletion() {
      return { text: '<tool_call>{"name":"delete_file","arguments":{}}</tool_call>', thinking: "" }
    },
  }
  const h = await setup(client, { accounts: [{ cookie: "sessionid=a", accountId: "u1" }] })
  try {
    const res = await chat(h.url, h.key.key, {
      model: "dola-fast",
      messages: [{ role: "user", content: "delete it" }],
      tools: [{ type: "function", function: { name: "delete_file", parameters: { type: "object" } } }],
      tool_choice: "none",
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.choices[0].message.tool_calls, undefined)
    assert.match(body.choices[0].message.content, /<tool_call>/)
  } finally {
    await h.close()
  }
})

test("only declared tools become tool_calls", async () => {
  const client = {
    async streamCompletion() {
      return { text: '<tool_call>{"name":"other_tool","arguments":{}}</tool_call>', thinking: "" }
    },
  }
  const h = await setup(client, { accounts: [{ cookie: "sessionid=a", accountId: "u1" }] })
  try {
    const res = await chat(h.url, h.key.key, {
      model: "dola-fast",
      messages: [{ role: "user", content: "do it" }],
      tools: [{ type: "function", function: { name: "delete_file", parameters: { type: "object" } } }],
    })
    const body = await res.json()
    assert.equal(body.choices[0].message.tool_calls, undefined)
    assert.match(body.choices[0].message.content, /<tool_call>/)
  } finally {
    await h.close()
  }
})

test("an allowed tool call is returned", async () => {
  const client = {
    async streamCompletion() {
      return { text: '<tool_call>{"name":"delete_file","arguments":{"path":"x"}}</tool_call>', thinking: "" }
    },
  }
  const h = await setup(client, { accounts: [{ cookie: "sessionid=a", accountId: "u1" }] })
  try {
    const res = await chat(h.url, h.key.key, {
      model: "dola-fast",
      messages: [{ role: "user", content: "delete it" }],
      tools: [{ type: "function", function: { name: "delete_file", parameters: { type: "object" } } }],
    })
    const body = await res.json()
    assert.equal(body.choices[0].message.tool_calls[0].function.name, "delete_file")
  } finally {
    await h.close()
  }
})
