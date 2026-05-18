# opencode-sticky-retry

Configurable, sticky retry plugin for [opencode](https://opencode.ai). Keeps
provider requests alive across transient network failures and 5xx outages so
long-running agent sessions survive flaky links, ISP blips, and provider
hiccups without operator intervention.

## What it does

When opencode makes an HTTP request to a configured LLM provider, this plugin
wraps `fetch` and:

- Retries on transport errors (DNS, ECONNRESET, timeouts, etc.).
- By default retries on every non-2xx HTTP status. Configure
  `nonRetriableStatusCodes` to opt specific codes out, or
  `retriableStatusCodes` to switch to a strict allowlist.
- Honors `Retry-After` on 429 / 503 responses when present.
- Backs off exponentially with optional jitter, capped at `maxDelayMs`.
- In **sticky mode** (default) keeps trying forever, until one of:
  - the request succeeds,
  - the user aborts the session (Ctrl+C / opencode's stop),
  - the response status matches `nonRetriableStatusCodes`,
  - `retriableStatusCodes` is set and the status is not in the list,
  - the error message matches `nonRetriableErrorPatterns`,
  - the response body matches `nonRetriableBodyPatterns`.

In non-sticky mode it falls back to a fixed `maxAttempts` cap.

## Install

The plugin is published as an npm package. opencode installs it for you when
it is referenced from `opencode.json`.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "opencode-sticky-retry"
  ]
}
```

For local development, drop the built JS into `.opencode/plugins/` instead, or
reference a relative path:

```jsonc
{
  "plugin": [
    "./path/to/opencode-sticky-retry/dist/index.js"
  ]
}
```

After saving the config, restart opencode. Plugins are loaded once at startup.

## Configure

Pass options as the second tuple element:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["opencode-sticky-retry", {
      "sticky": true,
      "initialDelayMs": 1000,
      "maxDelayMs": 60000,
      "backoffFactor": 2,
      "jitter": "equal",
      "honorRetryAfter": true,
      "nonRetriableStatusCodes": [400, 401, 403, 404, 422],
      "nonRetriableErrorPatterns": ["invalid api key"],
      "nonRetriableBodyPatterns": ["content policy"],
      "log": true,
      "logLevel": "info",
      "notify": "events"
    }]
  ]
}
```

### Options

| Option                       | Type                          | Default                                     | Notes |
| ---                          | ---                           | ---                                         | --- |
| `enabled`                    | `boolean`                     | `true`                                      | Master switch. |
| `sticky`                     | `boolean`                     | `true`                                      | When `true`, ignore `maxAttempts` and retry forever. |
| `maxAttempts`                | `number`                      | `5`                                         | Used only when `sticky: false`. Includes the initial attempt. |
| `initialDelayMs`             | `number`                      | `1000`                                      | Backoff before the second attempt. |
| `maxDelayMs`                 | `number`                      | `60000`                                     | Upper bound on the backoff. |
| `backoffFactor`              | `number`                      | `2`                                         | Exponential growth factor. |
| `jitter`                     | `"none" \| "full" \| "equal"` | `"equal"`                                  | Jitter strategy. |
| `honorRetryAfter`            | `boolean`                     | `true`                                      | Use `Retry-After` header when present. |
| `nonRetriableStatusCodes`    | `number[]`                    | `[]`                                        | Listed codes are never retried (returned as-is). |
| `retriableStatusCodes`       | `number[]`                    | `[]`                                        | When empty, every non-2xx is retried. When non-empty, ONLY listed codes are retried. |
| `nonRetriableErrorPatterns`  | `(string \| RegExp)[]`        | `[]`                                        | Match thrown error message. Strings compile with `i` flag. |
| `nonRetriableBodyPatterns`   | `(string \| RegExp)[]`        | `[]`                                        | Match against response body (first 4 KB) on non-2xx. |
| `urlAllowlist`               | `string[]`                    | curated provider list                       | Substring or `/regex/flags`. Use `["*"]` to apply to every fetch. |
| `log`                        | `boolean`                     | `true`                                      | Emit retry events through opencode's logger. |
| `logLevel`                   | `"debug" \| "info" \| "warn" \| "error"` | `"info"`                       | Floor for emitted events. |
| `notify`                     | `"off" \| "events" \| "verbose"` | `"events"`                              | Surface retry activity via TUI toasts. See [Notifications](#notifications). |
| `notifyMinDelayMs`           | `number`                      | `0`                                         | In `events` mode, suppress per-retry toasts whose backoff is shorter than this (set `>0` to mute fast initial bursts). `verbose` ignores it. |
| `notifyThrottleMs`           | `number`                      | `0`                                         | Minimum gap (ms) between consecutive toasts for the same phase. `0` disables. |
| `notifyDurationMs`           | `number`                      | `6000`                                      | Hint for how long opencode should keep each toast on screen. |

### Default URL allowlist

By default the wrapper only intercepts hosts that look like LLM endpoints —
Anthropic, OpenAI, OpenRouter, Google, Azure, Bedrock, Groq, Mistral,
DeepSeek, Together, Fireworks, Perplexity, Cerebras, Cohere, opencode Zen,
plus a few others. Telemetry, GitHub, and unrelated tool calls are forwarded
through the original fetch unchanged.

To add a host:

```jsonc
{ "urlAllowlist": ["api.anthropic.com", "my-internal-gateway.example.com"] }
```

To match every fetch (not recommended; will retry every outbound HTTP call):

```jsonc
{ "urlAllowlist": ["*"] }
```

To match by regex, wrap the entry in slashes:

```jsonc
{ "urlAllowlist": ["/^https?:\\/\\/.*\\.openai\\.azure\\.com\\//i"] }
```

## How it works

The plugin replaces `globalThis.fetch` once, on the first plugin call,
guarding with a `Symbol.for` flag so the install is idempotent across global
and project scopes. The wrapper:

1. Forwards out-of-scope URLs to the original fetch unchanged.
2. Reads the request's `AbortSignal` (if any) so user aborts always win.
3. On success (`response.ok`), returns the response immediately.
4. On retriable status, peeks at the body via `response.clone()`, checks
   `nonRetriableBodyPatterns`, and either returns the response or sleeps
   for `Retry-After` or computed backoff.
5. On thrown errors (network/transport), checks
   `nonRetriableErrorPatterns` and either re-throws or sleeps and retries.
6. The sleep is interruptible by the request's abort signal.

### Recommended escape hatches

Sticky retry is a hammer. Some failures are deterministic and will never
succeed no matter how many times you retry. The most common ones:

- **`400 Bad Request`** — the request body is malformed, retrying produces the same error.
- **`401 Unauthorized` / `403 Forbidden`** — auth issues, fix the credentials instead.
- **`422 Unprocessable Entity`** — request shape is wrong (often model-id mismatch with the provider).
- **Context-window exceeded** — provider returns a specific error in the body.

A reasonable starting point:

```jsonc
{
  "plugin": [["opencode-sticky-retry", {
    "nonRetriableStatusCodes": [400, 401, 403, 422],
    "nonRetriableBodyPatterns": ["context length", "context_length_exceeded", "content policy"]
  }]]
}
```

These are deliberately **not** defaults — the plugin's whole point is that
you decide what to opt out of, not the other way around.

### Limitations

- Mid-stream disconnects (token stream cut after the response started) are
  outside the scope of a fetch wrapper — once `fetch` resolves, the wrapper
  has already handed the body off to opencode. Recovery there belongs in the
  agent core, not in user-space plugins. This plugin reliably handles
  connection-establish failures, DNS, timeouts, and any non-2xx response.
- Some providers return 200 with an error envelope. Use
  `nonRetriableBodyPatterns` to short-circuit those.

## Logging

When `log: true`, retry events are sent through `client.app.log()` with the
service name `opencode-sticky-retry`. They appear in opencode's normal log
stream alongside other plugin output.

## Notifications

When `notify` is set to anything other than `"off"`, the plugin uses
opencode's TUI toast API (`client.tui.showToast`) to surface retry
activity to the user. The session no longer looks frozen during a long
outage — the user sees *why* the agent is waiting and roughly how long
until the next attempt.

Each toast carries:

- The host that failed (e.g. `api.anthropic.com`).
- A short reason: `HTTP 503`, `ECONNRESET`, `fetch failed`, etc.
- The full error message (with cause chain) for transport errors, or a
  body excerpt (first 4 KB, whitespace-collapsed, capped at 600 chars)
  for HTTP failures. This is **never omitted** — the goal is for the
  user to be able to read what the provider actually said.
- The time until the next attempt, when applicable.

Phases:

- `retry` — emitted on **every** failed attempt that triggers a retry.
  Toast variant is `warning`. The `first` flag distinguishes the initial
  failure from subsequent ones in the toast text.
- `recovered` — emitted on the first successful response after one or
  more retries. Variant is `success`.
- `gave_up` — emitted in non-sticky mode when `maxAttempts` is reached.
  Variant is `error`.

By default (`notify: "events"`, `notifyThrottleMs: 0`,
`notifyMinDelayMs: 0`) every retry produces a toast. If a fast initial
burst is too noisy, raise `notifyMinDelayMs` (or `notifyThrottleMs`) so
opencode coalesces those into fewer toasts. `notify: "verbose"` ignores
`notifyMinDelayMs` entirely and surfaces every retry no matter how
short the backoff.

If you are running an older opencode build that does not expose
`client.tui.showToast`, the plugin silently degrades and only logs.

## Development

```bash
npm install
npm run typecheck
npm run build
```

The package targets Node 18+ / Bun. opencode installs plugins through Bun, so
the build output is plain ESM.

## Releasing

Releases are cut by publishing a GitHub Release. The
[`release` workflow](.github/workflows/release.yml) builds, typechecks,
and publishes to npm with [provenance](https://docs.npmjs.com/generating-provenance-statements)
via npm Trusted Publishing — there is no long-lived `NPM_TOKEN`.

Steps for a new version:

1. Bump `version` in `package.json` and commit on `main`.
2. Tag and push: `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. Create a GitHub Release for that tag (`gh release create vX.Y.Z`).
   The workflow runs on `release: published`.
4. The workflow asserts `tag == package.json version`, runs the build,
   then `npm publish --provenance --access public`.

### One-time npm setup (Trusted Publishing)

Required only for the first release on npm — without this, the OIDC
publish will fail.

1. Sign in at [npmjs.com](https://www.npmjs.com/) as the package owner.
2. Open the package settings page (`Settings` → `Publishing access`).
3. Add a **Trusted Publisher**:
   - Organization or user: `ronanhansel`
   - Repository: `opencode-sticky-retry`
   - Workflow filename: `release.yml`
   - Environment: `npm`
4. Save. Subsequent GitHub Releases will publish automatically.

The repository already has an `npm` environment referenced in the
workflow; GitHub creates it on first run if it does not exist. You can
optionally add required reviewers to that environment if you want a
manual approval step before each publish.

Manual republish of an existing tag is also supported via
`workflow_dispatch` (`Actions` → `release` → `Run workflow`).

## License

MIT
