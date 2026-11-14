# Dola Gateway

一个非官方的、自托管的 **Dola**（`dola.com`，字节跳动国际版豆包 / Cici）网关。
它把 Dola 网页端接口封装成 **OpenAI 兼容 API**，维护账号池并在多个账号间轮询，
自带一个用于账号、模型、请求记录、API Key 和设置的 **Web 控制台**。

同一套上游客户端也打包成了 **magpie / OpenCode provider**，见
[`packages/dola`](packages/dola)。

> **非官方项目，与字节跳动、Dola、豆包、Cici 无隶属、授权或赞助关系。**
> 仅供个人学习研究。请自行遵守 Dola 服务条款和当地法律；非官方接入可能导致
> 限流、限制或封号。软件不附带任何保证，作者不承担赔偿责任。禁止商业转售、
> 共享账号、批量注册或绕过付费功能。完整免责声明见 [DISCLAIMER.md](DISCLAIMER.md)。

## 快速开始

```sh
cd dola-hub
node server.mjs
```

打开 `http://127.0.0.1:8788/`。首次启动会生成并打印一次面板密码；API Key
在登录后的「总览 / API Key」页查看。

1. **账号** → 添加账号：粘贴 Dola Cookie（无图形界面的 VPS 用这个），或在有
   Chrome/Edge 的机器上用「浏览器登录」。
2. **API Key** → 新建 Key：填名称，勾选这个 Key 能用的模型。
3. 客户端 Base URL 填 `http://127.0.0.1:8788/v1`，模型用 `dola-fast` 或
   `dola-pro`。

```sh
curl http://127.0.0.1:8788/v1/chat/completions \
  -H "Authorization: Bearer sk-dola-..." \
  -H "Content-Type: application/json" \
  -d '{"model":"dola-fast","messages":[{"role":"user","content":"你好"}],"stream":true}'
```

## 功能

- **OpenAI 兼容 API**：`/v1/chat/completions`、`/v1/models`，支持 SSE 流式、
  Pro 的 `reasoning_content`、文本工具调用。
- **账号池**：加权 `round_robin`、`least_inflight`、`priority`、`random`；
  按 `user` / `X-Session-Id` 粘性会话；每账号并发上限；指数冷却；401 失效；
  首个流式增量前失败自动换号。
- **API Key**：名称、模型白名单、启停、删除；在 `/v1/models` 和每次对话请求上
  强制生效。
- **实时模型目录**：读取 Dola 公开 chat bundle，缓存 5 分钟，可手动刷新；不发
  账号 Cookie、不调用对话接口，不产生风控流量；失败回退内置 Fast/Pro。
- **桌面版模型**：可选驱动豆包工作 / 豆包桌面版，读取 App 的模型菜单，把
  DeepSeek、GLM、Kimi 等模型接到同一个 `/v1`（需要 Windows/macOS 并登录桌面版）。
- **Web 控制台**：总览、账号、模型、请求记录、API Key、设置；明暗主题；面板
  密码；登录限流。
- **默认只监听本机**：`127.0.0.1`；Cookie 与 Key 存在
  `dola-hub/data/state.json`（600，已 gitignore）；请求日志不记录提示词和 Cookie。

## 仓库结构

```
dola-hub/          独立网关 + Web 控制台
  server.mjs       HTTP 服务、面板 API、/v1
  lib/             store、pool、gateway、models、log、auth
  public/          单文件控制台
  test/            node:test 测试
packages/dola/     magpie / OpenCode provider（同一套上游客户端）
DISCLAIMER.md      中英免责声明
registry.json      继承的 magpie 插件市场
packages/*         继承的 magpie / OpenCode 插件
```

## 模型

| ID | Dola 模式 | 思维链 | 上下文 |
| --- | --- | --- | --- |
| `dola-fast` | 豆包 快速（`need_deep_think: 0`） | — | 256k |
| `dola-pro` | 豆包 专家（`need_deep_think: 3`） | `reasoning_content` | 128k |

「模型」页从 Dola 公开的 `chat.*.js` bundle 读取实时菜单（`uF` 数组），映射为
上面两个 ID。只请求公开页面和 bundle，**不带账号 Cookie、不调用对话接口**；
缓存 **5 分钟**，手动「获取模型」也走同一缓存；失败保留上一版并等 5 分钟再试；
bundle 读不到时使用内置列表。

### 为什么只有豆包模型？

网页 bundle 的 `uF` 只有 **豆包 快速** 和 **豆包 专家**。bundle 里还有工作任务/
办公模式的 **豆包 2.1 Lite**、**豆包 2.1 Pro**、**自动**（`uB` / `uU` / `uz`），
它们走 `office/creation` 模式，不是用 `need_deep_think` 选模型，所以控制台把它们
列在「网页 bundle 中的其他模型」并标记 **未接入**。

网页 bundle 里**没有 DeepSeek、GLM、Kimi 的聊天模型**。这些出现在桌面端豆包工作
的模型菜单（见 [`packages/doubao-work`](packages/doubao-work)），或你自己用 API Key
添加的第三方模型；当前网页 `/chat/completion` 不支持直接选它们。如果你在 Dola
网页里看到其他模型，抓一个请求的 `client_meta` / `option` 字段，就可以判断能否接入。

### 桌面版模型（DeepSeek / GLM / Kimi 等）

网页模型不够时，网关可以驱动 **豆包工作 / 豆包桌面版**，读取 App 自己的模型菜单，
把 DeepSeek、GLM、Kimi 等模型加到同一个 `/v1` 接口里：

- 桌面版后端默认关闭；需要 **Windows 或 macOS**，设置 `DOLA_HUB_DESKTOP=1`
  （或启动参数 `--desktop`）并安装、登录桌面版。Linux 没有桌面版。
- 「模型」页 → 桌面版后端 → **获取桌面模型**。网关会用自己的 profile 启动 App，
  读取菜单；模型会出现在「当前模型」表里（后端标记为「桌面」），也会进入 API Key
  的模型白名单。
- 桌面版同一时间只能处理一个请求；网关会排队。
- 桌面版是云端智能体，不是纯模型 API：每个请求会在 App 里新建一个工作任务，
  文本 only，速度比网页模型慢。
- 模型 ID 由菜单名称生成，例如 `deepseek-v4.1-flash`、`glm-5.3`、
  `kimi-k3.1-pro-fast`；以实际菜单为准。

## API Key 与模型白名单

在「API Key」页新建或编辑：

- **名称**：例如 `laptop`、`claude-code`。
- **可用模型**：勾选这个 Key 能用的模型；不勾选 = 全部。
- **启用/停用**、**删除**立即生效。

`GET /v1/models` 只返回该 Key 允许的模型；调用未授权模型返回 `403`。Key 作为
Bearer Token：

```
Authorization: Bearer sk-dola-...
```

## 配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8788` | HTTP 端口（也支持 `--port`） |
| `HOST` | `127.0.0.1` | 监听地址（也支持 `--host`） |
| `PANEL_PASSWORD` | 首次启动随机生成 | 初始化密码；也可迁移旧 `admin` 密码（非默认且至少 6 位），不覆盖已有自定义密码 |
| `DOLA_HUB_DATA` | `./data` | 状态与请求日志目录 |
| `DOLA_HUB_DESKTOP` | 关闭 | 设为 `1` 才启用桌面版模型（也支持 `--desktop`） |
| `DOLA_HUB_TRUST_PROXY` | 关闭 | 设为 `1` 后信任代理的 `X-Forwarded-Proto` 以设置 Secure Cookie；不提供 TLS，也不限制监听地址（也支持 `--trust-proxy`） |
| `DOLA_BROWSER` | 自动 | 浏览器登录用的 Chrome/Chromium/Edge |
| `DOLA_BROWSER_HEADLESS` | 关闭 | `1` 用无头浏览器登录 |
| `DOLA_LOGIN_PROFILE` | 临时 | 复用浏览器 profile |
| `DOLA_HOME` | 平台默认 | 登录浏览器 profile 目录 |

## 测试

```sh
cd dola-hub
node --test test/*.test.mjs

# magpie / OpenCode provider
npx bun test packages/dola
npx bun scripts/check.mjs dola
```

hub 测试使用假上游和临时数据目录，不登录、不发真实请求；模型测试使用样例
bundle 和假 fetch。

## 继承的插件

本仓库 fork 自 [magpie-community/plugins](https://github.com/magpie-community/plugins)。
其他包、`registry.json` 和各自的 README 保留；完整插件市场见
[上游 README](https://github.com/magpie-community/plugins#readme)。Dola 相关代码只有
`dola-hub/` 和 `packages/dola/`。

## 法律

- [DISCLAIMER.md](DISCLAIMER.md) — 中英完整免责声明。
- [LICENSE](LICENSE) — MIT。

你需要对自己的使用、账号和部署负责。不要在未经授权、没有 TLS 和强面板密码的
情况下把网关暴露到公网。

## English

Dola Gateway is an unofficial, self-hosted OpenAI-compatible gateway for
`dola.com`, with an account pool, weighted rotation, API keys, a live model
catalog and a web dashboard. The sections above are the primary
documentation (Chinese); the full bilingual disclaimer is in
[DISCLAIMER.md](DISCLAIMER.md).
