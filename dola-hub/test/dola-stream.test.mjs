import { test } from "node:test"
import assert from "node:assert/strict"
import { streamCompletion } from "../../packages/dola/dola.mjs"

function textFrame(text, sep) {
  return (
    `event: STREAM_MSG_NOTIFY${sep}` +
    "data: " +
    JSON.stringify({ content: { content_block: [{ content: { text_block: { text } } }] } }) +
    sep +
    sep
  )
}

test("streamCompletion accepts LF and CRLF SSE frames", async () => {
  for (const sep of ["\n", "\r\n"]) {
    const body = textFrame("Hello", sep) + textFrame(" world", sep)
    const updates = []
    const out = await streamCompletion({
      cookie: "test",
      text: "hi",
      fetchImpl: async () => new Response(body, { status: 200 }),
      onUpdate: (read) => updates.push(read),
    })
    assert.equal(out.text, "Hello world", `line ending ${JSON.stringify(sep)}`)
    assert.deepEqual(updates.at(-1), { text: "Hello world", reasoning: "" })
  }
})

test("an upstream HTTP error does not echo its response body", async () => {
  const secret = "this-prompt-should-not-be-logged"
  const fetchImpl = async () =>
    new Response(JSON.stringify({ error: { message: `echo ${secret}` }, error_code: "E123" }), { status: 500 })
  await assert.rejects(
    streamCompletion({ cookie: "test", text: "hi", fetchImpl }),
    (error) => {
      assert.equal(error.code, "upstream_error")
      assert.equal(error.message, "Dola HTTP 500")
      assert.doesNotMatch(error.message, new RegExp(secret))
      return true
    },
  )
})

test("upstream error codes cannot carry free-form secrets", async () => {
  const secret = "private-prompt-and-account-data"
  await assert.rejects(
    streamCompletion({
      cookie: "test",
      text: secret,
      fetchImpl: async () => new Response(JSON.stringify({ error_code: secret }), { status: 500 }),
    }),
    (error) => {
      assert.equal(error.message, "Dola HTTP 500")
      assert.doesNotMatch(JSON.stringify(error), new RegExp(secret))
      return true
    },
  )
})

test("SSE errors expose only local messages and preserve retry classifications", async () => {
  const secret = "private-prompt-and-account-data"
  for (const [message, upstreamCode, code, status, expected] of [
    [secret, secret, "upstream_error", 502, "Dola stream failed"],
    [`high demand ${secret}`, 710022002, "rate_limited", 429, "Dola is rate limiting this account"],
    [`session expired ${secret}`, secret, "signin_expired", 401, "Dola refused the session cookies; sign in again"],
  ]) {
    const body = "event: STREAM_ERROR\ndata: " + JSON.stringify({ error_msg: message, error_code: upstreamCode }) + "\n\n"
    await assert.rejects(
      streamCompletion({ cookie: "test", text: secret, fetchImpl: async () => new Response(body) }),
      (error) => {
        assert.equal(error.message, expected)
        assert.equal(error.code, code)
        assert.equal(error.status, status)
        assert.equal(error.dola, undefined)
        assert.doesNotMatch(error.stack + JSON.stringify(error), new RegExp(secret))
        return true
      },
    )
  }
})

test("streamCompletion reassembles frames split across network chunks", async () => {
  const body = textFrame("你好", "\r\n") + textFrame("，世界", "\r\n")
  const bytes = new TextEncoder().encode(body)
  const chunks = []
  for (let i = 0; i < bytes.length; i += 3) chunks.push(bytes.slice(i, i + 3))
  const out = await streamCompletion({
    cookie: "sessionid=test",
    text: "hi",
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk)
            controller.close()
          },
        }),
        { status: 200 },
      ),
  })
  assert.equal(out.text, "你好，世界")
})
