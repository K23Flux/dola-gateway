# Dola Hub

**dola.com**（字节跳动国际版豆包 / Cici）的独立网关，带 OpenAI 兼容 API、账号池、
轮询、API Key 和 Web 控制台。它复用 [`packages/dola`](../packages/dola) 的上游
客户端；`packages/dola` 是 magpie/OpenCode provider，本目录是给 VPS 或桌面用的
独立应用。

**非官方。** Dola 没有公开的模型 API；本项目和它自己的网页窗口一样，用会话 Cookie
调用同一个接口。请用可以承受损失的账号。

> **免责声明。** 本项目是非官方个人项目，与字节跳动、Dola、豆包、Cici 及其关联方
> 没有隶属、授权或赞助关系。仅供个人学习研究。你需要自行遵守 Dola 服务条款和
> 所有适用法律；非官方接入可能导致限流、限制或封号。软件不附带任何保证，作者不
> 承担赔偿责任。禁止商业转售、共享账号、批量注册或绕过付费功能。完整声明见
> [DISCLAIMER.md](../DISCLAIMER.md)。

## 快速开始

```sh
cd dola-hub
node server.mjs
# 或：PORT=8788 HOST=127.0.0.1 PANEL_PASSWORD='change-me' node server.mjs
```

打开 `http://127.0.0.1:8788/`。首次启动会生成并打印一次面板密码；API Key
在登录后的「总览 / API Key」页查看。

控制台有这些页面：

- **总览** — 今日请求、成功率、可用账号、24 小时分布、最近请求、账号状态、
  Base URL / API Key。
- **账号** — 粘贴 Cookie 或浏览器登录添加账号；测试、启停、删除、查看统计。
- **请求记录** — 最近 500 次调用：Key、模型、账号、状态、耗时、估算 tokens、错误。
- **模型** — 实时模型菜单、来源、上次获取时间，以及「获取模型」按钮
  （5 分钟缓存，见下文）。
- **API Key** — 新建 Key 时填名称和模型白名单；支持编辑、复制、启停、删除。
- **设置** — 轮询策略、重试次数、冷却、粘性会话、region/language/bot id、
  每账号并发、面板密码。

## 添加账号

### 粘贴 Cookie（无图形界面的 VPS）

1. 在任意浏览器登录 `https://www.dola.com/chat/`。
2. 打开开发者工具 → Network → 任意请求 → 复制整段 `Cookie` 请求头。
3. 控制台 → 账号 → 添加账号 → 粘贴。

Cookie 需要包含 `sessionid` 或 `oauth_token`。网关会调用 Dola passport 校验，
然后存到 `data/state.json`（权限 600）。Cookie 不会写进请求日志。

### 浏览器登录（需要图形界面）

控制台 → 账号 → 浏览器登录。网关会用自己的 Chrome/Chromium/Edge 配置打开 Dola，
等待登录回调；窗口里出现会话 Cookie 后，通过 DevTools 协议读取（包含 HttpOnly），
关闭窗口并添加账号。

无图形界面的 Linux VPS 用不了这个方式，请用粘贴 Cookie；SSH X forwarding 也可以。
浏览器不在常规位置时设置 `DOLA_BROWSER`；已登录的 `DOLA_LOGIN_PROFILE` 可以配合
`DOLA_BROWSER_HEADLESS=1` 使用。

## 模型

「模型」页从 Dola 公开的 chat bundle 读取模型菜单（`uF` 数组：豆包 快速 / 豆包
专家），映射为 `dola-fast` / `dola-pro`。它只请求公开的
`https://www.dola.com/chat/` 页面和页面引用的带 hash 的 chat bundle，**不带账号
Cookie，也不调用对话接口**，所以不消耗消息、不增加账号流量。

结果缓存 **5 分钟**。手动「获取模型」按钮使用同一份缓存：5 分钟内只返回缓存，
不发请求。失败时保留上一版列表，并等 5 分钟再试，避免反复打 Dola；bundle 读不到
时使用内置的 Fast/Pro 列表。

API Key 的模型白名单来自这个目录：新建或编辑 Key 时勾选允许的模型（不勾选 = 全部）。
`GET /v1/models` 只返回该 Key 允许的模型。

### 为什么只有豆包模型？

网页 chat bundle 的 `uF` 只有两项：**豆包 快速** 和 **豆包 专家**。bundle 里还有
工作任务 / 办公模式的 **豆包 2.1 Lite**、**豆包 2.1 Pro**、**自动**
（`uB` / `uU` / `uz`）。它们使用 `office/creation` 模式，对话接口不是用
`need_deep_think` 选它们，所以控制台把它们列在「网页 bundle 中的其他模型」，
标记为 **未接入**。

网页 bundle 里**没有 DeepSeek、GLM、Kimi 的聊天模型**。这些可能出现在桌面端豆包
工作的模型菜单（由独立的 [`packages/doubao-work`](../packages/doubao-work)
provider 读取），或你自己用 API Key 添加的第三方模型；当前网页接口不能直接选它们。
如果你在 Dola 网页账号里看到其他模型，抓一个请求的 `client_meta` / `option` 字段，
就可以判断能否接入。

### 桌面版模型（DeepSeek / GLM / Kimi 等）

如果网页模型不够，网关可以驱动 **豆包工作** 或 **豆包** 桌面版，读取 App 自己的
模型菜单，把 DeepSeek、GLM、Kimi 等模型加到同一个 `/v1` 接口里。

- 桌面版后端默认关闭；需要 **Windows 或 macOS**，设置 `DOLA_HUB_DESKTOP=1`
  （或启动参数 `--desktop`）并安装、登录桌面版。Linux 没有桌面版。
- 「模型」页 → 桌面版后端 → **获取桌面模型**。网关会用自己的 profile 启动 App，
  读取模型菜单；模型会出现在「当前模型」表里，后端标记为「桌面」，也会进入
  API Key 的模型白名单。
- 桌面版同一时间只能处理一个请求；网关会排队。
- 桌面版是云端智能体，不是纯模型 API：每个请求会在 App 里新建一个工作任务，
  文本 only，速度比网页模型慢。
- 模型 ID 由菜单名称生成，例如 `deepseek-v4.1-flash`、`glm-5.3`、
  `kimi-k3.1-pro-fast`；以实际菜单为准。
- 相关环境变量沿用 `packages/doubao-work`：`DOUBAO_WORK_APP`、
  `DOUBAO_WORK_HOME`。

## 轮询

每次请求从账号池里选一个账号：

| 策略 | 行为 |
| --- | --- |
| `round_robin` | 平滑加权轮询，优先级优先（默认） |
| `least_inflight` | 当前并发最少的账号优先 |
| `priority` | `priority` 数字最小的优先，再按权重 |
| `random` | 加权随机 |

- **粘性会话** — 请求体里的 `user` 或 `X-Session-Id` 会让同一会话在
  `stickyTtlSeconds` 内固定在一个账号（0 关闭）。
- **故障转移** — 401 标记账号失效；429/5xx/网络错误进入指数冷却。首个流式增量
  之前失败会自动换号；增量之后失败则直接报错，不会把多个账号的输出混在一起。
- **并发** — 每个账号有并发上限，达到上限的账号会被跳过。
- **统计** — 尝试数、成功、失败、最近使用都会按账号保存并显示在控制台。

## API

Base URL：`http://<host>:<port>/v1`，Key 从控制台获取。

```sh
curl http://127.0.0.1:8788/v1/chat/completions \
  -H "Authorization: Bearer sk-dola-..." \
  -H "Content-Type: application/json" \
  -d '{
    "model": "dola-fast",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": true
  }'
```

模型：`dola-fast`（不深度思考）和 `dola-pro`（深度思考，返回
`reasoning_content`）。`GET /v1/models` 只列出该 Key 允许的模型。

网关是无状态的：每次请求新建一个临时 Dola 会话，把整段对话历史（包括工具定义）
压成一条消息。客户端工具用 `<tool_call>` 文本请求，再还原成 OpenAI `tool_calls`。
暂不支持图片和文件。

## 环境变量

| 变量 | 默认值 | 说明 |
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

## 安全

- 面板默认只监听 `127.0.0.1`，首次启动会生成随机密码并只打印一次。已有状态若仍
  使用默认 `admin`，必须设置非默认且至少 6 位的强 `PANEL_PASSWORD`；服务会在监听前
  替换并保存密码，保留账号和 Key。未提供有效替换值时拒绝启动，新装显式使用
  `admin` 也会被拒绝。已有自定义密码不会被环境变量覆盖；正常改密请用设置页面。
- 非回环监听不要求开启代理信任。远程访问应使用 HTTPS 反向代理及网络访问控制；
  `DOLA_HUB_TRUST_PROXY=1`（或 `--trust-proxy`）只控制是否信任 `X-Forwarded-Proto`，
  不建立 TLS，也不验证代理存在。仅在后端只能由可信代理访问、且代理覆盖该请求头时
  开启；头为 `https` 时为会话 Cookie 添加 `Secure`。
- 面板状态变更接口要求 JSON 内容类型并校验同源 `Origin`；不要用反向代理改写
  `Host`，否则登录和面板写入会被拒绝。
- Cookie 等同于账号权限。`data/state.json` 权限 600，且已 gitignore；不要提交。
- 上游非 2xx HTTP 错误只保留 HTTP 状态码；SSE 错误转换为本地固定消息及错误分类，
  不透传原始错误消息或任意上游错误码。请求日志不主动记录提示词和 Cookie，日志中的
  `key=value`、JSON、URL 编码及常见 Cookie / Bearer / `sk-*` 凭据形状会脱敏；
  这些模式不保证识别所有敏感文本，也不会清理历史日志。
- 桌面版后端默认关闭；需要时用 `DOLA_HUB_DESKTOP=1` 或 `--desktop` 显式开启。
- 面板是单用户的：一个密码、一套账号和 Key。

## 测试

```sh
cd dola-hub
node --test test/*.test.mjs
```

测试使用假上游和临时数据目录；不登录、不发真实请求。
