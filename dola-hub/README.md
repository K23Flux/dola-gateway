# Dola Hub

A standalone gateway for **dola.com** (ByteDance's international Doubao /
Cici) with an OpenAI-compatible API, an account pool, rotation, API keys and
a web dashboard. It reuses the upstream client from
[`packages/dola`](../packages/dola), which is the magpie/OpenCode provider;
this folder is the standalone app for a VPS or a desktop.

**Unofficial.** Dola has no public model API. This talks to the endpoint its
own web window uses, with session cookies. Use an account you can afford to
lose.

## Quick start

```sh
cd dola-hub
node server.mjs
# or: PORT=8788 HOST=127.0.0.1 PANEL_PASSWORD='change-me' node server.mjs
```

Open `http://127.0.0.1:8788/`. The first run prints an API key and the panel
password is `admin` until you change it in **设置**.

The dashboard has five pages:

- **总览** — today's requests, success rate, active accounts, 24-hour chart,
  recent requests, account status and the base URL / API key.
- **账号** — add an account by pasting a Cookie, or with browser login on a
  machine that has Chrome/Edge; test, enable/disable, delete, inspect stats.
- **请求记录** — the last 500 calls: key, model, account, status, latency,
  estimated tokens and the error.
- **API Key** — create keys, restrict each to a model allowlist, copy/revoke.
- **设置** — rotation strategy, retry count, cooldown, sticky sessions,
  region/language/bot id, per-account concurrency, panel password.

## Adding accounts

### Paste a Cookie (works on a headless VPS)

1. Sign in at `https://www.dola.com/chat/` in any browser.
2. Open DevTools → Network → any request → copy the whole `Cookie` request
   header.
3. Dashboard → 账号 → 添加账号 → paste it.

The Cookie needs `sessionid` or `oauth_token`. The hub checks it against
Dola's passport endpoint and stores it in `data/state.json` (mode 600). It
never writes cookies to the request log.

### Browser login (needs a graphical session)

Dashboard → 账号 → 浏览器登录. The hub starts its own Chrome/Chromium/Edge
on a private profile, opens Dola, and waits for the login callback. When the
window holds a session cookie, the hub reads it over the DevTools protocol
(HttpOnly included), closes the window and adds the account.

On a headless Linux VPS this is not available; use the Cookie method. SSH X
forwarding also works. Set `DOLA_BROWSER` if the browser is not in a usual
place, or `DOLA_BROWSER_HEADLESS=1` for an already signed-in
`DOLA_LOGIN_PROFILE`.

## Rotation

Every request picks an account from the pool:

| Strategy | What it does |
| --- | --- |
| `round_robin` | smooth weighted round-robin, priority first (default) |
| `least_inflight` | fewest in-flight requests first |
| `priority` | lowest `priority` number first, then weighted |
| `random` | weighted random |

- **Sticky sessions** — `user` in the request body or `X-Session-Id` keeps a
  conversation on one account for `stickyTtlSeconds` (0 disables).
- **Failover** — a 401 marks the account invalid; a 429/5xx/network error
  puts it in exponential cooldown. A failure before the first streamed delta
  moves the request to the next account; after the first delta the client
  gets the error instead of mixed output.
- **Concurrency** — each account has a limit; the pool skips accounts at
  their limit.
- **Stats** — attempts, successes, failures and last use are saved per
  account and shown in the dashboard.

## API

Base URL: `http://<host>:<port>/v1`, key from the dashboard.

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

Models: `dola-fast` (no deep think) and `dola-pro` (deep think, served as
`reasoning_content`). `GET /v1/models` lists what the key may use.

The gateway is stateless: each request opens a throwaway Dola conversation
and flattens the whole chat history (including tool definitions) into one
message. Client tools are asked for as `<tool_call>` text and returned as
OpenAI `tool_calls`. Images and files are not supported.

## Environment

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

## Security

- The panel binds to `127.0.0.1` by default. If you set `HOST=0.0.0.0`,
  put it behind TLS and change the panel password immediately.
- Cookies are full account access. `data/state.json` is mode 600 and
  `.gitignore`d; never commit it.
- The request ledger stores no prompts and no cookies.
- There is no multi-user panel: one password, one set of accounts and keys.

## Tests

```sh
cd dola-hub
node --test test/*.test.mjs
```

The tests use fake upstream clients and temporary data directories; they
sign in to nothing and send no request.
