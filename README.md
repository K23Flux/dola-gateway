# Dola Gateway

An unofficial, self-hosted gateway for **Dola** (`dola.com`), ByteDance's
international build of Doubao / Cici. It serves Dola's own web endpoint as an
**OpenAI-compatible API**, keeps a pool of signed-in accounts, rotates
requests across them, and ships a **web dashboard** for accounts, models,
request history, API keys and settings.

The same upstream client is also packaged as a **magpie / OpenCode provider**
in [`packages/dola`](packages/dola).

> **Unofficial. Not affiliated with ByteDance, Dola, Doubao or Cici.**
> This project is for personal study and research only. You are responsible
> for complying with Dola's Terms of Service and all applicable laws;
> unofficial use can lead to rate limits, restrictions or account bans. The
> software comes with no warranty and no liability. Do not resell, share
> accounts, mass-register or bypass paid features. Read the full
> [disclaimer](DISCLAIMER.md) (English / 中文).
>
> **非官方项目**，与字节跳动、Dola、豆包无关；仅供个人学习研究，请自行遵守服务
> 条款与法律，非官方接入可能导致限流或封号。详见 [免责声明](DISCLAIMER.md)。

## Quick start

```sh
cd dola-hub
node server.mjs
```

Open `http://127.0.0.1:8788/`. The first run prints an API key and the panel
password is `admin` until you change it in **设置**.

1. **账号** → 添加账号: paste a Dola Cookie (works on a headless VPS), or use
   浏览器登录 on a machine with Chrome/Edge.
2. **API Key** → 新建 Key: give it a name and tick the models it may use.
3. Point a client at `http://127.0.0.1:8788/v1` with that key and model
   `dola-fast` or `dola-pro`.

```sh
curl http://127.0.0.1:8788/v1/chat/completions \
  -H "Authorization: Bearer sk-dola-..." \
  -H "Content-Type: application/json" \
  -d '{"model":"dola-fast","messages":[{"role":"user","content":"你好"}],"stream":true}'
```

## Features

- **OpenAI-compatible API** — `/v1/chat/completions` and `/v1/models`, SSE
  streaming, `reasoning_content` for Pro, text-based tool calls.
- **Account pool** — weighted `round_robin`, `least_inflight`, `priority` and
  `random`; sticky sessions by `user` / `X-Session-Id`; per-account
  concurrency; exponential cooldown; 401 invalidation; failover before the
  first streamed delta.
- **API keys** — name, model allowlist, enable/disable and revoke; enforced
  on `/v1/models` and on every chat request.
- **Live model catalog** — reads Dola's public chat bundle, caches for five
  minutes and has a manual refresh. No account cookie, no completion request,
  no risk-control traffic; falls back to the built-in Fast/Pro list.
- **Dashboard** — overview, accounts, models, request ledger, API keys and
  settings; light/dark theme; panel password; login rate limiting.
- **Local by default** — binds `127.0.0.1`, stores cookies and keys in
  `dola-hub/data/state.json` (mode 600, git-ignored), and writes request logs
  without prompts or cookies.

## Repository layout

```
dola-hub/          standalone gateway + web dashboard
  server.mjs       HTTP server, panel API and /v1
  lib/             store, pool, gateway, models, log, auth
  public/          single-file dashboard
  test/            node:test suites
packages/dola/     magpie / OpenCode provider (same upstream client)
DISCLAIMER.md      legal disclaimer (English / 中文)
registry.json      inherited magpie plugin market
packages/*         inherited magpie / OpenCode plugins
```

## Models

| ID | Dola mode | Thinking | Context |
| --- | --- | --- | --- |
| `dola-fast` | 豆包 快速 (`need_deep_think: 0`) | — | 256k |
| `dola-pro` | 豆包 专家 (`need_deep_think: 3`) | `reasoning_content` | 128k |

The **模型** page reads the live menu from Dola's public `chat.*.js` bundle
(the `uF` array) and maps it to these two IDs. It fetches only the public
page and bundle — **no account cookie, no completion request** — caches the
result for **five minutes**, and the manual **获取模型** button uses the same
cache. On failure the previous list is kept and the next attempt waits five
minutes. If the bundle cannot be read, the built-in list is used.

## API keys and model allowlists

Create or edit a key in **API Key**:

- **名称** — a label such as `laptop` or `claude-code`.
- **可用模型** — tick the models the key may use; none means all.
- **启用/停用** and **删除** take effect immediately.

`GET /v1/models` returns only the models the key is allowed to use; a chat
request for another model returns `403`. The key is a Bearer token:

```
Authorization: Bearer sk-dola-...
```

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8788` | HTTP port (`--port` also works) |
| `HOST` | `127.0.0.1` | Bind address (`--host` also works) |
| `PANEL_PASSWORD` | `admin` | Initial panel password (first run only) |
| `DOLA_HUB_DATA` | `./data` | State and request ledger directory |
| `DOLA_BROWSER` | auto | Chrome/Chromium/Edge binary for browser login |
| `DOLA_BROWSER_HEADLESS` | off | `1` starts the login browser headless |
| `DOLA_LOGIN_PROFILE` | temp | Reuse a browser profile for browser login |
| `DOLA_HOME` | platform default | Where the login browser keeps profiles |

## Tests

```sh
cd dola-hub
node --test test/*.test.mjs

# the magpie / OpenCode provider
npx bun test packages/dola
npx bun scripts/check.mjs dola
```

The hub tests use fake upstream clients and temporary data directories; they
sign in to nothing and send no request. The model tests use a sample bundle
and a fake fetch.

## Inherited plugins

This repository is a fork of
[magpie-community/plugins](https://github.com/magpie-community/plugins). The
other packages, `registry.json` and their READMEs remain in place; see the
[upstream README](https://github.com/magpie-community/plugins#readme) for the
full plugin market. The Dola-specific code is `dola-hub/` and
`packages/dola/`.

## Legal

- [DISCLAIMER.md](DISCLAIMER.md) — full disclaimer in English and Chinese.
- [LICENSE](LICENSE) — MIT.

You are responsible for your own use, accounts and deployment. Do not expose
the gateway to the public internet without authorization, TLS and a strong
panel password.
