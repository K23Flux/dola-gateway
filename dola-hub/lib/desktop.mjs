// Desktop backend: 豆包工作 (DoubaoWork) / 豆包 (Doubao) driven the way a
// person uses it. The app's model menu is the live list, so models such as
// DeepSeek / GLM / Kimi that the web chat endpoint does not expose can be
// served through the same OpenAI-compatible API.
//
// This reuses the adapter from packages/doubao-work. It needs Windows or
// macOS and a signed-in app; Linux has neither app. Requests are serialized
// by the adapter because the app has one window.

import fs from "node:fs"
import { Doubao, DoubaoError, choose } from "../../packages/doubao-work/doubao.mjs"

export function createDesktopBackend({ doubao, available, app } = {}) {
  let clientInstance = doubao || null
  let lastModels = []
  let fetchedAt = 0
  let lastError = ""
  let appInfo = app || null
  let usable = available

  if (!doubao) {
    try {
      const c = choose()
      appInfo = { app: c.app?.name || "", binary: c.binary || "", dataDir: c.dataDir || "" }
      usable = Boolean(c.binary && fs.existsSync(c.binary))
    } catch (e) {
      appInfo = { app: "", binary: "", dataDir: "" }
      usable = false
      lastError = String(e?.message ?? e)
    }
  } else if (usable === undefined) {
    usable = true
  }
  if (!appInfo) appInfo = { app: "", binary: "", dataDir: "" }

  const missingHint =
    process.platform === "linux"
      ? "Linux 没有桌面版；请在 Windows/macOS 上运行网关，或继续使用网页模型"
      : "未找到豆包工作/豆包桌面版；请先安装并登录桌面版"

  function client() {
    if (!clientInstance) clientInstance = new Doubao()
    return clientInstance
  }

  function modelsFromTable(table) {
    return Object.entries(table || {}).map(([id, m]) => ({
      id,
      name: m?.name || m?.label || id,
      label: m?.label || m?.name || id,
      backend: "desktop",
      desktopId: id,
      context: 0,
      reasoning: true,
      needLogin: false,
      source: "desktop",
      ...(m?.rate ? { rate: m.rate } : {}),
    }))
  }

  function current() {
    if (!usable)
      return {
        models: [],
        available: false,
        app: appInfo,
        error: lastError || missingHint,
        fetchedAt,
      }
    if (!lastModels.length) {
      try {
        lastModels = modelsFromTable(client().modelList())
      } catch (e) {
        lastError = String(e?.message ?? e)
      }
    }
    return { models: lastModels, available: true, app: appInfo, error: lastError, fetchedAt }
  }

  async function refresh({ signal } = {}) {
    // the app may have been installed after the hub started
    if (!usable) {
      try {
        const c = choose()
        appInfo = { app: c.app?.name || "", binary: c.binary || "", dataDir: c.dataDir || "" }
        usable = Boolean(c.binary && fs.existsSync(c.binary))
      } catch (e) {
        lastError = String(e?.message ?? e)
      }
    }
    if (!usable) return current()
    try {
      const table = await client().discover({ signal })
      lastModels = modelsFromTable(table)
      fetchedAt = Date.now()
      lastError = ""
    } catch (e) {
      lastError = String(e?.message ?? e).slice(0, 500)
    }
    return current()
  }

  async function ask({ prompt, model, signal, onUpdate }) {
    if (!usable) throw new DoubaoError(missingHint, "app_missing", { status: 503 })
    const c = client()
    if (!c.modelList()[model]) {
      try {
        await c.discover({ signal })
      } catch (e) {
        if (!c.modelList()[model]) throw e
      }
    }
    if (!c.modelList()[model])
      throw new DoubaoError(`桌面版没有模型 ${model}；请在「模型」页点「获取桌面模型」`, "desktop_model_missing", {
        status: 404,
      })
    const read = await c.ask(prompt, { model, signal, onUpdate })
    return { text: read.text ?? "", reasoning: read.reasoning ?? "" }
  }

  return {
    current,
    refresh,
    ask,
    available: () => usable,
    app: () => appInfo,
    client: () => client(),
  }
}
