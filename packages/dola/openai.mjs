// What the plugin answers: an OpenAI chat completion, streamed as SSE or
// whole, built from Dola's reply. Dola streams cumulative text, so a
// Streamer turns successive reads into deltas and holds anything that may
// become a <tool_call> block.
import { heldFrom, parse } from "./prompt.mjs"

const enc = new TextEncoder()

export class Streamer {
  constructor() {
    this.text = ""
    this.shown = 0
    this.reasoning = ""
  }

  update({ text = "", reasoning = "" }) {
    const out = {}
    if (reasoning.startsWith(this.reasoning) && reasoning.length > this.reasoning.length) {
      out.reasoning = reasoning.slice(this.reasoning.length)
      this.reasoning = reasoning
    }
    if (text.startsWith(this.text.slice(0, this.shown))) {
      this.text = text
      const upto = heldFrom(text)
      if (upto > this.shown) {
        out.content = text.slice(this.shown, upto)
        this.shown = upto
      }
    }
    return out
  }

  finish(final, newId) {
    const p = parse(final?.text ?? this.text, newId)
    const shown = this.text.slice(0, this.shown)
    let content = p.raw.startsWith(shown) ? p.raw.slice(shown.length) : ""
    if (p.calls.length)
      content = content.replace(/```[a-z]*\s*```/gi, "").trim() ? content.replace(/```[a-z]*\s*```/gi, "").trimEnd() : ""
    return { content, calls: p.calls }
  }
}

// Dola reports no token counts, so both sides are estimated at one token
// per three characters; the prompt is the flattened request.
export function usageOf(promptText, text, reasoning = "") {
  const prompt_tokens = Math.ceil(String(promptText ?? "").length / 3)
  const completion_tokens = Math.ceil(((text ?? "").length + (reasoning ?? "").length) / 3)
  return { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens }
}

const chunk = (id, model, delta, finish = null, extra = {}) =>
  enc.encode(
    "data: " +
      JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta, finish_reason: finish }],
        ...extra,
      }) +
      "\n\n",
  )

// sse runs ask(onUpdate, signal) and streams what it reads. It resolves
// once the reply has begun, so a failure before that (not signed in, a
// refused session) goes back as an HTTP error, not as a 200 stream.
export async function sse({ id, model, ask, signal, promptText = "", newId }) {
  const st = new Streamer()
  const abort = new AbortController()
  const both = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal
  const buf = []
  let ctl = null
  let ended = false
  let failure = null
  let begun = false
  let onFirst
  const first = new Promise((r) => (onFirst = r))
  const push = (b) => (ctl ? ctl.enqueue(b) : buf.push(b))
  const deltas = (d) => {
    if (d.reasoning) push(chunk(id, model, { reasoning_content: d.reasoning }))
    if (d.content) push(chunk(id, model, { content: d.content }))
  }
  push(chunk(id, model, { role: "assistant", content: "" }))
  ;(async () => {
    try {
      const final = await ask((r) => {
        begun = true
        onFirst()
        deltas(st.update(r))
      }, both)
      begun = true
      deltas(st.update(final))
      const { content, calls } = st.finish(final, newId)
      if (content) push(chunk(id, model, { content }))
      if (calls.length)
        push(chunk(id, model, { tool_calls: calls.map((x, index) => ({ index, id: x.id, type: "function", function: x.function })) }))
      push(chunk(id, model, {}, calls.length ? "tool_calls" : "stop"))
      push(chunk(id, model, {}, null, { choices: [], usage: usageOf(promptText, final.text, final.reasoning) }))
      push(enc.encode("data: [DONE]\n\n"))
    } catch (e) {
      failure = e
      if (begun && !both.aborted)
        push(
          enc.encode(
            "data: " +
              JSON.stringify({ error: { message: String(e?.message ?? e), type: e?.code ?? "dola_error" } }) +
              "\n\n",
          ),
        )
    } finally {
      ended = true
      onFirst()
      if (ctl)
        try {
          ctl.close()
        } catch {}
    }
  })()
  await first
  if (failure && !begun) throw failure
  const stream = new ReadableStream({
    start(c) {
      ctl = c
      for (const b of buf.splice(0)) c.enqueue(b)
      if (ended) c.close()
    },
    cancel() {
      abort.abort()
    },
  })
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } })
}

export function completion({ id, model, final, promptText, newId }) {
  const { text, calls } = parse(final.text ?? "", newId)
  const message = { role: "assistant", content: text || (calls.length ? null : "") }
  if (final.reasoning) message.reasoning_content = final.reasoning
  if (calls.length) message.tool_calls = calls
  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: calls.length ? "tool_calls" : "stop" }],
    usage: usageOf(promptText, final.text, final.reasoning),
  }
}
