import { test } from "node:test"
import assert from "node:assert/strict"
import {
  BUILTIN_MODELS,
  createModelCatalog,
  extractArray,
  parseBundleCatalog,
  parseBundleModels,
  parseTaskModels,
  topLevelObjects,
} from "../lib/models.mjs"

const BUNDLE = `var x=1;var uF=[{item_id:uN.b.Off,menu_type:um.d.DeepThinkOff,model_item_key:"0",name:"豆包 快速",selected_name:"快速",need_login:!1,conversation_mode_list:["chat","creation"],reasoning_effort_config:{default_level:uN.i.LOW,option_list:uL}},{item_id:uN.b.Pro,menu_type:um.d.ProModel,model_item_key:"3",name:"豆包 专家",selected_name:"豆包 专家",need_login:!0,conversation_mode_list:["chat","creation"],model_extra_params:{total_window_size:"128000"},reasoning_effort_config:{default_level:uN.i.MEDIUM,option_list:uL}}];var uB={item_id:uN.b.TaskModelFromGateway,model_item_key:"seed-lite-7b",name:"豆包 2.1 Lite",show_task_tools:1,default_mode:"3",conversation_mode_list:["office","creation"],need_login:!0};var uU={item_id:uN.b.TaskPro,model_item_key:"5",name:"豆包 2.1 Pro",need_login:!0,show_task_tools:1,default_mode:"3",conversation_mode_list:["office","creation"]};var uz={item_id:uN.b.TaskAuto,model_item_key:"9",name:"自动",need_login:!0,show_task_tools:1,default_mode:"3",conversation_mode_list:["office","creation"]};`

const HTML = '<html><script src="//cdn.example/chat.abc123.js"></script></html>'

test("extractArray balances brackets and ignores strings", () => {
  const text = 'var uF=[{name:"a[b]c"},{x:1}];var after=1'
  assert.equal(extractArray(text, "uF"), '[{name:"a[b]c"},{x:1}]')
  assert.equal(extractArray("no array here", "uF"), null)
})

test("topLevelObjects splits the array entries", () => {
  const parts = topLevelObjects('[{"a":1},{"b":{"c":2}}]')
  assert.equal(parts.length, 2)
  assert.equal(parts[0], '{"a":1}')
  assert.equal(parts[1], '{"b":{"c":2}}')
})

test("parseBundleModels maps the Fast and Pro entries", () => {
  const models = parseBundleModels(BUNDLE)
  assert.equal(models.length, 2)
  const fast = models.find((m) => m.id === "dola-fast")
  const pro = models.find((m) => m.id === "dola-pro")
  assert.equal(fast.name, "豆包 快速")
  assert.equal(fast.deepThink, 0)
  assert.equal(fast.reasoning, false)
  assert.equal(fast.needLogin, false)
  assert.equal(pro.name, "豆包 专家")
  assert.equal(pro.deepThink, 3)
  assert.equal(pro.reasoning, true)
  assert.equal(pro.context, 128000)
})

test("parseBundleCatalog lists the task models as not connected", () => {
  const catalog = parseBundleCatalog(BUNDLE)
  assert.equal(catalog.models.length, 2)
  assert.deepEqual(
    catalog.otherModels.map((m) => m.name),
    ["豆包 2.1 Lite", "豆包 2.1 Pro", "自动"],
  )
  for (const m of catalog.otherModels) {
    assert.equal(m.supported, false)
    assert.match(m.reason, /need_deep_think/)
  }
  assert.equal(JSON.stringify(catalog.otherModels).toLowerCase().includes("deepseek"), false)
})

test("parseTaskModels ignores a bundle with no task entries", () => {
  assert.deepEqual(parseTaskModels("var x=1"), [])
})

test("parseBundleModels refuses a bundle with no supported models", () => {
  assert.throws(() => parseBundleModels("var uF=[{model_item_key:\"99\",name:\"Other\"}]"), /no supported/)
  assert.throws(() => parseBundleModels("var nothing=1"), /not found/)
})

test("the catalog merges desktop models", () => {
  const desktopModel = {
    id: "deepseek-v4.1-flash",
    name: "DeepSeek V4.1 Flash",
    backend: "desktop",
    desktopId: "deepseek-v4.1-flash",
    context: 0,
  }
  const desktop = {
    current: () => ({ models: [desktopModel], available: true, app: { app: "x" }, error: "", fetchedAt: 0 }),
  }
  const catalog = createModelCatalog({ desktop })
  const snap = catalog.snapshot()
  assert.ok(snap.models.some((m) => m.id === "dola-fast" && m.backend === "web"))
  assert.ok(snap.models.some((m) => m.id === "deepseek-v4.1-flash" && m.backend === "desktop"))
  assert.equal(catalog.find("deepseek-v4.1-flash").backend, "desktop")
  assert.equal(snap.desktopStatus.available, true)
})

test("the catalog caches the live list for five minutes", async () => {
  let calls = 0
  let t = 1_000
  const fetchImpl = async (url) => {
    calls++
    return new Response(String(url).endsWith(".js") ? BUNDLE : HTML)
  }
  const catalog = createModelCatalog({ fetchImpl, now: () => t })
  assert.deepEqual(catalog.currentModels().map((m) => m.id), ["dola-fast", "dola-pro"])

  const first = await catalog.refresh()
  assert.equal(first.source, "live")
  assert.equal(first.models.length, 2)
  assert.equal(first.otherModels.length, 3)
  assert.equal(calls, 2)
  assert.equal(first.nextAt, t + 5 * 60 * 1000)

  const second = await catalog.refresh()
  assert.equal(second.source, "live")
  assert.equal(calls, 2, "a refresh inside five minutes must not touch the network")

  t += 5 * 60 * 1000 + 1
  await catalog.refresh()
  assert.equal(calls, 4)
})

test("a failed fetch keeps the previous list and backs off", async () => {
  let calls = 0
  let t = 1_000
  const fetchImpl = async () => {
    calls++
    throw new Error("offline")
  }
  const catalog = createModelCatalog({ fetchImpl, now: () => t })
  const first = await catalog.refresh()
  assert.equal(first.source, "builtin")
  assert.match(first.error, /offline/)
  assert.equal(calls, 1)

  await catalog.refresh()
  assert.equal(calls, 1, "a failed fetch must not be retried inside the window")

  t += 5 * 60 * 1000 + 1
  await catalog.refresh()
  assert.equal(calls, 2)
})
