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
      "logLevel": "info"
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

## Development

```bash
npm install
npm run typecheck
npm run build
```

The package targets Node 18+ / Bun. opencode installs plugins through Bun, so
the build output is plain ESM.

## License

MIT
