// Account pool: which Dola account serves the next request, and what a
// failure does to that account. Runtime state (in-flight, cooldown, sticky
// sessions) lives here; counters and the invalid flag are saved by the
// store.

export function createPool({ store, now = () => Date.now() } = {}) {
  const inflight = new Map()
  const cooldown = new Map()
  const failStreak = new Map()
  const sticky = new Map()
  const weights = new Map()

  const settings = () => store.state.settings
  const accounts = () => store.state.accounts
  const inflightOf = (a) => inflight.get(a.id) ?? 0
  const cooldownOf = (a) => Math.max(Number(a.cooldownUntil) || 0, cooldown.get(a.id) || 0)
  const limitOf = (a) => Number(a.maxConcurrency) || settings().maxConcurrencyPerAccount || 1

  function eligible({ exclude = new Set(), at = now() } = {}) {
    return accounts().filter(
      (a) => a.enabled !== false && a.invalid !== true && !exclude.has(a.id) && cooldownOf(a) <= at && inflightOf(a) < limitOf(a),
    )
  }

  function weightedPick(list) {
    if (!list.length) return null
    if (list.length === 1) return list[0]
    let total = 0
    for (const a of list) {
      const w = Math.max(1, Number(a.weight) || 1)
      total += w
      weights.set(a.id, (weights.get(a.id) ?? 0) + w)
    }
    let best = list[0]
    for (const a of list) if ((weights.get(a.id) ?? 0) > (weights.get(best.id) ?? 0)) best = a
    weights.set(best.id, (weights.get(best.id) ?? 0) - total)
    return best
  }

  function weightedRandom(list) {
    let total = 0
    for (const a of list) total += Math.max(1, Number(a.weight) || 1)
    let roll = Math.random() * total
    for (const a of list) {
      roll -= Math.max(1, Number(a.weight) || 1)
      if (roll <= 0) return a
    }
    return list[list.length - 1]
  }

  function pick({ sessionKey = "", exclude = new Set(), at = now() } = {}) {
    const list = eligible({ exclude, at })
    if (!list.length) return null

    if (sessionKey) {
      const s = sticky.get(sessionKey)
      if (s && s.expires > at) {
        const a = list.find((x) => x.id === s.accountId)
        if (a) return a
      }
    }

    const strategy = settings().strategy
    let chosen
    if (strategy === "random") chosen = weightedRandom(list)
    else if (strategy === "least_inflight") {
      const min = Math.min(...list.map((a) => inflightOf(a)))
      chosen = weightedPick(list.filter((a) => inflightOf(a) === min))
    } else if (strategy === "priority") {
      const min = Math.min(...list.map((a) => Number(a.priority) || 100))
      chosen = weightedPick(list.filter((a) => (Number(a.priority) || 100) === min))
    } else {
      // round_robin, weighted: smooth weighted round-robin over the
      // eligible list, priority first
      const sorted = list.slice().sort((a, b) => (Number(a.priority) || 100) - (Number(b.priority) || 100))
      chosen = weightedPick(sorted)
    }

    if (sessionKey && settings().stickyTtlSeconds > 0)
      sticky.set(sessionKey, { accountId: chosen.id, expires: at + settings().stickyTtlSeconds * 1000 })
    return chosen
  }

  function acquire(account) {
    inflight.set(account.id, inflightOf(account) + 1)
    account.lastUsedAt = new Date(now()).toISOString()
  }

  function release(account) {
    const n = inflightOf(account) - 1
    if (n > 0) inflight.set(account.id, n)
    else inflight.delete(account.id)
  }

  function success(account) {
    account.stats = account.stats || { requests: 0, success: 0, failure: 0 }
    account.stats.requests = (Number(account.stats.requests) || 0) + 1
    account.stats.success = (Number(account.stats.success) || 0) + 1
    account.invalid = false
    account.cooldownUntil = 0
    cooldown.delete(account.id)
    failStreak.delete(account.id)
    store.save()
  }

  function failure(account, error) {
    account.stats = account.stats || { requests: 0, success: 0, failure: 0 }
    account.stats.requests = (Number(account.stats.requests) || 0) + 1
    account.stats.failure = (Number(account.stats.failure) || 0) + 1
    const code = error?.code
    const status = Number(error?.status) || 0
    if (code === "signin_expired" || code === "signin_required" || status === 401 || status === 403) {
      account.invalid = true
      account.invalidAt = new Date(now()).toISOString()
    } else if (
      code === "rate_limited" ||
      code === "network_error" ||
      code === "upstream_error" ||
      status === 429 ||
      status >= 500
    ) {
      const streak = (failStreak.get(account.id) || 0) + 1
      failStreak.set(account.id, streak)
      const base = Math.max(5, Number(settings().cooldownSeconds) || 60)
      const delay = Math.min(base * 2 ** (streak - 1), 3600)
      const until = now() + delay * 1000
      cooldown.set(account.id, until)
      account.cooldownUntil = until
    }
    store.save()
  }

  function clearCooldown(id) {
    cooldown.delete(id)
    failStreak.delete(id)
    const a = store.findAccount(id)
    if (a) {
      a.cooldownUntil = 0
      store.save()
    }
  }

  function revive(id) {
    const a = store.findAccount(id)
    if (!a) return null
    a.invalid = false
    a.cooldownUntil = 0
    cooldown.delete(id)
    failStreak.delete(id)
    store.save()
    return a
  }

  function snapshot() {
    const out = {}
    for (const a of accounts()) {
      out[a.id] = {
        inflight: inflightOf(a),
        cooldownUntil: cooldownOf(a),
        sticky: 0,
      }
    }
    return out
  }

  function activeCount() {
    return eligible().length
  }

  function clearSticky(sessionKey) {
    sticky.delete(sessionKey)
  }

  return {
    pick,
    acquire,
    release,
    success,
    failure,
    clearCooldown,
    revive,
    snapshot,
    activeCount,
    clearSticky,
    eligible,
    inflightOf,
    cooldownOf,
  }
}
