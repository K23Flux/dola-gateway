// Low-level client for dola.com's private web endpoint.
//
// Dola (dola.com) is the international build of ByteDance's Doubao/Cici.
// It has no public model API. This file talks to the same endpoint its own
// web window uses, with the session cookies a signed-in browser holds:
//
//   POST https://www.dola.com/chat/completion?aid=495671&device_platform=web…
//   headers: content-type: application/json, Agw-Js-Conv: str, cookie
//
// The endpoint answers Server-Sent Events. Answer text arrives in
// STREAM_MSG_NOTIFY (Fast) or STREAM_CHUNK patch_ops (Pro); Pro also
// streams a thinking block (Deep_Think), which the plugin serves as
// reasoning_content. There is no signing: the browser's a_bogus/msToken
// query parameters are not required.
//
// Every request creates a throwaway conversation (need_create_conversation)
// and leaves it there, so the proxy behaves like a stateless API.

import { randomUUID } from "node:crypto"

export const BASE = "https://www.dola.com"
export const DEFAULT_BOT_ID = "7339470689562525703"
export const DEFAULT_REGION = "AU"
export const DEFAULT_LANGUAGE = "en"

const AID = "495671"

const jsonHeaders = (cookie, { language = DEFAULT_LANGUAGE, origin = BASE } = {}) => ({
  "content-type": "application/json",
  accept: "text/event-stream, application/json",
  "Agw-Js-Conv": "str",
  cookie,
  origin,
  referer: `${BASE}/chat/`,
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "accept-language": language,
})

export class DolaError extends Error {
  constructor(message, { code = "dola_error", status = 502 } = {}) {
    super(message)
    this.name = "DolaError"
    this.code = code
    this.status = status
  }
}

// normalizeCookie accepts what a user copies from DevTools: the whole
// Cookie header, a `cookie:` prefix, or a cookie jar's newline-separated
// lines. It returns one `a=b; c=d` string.
export function normalizeCookie(input) {
  let s = String(input ?? "").trim()
  if (!s) return ""
  s = s.replace(/^cookie\s*:\s*/i, "")
  s = s
    .split(/\r?\n/)
    .flatMap((line) => line.split(";"))
    .map((part) => part.trim())
    .filter(Boolean)
    .join("; ")
  return s
}

// cookieValue reads one cookie out of a Cookie header.
export function cookieValue(cookie, name) {
  for (const part of String(cookie ?? "").split(";")) {
    const at = part.indexOf("=")
    if (at < 0) continue
    if (part.slice(0, at).trim() !== name) continue
    const value = part.slice(at + 1).trim()
    try {
      return decodeURIComponent(value)
    } catch {
      return value
    }
  }
  return ""
}

// hasSession says whether a Cookie header carries a signed-in session.
export function hasSession(cookie) {
  return Boolean(cookieValue(cookie, "sessionid") || cookieValue(cookie, "oauth_token"))
}

export function completionUrl({ region = DEFAULT_REGION, language = DEFAULT_LANGUAGE } = {}) {
  const q = new URLSearchParams({
    aid: AID,
    device_platform: "web",
    language,
    region,
    samantha_web: "1",
    sys_region: region,
    "use-olympus-account": "1",
    version_code: "20800",
    web_platform: "browser",
  })
  return `${BASE}/chat/completion?${q}`
}

export function accountInfoUrl({ region = DEFAULT_REGION, language = DEFAULT_LANGUAGE } = {}) {
  const q = new URLSearchParams({
    aid: AID,
    device_platform: "web",
    language,
    region,
    sys_region: region,
    "use-olympus-account": "1",
  })
  return `${BASE}/passport/account/info/v2/?${q}`
}

// A text message (content block 10000).
function textMessage(text) {
  return {
    local_message_id: randomUUID(),
    content_block: [
      {
        block_type: 10000,
        content: {
          text_block: { text, icon_url: "", icon_url_dark: "", summary: "" },
          pc_event_block: "",
        },
        block_id: randomUUID(),
        parent_id: "",
        meta_info: [],
        append_fields: [],
      },
    ],
    message_status: 0,
  }
}

// buildBody is the body the web window sends. deepThink is 0 (Fast) or
// 3 (Pro); a fresh conversation is created on every request.
export function buildBody({ text, deepThink = 0, botId = DEFAULT_BOT_ID } = {}) {
  return {
    client_meta: {
      local_conversation_id: "local_" + Date.now() + Math.floor(Math.random() * 1e6),
      conversation_id: "",
      bot_id: botId,
      last_section_id: "",
      last_message_index: null,
    },
    messages: [textMessage(text ?? "")],
    option: {
      send_message_scene: "",
      create_time_ms: Date.now(),
      collect_id: "",
      is_audio: false,
      answer_with_suggest: false,
      tts_switch: false,
      need_deep_think: deepThink,
      click_clear_context: false,
      from_suggest: false,
      is_regen: false,
      is_replace: false,
      is_from_click_option: false,
      is_from_click_softlink: false,
      disable_sse_cache: false,
      select_text_action: "",
      is_select_text: false,
      resend_for_regen: false,
      scene_type: 0,
      unique_key: randomUUID(),
      start_seq: 0,
      need_create_conversation: true,
      regen_query_id: [],
      edit_query_id: [],
      regen_instruction: "",
      no_replace_for_regen: false,
      message_from: 0,
      shared_app_name: "",
      shared_app_id: "",
      sse_recv_event_options: { support_chunk_delta: true },
      is_ai_playground: false,
      is_old_user: false,
      recovery_option: {
        is_recovery: false,
        req_create_time_sec: Math.floor(Date.now() / 1000),
        append_sse_event_scene: 0,
      },
      message_storage_type: 0,
    },
    user_context: [],
    ext: {
      use_deep_think: String(deepThink),
      fp: "",
      collection_id: "",
      commerce_credit_config_enable: "0",
    },
  }
}

const SSE_FRAME_END = /\r\n\r\n|\n\n|\r\r/
const SSE_LINE_END = /\r\n|\n|\r/

// takeSseFrame returns the first complete frame in buffer and what follows
// it. SSE permits LF, CRLF and CR line endings, so all three frame endings
// have to be recognised while the stream is still arriving.
function takeSseFrame(buffer) {
  let best = null
  for (const delimiter of ["\r\n\r\n", "\n\n", "\r\r"]) {
    const at = buffer.indexOf(delimiter)
    if (at < 0) continue
    if (!best || at < best.at || (at === best.at && delimiter.length > best.delimiter.length))
      best = { at, delimiter }
  }
  return best ? { block: buffer.slice(0, best.at), rest: buffer.slice(best.at + best.delimiter.length) } : null
}

// parseSseFrames turns a buffer of `event:`/`data:` blocks into records.
export function parseSseFrames(buffer) {
  const frames = []
  for (const raw of String(buffer).split(SSE_FRAME_END)) {
    const block = raw.trim()
    if (!block) continue
    let event = "message"
    const dataLines = []
    for (const line of block.split(SSE_LINE_END)) {
      if (line.startsWith("event:")) event = line.slice(6).trim()
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""))
    }
    let parsed = null
    if (dataLines.length) {
      try {
        parsed = JSON.parse(dataLines.join("\n"))
      } catch {}
    }
    frames.push({ event, data: parsed })
  }
  return frames
}

// isThinkingBlock tells Pro's reasoning stream (the Deep_Think tool icon)
// from the answer text.
function isThinkingBlock(textBlock) {
  return /Deep_Think/i.test(textBlock?.icon_url || "") || /Deep_Think/i.test(textBlock?.icon_url_dark || "")
}

function applyTextBlock(textBlock, out, onUpdate) {
  if (!textBlock || typeof textBlock.text !== "string" || !textBlock.text) return
  if (isThinkingBlock(textBlock)) out.thinking += textBlock.text
  else out.text += textBlock.text
  onUpdate?.({ text: out.text, reasoning: out.thinking })
}

// streamCompletion sends one prompt and reads the reply to its end.
// onUpdate receives the cumulative { text, reasoning } as it grows.
export async function streamCompletion({
  cookie,
  text,
  deepThink = 0,
  botId = DEFAULT_BOT_ID,
  region = DEFAULT_REGION,
  language = DEFAULT_LANGUAGE,
  signal,
  fetchImpl = globalThis.fetch,
  onUpdate,
} = {}) {
  if (!cookie) throw new DolaError("Dola is not signed in", { code: "signin_required", status: 401 })

  let res
  try {
    res = await fetchImpl(completionUrl({ region, language }), {
      method: "POST",
      headers: jsonHeaders(cookie, { language }),
      body: JSON.stringify(buildBody({ text, deepThink, botId })),
      signal,
    })
  } catch (e) {
    if (e?.name === "AbortError") throw e
    throw new DolaError(`Dola could not be reached: ${e?.message ?? e}`, { code: "network_error" })
  }

  if (res.status === 401 || res.status === 403) {
    throw new DolaError("Dola refused the session cookies; sign in again", {
      code: "signin_expired",
      status: 401,
    })
  }
  if (res.status === 429) {
    throw new DolaError("Dola is rate limiting this account", { code: "rate_limited", status: 429 })
  }
  if (!res.ok) {
    // Neither a free-form upstream message nor an arbitrary error-code
    // string is safe to include in logs or API responses.
    await res.body?.cancel().catch(() => {})
    throw new DolaError(`Dola HTTP ${res.status}`, {
      code: "upstream_error",
      status: 502,
    })
  }

  const out = { text: "", thinking: "", conversationId: "", messageId: "" }
  const reader = res.body?.getReader()
  if (!reader) throw new DolaError("Dola returned no stream", { code: "upstream_error" })
  const decoder = new TextDecoder()
  let buffer = ""

  const handle = (frames) => {
    for (const f of frames) {
      if (f.event === "STREAM_ERROR") {
        const err = f.data ?? {}
        const message = String(err.error_msg ?? "unknown")
        // 710022002 is "high demand, try again later", which is a rate
        // limit in practice; a session error is worth marking.
        const rate =
          Number(err.error_code) === 710022002 ||
          /high demand|try again later|rate.?limit|too many|稍后|频繁/i.test(message)
        const lapsed = /sign in|log in|login|session|unauthorized|expired|未登录|登录/i.test(message)
        // Use the raw message only to classify the error, never to expose
        // upstream content to API clients, request logs or error inspectors.
        throw new DolaError(
          lapsed
            ? "Dola refused the session cookies; sign in again"
            : rate
              ? "Dola is rate limiting this account"
              : "Dola stream failed",
          {
            code: lapsed ? "signin_expired" : rate ? "rate_limited" : "upstream_error",
            status: lapsed ? 401 : rate ? 429 : 502,
          },
        )
      }
      if (f.event === "SSE_ACK" && f.data?.ack_client_meta) {
        out.conversationId = f.data.ack_client_meta.conversation_id || out.conversationId
      }
      if (f.event === "STREAM_MSG_NOTIFY" && f.data) {
        for (const cb of f.data.content?.content_block || []) applyTextBlock(cb.content?.text_block, out, onUpdate)
      }
      if (f.event === "STREAM_CHUNK" && f.data) {
        for (const op of f.data.patch_op || []) {
          for (const cb of op.patch_value?.content_block || []) applyTextBlock(cb.content?.text_block, out, onUpdate)
        }
        if (f.data.message_id) out.messageId = f.data.message_id
      }
    }
  }

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    for (;;) {
      const frame = takeSseFrame(buffer)
      if (!frame) break
      handle(parseSseFrames(frame.block))
      buffer = frame.rest
    }
  }
  if (buffer.trim()) handle(parseSseFrames(buffer))
  return out
}

// findAccount walks a passport reply for the account's id and display name.
function findAccount(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 6) return null
  const rawId =
    value.user_id ?? value.userId ?? value.uid ?? value.sec_uid ?? value.sec_user_id ?? value.secUserId ?? null
  const rawName =
    value.screen_name ?? value.screenName ?? value.name ?? value.user_name ?? value.username ?? value.nickname ?? null
  // passport's failure body carries user_id 0 and name "account_info_error"
  const id = rawId == null || String(rawId) === "0" ? "" : String(rawId)
  const name = rawName == null || String(rawName) === "account_info_error" ? "" : String(rawName)
  if (id || name) return { id, name }
  for (const v of Object.values(value)) {
    const found = findAccount(v, depth + 1)
    if (found) return found
  }
  return null
}

// accountInfo asks passport who these cookies belong to. It is best
// effort: an unreachable or unusual reply falls back to the cookie's own
// user id, so sign-in still succeeds.
export async function accountInfo({
  cookie,
  region = DEFAULT_REGION,
  language = DEFAULT_LANGUAGE,
  fetchImpl = globalThis.fetch,
  signal = AbortSignal.timeout(15000),
} = {}) {
  const fallback = {
    accountId: cookieValue(cookie, "flow_cur_user_sec_id") || "",
    name: "",
    lapsed: false,
    error: "",
  }
  let res
  try {
    res = await fetchImpl(accountInfoUrl({ region, language }), {
      method: "GET",
      headers: {
        accept: "application/json",
        "Agw-Js-Conv": "str",
        cookie,
        origin: BASE,
        referer: `${BASE}/chat/`,
        "user-agent": jsonHeaders(cookie)["user-agent"],
      },
      signal,
    })
  } catch (e) {
    return { ...fallback, error: `account info unreachable: ${e?.message ?? e}` }
  }
  if (res.status === 401 || res.status === 403) return { ...fallback, lapsed: true }
  if (!res.ok) return { ...fallback, error: `account info HTTP ${res.status}` }
  let body
  try {
    body = await res.json()
  } catch {
    return { ...fallback, error: "account info was not JSON" }
  }
  // passport answers an expired or guest session with HTTP 200 and
  // {"data":{"name":"account_info_error","error_code":13,…},"message":"error"}
  const data = body?.data ?? body
  if (body?.message === "error" || data?.error_code) {
    const description = String(data?.description ?? body?.message ?? "account info error")
    return {
      ...fallback,
      lapsed: /session expired|not login|未登录|sign in again/i.test(description),
      error: description,
    }
  }
  const found = findAccount(data)
  if (!found) return { ...fallback, error: "account info had no account" }
  return {
    accountId: found.id || fallback.accountId,
    name: found.name,
    lapsed: false,
    error: "",
  }
}
