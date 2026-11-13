// Dola (dola.com), the international build of ByteDance's Doubao/Cici, as
// an OpenAI-compatible model provider.
//
// Dola has no public model API. This plugin talks to the endpoint its own
// web window uses, with the session cookies a signed-in browser holds:
// every request opens a throwaway conversation, sends the flattened chat
// request, and reads the SSE reply back as an OpenAI completion. Sign in
// by letting the plugin open a browser and waiting for the login callback,
// or paste the Cookie header of an already signed-in session.
//
// Several Dola accounts can be signed in to magpie at once; each sign-in
// carries its own accountId, and magpie's rotate routing (or smart/usage)
// spreads requests over them, moving off an account that answers 401/429.
// See README.md for what this costs.

import { createHash } from "node:crypto"
import {
  DEFAULT_BOT_ID,
  DEFAULT_LANGUAGE,
  DEFAULT_REGION,
  DolaError,
  accountInfo,
  cookieValue,
  hasSession,
  normalizeCookie,
  streamCompletion,
} from "./dola.mjs"
import { LOGIN_URL, openLoginBrowser } from "./browser.mjs"
import { completion, sse } from "./openai.mjs"
import { flatten } from "./prompt.mjs"

const ID = "dola"
const BASE = "https://www.dola.com/v1"

const MODELS = {
  "dola-fast": {
    name: "Dola Fast",
    limit: { context: 256000, output: 32768 },
    reasoning: false,
  },
  "dola-pro": {
    name: "Dola Pro",
    limit: { context: 256000, output: 32768 },
    reasoning: true,
  },
}

function models() {
  const out = {}
  for (const [id, m] of Object.entries(MODELS))
    out[id] = {
      name: m.name,
      limit: m.limit,
      tool_call: true,
      reasoning: m.reasoning,
      attachment: false,
      modalities: { input: ["text"], output: ["text"] },
    }
  return out
}

const json = (status, message, type, headers = {}) =>
  new Response(JSON.stringify({ error: { message, type } }), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  })

const textOf = (e) => String(e?.message ?? e ?? "unknown error").slice(0, 500)

// cookieOf reads the Cookie header out of whatever shape the host saved.
function cookieOf(auth) {
  return normalizeCookie(auth?.key ?? auth?.access ?? auth?.metadata?.cookie ?? auth?.metadata?.v1?.key ?? "")
}

// accountIdOf names the account for magpie: Dola's own user id when
// passport answered, else the cookie's user id, else a short hash so two
// accounts never collapse into one.
function accountIdOf(cookie, info) {
  const sec = cookieValue(cookie, "flow_cur_user_sec_id")
  return (
    (info?.accountId && info.accountId !== "0" ? info.accountId : "") ||
    (sec && sec !== "0" ? sec : "") ||
    "dola-" + createHash("sha256").update(cookie).digest("hex").slice(0, 12)
  )
}

function errorResponse(e) {
  const code = e?.code ?? "dola_error"
  const status = Number(e?.status) || 502
  const headers = {}
  if (code === "signin_expired" || code === "signin_required") headers["X-Magpie-Sign-In"] = "expired"
  if (code === "rate_limited") headers["Retry-After"] = "60"
  return json(status, textOf(e), code, headers)
}

export function createPlugin({
  fetchImpl = globalThis.fetch,
  openBrowser = openLoginBrowser,
  botId = DEFAULT_BOT_ID,
  region = process.env.DOLA_REGION || DEFAULT_REGION,
  language = process.env.DOLA_LANGUAGE || DEFAULT_LANGUAGE,
} = {}) {
  async function signIn(cookie, source) {
    const clean = normalizeCookie(cookie)
    if (!hasSession(clean)) {
      return {
        type: "failed",
        error: "这串 Cookie 里没有 sessionid 或 oauth_token。请在已登录的 dola.com 请求里复制完整的 Cookie 请求头。",
      }
    }
    const info = await accountInfo({ cookie: clean, fetchImpl, region, language })
    if (info.lapsed) return { type: "failed", error: "Dola 不认这串 Cookie，登录可能已过期，请重新登录后再复制。" }
    const accountId = accountIdOf(clean, info)
    return {
      type: "success",
      key: clean,
      accountId,
      metadata: {
        ...(info.name ? { name: info.name } : {}),
        source,
        ...(info.error ? { note: info.error } : {}),
      },
    }
  }

  return {
    config(cfg) {
      cfg.provider ??= {}
      const was = cfg.provider[ID] ?? {}
      cfg.provider[ID] = {
        name: "Dola",
        npm: "@ai-sdk/openai-compatible",
        api: BASE,
        ...was,
        models: { ...models(), ...(was.models ?? {}) },
      }
    },

    auth: {
      provider: ID,
      methods: [
        {
          type: "oauth",
          label: "Dola 网页登录（浏览器自动回调）",
          async authorize(_inputs, _options) {
            let session
            try {
              session = await openBrowser({ url: LOGIN_URL })
            } catch (e) {
              return {
                type: "failed",
                error:
                  textOf(e) +
                  " 也可以用「粘贴 Dola Cookie」：在任意设备登录 dola.com 后，从请求头复制 Cookie。",
              }
            }
            return {
              url: "",
              instructions:
                "已打开一个独立的 Dola 登录窗口（不影响你平时用的浏览器）。请在其中登录；登录完成后这个窗口会自动关闭，插件会读取会话并完成添加。",
              method: "auto",
              opened: true,
              callback: async (_code, { signal } = {}) => {
                try {
                  const cookie = await session.cookies(5 * 60 * 1000, { signal })
                  if (!cookie) {
                    return {
                      type: "failed",
                      error: "五分钟内没有读到 Dola 的登录会话。请重新发起登录，并在打开的窗口里完成登录。",
                    }
                  }
                  return await signIn(cookie, "browser")
                } catch (e) {
                  return { type: "failed", error: textOf(e) }
                } finally {
                  await session.close()
                }
              },
            }
          },
        },
        {
          type: "api",
          label: "粘贴 Dola Cookie",
          placeholder: "sessionid=…; oauth_token=…",
          prompts: [
            {
              type: "password",
              key: "cookie",
              message: "Dola 的 Cookie（登录 dola.com 后，从任意请求的 Cookie 请求头复制整段）",
              validate: (v) => (hasSession(normalizeCookie(v)) ? undefined : "需要包含 sessionid 或 oauth_token"),
            },
          ],
          async authorize(inputs) {
            return await signIn(inputs?.cookie, "cookie")
          },
        },
      ],

      async loader(getAuth) {
        return {
          baseURL: BASE,
          apiKey: "dola-cookie",
          async fetch(input, init = {}) {
            const request = input instanceof Request ? new Request(input, init) : null
            const url = new URL(request ? request.url : String(input))
            const method = request ? request.method : init.method ?? "GET"
            if (!url.pathname.endsWith("/chat/completions") || method !== "POST")
              return json(404, "Dola 只提供 chat/completions。", "not_found")

            const auth = await getAuth()
            const cookie = cookieOf(auth)
            if (!cookie) return json(401, "Dola 还没有登录。", "signin_required", { "X-Magpie-Sign-In": "expired" })

            let body
            try {
              const raw = request
                ? await request.text()
                : typeof init.body === "string"
                  ? init.body
                  : await new Response(init.body).text()
              body = JSON.parse(raw)
            } catch {
              return json(400, "请求不是 JSON。", "invalid_request_error")
            }

            const model = String(body.model ?? "dola-fast").replace(/^dola\//, "")
            if (!MODELS[model])
              return json(404, `没有模型 ${model}。可用：${Object.keys(MODELS).join("、")}。`, "model_not_found")

            const prompt = flatten(body)
            const deepThink = model === "dola-pro" ? 3 : 0
            const id = "chatcmpl-" + Math.random().toString(36).slice(2)
            const signal = request ? request.signal : init.signal
            const ask = async (onUpdate, askSignal) => {
              const read = await streamCompletion({
                cookie,
                text: prompt,
                deepThink,
                botId,
                region,
                language,
                signal: askSignal,
                fetchImpl,
                onUpdate,
              })
              return { text: read.text, reasoning: read.thinking }
            }

            try {
              if (body.stream) return await sse({ id, model, signal, ask, promptText: prompt })
              const final = await ask(undefined, signal)
              return Response.json(completion({ id, model, final, promptText: prompt }))
            } catch (e) {
              if (e?.name === "AbortError" || e?.name === "TimeoutError") throw e
              return errorResponse(e)
            }
          },
        }
      },
    },
  }
}

export async function DolaPlugin() {
  return createPlugin()
}

export default DolaPlugin

export const _internal = {
  createPlugin,
  models,
  cookieOf,
  accountIdOf,
  errorResponse,
  MODELS,
  ID,
  BASE,
  DolaError,
}
