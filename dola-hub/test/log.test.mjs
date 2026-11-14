import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createLog } from "../lib/log.mjs"

test("the request ledger redacts common credential shapes", () => {
  const dir = mkdtempSync(join(tmpdir(), "dola-hub-log-"))
  try {
    const log = createLog({ dataDir: dir })
    const fakeKey = ["sk", "abcdefghijklmnopqrstuvwx"].join("-")
    log.record({
      error: `Cookie: sessionid=secret-session; Authorization: Bearer secret-token; api_key=${fakeKey}`,
    })
    log.record({
      error:
        '{"sessionid":"json-session","dola_session":"panel-session","flow_cur_user_sec_id":"user-id"}; token%3Dencoded-token; msToken=ms-token',
    })
    const text = readFileSync(log.file, "utf8")
    for (const secret of [
      "secret-session",
      "secret-token",
      fakeKey,
      "json-session",
      "panel-session",
      "user-id",
      "encoded-token",
      "ms-token",
    ])
      assert.doesNotMatch(text, new RegExp(secret))
    assert.match(text, /\[redacted\]/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
