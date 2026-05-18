import type { ResolvedConfig } from "./types.js"

/**
 * Decide whether a URL is in scope for the retry wrapper.
 *
 * Each entry in the allowlist is interpreted as either:
 *  - `*`              → match everything
 *  - `/regex/flags`   → compiled RegExp (entry starts and ends with `/`)
 *  - anything else    → case-insensitive substring match against the URL
 */
export const isUrlInScope = (url: string, allowlist: readonly string[]): boolean => {
  if (allowlist.length === 0) return false
  const lower = url.toLowerCase()
  for (const raw of allowlist) {
    if (raw === "*") return true
    if (raw.length >= 2 && raw.startsWith("/")) {
      const last = raw.lastIndexOf("/")
      if (last > 0) {
        const body = raw.slice(1, last)
        const flags = raw.slice(last + 1)
        try {
          if (new RegExp(body, flags).test(url)) return true
          continue
        } catch {
          // fall through to substring match if regex was malformed
        }
      }
    }
    if (lower.includes(raw.toLowerCase())) return true
  }
  return false
}

/**
 * Match thrown error message (and any nested cause) against the
 * configured non-retriable patterns. Returns the offending pattern
 * source on match, or `null` otherwise.
 */
export const matchNonRetriableError = (err: unknown, patterns: readonly RegExp[]): string | null => {
  if (patterns.length === 0) return null
  const haystack = collectErrorText(err)
  for (const re of patterns) {
    if (re.test(haystack)) return re.source
  }
  return null
}

const collectErrorText = (err: unknown, depth = 0): string => {
  if (depth > 4 || err == null) return ""
  if (typeof err === "string") return err
  if (typeof err !== "object") return String(err)
  const e = err as { message?: unknown; name?: unknown; code?: unknown; cause?: unknown }
  const parts: string[] = []
  if (typeof e.name === "string") parts.push(e.name)
  if (typeof e.code === "string") parts.push(e.code)
  if (typeof e.message === "string") parts.push(e.message)
  if (e.cause) parts.push(collectErrorText(e.cause, depth + 1))
  return parts.join(" :: ")
}

/**
 * Match a response body string against non-retriable body patterns.
 * Returns the offending pattern source on match, or `null` otherwise.
 */
export const matchNonRetriableBody = (body: string, patterns: readonly RegExp[]): string | null => {
  if (patterns.length === 0 || body.length === 0) return null
  for (const re of patterns) {
    if (re.test(body)) return re.source
  }
  return null
}

/**
 * Decide whether an HTTP status code should be retried under the
 * supplied policy.
 *
 * Precedence (highest to lowest):
 *  1. `nonRetriableStatusCodes` — listed code is never retried.
 *  2. `retriableStatusCodes` (when non-empty) — acts as an allowlist:
 *     only listed codes are retried, everything else is returned as-is.
 *  3. Default (when both lists are empty): retry every non-2xx.
 *
 * 2xx is handled upstream of this function (`response.ok`) and never
 * reaches it.
 */
export const shouldRetryStatus = (status: number, cfg: ResolvedConfig): boolean => {
  if (cfg.nonRetriableStatusCodes.includes(status)) return false
  if (cfg.retriableStatusCodes.length > 0) {
    return cfg.retriableStatusCodes.includes(status)
  }
  return true
}
