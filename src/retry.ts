import { abortableSleep, computeDelay, isAbortError, parseRetryAfter } from "./backoff.js"
import { isUrlInScope, matchNonRetriableBody, matchNonRetriableError, shouldRetryStatus } from "./matcher.js"
import type { ResolvedConfig } from "./types.js"

export type Logger = (level: "debug" | "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) => void

/**
 * Retry lifecycle events surfaced to the user (toasts). Decoupled from
 * the logger so notifications can be opt-in / opt-out independently.
 */
export type NotifyEvent =
  | {
      phase: "retry"
      /** Short reason ("HTTP 503", "ECONNRESET", "fetch failed"). */
      reason: string
      /** Full error message / response body excerpt. Empty string if none. */
      detail: string
      /** Computed backoff before the next attempt (ms). */
      delayMs: number
      /** 1-indexed attempt number that just failed. */
      attempt: number
      /** Whether this is the first failure of the request. */
      first: boolean
      /** Request URL. */
      url: string
    }
  | { phase: "recovered"; attempts: number; elapsedMs: number; url: string }
  | { phase: "gave_up"; reason: string; detail: string; attempts: number; url: string }

export type Notifier = (event: NotifyEvent) => void

const noopLogger: Logger = () => {}
const noopNotifier: Notifier = () => {}

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
  /** Optional notifier sink for surfacing retry events to the user (e.g. TUI toasts). */
  notify?: Notifier
}

/**
 * Wraps a Notifier with throttling per phase. `notifyThrottleMs: 0`
 * disables throttling. Returns a noop when notifications are disabled.
 */
const buildNotifierGate = (cfg: ResolvedConfig, sink: Notifier): Notifier => {
  if (cfg.notify === "off") return noopNotifier
  const lastAt = new Map<NotifyEvent["phase"], number>()
  return (event) => {
    if (event.phase === "retry" && cfg.notify === "events") {
      // events mode: drop fast-burst retries below the configured floor.
      // verbose mode always emits.
      if (cfg.notifyMinDelayMs > 0 && event.delayMs < cfg.notifyMinDelayMs) return
    }
    if (cfg.notifyThrottleMs > 0) {
      const now = Date.now()
      const prev = lastAt.get(event.phase) ?? 0
      if (now - prev < cfg.notifyThrottleMs) return
      lastAt.set(event.phase, now)
    }
    try {
      sink(event)
    } catch {
      // notifier failures must never break a retry loop
    }
  }
}

const summarizeError = (err: unknown): string => {
  if (err == null) return "unknown error"
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code
    if (typeof code === "string" && code.length > 0) return code
    return err.message || err.name || "transport error"
  }
  return String(err)
}

/** Full one-line error description, walking the cause chain. */
const detailError = (err: unknown, max = 600): string => {
  if (err == null) return ""
  const text = stringifyError(err)
  return collapseAndTruncate(text, max)
}

/** Single-line, length-capped extract of a response body for display. */
const detailBody = (body: string, max = 600): string => {
  if (!body) return ""
  return collapseAndTruncate(body, max)
}

const collapseAndTruncate = (s: string, max: number): string => {
  const collapsed = s.replace(/\s+/g, " ").trim()
  if (collapsed.length <= max) return collapsed
  return collapsed.slice(0, max - 1) + "…"
}

const summarizeStatus = (status: number): string => `HTTP ${status}`

const hostFromUrl = (url: string): string => {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/**
 * Build a fetch-compatible function that retries failed calls per the
 * sticky-retry policy. Calls outside the URL allowlist are forwarded
 * to the base fetch unchanged.
 */
export const createStickyFetch = ({ baseFetch, config, log = noopLogger, notify = noopNotifier }: FetchWrapperDeps): typeof fetch => {
  const notifyGate = buildNotifierGate(config, notify)
  const wrapped: typeof fetch = async (input, init) => {
    if (!config.enabled) return baseFetch(input, init)
    const url = extractUrl(input)
    if (!isUrlInScope(url, config.urlAllowlist)) return baseFetch(input, init)

    const method = extractMethod(input, init)
    const signal = extractSignal(input, init)
    const startedAt = Date.now()
    let attempt = 0
    let lastError: unknown = null
    let notifiedStarted = false

    while (true) {
      if (signal?.aborted) {
        throw signal.reason ?? new DOMException("Aborted", "AbortError")
      }
      attempt += 1
      try {
        const response = await baseFetch(input, init)
        if (response.ok) {
          if (attempt > 1) {
            const elapsedMs = Date.now() - startedAt
            log("info", `[sticky-retry] recovered after ${attempt} attempts`, {
              url,
              method,
              status: response.status,
              elapsedMs,
            })
            notifyGate({ phase: "recovered", attempts: attempt, elapsedMs, url })
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
          notifyGate({
            phase: "gave_up",
            reason: summarizeStatus(status),
            detail: detailBody(bodyPeek),
            attempts: attempt,
            url,
          })
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
        notifyGate({
          phase: "retry",
          reason: summarizeStatus(status),
          detail: detailBody(bodyPeek),
          delayMs: delay,
          attempt,
          first: !notifiedStarted,
          url,
        })
        notifiedStarted = true
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
          notifyGate({
            phase: "gave_up",
            reason: summarizeError(err),
            detail: detailError(err),
            attempts: attempt,
            url,
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
        notifyGate({
          phase: "retry",
          reason: summarizeError(err),
          detail: detailError(err),
          delayMs: delay,
          attempt,
          first: !notifiedStarted,
          url,
        })
        notifiedStarted = true
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

/** Default human-readable formatter for NotifyEvent → toast text. */
export const formatNotifyEvent = (
  event: NotifyEvent,
): { title: string; message: string; variant: "info" | "success" | "warning" | "error" } => {
  const host = hostFromUrl(event.url)
  const appendDetail = (head: string, detail: string): string =>
    detail ? `${head}\n${detail}` : head
  switch (event.phase) {
    case "retry": {
      const seconds = Math.max(1, Math.round(event.delayMs / 1000))
      const head = event.first
        ? `${host} failed (${event.reason}) — retrying in ${seconds}s…`
        : `${host} still failing (${event.reason}) — attempt ${event.attempt}, next in ${seconds}s…`
      return {
        title: "opencode-sticky-retry",
        message: appendDetail(head, event.detail),
        variant: "warning",
      }
    }
    case "recovered": {
      const seconds = Math.max(1, Math.round(event.elapsedMs / 1000))
      return {
        title: "opencode-sticky-retry",
        message: `${host} recovered after ${event.attempts} attempt${event.attempts === 1 ? "" : "s"} (${seconds}s).`,
        variant: "success",
      }
    }
    case "gave_up": {
      const head = `${host} gave up after ${event.attempts} attempt${event.attempts === 1 ? "" : "s"} (${event.reason}).`
      return {
        title: "opencode-sticky-retry",
        message: appendDetail(head, event.detail),
        variant: "error",
      }
    }
  }
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
