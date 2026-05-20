import { getGlobals } from './globals';
import type { ChurnLoopOptions } from './types';

// Default ingest host. Configured at SDK build time as a real
// hostname before publishing; the placeholder here is what the
// customer sees in error messages if they forget to set `host` and
// the env var isn't present either.
const DEFAULT_HOST = 'https://ingest.churnloop.com';

const DEFAULT_TIMEOUT_MS = 30_000;

// v0.2 batching + retry defaults.
//
// flushAt = 100 matches the server's Segment-batch endpoint cap
// (libs/dto/segment-event.dto.ts ArrayMaxSize(100)). Sending more
// in one request would 400.
//
// flushInterval = 1000 ms balances request frequency vs. data
// freshness — at a typical SaaS volume (1–10 events/sec) this
// flushes every batch within a second, with single-event tails
// hitting on the timer rather than waiting for size.
//
// maxQueueSize = 1000 caps memory under unreachable-ingest
// conditions. At 1KB/event that's ≈1MB worst case; loud overflow
// via onError tells the operator something's wrong long before.
//
// maxRetries = 5 with the backoff schedule below = ~30s total
// wall-clock max retry time per batch. Past that, the events are
// dropped to onError — the alternative (retry forever) starves
// other batches and grows the queue unboundedly.
const DEFAULT_FLUSH_AT = 100;
const DEFAULT_FLUSH_INTERVAL_MS = 1000;
const DEFAULT_MAX_QUEUE_SIZE = 1000;
const DEFAULT_MAX_RETRIES = 5;

/**
 * Detect the runtime once. The SDK is isomorphic (Node + browser);
 * a few small behaviours branch on which environment we're in.
 *
 * `typeof window !== 'undefined'` is the standard check. Edge
 * runtimes (Cloudflare Workers, Vercel Edge, Deno) don't have
 * `window` either, so they fall into the "node-like" branch — that's
 * the right default since they have `fetch` and no DOM.
 */
export function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof window.document !== 'undefined';
}

/**
 * Resolve options + environment-variable fallbacks into a fully
 * populated config object. Throws on construction-time errors
 * (missing API key) so the failure is loud rather than silent at
 * the first `track()` call.
 *
 * Env vars consumed on Node only (browser doesn't have `process`):
 *   CHURNLOOP_API_KEY  → options.apiKey  (legacy: JARVIS_API_KEY)
 *   CHURNLOOP_HOST     → options.host    (legacy: JARVIS_HOST)
 *   CHURNLOOP_DISABLED → options.disabled (legacy: JARVIS_DISABLED)
 *
 * Stage 23 rebrand: legacy `JARVIS_*` env vars are still honored as
 * a fallback so existing customer deployments don't break across
 * SDK upgrade. Using a legacy var emits a one-time deprecation
 * warning to the console; bump to `CHURNLOOP_*` to silence.
 *
 * The legacy fallback is removed in v1.0.
 */
export interface ResolvedConfig {
  apiKey: string;
  host: string;
  timeoutMs: number;
  disabled: boolean;
  flushAt: number;
  flushInterval: number;
  maxQueueSize: number;
  maxRetries: number;
}

// Track-once dedup for the deprecation warning. Module-scoped so a
// long-running process with N ChurnLoop instances doesn't spam.
const warnedLegacyEnv = new Set<string>();

function readEnvWithLegacy(
  env: Record<string, string | undefined>,
  preferred: string,
  legacy: string,
): string | undefined {
  if (env[preferred] !== undefined) return env[preferred];
  const legacyValue = env[legacy];
  if (legacyValue !== undefined && !warnedLegacyEnv.has(legacy)) {
    warnedLegacyEnv.add(legacy);
    // eslint-disable-next-line no-console
    console.warn(
      `[ChurnLoop] Using legacy env var ${legacy}. Please migrate to ${preferred}; ` +
        `the legacy alias will be removed in v1.0.`,
    );
  }
  return legacyValue;
}

export function resolveConfig(options: ChurnLoopOptions): ResolvedConfig {
  // Node-only env access. `process` is missing in browsers; the
  // getGlobals() indirection types it as optional so this works
  // isomorphically with no DOM/Node @types pulled in.
  const env = getGlobals().process?.env ?? ({} as Record<string, string | undefined>);

  const apiKey =
    options.apiKey ?? readEnvWithLegacy(env, 'CHURNLOOP_API_KEY', 'JARVIS_API_KEY');
  if (!apiKey) {
    throw new Error(
      '[ChurnLoop] apiKey is required. Pass it to the ChurnLoop constructor or set CHURNLOOP_API_KEY in the environment.',
    );
  }

  const host =
    options.host ??
    readEnvWithLegacy(env, 'CHURNLOOP_HOST', 'JARVIS_HOST') ??
    DEFAULT_HOST;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // `disabled` defaults to false; env value is 'true'/'false' string.
  const disabledEnv = readEnvWithLegacy(env, 'CHURNLOOP_DISABLED', 'JARVIS_DISABLED');
  const envDisabled = disabledEnv === 'true';
  const disabled = options.disabled ?? envDisabled;

  return {
    apiKey,
    host,
    timeoutMs,
    disabled,
    flushAt: options.flushAt ?? DEFAULT_FLUSH_AT,
    flushInterval: options.flushInterval ?? DEFAULT_FLUSH_INTERVAL_MS,
    maxQueueSize: options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE,
    maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
  };
}
