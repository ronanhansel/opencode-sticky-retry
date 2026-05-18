import type { Plugin, PluginInput, PluginOptions } from "@opencode-ai/plugin"

import { resolveConfig } from "./config.js"
import { createStickyFetch, formatNotifyEvent, makeLevelFilteredLogger, type Logger, type Notifier } from "./retry.js"
import type { StickyRetryConfig } from "./types.js"

// Re-export type-only surface for TS consumers. Type exports compile to a
// no-op at runtime so opencode's plugin loader (which iterates every runtime
// export and rejects non-function values) does not see them.
export type { StickyRetryConfig, ResolvedConfig, RetryDecision } from "./types.js"
export type { Notifier, NotifyEvent } from "./retry.js"

const INSTALLED_FLAG = Symbol.for("opencode-sticky-retry.installed")

type GlobalWithFlag = typeof globalThis & {
  [INSTALLED_FLAG]?: boolean
}

/**
 * Plugin entry point. opencode imports the default export and calls it
 * with the plugin context plus the user-supplied options from
 * `opencode.json`'s `plugin` array.
 *
 * Wiring example (project `opencode.json`):
 * ```json
 * {
 *   "plugin": [
 *     ["opencode-sticky-retry", { "sticky": true, "log": true }]
 *   ]
 * }
 * ```
 */
const stickyRetryPlugin: Plugin = async (ctx: PluginInput, options?: PluginOptions) => {
  const config = resolveConfig(options as StickyRetryConfig | undefined)

  // Build a logger that routes through opencode's app log when
  // available. Plugin context's `client.app.log` is async; we
  // fire-and-forget because retry decisions can't wait on logging.
  const sink: Logger = (level, message, extra) => {
    try {
      void ctx.client.app.log({
        body: {
          service: "opencode-sticky-retry",
          level,
          message,
          extra: extra ?? {},
        },
      })
    } catch {
      // ignore logging failures
    }
  }
  const log = makeLevelFilteredLogger(config, sink)

  // Notifier sink: surface retry activity via opencode's TUI toast.
  // Fire-and-forget so retry decisions never wait on the UI.
  const notifySink: Notifier = (event) => {
    if (config.notify === "off") return
    const toast = formatNotifyEvent(event)
    try {
      const tui = (ctx.client as { tui?: { showToast?: (input: unknown) => unknown } }).tui
      const showToast = tui?.showToast?.bind(tui)
      if (typeof showToast !== "function") {
        // Older opencode without TUI toast API: silently degrade.
        log("debug", "[sticky-retry] client.tui.showToast unavailable, skipping toast", {
          phase: event.phase,
        })
        return
      }
      void Promise.resolve(
        showToast({
          body: {
            title: toast.title,
            message: toast.message,
            variant: toast.variant,
            duration: config.notifyDurationMs,
          },
        }),
      ).catch(() => {
        // ignore toast failures
      })
    } catch {
      // ignore toast failures
    }
  }

  if (!config.enabled) {
    log("info", "[sticky-retry] disabled via config")
    return {}
  }

  const g = globalThis as GlobalWithFlag
  if (g[INSTALLED_FLAG]) {
    // Some opencode versions instantiate plugins more than once
    // (e.g. global + project scope). The wrapper is idempotent: the
    // first install captures the original fetch and subsequent calls
    // are no-ops.
    log("debug", "[sticky-retry] wrapper already installed, skipping")
    return {}
  }

  const originalFetch = globalThis.fetch.bind(globalThis)
  const wrapped = createStickyFetch({ baseFetch: originalFetch, config, log, notify: notifySink })
  globalThis.fetch = wrapped as typeof fetch
  g[INSTALLED_FLAG] = true

  log("info", "[sticky-retry] installed", {
    sticky: config.sticky,
    maxAttempts: config.sticky ? "∞" : String(config.maxAttempts),
    initialDelayMs: config.initialDelayMs,
    maxDelayMs: config.maxDelayMs,
    backoffFactor: config.backoffFactor,
    jitter: config.jitter,
    honorRetryAfter: config.honorRetryAfter,
    allowlistSize: config.urlAllowlist.length,
    nonRetriableStatusCodes: config.nonRetriableStatusCodes,
    nonRetriableErrorPatterns: config.nonRetriableErrorPatterns.map((r) => r.source),
    nonRetriableBodyPatterns: config.nonRetriableBodyPatterns.map((r) => r.source),
    notify: config.notify,
  })

  return {}
}

export default stickyRetryPlugin
