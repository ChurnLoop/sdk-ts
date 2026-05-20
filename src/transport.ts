import type { ResolvedConfig } from './env';

// v0.2 transport: batch-send + exponential-backoff retry.
//
// Single-event sends are gone from the client's hot path — events
// are buffered into batches and POSTed via `sendBatch`.
// /v1/compat/segment/batch accepts up to 100 events per request
// (server's class-validator ArrayMaxSize), which `resolveConfig`'s
// flushAt enforces locally.

/**
 * Segment-wire payload posted to the ingest. Shape mirrors the
 * server's `SegmentEventDto` exactly — do NOT add fields that
 * aren't part of the public ingest contract.
 */
export interface SegmentPayload {
  type: 'track' | 'identify' | 'page' | 'screen';
  event?: string;
  userId?: string;
  anonymousId?: string;
  timestamp?: string;
  messageId?: string;
  properties?: Record<string, unknown>;
  traits?: Record<string, unknown>;
}

/**
 * Status codes the SDK distinguishes:
 *   - 2xx (typically 202) — success
 *   - 400/401/403/404 — caller bug or auth/quota. Not retryable;
 *     drop with onError.
 *   - 429 / 5xx / network errors — transient. Retry with backoff;
 *     drop only after maxRetries exhausted.
 */
export class TransportError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = 'TransportError';
  }
}

/**
 * Send a batch of events to `/v1/compat/segment/batch`. The Pump
 * handles retry; this function makes one HTTP call and either
 * resolves or throws a `TransportError` annotated with `retryable`.
 */
export async function sendBatch(
  batch: SegmentPayload[],
  config: ResolvedConfig,
): Promise<void> {
  // Empty batch should never reach here, but if it does the server
  // would 400 (requires non-empty `batch`). Defensive bail.
  if (batch.length === 0) return;

  const url = `${stripTrailingSlash(config.host)}/v1/compat/segment/batch`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      // Server expects `{ batch: [...] }` envelope (matches
      // SegmentBatchDto in libs/dto).
      body: JSON.stringify({ batch }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    throw new TransportError(`ChurnLoop ingest unreachable: ${msg}`, undefined, true);
  }
  clearTimeout(timer);

  if (response.ok) return;

  // 429 + 5xx are transient; 4xx is permanent.
  const retryable = response.status === 429 || response.status >= 500;
  let detail = response.statusText;
  try {
    const body = (await response.json()) as { message?: string | string[] };
    if (typeof body.message === 'string') detail = body.message;
    else if (Array.isArray(body.message)) detail = body.message.join('; ');
  } catch {
    // body unreadable / not JSON — keep statusText
  }
  throw new TransportError(
    `ChurnLoop ingest rejected batch (${response.status}): ${detail}`,
    response.status,
    retryable,
  );
}

/**
 * Legacy single-event send. Kept exported so v0.1 transport tests
 * still pass — they validate URL construction + error handling
 * that is reused by `sendBatch`. The v0.2 client does NOT call this
 * directly. Will be removed in v1.0.
 */
export async function sendSingle(
  payload: SegmentPayload,
  config: ResolvedConfig,
): Promise<void> {
  const url = `${stripTrailingSlash(config.host)}/v1/compat/segment`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    throw new TransportError(`ChurnLoop ingest unreachable: ${msg}`, undefined, true);
  }
  clearTimeout(timer);
  if (response.ok) return;
  const retryable = response.status === 429 || response.status >= 500;
  let detail = response.statusText;
  try {
    const body = (await response.json()) as { message?: string | string[] };
    if (typeof body.message === 'string') detail = body.message;
    else if (Array.isArray(body.message)) detail = body.message.join('; ');
  } catch {
    // body unreadable / not JSON
  }
  throw new TransportError(
    `ChurnLoop ingest rejected event (${response.status}): ${detail}`,
    response.status,
    retryable,
  );
}

function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

/**
 * Compute the next backoff delay (ms) for retry attempt `attempt`
 * (1-indexed). Exponential growth with FULL JITTER — uniform
 * random between [0, base * 2^(attempt-1)] capped at MAX_BACKOFF.
 *
 * Full jitter is critical under load: without it, every SDK
 * retrying a 503 spike hits the server at the same instants.
 * Jitter spreads the retries randomly across the interval.
 *
 * `random` injectable for deterministic tests.
 */
const BACKOFF_BASE_MS = 250;
const BACKOFF_MAX_MS = 30_000;

export function backoffMs(
  attempt: number,
  random: () => number = Math.random,
): number {
  const exp = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
  return Math.floor(random() * exp);
}
