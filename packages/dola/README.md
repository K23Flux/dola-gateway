# Dola (dola.com)

**Unofficial.** Dola is ByteDance's international build of Doubao / Cici.
It has no public model API. This plugin calls the same endpoint Dola's own
web window calls, with the session cookies a signed-in browser holds, and
serves the replies as OpenAI-compatible chat completions:

- `dola-fast` — the Fast model (`need_deep_think: 0`);
- `dola-pro` — the Pro model (`need_deep_think: 3`), whose thinking
  streams back as `reasoning_content`.

Streaming, multi-turn requests (the whole conversation is flattened into
the one message Dola takes), and the client's tools (asked for as
`<tool_call>` text and read back as `tool_calls`) are supported. Images and
files are not: Dola's upload path needs a separate ImageX/SigV4 exchange
this plugin does not do, so only text is sent.

This is not an official API and ByteDance may not like it. Use an account
you can afford to lose.

## Signing in

Dola signs people in through its web window (Google, Apple, email…).
There are two ways in:

1. **Dola 网页登录（浏览器自动回调）** — the plugin starts its own
   Chrome/Chromium/Edge on a profile of its own, opens
   `https://www.dola.com/chat/`, and waits for the login callback. Once the
   window holds a `sessionid` (or `oauth_token`) cookie, the plugin reads
   the cookies over the DevTools protocol — HttpOnly ones included — and
   closes the window. Your everyday browser profile is not touched.
2. **粘贴 Dola Cookie** — for a headless VPS, or any browser the plugin
   cannot start. Sign in at `dola.com` on any device, open DevTools →
   Network → any request → copy the whole `Cookie` request header, and
   paste it. The plugin checks it against Dola's passport endpoint and
   saves it.

The cookies are what grants access, so they are stored by the host like any
other provider credential (`plugin-auth.json`, mode 600). They expire on
Dola's schedule; when one stops working magpie marks the account as needing
sign-in, and the other accounts keep serving.

### A headless VPS

There is no window to log in through on a machine without a graphical
session. Use **粘贴 Dola Cookie**, or run magpie where a browser can open
(SSH X forwarding works too). `DOLA_BROWSER_HEADLESS=1` starts a headless
browser for a `DOLA_LOGIN_PROFILE` that is already signed in, which is only
useful for automation.

## Several accounts, rotating

magpie keeps more than one sign-in for a provider. Sign each Dola account
in separately: every sign-in carries its own `accountId` (Dola's user id,
or the cookie's `flow_cur_user_sec_id`), so two accounts never collapse into
one.

Rotation is magpie's job, not the plugin's. Put the accounts in a group and
pick a routing strategy:

```sh
magpie group set <id> routing=rotate     # round-robin across accounts
magpie group set <id> routing=smart      # magpie's default pick
magpie group set <id> routing=usage      # prefer the least-used account
```

`rotate` is the round-robin the plugin is meant to be used with. A 401/403
marks that account as expired and magpie moves the request to another one;
a 429 is retried on another account as well. OpenCode has one account per
provider, so rotation applies to magpie.

## What it costs

- **Unofficial.** It uses Dola the way its web window does. Accounts can be
  limited or banned.
- **One conversation per request.** Every request opens a throwaway
  conversation and leaves it there. Dola's own delete endpoint needs the
  browser's `webmssdk` signature, so the plugin does not delete them; API
  conversations do not show in the history sidebar.
- **No images or files.** Text only.
- **Estimated usage.** Dola reports no token counts; prompt and reply
  tokens are estimated at one token per three characters.
- **Region.** The endpoint is queried with `region=AU` by default, which is
  the international build. Set `DOLA_REGION` if your account lives
  elsewhere. Dola geo-blocks some countries.
- **Streaming reads the whole reply.** The plugin reads Dola's SSE to the
  end, as the web window does. A cancelled client request stops being read,
  but Dola finishes its answer in the cloud anyway.

## Settings

| Variable | Meaning |
| --- | --- |
| `DOLA_BROWSER` | Chrome/Chromium/Edge binary, when it is not in a usual place |
| `DOLA_HOME` | Where the plugin keeps its own files (default: `~/.config/magpie-dola`, `%LOCALAPPDATA%\magpie-dola`) |
| `DOLA_LOGIN_PROFILE` | Reuse this browser profile for sign-in instead of a fresh temporary one |
| `DOLA_BROWSER_HEADLESS` | `1` starts the sign-in browser headless (only for an already signed-in profile) |
| `DOLA_REGION` | Region sent to Dola (default `AU`) |
| `DOLA_LANGUAGE` | Language sent to Dola (default `en`) |
| `DOLA_BOT_ID` | Assistant bot id (default: Dola's own assistant) |

## How it works

```
POST https://www.dola.com/chat/completion?aid=495671&device_platform=web…
headers: content-type: application/json, Agw-Js-Conv: str, cookie
```

The reply is Server-Sent Events: `SSE_ACK` carries the new conversation id,
`STREAM_MSG_NOTIFY` (Fast) or `STREAM_CHUNK` (Pro) carries answer text, and
Pro's reasoning is a `Deep_Think` text block. No `a_bogus`/`msToken`
signature is needed with valid cookies. `dola.mjs` is the whole upstream
client; `prompt.mjs` and `openai.mjs` turn a chat request into Dola's one
message and the reply back into a completion.

## Tests

```sh
bun test packages/dola
```

The tests use a fake upstream and a fake browser session; they sign in to
nothing and send no request.
