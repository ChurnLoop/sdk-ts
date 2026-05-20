import { buildContext } from './context';
import { resolveConfig, type ResolvedConfig } from './env';
import {
  backoffMs,
  sendBatch,
  TransportError,
  type SegmentPayload,
} from './transport';
import type {
  ErrorHandler,
  IdentifyInput,
  ChurnLoopOptions,
  PageInput,
  ScreenInput,
  TrackInput,
} from './types';

/**
 * Stage 22c — JS SDK v0.2.
 *
 * Architecture: queue + single-pump model.
 *
 *   - `track`/`identify`/`page`/`screen` synchronously buffer a
 *     fully-formed SegmentPayload via `enqueue()`, then decide
 *     whether to trigger a flush.
 *   - Flush triggers: queue reaches `flushAt` (size trigger),
 *     `flushInterval` elapses since first buffered event (time
 *     trigger), or `flush()` / `close()` is called explicitly.
 *   - At most one batch is in flight per Jarvis instance. New
 *     events keep buffering; the pump picks them up on the next
 *     loop iteration.
 *   - Retryable failures replay the same batch (same messageIds,
 *     so server-side dedup holds) with exponential backoff + full
 *     jitter up to `maxRetries`. On exhaustion the events drop
 *     to `onError`.
 *   - Non-retryable failures (4xx) drop the batch immediately —
 *     replaying would 4xx again.
 *
 * Public API mirrors Segment's analytics-js/node: callers don't
 * await `track()` etc.; errors flow through `onError`, not as
 * exceptions out of these methods.
 */
export class ChurnLoop {
  private readonly config: ResolvedConfig;
  private readonly onError: ErrorHandler;
  private readonly queue: SegmentPayload[] = [];

  // Pump state. `pumping` is a single-flight latch — only one
  // sendBatch can be in-flight per ChurnLoop instance, so retries
  // don't overlap and a slow ingest doesn't multiply requests.
  private pumping: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  // Once `close()` runs, all calls become no-ops. Prevents
  // late-binding code from resurrecting a torn-down client.
  private closed = false;

  constructor(options: ChurnLoopOptions = {}) {
    this.config = resolveConfig(options);
    this.onError = options.onError ?? defaultErrorHandler;
  }

  // ── Public API ────────────────────────────────────────────

  track(input: TrackInput): void {
    if (this.config.disabled || this.closed) return;
    if (!input.event || !input.userId) {
      this.onError(
        new Error('[ChurnLoop] track() requires `event` and `userId`'),
        { droppedEvents: 1 },
      );
      return;
    }
    this.enqueue({
      type: 'track',
      event: input.event,
      userId: input.userId,
      messageId: input.messageId ?? generateUuid(),
      ...(input.timestamp ? { timestamp: input.timestamp } : {}),
      properties: {
        ...(input.properties ?? {}),
        ...(input.value !== undefined ? { $value: input.value } : {}),
        $context: buildContext(),
      },
    });
  }

  identify(input: IdentifyInput): void {
    if (this.config.disabled || this.closed) return;
    if (!input.userId) {
      this.onError(
        new Error('[ChurnLoop] identify() requires `userId`'),
        { droppedEvents: 1 },
      );
      return;
    }
    this.enqueue({
      type: 'identify',
      userId: input.userId,
      messageId: input.messageId ?? generateUuid(),
      ...(input.timestamp ? { timestamp: input.timestamp } : {}),
      traits: input.traits ?? {},
      // $context lives under `properties` to match the server's
      // SegmentMapperService — even for identify we want
      // library/version metadata visible on the event row.
      properties: { $context: buildContext() },
    });
  }

  page(input: PageInput): void {
    if (this.config.disabled || this.closed) return;
    if (!input.userId) {
      this.onError(
        new Error('[ChurnLoop] page() requires `userId`'),
        { droppedEvents: 1 },
      );
      return;
    }
    this.enqueue({
      type: 'page',
      userId: input.userId,
      messageId: input.messageId ?? generateUuid(),
      ...(input.timestamp ? { timestamp: input.timestamp } : {}),
      properties: {
        ...(input.properties ?? {}),
        // Segment convention: `name` lives in properties for
        // page/screen so downstream analytics treat it like any
        // other property.
        ...(input.name ? { name: input.name } : {}),
        $context: buildContext(),
      },
    });
  }

  screen(input: ScreenInput): void {
    if (this.config.disabled || this.closed) return;
    if (!input.userId) {
      this.onError(
        new Error('[ChurnLoop] screen() requires `userId`'),
        { droppedEvents: 1 },
      );
      return;
    }
    this.enqueue({
      type: 'screen',
      userId: input.userId,
      messageId: input.messageId ?? generateUuid(),
      ...(input.timestamp ? { timestamp: input.timestamp } : {}),
      properties: {
        ...(input.properties ?? {}),
        ...(input.name ? { name: input.name } : {}),
        $context: buildContext(),
      },
    });
  }

  /**
   * Force-flush the queue. Returns a promise that resolves once
   * every event buffered AT CALL TIME has either succeeded or
   * been dropped (4xx or exhausted retries).
   *
   * Events enqueued AFTER `flush()` returns are not awaited — use
   * a fresh flush() for those.
   */
  async flush(): Promise<void> {
    if (this.config.disabled || this.closed) return;
    this.cancelTimer();
    await this.pump();
  }

  /**
   * Drain everything in the queue and stop accepting new events.
   * Suitable for `beforeExit` / `pagehide` hooks. Idempotent —
   * calling close() twice is a no-op after the first.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.cancelTimer();
    await this.pump();
  }

  /**
   * Back-compat alias for the v0.1 method name. The v0.2 contract
   * is `flush()`; this redirect lets v0.1 customers upgrade
   * without code changes. Will be removed in v1.0.
   *
   * @deprecated Use `flush()` instead.
   */
  async flushPending(): Promise<void> {
    await this.flush();
  }

  // ── Internals ─────────────────────────────────────────────

  private enqueue(payload: SegmentPayload): void {
    // Queue overflow protection. Under normal operation the pump
    // drains faster than the producer; this kicks in when the
    // ingest is unreachable + producer keeps firing. Drop OLDEST
    // first — the most recent events (most informative for a
    // stuck customer) survive.
    if (this.queue.length >= this.config.maxQueueSize) {
      const dropped = this.queue.shift();
      if (dropped) {
        this.onError(
          new Error(
            `[ChurnLoop] queue overflow (>${this.config.maxQueueSize}); dropping oldest event`,
          ),
          { droppedEvents: 1 },
        );
      }
    }
    this.queue.push(payload);

    // Size trigger: flush as soon as we hit `flushAt`. Run the
    // pump on a microtask so the caller's stack returns first —
    // matches Segment's contract where track() is sync-return.
    if (this.queue.length >= this.config.flushAt) {
      this.cancelTimer();
      void this.pump();
      return;
    }

    // Time trigger: arm the flush timer. Only set once per batch
    // — restarting on every enqueue would push the flush forever
    // under sustained load.
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.pump();
      }, this.config.flushInterval);
      // In Node, allow the process to exit even if the timer is
      // pending — otherwise a CLI script using the SDK never
      // exits. `unref()` is Node-only; guarded for browsers.
      const timer = this.timer as unknown as { unref?: () => void };
      if (typeof timer.unref === 'function') timer.unref();
    }
  }

  /**
   * Drain the current queue into batches and send them. Single-
   * flight: if a pump is already running, return the same promise
   * (new events get picked up in the existing pump's continuation
   * loop).
   */
  private pump(): Promise<void> {
    if (this.pumping) return this.pumping;
    this.pumping = this.pumpLoop().finally(() => {
      this.pumping = null;
    });
    return this.pumping;
  }

  private async pumpLoop(): Promise<void> {
    // Keep draining while events are queued. New events arriving
    // during a send (via track() etc.) get picked up on the next
    // loop iteration — bounded by the same single-pump latch, so
    // we never have two batches in flight at once.
    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, this.config.flushAt);
      await this.sendWithRetry(batch);
    }
  }

  private async sendWithRetry(batch: SegmentPayload[]): Promise<void> {
    let attempt = 0;
    while (true) {
      try {
        await sendBatch(batch, this.config);
        return;
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        const tErr = err instanceof TransportError ? err : undefined;
        const retryable = tErr?.retryable ?? false;
        attempt += 1;

        if (!retryable) {
          // 4xx / caller bug — replay would 4xx again. Drop now.
          this.onError(e, { droppedEvents: batch.length });
          return;
        }

        if (attempt >= this.config.maxRetries) {
          // Exhausted. Drop the batch loud so ops sees it.
          this.onError(
            new Error(
              `[ChurnLoop] dropping ${batch.length} events after ${attempt} retries: ${e.message}`,
            ),
            { droppedEvents: batch.length },
          );
          return;
        }

        // Sleep with full jitter before next attempt. The pump is
        // single-flight so we can sleep here without holding back
        // OTHER batches — they're queued behind this one in the
        // pumpLoop.
        await sleep(backoffMs(attempt));
      }
    }
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    const timer = t as unknown as { unref?: () => void };
    if (typeof timer.unref === 'function') timer.unref();
  });
}

function defaultErrorHandler(err: Error, ctx: { droppedEvents: number }): void {
  // eslint-disable-next-line no-console
  console.warn(`[ChurnLoop] ${err.message} (dropped: ${ctx.droppedEvents})`);
}

/**
 * UUID v4 generator. Prefers the platform's `crypto.randomUUID`
 * (Node 19+ and every modern browser). Falls back to Math.random
 * — collision probability is far below dedup's noise floor.
 *
 * The messageId is generated ONCE per event at enqueue time and
 * REUSED across retries — that's the dedup contract with the
 * server's BullMQ jobId.
 */
function generateUuid(): string {
  const c = typeof crypto !== 'undefined' ? crypto : undefined;
  if (c?.randomUUID) return c.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export { TransportError };
