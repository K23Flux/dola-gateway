// Model catalog for the Dola hub.
//
// Dola's web window builds its model menu from a static list in its public
// chat bundle (the `uF` array: "豆包 快速" and "豆包 专家"). That list is
// the live source of truth for what the web endpoint offers, so the hub
// reads it from the public page and bundle instead of calling the account
// API. No cookies, no completion request, no risk-control traffic.
//
// The fetch is cached for five minutes. A manual refresh uses the same
// cache: within five minutes it answers with the cached list and does not
// touch the network. On failure the previous list is kept and the next
// attempt waits five minutes, so a broken page is not hammered.

export const BUILTIN_MODELS = [
  {
    id: "dola-fast",
    name: "豆包 快速",
    selectedName: "快速",
    deepThink: 0,
    reasoning: false,
    context: 256000,
    needLogin: false,
  },
  {
    id: "dola-pro",
    name: "豆包 专家",
    selectedName: "豆包 专家",
    deepThink: 3,
    reasoning: true,
    context: 128000,
    needLogin: true,
  },
]

export const PAGE_URL = "https://www.dola.com/chat/"
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

const copyModels = (models) => models.map((m) => ({ ...m }))

// extractArray finds `name=[…]` in a JS bundle and returns the array text,
// balancing brackets while ignoring strings.
export function extractArray(source, name) {
  const match = new RegExp(name + "\\s*=\\s*\\[").exec(source)
  if (!match) return null
  let i = match.index + match[0].length - 1
  let depth = 0
  let quote = null
  let esc = false
  for (; i < source.length; i++) {
    const c = source[i]
    if (quote) {
      if (esc) esc = false
      else if (c === "\\") esc = true
      else if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c
      continue
    }
    if (c === "[") depth++
    else if (c === "]") {
      depth--
      if (depth === 0) return source.slice(match.index + match[0].length - 1, i + 1)
    }
  }
  return null
}

// topLevelObjects splits `[{…},{…}]` into its top-level object literals.
export function topLevelObjects(arrayText) {
  const out = []
  let depth = 0
  let quote = null
  let esc = false
  let start = -1
  for (let i = 0; i < arrayText.length; i++) {
    const c = arrayText[i]
    if (quote) {
      if (esc) esc = false
      else if (c === "\\") esc = true
      else if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c
      continue
    }
    if (c === "[" || c === "{") {
      if (c === "{" && depth === 1) start = i
      depth++
    } else if (c === "]" || c === "}") {
      depth--
      if (c === "}" && depth === 1 && start >= 0) {
        out.push(arrayText.slice(start, i + 1))
        start = -1
      }
    }
  }
  return out
}

const field = (text, name) => {
  const m = new RegExp(name + '\\s*:\\s*"([^"]*)"').exec(text)
  return m ? m[1] : ""
}

// parseBundleModels turns the bundle's `uF` entries into the two models the
// completion endpoint can select. Entries whose mode is not Fast/Pro are
// ignored: the endpoint's selector is `need_deep_think`, not a model name.
export function parseBundleModels(bundle) {
  const array = extractArray(bundle, "uF")
  if (!array) throw new Error("model list (uF) not found in the Dola chat bundle")
  const models = []
  const seen = new Set()
  for (const entry of topLevelObjects(array)) {
    const key = field(entry, "model_item_key")
    const name = field(entry, "name")
    const selectedName = field(entry, "selected_name") || name
    const menu = (entry.match(/menu_type\s*:\s*([A-Za-z0-9_.]+)/) || [])[1] || ""
    const windowSize = Number((entry.match(/total_window_size\s*:\s*"?(\d+)"?/) || [])[1]) || 0
    const needLogin = /need_login\s*:\s*(!0|true)/.test(entry)

    let id = ""
    let deepThink = 0
    let reasoning = false
    let context = 256000
    if (key === "0" || /DeepThinkOff/i.test(menu)) {
      id = "dola-fast"
      deepThink = 0
      reasoning = false
      context = windowSize || 256000
    } else if (key === "3" || /ProModel/i.test(menu)) {
      id = "dola-pro"
      deepThink = 3
      reasoning = true
      context = windowSize || 128000
    } else {
      continue
    }
    if (seen.has(id)) continue
    seen.add(id)
    models.push({
      id,
      name: name || (id === "dola-pro" ? "Dola Pro" : "Dola Fast"),
      selectedName,
      deepThink,
      reasoning,
      context,
      needLogin,
    })
  }
  if (!models.length) throw new Error("the Dola bundle had no supported Fast/Pro model")
  return models
}

async function fetchText(fetchImpl, url, timeoutMs) {
  const res = await fetchImpl(url, {
    headers: {
      "user-agent": UA,
      accept: "*/*",
      "accept-language": "en-US,en;q=0.9",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return await res.text()
}

// fetchLiveModels reads the public chat page, finds its hashed chat bundle,
// and parses the model menu out of it. No account cookie is sent.
export async function fetchLiveModels({ fetchImpl = globalThis.fetch } = {}) {
  const html = await fetchText(fetchImpl, PAGE_URL, 12000)
  const src =
    (html.match(/<script[^>]+src=["']([^"']*\/chat\.[a-z0-9]+\.js)["']/i) || [])[1] ||
    (html.match(/(\/[^"'\s<>]*\/chat\.[a-z0-9]+\.js)/i) || [])[1] ||
    ""
  if (!src) throw new Error("chat bundle not found in the Dola page")
  const bundleUrl = new URL(src, PAGE_URL).href
  const bundle = await fetchText(fetchImpl, bundleUrl, 20000)
  return { models: parseBundleModels(bundle), bundleUrl }
}

export function createModelCatalog({
  fetchImpl = globalThis.fetch,
  cacheMs = 5 * 60 * 1000,
  now = () => Date.now(),
} = {}) {
  let state = {
    models: copyModels(BUILTIN_MODELS),
    source: "builtin",
    fetchedAt: 0,
    error: "",
    bundleUrl: "",
  }
  let inflight = null

  function snapshot() {
    return {
      models: copyModels(state.models),
      source: state.source,
      fetchedAt: state.fetchedAt,
      nextAt: state.fetchedAt ? state.fetchedAt + cacheMs : 0,
      cacheSeconds: Math.round(cacheMs / 1000),
      error: state.error,
      bundleUrl: state.bundleUrl,
      refreshing: Boolean(inflight),
    }
  }

  function refresh({ force = false } = {}) {
    if (inflight) return inflight
    if (!force && state.fetchedAt && now() < state.fetchedAt + cacheMs) return Promise.resolve(snapshot())
    inflight = (async () => {
      try {
        const { models, bundleUrl } = await fetchLiveModels({ fetchImpl })
        state = {
          models,
          source: "live",
          fetchedAt: now(),
          error: "",
          bundleUrl,
        }
      } catch (e) {
        // keep the previous list; wait the full window before trying again
        state = {
          ...state,
          fetchedAt: now(),
          error: String(e?.message ?? e).slice(0, 300),
        }
      } finally {
        inflight = null
      }
      return snapshot()
    })()
    return inflight
  }

  return {
    refresh,
    snapshot,
    currentModels: () => state.models,
    find: (id) => state.models.find((m) => m.id === id) || null,
    cacheMs,
  }
}
