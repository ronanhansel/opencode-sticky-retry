/**
 * Public configuration shape for the sticky-retry plugin.
 *
 * All fields are optional. See {@link DEFAULT_CONFIG} for defaults.
 */
export interface StickyRetryConfig {
  /**
   * Master switch. Set to `false` to disable retry entirely without
   * removing the plugin from your config.
   * @default true
   */
  enabled?: boolean

  /**
   * Sticky mode: keep retrying forever (subject to non-retriable rules
   * and user abort). When `false`, falls back to {@link maxAttempts}.
   * @default true
   */
  sticky?: boolean

  /**
   * Cap on retry attempts when {@link sticky} is `false`. Ignored in
   * sticky mode. Includes the initial attempt.
   * @default 5
   */
  maxAttempts?: number

  /**
   * Initial backoff delay in milliseconds for the second attempt.
   * @default 1000
   */
  initialDelayMs?: number

  /**
   * Cap on the backoff delay between attempts.
   * @default 60000
   */
  maxDelayMs?: number

  /**
   * Exponential growth factor applied between attempts.
   * @default 2
   */
  backoffFactor?: number

  /**
   * Jitter strategy applied to the computed delay.
   * - `none`: deterministic delay
   * - `full`: uniform random in [0, delay]
   * - `equal`: delay/2 + uniform random in [0, delay/2]
   * @default "equal"
   */
  jitter?: "none" | "full" | "equal"

  /**
   * Honor the `Retry-After` header on 429 / 503 responses when present.
   * Capped by {@link maxDelayMs}.
   * @default true
   */
  honorRetryAfter?: boolean

  /**
   * HTTP status codes that should NEVER be retried. Takes priority
   * over `retriableStatusCodes`. Empty by default — sticky mode retries
   * everything unless you opt a code out here.
   * @default []
   */
  nonRetriableStatusCodes?: number[]

  /**
   * HTTP status codes that should be retried. Empty by default, which
   * means "retry every non-2xx" (sticky default). When non-empty, ONLY
   * the listed codes are retried; everything else is returned as-is.
   * Network/transport failures (no response at all) are always
   * considered retriable independently of this list.
   * @default []
   */
  retriableStatusCodes?: number[]

  /**
   * Regex patterns matched against the error message of thrown errors
   * (network failures, timeouts, DNS, etc). If any pattern matches,
   * the error is treated as NON-retriable and re-thrown.
   *
   * Supplied as strings (compiled with the `i` flag) or pre-built RegExp.
   * @default []
   */
  nonRetriableErrorPatterns?: Array<string | RegExp>

  /**
   * Regex patterns matched against the response body (when present)
   * for non-2xx responses. If any pattern matches, the response is
   * returned as-is and retry stops.
   *
   * Body is read with `response.clone().text()` so the original
   * response stream remains usable.
   * @default []
   */
  nonRetriableBodyPatterns?: Array<string | RegExp>

  /**
   * URL host or full-URL patterns that the wrapper applies to.
   * If empty, defaults to a curated list of common LLM provider hosts.
   * Set to `["*"]` to apply to ALL fetch calls (not recommended; this
   * will retry calls to unrelated services).
   *
   * Each entry is matched against `request.url` with substring
   * matching, OR compiled as a regex if it starts AND ends with `/`.
   * @default see DEFAULT_PROVIDER_HOSTS
   */
  urlAllowlist?: string[]

  /**
   * If `true`, log retry attempts via `client.app.log()` so they show up
   * in opencode's log stream.
   * @default true
   */
  log?: boolean

  /**
   * Verbosity level for log output.
   * @default "info"
   */
  logLevel?: "debug" | "info" | "warn" | "error"

  /**
   * Surface retry activity through opencode's TUI toast system so the
   * user knows the agent is waiting on retries (and why) instead of
   * looking frozen. Each toast includes the host, reason, and the full
   * error / response body excerpt (truncated for readability — never
   * omitted) so the user can see *what* failed, not just the status code.
   *
   * - `"off"`: no toasts.
   * - `"events"`: a toast on every retry, on recovery, and when the
   *   plugin gives up. (default)
   * - `"verbose"`: same as `events`, but does NOT suppress per-retry
   *   toasts during fast initial bursts. Use this if you want every
   *   single attempt surfaced regardless of backoff length.
   * @default "events"
   */
  notify?: "off" | "events" | "verbose"

  /**
   * In `notify: "events"`, suppress per-retry toasts whose backoff is
   * shorter than this so a tight initial burst doesn't spam the TUI.
   * Set to `0` to never suppress (every retry gets a toast). `verbose`
   * mode ignores this entirely.
   * @default 0
   */
  notifyMinDelayMs?: number

  /**
   * Minimum gap (ms) between consecutive toasts for the same phase.
   * Bursts inside this window are coalesced into one toast. Set to `0`
   * to disable throttling and surface every retry (default).
   * @default 0
   */
  notifyThrottleMs?: number

  /**
   * Default `duration` (ms) used when emitting toasts. opencode's TUI
   * controls the actual presentation; this is just a hint.
   * @default 6000
   */
  notifyDurationMs?: number
}

export type ResolvedConfig = Required<
  Omit<StickyRetryConfig, "nonRetriableErrorPatterns" | "nonRetriableBodyPatterns">
> & {
  nonRetriableErrorPatterns: RegExp[]
  nonRetriableBodyPatterns: RegExp[]
}

export type RetryDecision =
  | { retry: true; reason: string; delayHintMs?: number }
  | { retry: false; reason: string }
