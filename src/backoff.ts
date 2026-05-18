import type { ResolvedConfig } from "./types.js"

/**
 * Compute the next backoff delay (ms) given the current attempt number.
 * `attempt` is 1-indexed: attempt=1 means the delay before the second try.
 */
export const computeDelay = (attempt: number, cfg: ResolvedConfig, retryAfterMs?: number): number => {
  if (retryAfterMs != null && cfg.honorRetryAfter) {
    return Math.min(Math.max(0, retryAfterMs), cfg.maxDelayMs)
  }
  const exp = Math.min(cfg.maxDelayMs, cfg.initialDelayMs * Math.pow(cfg.backoffFactor, Math.max(0, attempt - 1)))
  switch (cfg.jitter) {
    case "none":
      return exp
    case "full":
      return Math.random() * exp
    case "equal":
    default:
      return exp / 2 + Math.random() * (exp / 2)
  }
}

/**
 * Parse a `Retry-After` header value (in seconds OR HTTP-date) into ms.
 * Returns `undefined` if the header is missing or unparseable.
 */
export const parseRetryAfter = (headerValue: string | null | undefined): number | undefined => {
  if (!headerValue) return undefined
  const trimmed = headerValue.trim()
  if (trimmed === "") return undefined
  const asNumber = Number(trimmed)
  if (Number.isFinite(asNumber)) {
    return Math.max(0, asNumber * 1000)
  }
  const asDate = Date.parse(trimmed)
  if (!Number.isNaN(asDate)) {
    return Math.max(0, asDate - Date.now())
  }
  return undefined
}

/**
 * Sleep that resolves after `ms` OR rejects with the abort signal's reason
 * when the signal aborts first. Used so user Ctrl+C interrupts the wait
 * between attempts immediately.
 */
export const abortableSleep = (ms: number, signal?: AbortSignal | null): Promise<void> => {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

export const isAbortError = (err: unknown): boolean => {
  if (err == null) return false
  if (typeof err === "object") {
    const e = err as { name?: unknown; code?: unknown }
    if (e.name === "AbortError") return true
    if (e.code === "ABORT_ERR" || e.code === 20) return true
  }
  return false
}
