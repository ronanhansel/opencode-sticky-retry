import { abortableSleep, computeDelay, isAbortError, parseRetryAfter } from "./backoff.js"
import { isUrlInScope, matchNonRetriableBody, matchNonRetriableError, shouldRetryStatus } from "./matcher.js"
import type { ResolvedConfig } from "./types.js"

export type Logger = (level: "debug" | "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) => void

const noopLogger: Logger = () => {}

const levelRank = { debug: 10, info: 20, warn: 30, error: 40 } as const

export const makeLevelFilteredLogger = (cfg: ResolvedConfig, sink: Logger): Logger => {
  if (!cfg.log) return noopLogger
  const min = levelRank[cfg.logLevel]
  return (level, message, extra) => {
    if (levelRank[level] >= min) sink(level, message, extra)
  }
}

const extractUrl = (input: RequestInfo | URL): string => {
  if (typeof input === "string") return input
  if (input instanceof URL) return input.toString()
  return input.url
}

const extractMethod = (input: RequestInfo | URL, init?: RequestInit): string => {
  if (init?.method) return init.method.toUpperCase()
  if (typeof input === "object" && "method" in input && input.method) return input.method.toUpperCase()
  return "GET"
}

const extractSignal = (input: RequestInfo | URL, init?: RequestInit): AbortSignal | null => {
  if (init?.signal) return init.signal
  if (typeof input === "object" && "signal" in input && input.signal) return input.signal as AbortSignal
  return null
}

/**
 * Read up to `limit` characters from a Response body without consuming
 * the original (uses .clone()). Returns "" on any failure.
 */
const peekBody = async (response: Response, limit = 4096): Promise<string> => {
  try {
    const text = await response.clone().text()
    return text.length > limit ? text.slice(0, limit) : text
  } catch {
    return ""
  }
}

export interface FetchWrapperDeps {
  /** The fetch implementation to wrap (typically the original globalThis.fetch). */
  baseFetch: typeof fetch
  /** Resolved plugin configuration. */
  config: ResolvedConfig
  /** Optional logger sink. */
  log?: Logger
}

/**
 * Build a fetch-compatible function that retries failed calls per the
 * sticky-retry policy. Calls outside the URL allowlist are forwarded
 * to the base fetch unchanged.
 */
export const createStickyFetch = ({ baseFetch, config, log = noopLogger }: FetchWrapperDeps): typeof fetch => {
  const wrapped: typeof fetch = async (input, init) => {
    if (!config.enabled) return baseFetch(input, init)
    const url = extractUrl(input)
    if (!isUrlInScope(url, config.urlAllowlist)) return baseFetch(input, init)

    const method = extractMethod(input, init)
    const signal = extractSignal(input, init)
    const startedAt = Date.now()
    let attempt = 0
    let lastError: unknown = null

    while (true) {
      if (signal?.aborted) {
        throw signal.reason ?? new DOMException("Aborted", "AbortError")
      }
      attempt += 1
      try {
        const response = await baseFetch(input, init)
        if (response.ok) {
          if (attempt > 1) {
            log("info", `[sticky-retry] recovered after ${attempt} attempts`, {
              url,
              method,
              status: response.status,
              elapsedMs: Date.now() - startedAt,
            })
          }
          return response
        }

        // Non-OK response. Decide if we retry.
        const status = response.status
        if (!shouldRetryStatus(status, config)) {
          log("debug", `[sticky-retry] non-retriable status, returning response`, { url, method, status })
          return response
        }

        // Body-pattern check (e.g. provider returns 200/4xx with a specific
        // error code that should never retry).
        const bodyPeek = await peekBody(response)
        const bodyMatch = matchNonRetriableBody(bodyPeek, config.nonRetriableBodyPatterns)
        if (bodyMatch) {
          log("info", `[sticky-retry] body matched non-retriable pattern, returning response`, {
            url,
            method,
            status,
            pattern: bodyMatch,
          })
          return response
        }

        // Stop if we've hit the cap in non-sticky mode.
        if (!config.sticky && attempt >= config.maxAttempts) {
          log("warn", `[sticky-retry] gave up after ${attempt} attempts (non-sticky)`, { url, method, status })
          return response
        }

        const retryAfter = parseRetryAfter(response.headers.get("retry-after"))
        const delay = computeDelay(attempt, config, retryAfter)
        log("info", `[sticky-retry] retrying after ${Math.round(delay)}ms`, {
          url,
          method,
          status,
          attempt,
          sticky: config.sticky,
          retryAfterMs: retryAfter,
        })
        await abortableSleep(delay, signal)
        continue
      } catch (err) {
        // User abort: never retry.
        if (isAbortError(err) || signal?.aborted) {
          throw err
        }
        lastError = err

        const errMatch = matchNonRetriableError(err, config.nonRetriableErrorPatterns)
        if (errMatch) {
          log("info", `[sticky-retry] error matched non-retriable pattern, rethrowing`, {
            url,
            method,
            pattern: errMatch,
          })
          throw err
        }

        if (!config.sticky && attempt >= config.maxAttempts) {
          log("warn", `[sticky-retry] gave up after ${attempt} attempts (non-sticky)`, {
            url,
            method,
            error: stringifyError(err),
          })
          throw err
        }

        const delay = computeDelay(attempt, config)
        log("warn", `[sticky-retry] transport error, retrying after ${Math.round(delay)}ms`, {
          url,
          method,
          attempt,
          sticky: config.sticky,
          error: stringifyError(err),
        })
        try {
          await abortableSleep(delay, signal)
        } catch (abortErr) {
          throw abortErr
        }
        continue
      }
    }

    // unreachable, but keeps tsc happy on some configs
    // eslint-disable-next-line @typescript-eslint/no-throw-literal
    throw lastError
  }

  return wrapped
}

const stringifyError = (err: unknown): string => {
  if (err == null) return "null"
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause
    return cause ? `${err.name}: ${err.message} (cause: ${stringifyError(cause)})` : `${err.name}: ${err.message}`
  }
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}
