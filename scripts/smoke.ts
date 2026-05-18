// Standalone smoke test for the retry wrapper. Not shipped.
// Run with: npx tsx scripts/smoke.ts (or `bun scripts/smoke.ts`)

import { resolveConfig } from "../src/config.js"
import { createStickyFetch } from "../src/retry.js"

const test = async (name: string, fn: () => Promise<void>) => {
  process.stdout.write(`- ${name} ... `)
  try {
    await fn()
    process.stdout.write("ok\n")
  } catch (err) {
    process.stdout.write("FAIL\n")
    console.error(err)
    process.exitCode = 1
  }
}

const assert = (cond: unknown, msg: string) => {
  if (!cond) throw new Error(`assertion failed: ${msg}`)
}

const PROVIDER = "https://api.anthropic.com/v1/messages"

const main = async () => {
  // 1) succeeds first try, no retry
  await test("returns 200 immediately", async () => {
    let calls = 0
    const base: typeof fetch = async () => {
      calls += 1
      return new Response("hi", { status: 200 })
    }
    const cfg = resolveConfig({ initialDelayMs: 1, log: false })
    const wrapped = createStickyFetch({ baseFetch: base, config: cfg })
    const res = await wrapped(PROVIDER)
    assert(res.status === 200, "status")
    assert(calls === 1, `calls=${calls}`)
  })

  // 2) retries on 500 then succeeds
  await test("retries 500 then 200", async () => {
    let calls = 0
    const base: typeof fetch = async () => {
      calls += 1
      if (calls < 3) return new Response("boom", { status: 500 })
      return new Response("ok", { status: 200 })
    }
    const cfg = resolveConfig({ initialDelayMs: 1, maxDelayMs: 5, jitter: "none", log: false })
    const wrapped = createStickyFetch({ baseFetch: base, config: cfg })
    const res = await wrapped(PROVIDER)
    assert(res.status === 200, "status")
    assert(calls === 3, `calls=${calls}`)
  })

  // 3) default policy retries 404 (sticky retries everything by default)
  await test("default policy retries 404 then succeeds", async () => {
    let calls = 0
    const base: typeof fetch = async () => {
      calls += 1
      if (calls < 3) return new Response("nope", { status: 404 })
      return new Response("ok", { status: 200 })
    }
    const cfg = resolveConfig({ initialDelayMs: 1, maxDelayMs: 2, jitter: "none", log: false })
    const wrapped = createStickyFetch({ baseFetch: base, config: cfg })
    const res = await wrapped(PROVIDER)
    assert(res.status === 200, "status")
    assert(calls === 3, `calls=${calls}`)
  })

  // 3b) explicit nonRetriableStatusCodes opts a code out
  await test("nonRetriableStatusCodes opts 404 out of retry", async () => {
    let calls = 0
    const base: typeof fetch = async () => {
      calls += 1
      return new Response("nope", { status: 404 })
    }
    const cfg = resolveConfig({ initialDelayMs: 1, log: false, nonRetriableStatusCodes: [404] })
    const wrapped = createStickyFetch({ baseFetch: base, config: cfg })
    const res = await wrapped(PROVIDER)
    assert(res.status === 404, "status")
    assert(calls === 1, `calls=${calls}`)
  })

  // 3c) retriableStatusCodes acts as an allowlist
  await test("retriableStatusCodes allowlist limits retries", async () => {
    let calls = 0
    const base: typeof fetch = async () => {
      calls += 1
      return new Response("teapot", { status: 418 })
    }
    const cfg = resolveConfig({ initialDelayMs: 1, log: false, retriableStatusCodes: [429, 503] })
    const wrapped = createStickyFetch({ baseFetch: base, config: cfg })
    const res = await wrapped(PROVIDER)
    assert(res.status === 418, "status")
    assert(calls === 1, `not in allowlist, should not retry, calls=${calls}`)
  })

  // 3d) nonRetriable wins over retriable
  await test("nonRetriable beats retriable when both list a code", async () => {
    let calls = 0
    const base: typeof fetch = async () => {
      calls += 1
      return new Response("", { status: 503 })
    }
    const cfg = resolveConfig({
      initialDelayMs: 1,
      log: false,
      retriableStatusCodes: [503],
      nonRetriableStatusCodes: [503],
    })
    const wrapped = createStickyFetch({ baseFetch: base, config: cfg })
    const res = await wrapped(PROVIDER)
    assert(res.status === 503, "status")
    assert(calls === 1, `calls=${calls}`)
  })

  // 4) retries on transport error (sticky=false) up to maxAttempts
  await test("retries transport error then gives up (non-sticky)", async () => {
    let calls = 0
    const base: typeof fetch = async () => {
      calls += 1
      throw Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" })
    }
    const cfg = resolveConfig({ initialDelayMs: 1, maxDelayMs: 2, jitter: "none", sticky: false, maxAttempts: 3, log: false })
    const wrapped = createStickyFetch({ baseFetch: base, config: cfg })
    let threw = false
    try {
      await wrapped(PROVIDER)
    } catch {
      threw = true
    }
    assert(threw, "should have thrown")
    assert(calls === 3, `calls=${calls}`)
  })

  // 5) non-retriable error pattern stops sticky loop
  await test("non-retriable error pattern stops sticky", async () => {
    let calls = 0
    const base: typeof fetch = async () => {
      calls += 1
      throw new Error("invalid api key xyz")
    }
    const cfg = resolveConfig({
      initialDelayMs: 1,
      maxDelayMs: 2,
      jitter: "none",
      sticky: true,
      nonRetriableErrorPatterns: ["invalid api key"],
      log: false,
    })
    const wrapped = createStickyFetch({ baseFetch: base, config: cfg })
    let threw = false
    try {
      await wrapped(PROVIDER)
    } catch {
      threw = true
    }
    assert(threw, "should have thrown")
    assert(calls === 1, `calls=${calls}`)
  })

  // 6) non-retriable body pattern returns response
  await test("non-retriable body pattern returns response", async () => {
    let calls = 0
    const base: typeof fetch = async () => {
      calls += 1
      return new Response(JSON.stringify({ error: "context length exceeded" }), { status: 500 })
    }
    const cfg = resolveConfig({
      initialDelayMs: 1,
      maxDelayMs: 2,
      jitter: "none",
      sticky: true,
      nonRetriableBodyPatterns: ["context length"],
      log: false,
    })
    const wrapped = createStickyFetch({ baseFetch: base, config: cfg })
    const res = await wrapped(PROVIDER)
    assert(res.status === 500, "status")
    const body = await res.text()
    assert(body.includes("context length"), "body preserved")
    assert(calls === 1, `calls=${calls}`)
  })

  // 7) abort during sleep
  await test("abort signal interrupts retry loop", async () => {
    let calls = 0
    const base: typeof fetch = async () => {
      calls += 1
      throw new Error("network down")
    }
    const cfg = resolveConfig({ initialDelayMs: 100, maxDelayMs: 100, jitter: "none", sticky: true, log: false })
    const wrapped = createStickyFetch({ baseFetch: base, config: cfg })
    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(), 50)
    let aborted = false
    try {
      await wrapped(PROVIDER, { signal: ctrl.signal })
    } catch (err) {
      aborted = (err as Error).name === "AbortError" || ctrl.signal.aborted
    }
    assert(aborted, "should have aborted")
    assert(calls >= 1, `calls=${calls}`)
  })

  // 8) URL out of scope is forwarded unchanged
  await test("out-of-scope URL is not retried", async () => {
    let calls = 0
    const base: typeof fetch = async () => {
      calls += 1
      return new Response("ignored", { status: 500 })
    }
    const cfg = resolveConfig({ initialDelayMs: 1, log: false })
    const wrapped = createStickyFetch({ baseFetch: base, config: cfg })
    const res = await wrapped("https://api.github.com/some-endpoint")
    assert(res.status === 500, "status")
    assert(calls === 1, `out-of-scope should pass through, calls=${calls}`)
  })

  // 9) sticky succeeds eventually after several 503s
  await test("sticky retries 503 forever until success", async () => {
    let calls = 0
    const base: typeof fetch = async () => {
      calls += 1
      if (calls < 8) return new Response("", { status: 503 })
      return new Response("ok", { status: 200 })
    }
    const cfg = resolveConfig({ initialDelayMs: 1, maxDelayMs: 2, jitter: "none", sticky: true, log: false })
    const wrapped = createStickyFetch({ baseFetch: base, config: cfg })
    const res = await wrapped(PROVIDER)
    assert(res.status === 200, "status")
    assert(calls === 8, `calls=${calls}`)
  })
}

void main()
