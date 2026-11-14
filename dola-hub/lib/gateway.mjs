// OpenAI-compatible face of the Dola hub: /v1/models and
// /v1/chat/completions. Every request picks an account from the pool,
// flattens the chat into the one message Dola takes, and streams the reply
// back as OpenAI SSE. A failure before the first delta moves to the next
// account; a failure after it is reported to the client.

import { Readable } from "node:stream"
import { randomUUID } from "node:crypto"
import { completion, sse } from "../../packages/dola/openai.mjs"
import { flatten, toolPolicy } from "../../packages/dola/prompt.mjs"
import { streamCompletion } from "../../packages/dola/dola.mjs"
import { BUILTIN_MODELS } from "./models.mjs"

const FALLBACK_CATALOG = {
  currentModels: () => BUILTIN_MODELS.map((m) => ({ ...m, backend: "web" })),
  find: (id) => BUILTIN_MODELS.find((m) => m.id === id) || null,
  snapshot: () => ({
    models: BUILTIN_MODELS,
    source: "builtin",
    fetchedAt: 0,
    nextAt: 0,
    error: "",
    refreshing: false,
  }),
}

export class HubError extends Error {
  constructor(message, status = 502, code = "hub_error") {
    super(message)
    this.name = "HubError"
    this.status = status
    this.code = code
  }
}

const estimate = (text) => Math.ceil(String(text ?? "").length / 3)

function matchesModel(patterns, model) {
  if (!Array.isArray(patterns) || !patterns.length) return true
  return patterns.some((p) => {
    const s = String(p).trim()
    if (!s) return false
    if (!s.includes("*")) return s === model
    const rx = new RegExp("^" + s.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$")
    return rx.test(model)
  })
}

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Headers", "authorization, content-type, x-session-id")
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
  res.setHeader("Access-Control-Max-Age", "86400")
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  })
  res.end(text)
}

function sendError(res, status, message, type = "hub_error") {
  sendJson(res, status, { error: { message: String(message).slice(0, 1000), type } })
}

function pipeSse(res, response) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  })
  const readable = Readable.fromWeb(response.body)
  readable.pipe(res)
  res.on("close", () => readable.destroy())
}

function readJson(req, limit = 16 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on("data", (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new HubError(`request body is larger than ${limit} bytes`, 413, "payload_too_large"))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8")
        resolve(text ? JSON.parse(text) : {})
      } catch {
        reject(new HubError("request body is not JSON", 400, "invalid_request_error"))
      }
    })
    req.on("error", reject)
  })
}

function requestSignal(req, res) {
  const ac = new AbortController()
  req.on("aborted", () => ac.abort(new HubError("client aborted", 499, "client_aborted")))
  res.on("close", () => {
    if (!res.writableEnded) ac.abort(new HubError("client closed", 499, "client_aborted"))
  })
  return ac.signal
}

const retryable = (e) =>
  e?.code === "signin_expired" ||
  e?.code === "signin_required" ||
  e?.code === "rate_limited" ||
  e?.code === "network_error" ||
  e?.code === "upstream_error" ||
  Number(e?.status) === 429 ||
  Number(e?.status) >= 500

export function createGateway({
  store,
  pool,
  log,
  catalog = FALLBACK_CATALOG,
  desktop = null,
  client = { streamCompletion },
}) {
  async function handle(req, res, key, url) {
    cors(res)
    if (req.method === "OPTIONS") {
      res.writeHead(204)
      res.end()
      return
    }

    if (url.pathname === "/v1/models" || url.pathname === "/models") {
      if (req.method !== "GET") return sendError(res, 405, "method not allowed", "method_not_allowed")
      return sendJson(res, 200, {
        object: "list",
        data: catalog
          .currentModels()
          .filter((m) => matchesModel(key.models, m.id))
          .map((m) => ({
            id: m.id,
            object: "model",
            created: 0,
            owned_by: "dola",
            name: m.name,
            context_window: m.context,
          })),
      })
    }

    if (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions") {
      if (req.method !== "POST") return sendError(res, 405, "method not allowed", "method_not_allowed")
      return chat(req, res, key)
    }

    sendError(res, 404, "not found", "not_found")
  }

  async function chat(req, res, key) {
    let body
    try {
      body = await readJson(req)
    } catch (e) {
      return sendError(res, e.status || 400, e.message, e.code)
    }

    const model = String(body.model ?? "dola-fast").replace(/^dola\//, "")
    const modelInfo = catalog.find(model)
    if (!modelInfo)
      return sendError(
        res,
        404,
        `unknown model ${model}; use ${catalog.currentModels().map((m) => m.id).join(" or ")}`,
        "model_not_found",
      )
    if (!matchesModel(key.models, model))
      return sendError(res, 403, `this API key is not allowed to use ${model}`, "model_not_allowed")

    const prompt = flatten(body)
    const policy = toolPolicy(body)
    const deepThink = Number(modelInfo.deepThink) || 0
    const sessionKey = String(body.user ?? req.headers["x-session-id"] ?? body.metadata?.session_id ?? "").slice(0, 256)
    const id = "chatcmpl-" + randomUUID().replace(/-/g, "").slice(0, 24)
    const started = Date.now()
    const signal = requestSignal(req, res)
    let logged = false

    const record = (status, account, error, finalText = "", reasoning = "") => {
      if (logged) return
      logged = true
      log.record({
        key: key.name,
        model,
        account: account?.accountId ?? "",
        status,
        durationMs: Date.now() - started,
        promptTokens: estimate(prompt),
        completionTokens: estimate(finalText) + estimate(reasoning),
        error: error ? String(error?.message ?? error).slice(0, 300) : "",
      })
      key.stats = key.stats || { requests: 0, success: 0, failure: 0 }
      key.stats.requests = (Number(key.stats.requests) || 0) + 1
      if (status < 400) key.stats.success = (Number(key.stats.success) || 0) + 1
      else key.stats.failure = (Number(key.stats.failure) || 0) + 1
      store.save()
    }

    const ask = async (onUpdate, askSignal) => {
      const tried = new Set()
      const max = Math.max(1, Number(store.state.settings.maxAttempts) || 3)
      let lastError = null
      for (let attempt = 0; attempt < max; attempt++) {
        const account = pool.pick({ sessionKey, exclude: tried })
        if (!account) {
          // keep the account's own failure (a 401 is more useful than
          // "no account") when this was a failover
          if (!lastError) lastError = new HubError("没有可用账号：请先在面板添加账号，或等待冷却结束", 503, "no_account")
          break
        }
        tried.add(account.id)
        pool.acquire(account)
        let committed = false
        try {
          const read = await client.streamCompletion({
            cookie: account.cookie,
            text: prompt,
            deepThink,
            region: store.state.settings.region,
            language: store.state.settings.language,
            botId: store.state.settings.botId,
            signal: askSignal,
            onUpdate: (r) => {
              committed = true
              onUpdate?.(r)
            },
          })
          pool.success(account)
          record(200, account, "", read.text, read.thinking)
          return { text: read.text, reasoning: read.thinking, account }
        } catch (e) {
          lastError = e
          pool.failure(account, e)
          if (committed || !retryable(e)) {
            record(Number(e?.status) || 502, account, e?.message ?? e)
            throw e
          }
          // not committed yet: try the next account
        } finally {
          pool.release(account)
        }
      }
      record(Number(lastError?.status) || 503, null, lastError?.message ?? "no account")
      throw lastError ?? new HubError("没有可用账号", 503, "no_account")
    }

    // Desktop models (DeepSeek / GLM / Kimi / ...) come from the app's own
    // menu, not from the web account pool. The adapter serializes requests.
    if (modelInfo.backend === "desktop") {
      if (!desktop) return sendError(res, 503, "桌面版后端未启用", "desktop_unavailable")
      const statusOf = (e) =>
        Number(e?.status) ||
        (e?.code === "doubao_signed_out"
          ? 401
          : e?.code === "doubao_upgrade"
            ? 403
            : e?.code === "doubao_timeout"
              ? 504
              : e?.code === "desktop_model_missing"
                ? 404
                : 502)
      const askDesktop = async (onUpdate, askSignal) => {
        try {
          const read = await desktop.ask({
            prompt,
            model: modelInfo.desktopId || modelInfo.id,
            signal: askSignal,
            onUpdate,
          })
          record(200, { accountId: "desktop" }, "", read.text, read.reasoning)
          return read
        } catch (e) {
          record(statusOf(e), { accountId: "desktop" }, e?.message ?? e)
          throw e
        }
      }
      try {
        if (body.stream) {
          const response = await sse({ id, model, ask: askDesktop, signal, promptText: prompt, policy })
          return pipeSse(res, response)
        }
        const final = await askDesktop(undefined, signal)
        return sendJson(res, 200, completion({ id, model, final, promptText: prompt, policy }))
      } catch (e) {
        if (res.headersSent) {
          try {
            res.end()
          } catch {}
          return
        }
        if (e?.name === "AbortError" || e?.code === "client_aborted") return
        return sendError(res, statusOf(e), e?.message ?? e, e?.code ?? "desktop_error")
      }
    }

    try {
      if (body.stream) {
        const response = await sse({ id, model, ask, signal, promptText: prompt, policy })
        return pipeSse(res, response)
      }
      const final = await ask(undefined, signal)
      const out = completion({ id, model, final, promptText: prompt, policy })
      sendJson(res, 200, out)
    } catch (e) {
      if (res.headersSent) {
        try {
          res.end()
        } catch {}
        return
      }
      if (e?.name === "AbortError" || e?.code === "client_aborted") return
      sendError(res, Number(e?.status) || 502, e?.message ?? e, e?.code ?? "upstream_error")
    }
  }

  return { handle, models: () => catalog.currentModels() }
}
