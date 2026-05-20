import { ChurnLoop } from './client';
import { StandardEvent } from './types';

const ORIGINAL_FETCH = globalThis.fetch;

interface MockResponse {
  status: number;
  body?: unknown;
}

/**
 * Mock fetch with a sequence of responses (one per call). Once
 * the sequence is exhausted, every additional call gets the LAST
 * response — convenient for "permanent 503" style tests.
 */
function mockFetchSequence(...responses: Array<MockResponse | Error>): jest.Mock {
  let i = 0;
  const fn = jest.fn(async () => {
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (r instanceof Error) throw r;
    const body = r.body !== undefined ? JSON.stringify(r.body) : '';
    return new Response(body, { status: r.status });
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

function lastBatch(fn: jest.Mock): Array<Record<string, unknown>> {
  const call = fn.mock.calls[fn.mock.calls.length - 1] as [string, RequestInit];
  const body = JSON.parse(call[1].body as string) as {
    batch: Array<Record<string, unknown>>;
  };
  return body.batch;
}

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  jest.useRealTimers();
});

describe('ChurnLoop client (v0.2)', () => {
  describe('construction', () => {
    it('throws when no apiKey is provided', () => {
      expect(() => new ChurnLoop({})).toThrow(/apiKey is required/);
    });

    it('constructs successfully with an apiKey', () => {
      expect(() => new ChurnLoop({ apiKey: 'cl_test' })).not.toThrow();
    });
  });

  // ── basic batching ────────────────────────────────────────

  describe('track + flush', () => {
    it('buffers events and sends them in a single batch on flush()', async () => {
      const fetchMock = mockFetchSequence({ status: 202 });
      const client = new ChurnLoop({ apiKey: 'cl_test' });

      client.track({ event: 'A', userId: 'u_1' });
      client.track({ event: 'B', userId: 'u_1' });
      client.track({ event: 'C', userId: 'u_1' });
      await client.flush();

      // Exactly one HTTP call, with three events in the batch.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const batch = lastBatch(fetchMock);
      expect(batch).toHaveLength(3);
      expect(batch.map((e) => e.event)).toEqual(['A', 'B', 'C']);
    });

    it('hits the batch endpoint, not the single endpoint', async () => {
      const fetchMock = mockFetchSequence({ status: 202 });
      const client = new ChurnLoop({ apiKey: 'cl_test' });

      client.track({ event: 'X', userId: 'u_1' });
      await client.flush();

      const [url] = fetchMock.mock.calls[0] as [string];
      expect(url).toMatch(/\/v1\/compat\/segment\/batch$/);
    });

    it('flushes automatically when the queue hits flushAt', async () => {
      const fetchMock = mockFetchSequence({ status: 202 });
      const client = new ChurnLoop({ apiKey: 'cl_test', flushAt: 3 });

      client.track({ event: 'A', userId: 'u_1' });
      client.track({ event: 'B', userId: 'u_1' });
      // Third event triggers size-flush — no explicit flush()
      // needed.
      client.track({ event: 'C', userId: 'u_1' });
      // Wait for the pump's microtask to complete.
      await new Promise((r) => setImmediate(r));

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(lastBatch(fetchMock)).toHaveLength(3);
    });

    it('splits >flushAt events into multiple sequential batches', async () => {
      const fetchMock = mockFetchSequence({ status: 202 }, { status: 202 });
      const client = new ChurnLoop({ apiKey: 'cl_test', flushAt: 2 });

      client.track({ event: 'A', userId: 'u_1' });
      client.track({ event: 'B', userId: 'u_1' });
      client.track({ event: 'C', userId: 'u_1' });
      client.track({ event: 'D', userId: 'u_1' });
      await client.flush();

      // 4 events at flushAt=2 → 2 sequential batches.
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  // ── identify / page / screen ──────────────────────────────

  describe('identify / page / screen', () => {
    it('identify sends a Segment identify payload with traits', async () => {
      const fetchMock = mockFetchSequence({ status: 202 });
      const client = new ChurnLoop({ apiKey: 'cl_test' });

      client.identify({
        userId: 'u_1',
        traits: { plan: 'pro', email: 'a@b.co' },
      });
      await client.flush();

      const event = lastBatch(fetchMock)[0];
      expect(event.type).toBe('identify');
      expect(event.userId).toBe('u_1');
      expect(event.traits).toEqual({ plan: 'pro', email: 'a@b.co' });
    });

    it('page sends a Segment page payload with name in properties', async () => {
      const fetchMock = mockFetchSequence({ status: 202 });
      const client = new ChurnLoop({ apiKey: 'cl_test' });

      client.page({
        userId: 'u_1',
        name: 'Pricing',
        properties: { path: '/pricing' },
      });
      await client.flush();

      const event = lastBatch(fetchMock)[0];
      expect(event.type).toBe('page');
      const props = event.properties as Record<string, unknown>;
      expect(props.name).toBe('Pricing');
      expect(props.path).toBe('/pricing');
    });

    it('screen sends a Segment screen payload', async () => {
      const fetchMock = mockFetchSequence({ status: 202 });
      const client = new ChurnLoop({ apiKey: 'cl_test' });

      client.screen({ userId: 'u_1', name: 'Home' });
      await client.flush();

      const event = lastBatch(fetchMock)[0];
      expect(event.type).toBe('screen');
      expect((event.properties as Record<string, unknown>).name).toBe('Home');
    });

    it('every method attaches the SDK $context block', async () => {
      const fetchMock = mockFetchSequence({ status: 202 });
      const client = new ChurnLoop({ apiKey: 'cl_test' });

      client.track({ event: 'T', userId: 'u_1' });
      client.identify({ userId: 'u_1', traits: { a: 1 } });
      client.page({ userId: 'u_1', name: 'P' });
      client.screen({ userId: 'u_1', name: 'S' });
      await client.flush();

      for (const event of lastBatch(fetchMock)) {
        const props = event.properties as Record<string, unknown>;
        expect(props.$context).toBeDefined();
      }
    });
  });

  // ── retry behaviour ───────────────────────────────────────

  describe('retry', () => {
    it('retries on 503 and eventually succeeds', async () => {
      // 2 failures, then success. The pump should backoff +
      // retry transparently — caller's flush() resolves OK.
      const fetchMock = mockFetchSequence(
        { status: 503 },
        { status: 503 },
        { status: 202 },
      );
      const client = new ChurnLoop({ apiKey: 'cl_test', maxRetries: 5 });

      client.track({ event: 'X', userId: 'u_1' });
      await client.flush();

      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('retries on 429 (rate limited)', async () => {
      const fetchMock = mockFetchSequence(
        { status: 429 },
        { status: 202 },
      );
      const client = new ChurnLoop({ apiKey: 'cl_test' });

      client.track({ event: 'X', userId: 'u_1' });
      await client.flush();

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('retries on network failure', async () => {
      const fetchMock = mockFetchSequence(
        new TypeError('fetch failed'),
        { status: 202 },
      );
      const client = new ChurnLoop({ apiKey: 'cl_test' });

      client.track({ event: 'X', userId: 'u_1' });
      await client.flush();

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('does NOT retry on 4xx (caller bug)', async () => {
      // 401 — replay would 401 again. Drop after 1 call.
      const onError = jest.fn();
      const fetchMock = mockFetchSequence({ status: 401 });
      const client = new ChurnLoop({ apiKey: 'cl_test', onError });

      client.track({ event: 'X', userId: 'u_1' });
      await client.flush();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledTimes(1);
    });

    it('drops the batch after maxRetries exhausted', async () => {
      // Permanent 503. maxRetries=2 → 2 attempts then drop.
      const onError = jest.fn();
      const fetchMock = mockFetchSequence({ status: 503 });
      const client = new ChurnLoop({
        apiKey: 'cl_test',
        maxRetries: 2,
        onError,
      });

      client.track({ event: 'X', userId: 'u_1' });
      client.track({ event: 'Y', userId: 'u_1' });
      await client.flush();

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const [, ctx] = onError.mock.calls[0] as [Error, { droppedEvents: number }];
      expect(ctx.droppedEvents).toBe(2);
    });

    it('reuses messageId across retries (server-side dedup contract)', async () => {
      // The same batch sent twice must carry identical messageIds.
      // The server dedups by messageId so a retry of a request
      // that actually succeeded server-side doesn't double-count.
      const fetchMock = mockFetchSequence(
        { status: 503 },
        { status: 202 },
      );
      const client = new ChurnLoop({ apiKey: 'cl_test' });

      client.track({ event: 'X', userId: 'u_1' });
      await client.flush();

      const firstBatch = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
      const secondBatch = JSON.parse((fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string);
      expect(firstBatch.batch[0].messageId).toBe(secondBatch.batch[0].messageId);
    });
  });

  // ── queue overflow ────────────────────────────────────────

  describe('queue overflow', () => {
    it('drops the oldest event when maxQueueSize is exceeded', async () => {
      // Stall fetch indefinitely so the pump never drains.
      let resolveFetch: (r: Response) => void = () => undefined;
      globalThis.fetch = jest.fn(
        () => new Promise<Response>((r) => { resolveFetch = r; }),
      ) as unknown as typeof fetch;

      const onError = jest.fn();
      const client = new ChurnLoop({
        apiKey: 'cl_test',
        flushAt: 1000, // don't auto-flush by size during the test
        maxQueueSize: 3,
        onError,
      });

      client.track({ event: 'A', userId: 'u_1' });
      client.track({ event: 'B', userId: 'u_1' });
      client.track({ event: 'C', userId: 'u_1' });
      client.track({ event: 'D', userId: 'u_1' }); // pushes A out

      expect(onError).toHaveBeenCalledTimes(1);
      const [err, ctx] = onError.mock.calls[0] as [Error, { droppedEvents: number }];
      expect(err.message).toMatch(/queue overflow/);
      expect(ctx.droppedEvents).toBe(1);

      // flush() synchronously calls fetch (via pumpLoop → sendBatch → fetch),
      // which sets resolveFetch to the real resolver. Only THEN resolve it.
      const flushPromise = client.flush();
      resolveFetch(new Response('', { status: 202 }));
      await flushPromise;
    });
  });

  // ── disabled / close ──────────────────────────────────────

  describe('disabled mode + close()', () => {
    it('does nothing when disabled', async () => {
      const fetchMock = mockFetchSequence({ status: 202 });
      const client = new ChurnLoop({ apiKey: 'cl_test', disabled: true });

      client.track({ event: 'X', userId: 'u_1' });
      await client.flush();

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('close() drains the queue then refuses new events', async () => {
      const fetchMock = mockFetchSequence({ status: 202 });
      const client = new ChurnLoop({ apiKey: 'cl_test' });

      client.track({ event: 'A', userId: 'u_1' });
      client.track({ event: 'B', userId: 'u_1' });
      await client.close();

      // A + B flushed.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(lastBatch(fetchMock)).toHaveLength(2);

      // New events post-close are dropped silently — no HTTP call.
      client.track({ event: 'C', userId: 'u_1' });
      await new Promise((r) => setImmediate(r));
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('close() is idempotent', async () => {
      mockFetchSequence({ status: 202 });
      const client = new ChurnLoop({ apiKey: 'cl_test' });
      await client.close();
      await expect(client.close()).resolves.toBeUndefined();
    });
  });

  // ── validation errors ─────────────────────────────────────

  describe('input validation', () => {
    it('track() with empty event calls onError with droppedEvents:1', () => {
      const onError = jest.fn();
      const client = new ChurnLoop({ apiKey: 'cl_test', onError });
      // @ts-expect-error testing runtime validation
      client.track({ userId: 'u_1' });
      expect(onError).toHaveBeenCalledTimes(1);
    });

    it('track() with empty userId calls onError', () => {
      const onError = jest.fn();
      const client = new ChurnLoop({ apiKey: 'cl_test', onError });
      // @ts-expect-error testing runtime validation
      client.track({ event: 'X' });
      expect(onError).toHaveBeenCalledTimes(1);
    });

    it('identify() with empty userId calls onError', () => {
      const onError = jest.fn();
      const client = new ChurnLoop({ apiKey: 'cl_test', onError });
      // @ts-expect-error testing runtime validation
      client.identify({});
      expect(onError).toHaveBeenCalledTimes(1);
    });
  });

  // ── back-compat alias ─────────────────────────────────────

  describe('v0.1 compatibility', () => {
    it('flushPending() is an alias for flush()', async () => {
      const fetchMock = mockFetchSequence({ status: 202 });
      const client = new ChurnLoop({ apiKey: 'cl_test' });

      client.track({ event: 'X', userId: 'u_1' });
      await client.flushPending();

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('still exports StandardEvent values unchanged', async () => {
      const fetchMock = mockFetchSequence({ status: 202 });
      const client = new ChurnLoop({ apiKey: 'cl_test' });

      client.track({ event: StandardEvent.UserSignedUp, userId: 'u_1' });
      await client.flush();

      expect(lastBatch(fetchMock)[0].event).toBe('User Signed Up');
    });
  });
});
