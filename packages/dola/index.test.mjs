import { describe, expect, test } from "bun:test"
import { createPlugin, _internal } from "./index.mjs"
import { buildBody, cookieValue, hasSession, normalizeCookie, parseSseFrames } from "./dola.mjs"
import { flatten, parse } from "./prompt.mjs"
import { browserArgs, cookieHeader, findBrowser } from "./browser.mjs"

const { MODELS, BASE } = _internal
const COOKIE = "sessionid=session-value; oauth_token=oauth-value; flow_cur_user_sec_id=user-1"

function jsonRes(status, body, headers = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })
}

function sseRes(events) {
  const text = events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join("")
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } })
}

function textEvent(text, { thinking = false } = {}) {
  return {
    event: "STREAM_MSG_NOTIFY",
    data: {
      content: {
        content_block: [
          {
            block_type: 10000,
            content: {
              text_block: {
                text,
                icon_url: thinking ? "https://example.invalid/Deep_Think.png" : "",
                icon_url_dark: "",
              },
            },
          },
        ],
      },
    },
  }
}

function upstreamFetch({ frames = [textEvent("Hello")], status = 200, account = { user_id: "42", screen_name: "Tester" } } = {}) {
  const calls = []
  const impl = async (input, init = {}) => {
    const url = new URL(String(input))
    calls.push({ url, init })
    if (url.pathname.startsWith("/passport/account/info/v2")) {
      if (status === 401 || status === 403) return jsonRes(status, {})
      return jsonRes(200, { data: account })
    }
    if (url.pathname === "/chat/completion") {
      if (status !== 200) return jsonRes(status, { message: "refused" })
      return sseRes(frames)
    }
    throw new Error(`unexpected ${url.pathname}`)
  }
  return { impl, calls }
}

function loaderOf(plugin, auth = { type: "api", key: COOKIE }) {
  return plugin.auth.loader(async () => auth)
}

function chat(loader, body) {
  return loader.fetch("https://www.dola.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("config", () => {
  test("declares Dola with its two text models", async () => {
    const plugin = createPlugin()
    const cfg = { provider: {} }
    await plugin.config(cfg)
    expect(cfg.provider.dola).toMatchObject({
      name: "Dola",
      npm: "@ai-sdk/openai-compatible",
      api: BASE,
    })
    expect(Object.keys(cfg.provider.dola.models)).toEqual(["dola-fast", "dola-pro"])
    expect(cfg.provider.dola.models["dola-pro"].reasoning).toBe(true)
    expect(cfg.provider.dola.models["dola-fast"].attachment).toBe(false)
  })

  test("keeps a user's own provider settings and models", async () => {
    const plugin = createPlugin()
    const cfg = { provider: { dola: { name: "Mine", models: { "dola-fast": { name: "Custom" } } } } }
    await plugin.config(cfg)
    expect(cfg.provider.dola.name).toBe("Mine")
    expect(cfg.provider.dola.models["dola-fast"].name).toBe("Custom")
  })
})

describe("cookie handling", () => {
  test("normalizes a copied Cookie header", () => {
    expect(normalizeCookie("Cookie: a=1; b=2\n")).toBe("a=1; b=2")
    expect(normalizeCookie("a=1;\nb=2\n")).toBe("a=1; b=2")
    expect(normalizeCookie("a=1;;b=2;")).toBe("a=1; b=2")
  })

  test("recognizes a session and reads a value", () => {
    expect(hasSession(COOKIE)).toBe(true)
    expect(hasSession("s_v_web_id=x")).toBe(false)
    expect(cookieValue(COOKIE, "flow_cur_user_sec_id")).toBe("user-1")
  })
})

describe("sign-in", () => {
  test("pasting a cookie asks passport who it belongs to", async () => {
    const upstream = upstreamFetch()
    const plugin = createPlugin({ fetchImpl: upstream.impl })
    const saved = await plugin.auth.methods[1].authorize({ cookie: `Cookie: ${COOKIE}` })
    expect(saved).toMatchObject({
      type: "success",
      key: COOKIE,
      accountId: "42",
      metadata: { name: "Tester", source: "cookie" },
    })
  })

  test("a refused cookie fails the sign-in", async () => {
    const upstream = upstreamFetch({ status: 401 })
    const plugin = createPlugin({ fetchImpl: upstream.impl })
    expect(await plugin.auth.methods[1].authorize({ cookie: COOKIE })).toMatchObject({ type: "failed" })
  })

  test("passport's expired-session body fails the sign-in", async () => {
    const impl = async (input) => {
      const url = new URL(String(input))
      if (url.pathname.startsWith("/passport/account/info/v2"))
        return jsonRes(200, {
          data: {
            description: "session expired, please sign in again",
            error_code: 13,
            name: "account_info_error",
            session_key: "",
            user_id: 0,
          },
          message: "error",
        })
      throw new Error("unexpected " + url.pathname)
    }
    const plugin = createPlugin({ fetchImpl: impl })
    expect(await plugin.auth.methods[1].authorize({ cookie: COOKIE })).toMatchObject({ type: "failed" })
  })

  test("a cookie without a session is refused before any request", async () => {
    const upstream = upstreamFetch()
    const plugin = createPlugin({ fetchImpl: upstream.impl })
    const saved = await plugin.auth.methods[1].authorize({ cookie: "s_v_web_id=x" })
    expect(saved.type).toBe("failed")
    expect(upstream.calls).toHaveLength(0)
  })

  test("the browser flow reads cookies and finishes the callback", async () => {
    const upstream = upstreamFetch()
    const events = []
    const session = {
      cookies: async () => COOKIE,
      close: async () => events.push("closed"),
    }
    const plugin = createPlugin({
      fetchImpl: upstream.impl,
      openBrowser: async ({ url }) => {
        events.push(url)
        return session
      },
    })
    const flow = await plugin.auth.methods[0].authorize()
    expect(flow.method).toBe("auto")
    const saved = await flow.callback()
    expect(saved).toMatchObject({ type: "success", key: COOKIE, accountId: "42" })
    expect(events).toEqual(["https://www.dola.com/chat/", "closed"])
  })

  test("the browser flow reports a machine that cannot open one", async () => {
    const plugin = createPlugin({
      fetchImpl: upstreamFetch().impl,
      openBrowser: async () => {
        throw new Error("no display")
      },
    })
    const flow = await plugin.auth.methods[0].authorize()
    expect(flow.type).toBe("failed")
    expect(flow.error).toContain("粘贴 Dola Cookie")
  })
})

describe("requests", () => {
  test("a non-streamed request becomes an OpenAI completion", async () => {
    const upstream = upstreamFetch({ frames: [textEvent("Hel"), textEvent("lo")] })
    const plugin = createPlugin({ fetchImpl: upstream.impl })
    const loader = await loaderOf(plugin)
    const res = await chat(loader, { model: "dola-fast", messages: [{ role: "user", content: "hi" }] })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.choices[0].message.content).toBe("Hello")
    expect(body.choices[0].finish_reason).toBe("stop")
    expect(body.usage.prompt_tokens).toBeGreaterThan(0)
  })

  test("Pro's thinking is served as reasoning_content", async () => {
    const upstream = upstreamFetch({ frames: [textEvent("think", { thinking: true }), textEvent("answer")] })
    const plugin = createPlugin({ fetchImpl: upstream.impl })
    const loader = await loaderOf(plugin)
    const res = await chat(loader, { model: "dola-pro", messages: [{ role: "user", content: "hi" }] })
    const body = await res.json()
    expect(body.choices[0].message.reasoning_content).toBe("think")
    expect(body.choices[0].message.content).toBe("answer")
    const sent = JSON.parse(upstream.calls.find((c) => c.url.pathname === "/chat/completion").init.body)
    expect(sent.option.need_deep_think).toBe(3)
    expect(sent.ext.use_deep_think).toBe("3")
  })

  test("a streamed request emits SSE deltas and [DONE]", async () => {
    const upstream = upstreamFetch({ frames: [textEvent("Hel"), textEvent("lo")] })
    const plugin = createPlugin({ fetchImpl: upstream.impl })
    const loader = await loaderOf(plugin)
    const res = await chat(loader, { model: "dola-fast", stream: true, messages: [{ role: "user", content: "hi" }] })
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    const text = await res.text()
    expect(text).toContain('"content":"Hel"')
    expect(text).toContain('"content":"lo"')
    expect(text).toContain('"finish_reason":"stop"')
    expect(text).toContain("data: [DONE]")
  })

  test("a refused session is a 401 magpie can act on", async () => {
    const upstream = upstreamFetch({ status: 401 })
    const plugin = createPlugin({ fetchImpl: upstream.impl })
    const loader = await loaderOf(plugin)
    const res = await chat(loader, { model: "dola-fast", messages: [{ role: "user", content: "hi" }] })
    expect(res.status).toBe(401)
    expect(res.headers.get("x-magpie-sign-in")).toBe("expired")
  })

  test("Dola's high-demand stream error becomes a 429", async () => {
    const upstream = upstreamFetch({
      frames: [
        {
          event: "STREAM_ERROR",
          data: { error_msg: "We are experiencing high demand right now. Please try again later.", error_code: 710022002 },
        },
      ],
    })
    const plugin = createPlugin({ fetchImpl: upstream.impl })
    const loader = await loaderOf(plugin)
    const res = await chat(loader, { model: "dola-fast", messages: [{ role: "user", content: "hi" }] })
    expect(res.status).toBe(429)
  })

  test("an unknown model is refused without a request", async () => {
    const upstream = upstreamFetch()
    const plugin = createPlugin({ fetchImpl: upstream.impl })
    const loader = await loaderOf(plugin)
    const res = await chat(loader, { model: "nope", messages: [] })
    expect(res.status).toBe(404)
    expect(upstream.calls).toHaveLength(0)
  })

  test("no cookie is a 401", async () => {
    const plugin = createPlugin({ fetchImpl: upstreamFetch().impl })
    const loader = await loaderOf(plugin, { type: "api", key: "" })
    const res = await chat(loader, { model: "dola-fast", messages: [] })
    expect(res.status).toBe(401)
  })
})

describe("prompt", () => {
  test("flatten carries the system prompt, every turn and the tools", () => {
    const prompt = flatten({
      messages: [
        { role: "system", content: "Be terse." },
        { role: "user", content: "weather?" },
        { role: "assistant", content: "checking", tool_calls: [{ id: "1", function: { name: "w", arguments: '{"c":"x"}' } }] },
        { role: "tool", tool_call_id: "1", content: "sunny" },
        { role: "user", content: "thanks" },
      ],
      tools: [{ type: "function", function: { name: "w", description: "weather", parameters: { type: "object" } } }],
    })
    expect(prompt).toContain("Be terse.")
    expect(prompt).toContain("[user]\nweather?")
    expect(prompt).toContain('<tool_call>{"name":"w","arguments":{"c":"x"}}</tool_call>')
    expect(prompt).toContain("[tool result of w]\nsunny")
    expect(prompt).toContain("## w")
    expect(prompt).toContain("Write the next [assistant] turn now")
  })

  test("parse reads a tool call back and keeps the text", () => {
    const p = parse('Let me check.\n<tool_call>{"name":"w","arguments":{"c":"x"}}</tool_call>')
    expect(p.text).toBe("Let me check.")
    expect(p.calls).toHaveLength(1)
    expect(p.calls[0].function.name).toBe("w")
  })
})

describe("wire format", () => {
  test("buildBody creates a fresh conversation", () => {
    const body = buildBody({ text: "hi", deepThink: 0 })
    expect(body.client_meta.conversation_id).toBe("")
    expect(body.option.need_create_conversation).toBe(true)
    expect(body.messages[0].content_block[0].content.text_block.text).toBe("hi")
  })

  test("parseSseFrames reads event and data", () => {
    const frames = parseSseFrames('event: SSE_ACK\ndata: {"a":1}\n\nevent: STREAM_MSG_NOTIFY\ndata: {"b":2}\n\n')
    expect(frames).toEqual([
      { event: "SSE_ACK", data: { a: 1 } },
      { event: "STREAM_MSG_NOTIFY", data: { b: 2 } },
    ])
  })
})

describe("browser helpers", () => {
  test("keeps only dola.com cookies, HttpOnly included", () => {
    const header = cookieHeader([
      { name: "sessionid", value: "s", domain: ".dola.com", httpOnly: true },
      { name: "ttwid", value: "t", domain: "www.dola.com" },
      { name: "other", value: "x", domain: ".example.com" },
    ])
    expect(header).toBe("sessionid=s; ttwid=t")
  })

  test("browserArgs asks for remote debugging on loopback", () => {
    const args = browserArgs("/tmp/p", 9222, "https://www.dola.com/chat/", { headless: true })
    expect(args).toContain("--remote-debugging-port=9222")
    expect(args).toContain("--remote-debugging-address=127.0.0.1")
    expect(args).toContain("--headless=new")
    expect(args.at(-1)).toBe("https://www.dola.com/chat/")
  })

  test("findBrowser prefers DOLA_BROWSER", () => {
    expect(findBrowser({ env: { DOLA_BROWSER: "/opt/x" }, platform: "linux", exists: () => false })).toBe("/opt/x")
  })
})

describe("model table", () => {
  test("both models say text only and support tools", () => {
    for (const m of Object.values(MODELS)) expect(m.limit.context).toBe(256000)
    for (const m of Object.values(_internal.models()))
      expect(m).toMatchObject({ tool_call: true, attachment: false, modalities: { input: ["text"], output: ["text"] } })
  })
})
