// server/_shared/llm-health.ts
// Lightweight LLM provider health gate.
// Probes provider URLs with a fast request, caches results.
// All LLM call sites check this before attempting expensive fetch calls.
//
// Two independent questions live here, and they are deliberately kept apart:
//   1. Is the provider ORIGIN reachable?  -> isProviderAvailable(), async, probes.
//   2. Is this MODEL usable on it?        -> isModelUsable(), sync, no network.
// The origin probe cannot answer (2): it GETs the bare origin, so a provider
// that is up but does not serve the configured model ID still looks healthy.

const PROBE_TIMEOUT_MS = 2_000;
const CACHE_TTL_MS = 60_000; // re-probe every 60s

/**
 * Consecutive provider-side model rejections before a model is quarantined.
 * Mirrors `DEFAULT_MAX_FAILURES` in `src/utils/circuit-breaker.ts`. One
 * rejection is deliberately not enough: an HTTP 400 can also be a malformed
 * request, and reading that as a dead model would pull a working model out of
 * the chain.
 */
const MODEL_FAILURE_THRESHOLD = 2;

/**
 * How long a quarantined model stays out of the provider chain. Longer than
 * the circuit breaker's 5-minute network cooldown because an unroutable model
 * ID is a configuration error rather than a transient fault — it does not heal
 * on its own. Bounded rather than permanent so a provider that re-lists a
 * model recovers without a redeploy.
 */
const MODEL_QUARANTINE_MS = 10 * 60_000;

/**
 * Provider error messages that identify the MODEL as the rejected part.
 * Matched against the (already-read) error body, never against the status
 * alone: OpenAI-compatible providers reuse 400/404 for malformed requests too.
 */
const MODEL_REJECTION_PATTERNS: readonly RegExp[] = [
  /\bno such model\b/i,
  /\bunknown model\b/i,
  /\binvalid model\b/i,
  /\bnot a valid model\b/i,
  /\bmodel[\s_-]*not[\s_-]*found\b/i,
  /\bmodel\b[^\n]{0,120}?\b(?:not found|does not exist|is not available|is not supported)\b/i,
];

interface HealthEntry {
  available: boolean;
  checkedAt: number;
}

interface ModelEntry {
  failures: number;
  /** 0 while the model is still inside its failure budget. */
  quarantinedUntil: number;
  lastStatus: number;
}

const cache = new Map<string, HealthEntry>();
const inFlight = new Map<string, Promise<boolean>>();
const modelCache = new Map<string, ModelEntry>();

/**
 * Probe a provider URL to check if it's reachable.
 * Uses a lightweight GET to the base origin (most OpenAI-compat servers
 * return 200 or 404 on root, either confirms reachability).
 */
async function probe(url: string): Promise<boolean> {
  try {
    const origin = new URL(url).origin;
    await fetch(origin, {
      method: 'GET',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if an LLM provider endpoint is available.
 * Returns cached result if fresh (< CACHE_TTL_MS old).
 * Otherwise probes and caches the result.
 */
export async function isProviderAvailable(apiUrl: string): Promise<boolean> {
  const origin = new URL(apiUrl).origin;
  const cached = cache.get(origin);
  if (cached && Date.now() - cached.checkedAt < CACHE_TTL_MS) {
    return cached.available;
  }

  // Coalesce concurrent probes to the same origin
  const existing = inFlight.get(origin);
  if (existing) return existing;

  const promise = probe(apiUrl).then(available => {
    cache.set(origin, { available, checkedAt: Date.now() });
    inFlight.delete(origin);
    if (!available) {
      console.warn(`[llm-health] Provider unreachable: ${origin}`);
    }
    return available;
  });
  inFlight.set(origin, promise);
  return promise;
}

/** `<origin>|<model>` — a model is only dead relative to the provider serving it. */
function modelKey(apiUrl: string, model: string): string | null {
  if (!model) return null;
  try {
    return `${new URL(apiUrl).origin}|${model}`;
  } catch {
    return null;
  }
}

/**
 * Read a model's failure record, dropping it once the quarantine has elapsed.
 * Expiry clears the failure count too, so a re-listed model gets a full budget
 * of attempts again instead of tripping on its next single failure.
 */
function readModelEntry(key: string): ModelEntry | undefined {
  const entry = modelCache.get(key);
  if (!entry) return undefined;
  if (entry.quarantinedUntil > 0 && Date.now() >= entry.quarantinedUntil) {
    modelCache.delete(key);
    return undefined;
  }
  return entry;
}

/**
 * Does this provider response mean "I do not serve that model"?
 *
 * Restricted to 400/404: 401/403 are credentials, 429 is rate limiting and 5xx
 * is an outage. Those are provider-wide and transient, and none of them says
 * anything about the model ID being wrong. An unreadable or non-matching body
 * yields `false`, so the fail-safe is the pre-existing retry-every-call
 * behaviour rather than a wrongly-quarantined model.
 */
export function isModelRejection(status: number, body: string): boolean {
  if (status !== 400 && status !== 404) return false;
  if (!body) return false;
  return MODEL_REJECTION_PATTERNS.some((pattern) => pattern.test(body));
}

/**
 * Check whether a model is currently usable on a provider. Synchronous and
 * network-free — call it before `isProviderAvailable()` so a quarantined model
 * costs neither a completion request nor an origin probe.
 */
export function isModelUsable(apiUrl: string, model: string): boolean {
  const key = modelKey(apiUrl, model);
  if (!key) return true;
  const entry = readModelEntry(key);
  return !entry || entry.quarantinedUntil === 0;
}

/**
 * Feed a failed provider response back into the gate. Ignores everything that
 * is not an explicit model rejection, so ordinary fallbacks are unaffected.
 */
export function recordModelFailure(apiUrl: string, model: string, status: number, body: string): void {
  if (!isModelRejection(status, body)) return;
  const key = modelKey(apiUrl, model);
  if (!key) return;

  const entry = readModelEntry(key) ?? { failures: 0, quarantinedUntil: 0, lastStatus: 0 };
  entry.failures += 1;
  entry.lastStatus = status;
  if (entry.quarantinedUntil === 0 && entry.failures >= MODEL_FAILURE_THRESHOLD) {
    entry.quarantinedUntil = Date.now() + MODEL_QUARANTINE_MS;
    console.warn(
      `[llm-health] Model quarantined for ${MODEL_QUARANTINE_MS / 1000}s: ${key} — rejected ${entry.failures}x with HTTP ${status}`,
    );
  }
  modelCache.set(key, entry);
}

/** Clear a model's failure record — the threshold counts CONSECUTIVE rejections. */
export function recordModelSuccess(apiUrl: string, model: string): void {
  const key = modelKey(apiUrl, model);
  if (key) modelCache.delete(key);
}

/**
 * Get current model-level health. Companion to `getLlmHealthStatus()`, which
 * only reports origin reachability and so cannot show a quarantined model.
 */
export function getLlmModelHealthStatus(): Record<string, {
  quarantined: boolean;
  failures: number;
  quarantinedUntil: number;
  lastStatus: number;
}> {
  const status: Record<string, {
    quarantined: boolean;
    failures: number;
    quarantinedUntil: number;
    lastStatus: number;
  }> = {};
  for (const [key, entry] of modelCache) {
    status[key] = {
      quarantined: entry.quarantinedUntil > 0 && Date.now() < entry.quarantinedUntil,
      failures: entry.failures,
      quarantinedUntil: entry.quarantinedUntil,
      lastStatus: entry.lastStatus,
    };
  }
  return status;
}

/**
 * Get current health status for all probed providers.
 * Used by /api/health to expose LLM status.
 */
export function getLlmHealthStatus(): Record<string, { available: boolean; checkedAt: number }> {
  const status: Record<string, { available: boolean; checkedAt: number }> = {};
  for (const [origin, entry] of cache) {
    status[origin] = { available: entry.available, checkedAt: entry.checkedAt };
  }
  return status;
}

/**
 * Force a re-probe of all cached providers.
 * Called on startup or when a provider comes back online.
 */
export async function reprobeAll(): Promise<void> {
  const origins = [...cache.keys()];
  await Promise.all(origins.map(async (origin) => {
    const available = await probe(origin);
    cache.set(origin, { available, checkedAt: Date.now() });
  }));
}

/**
 * Warm the health cache on startup by probing configured providers.
 * Fire-and-forget — does not block the caller.
 */
export function warmHealthCache(): void {
  const providerUrls: string[] = [];

  const ollamaUrl = typeof process !== 'undefined'
    ? (process.env?.OLLAMA_API_URL || process.env?.LLM_API_URL)
    : undefined;
  if (ollamaUrl) providerUrls.push(ollamaUrl);

  if (typeof process !== 'undefined' && process.env?.GROQ_API_KEY) {
    providerUrls.push('https://api.groq.com/openai/v1/chat/completions');
  }
  if (typeof process !== 'undefined' && process.env?.OPENROUTER_API_KEY) {
    providerUrls.push('https://openrouter.ai/api/v1/chat/completions');
  }

  for (const url of providerUrls) {
    void isProviderAvailable(url);
  }
}

/** Module-level caches are process-lived; tests need a clean slate per case. */
export const __testing__ = {
  MODEL_FAILURE_THRESHOLD,
  MODEL_QUARANTINE_MS,
  reset(): void {
    cache.clear();
    inFlight.clear();
    modelCache.clear();
  },
};
