import type { ResolvedConfig, StickyRetryConfig } from "./types.js"

/**
 * Curated list of known LLM provider hosts. Used as the default
 * URL allowlist so unrelated fetch calls (telemetry, GitHub API, etc)
 * are not affected by the retry wrapper.
 */
export const DEFAULT_PROVIDER_HOSTS: string[] = [
  "api.anthropic.com",
  "api.openai.com",
  "api.openrouter.ai",
  "openrouter.ai",
  "generativelanguage.googleapis.com",
  "aiplatform.googleapis.com",
  "api.x.ai",
  "api.groq.com",
  "api.mistral.ai",
  "api.deepseek.com",
  "api.together.xyz",
  "api.fireworks.ai",
  "api.perplexity.ai",
  "api.cerebras.ai",
  "api.cohere.com",
  "api.cohere.ai",
  ".bedrock-runtime.",
  ".amazonaws.com",
  "azure.com",
  "openai.azure.com",
  "opencode.ai",
  "api.opencode.ai",
  "zen.opencode.ai",
]

export const DEFAULT_CONFIG: ResolvedConfig = {
  enabled: true,
  sticky: true,
  maxAttempts: 5,
  initialDelayMs: 1_000,
  maxDelayMs: 60_000,
  backoffFactor: 2,
  jitter: "equal",
  honorRetryAfter: true,
  nonRetriableStatusCodes: [],
  retriableStatusCodes: [],
  nonRetriableErrorPatterns: [],
  nonRetriableBodyPatterns: [],
  urlAllowlist: DEFAULT_PROVIDER_HOSTS,
  log: true,
  logLevel: "info",
}

const compilePattern = (p: string | RegExp): RegExp => {
  if (p instanceof RegExp) return p
  return new RegExp(p, "i")
}

/**
 * Merge user-supplied options on top of the defaults and compile
 * pattern strings into RegExp instances.
 */
export const resolveConfig = (input: StickyRetryConfig | undefined): ResolvedConfig => {
  const cfg = input ?? {}
  return {
    enabled: cfg.enabled ?? DEFAULT_CONFIG.enabled,
    sticky: cfg.sticky ?? DEFAULT_CONFIG.sticky,
    maxAttempts: Math.max(1, cfg.maxAttempts ?? DEFAULT_CONFIG.maxAttempts),
    initialDelayMs: Math.max(0, cfg.initialDelayMs ?? DEFAULT_CONFIG.initialDelayMs),
    maxDelayMs: Math.max(0, cfg.maxDelayMs ?? DEFAULT_CONFIG.maxDelayMs),
    backoffFactor: Math.max(1, cfg.backoffFactor ?? DEFAULT_CONFIG.backoffFactor),
    jitter: cfg.jitter ?? DEFAULT_CONFIG.jitter,
    honorRetryAfter: cfg.honorRetryAfter ?? DEFAULT_CONFIG.honorRetryAfter,
    nonRetriableStatusCodes: cfg.nonRetriableStatusCodes ?? DEFAULT_CONFIG.nonRetriableStatusCodes,
    retriableStatusCodes: cfg.retriableStatusCodes ?? DEFAULT_CONFIG.retriableStatusCodes,
    nonRetriableErrorPatterns: (cfg.nonRetriableErrorPatterns ?? []).map(compilePattern),
    nonRetriableBodyPatterns: (cfg.nonRetriableBodyPatterns ?? []).map(compilePattern),
    urlAllowlist: cfg.urlAllowlist ?? DEFAULT_CONFIG.urlAllowlist,
    log: cfg.log ?? DEFAULT_CONFIG.log,
    logLevel: cfg.logLevel ?? DEFAULT_CONFIG.logLevel,
  }
}
