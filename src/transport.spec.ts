import {
  backoffMs,
  sendBatch,
  sendSingle,
  TransportError,
  type SegmentPayload,
} from './transport';
import type { ResolvedConfig } from './env';

const ORIGINAL_FETCH = globalThis.fetch;

function mockFetch(response: { status: number; body?: unknown } | Error): jest.Mock {
  const fn = jest.fn(async () => {
    if (response instanceof Error) throw response;
    const init: ResponseInit = { status: response.status };
    const body = response.body !== undefined ? JSON.stringify(response.body) : '';
    return new Response(body, init);
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

const baseConfig: ResolvedConfig = {
  apiKey: 'jv_test_key',
  host: 'https://ingest.test.example.com',
  timeoutMs: 5_000,
  disabled: false,
  flushAt: 100,
  flushInterval: 1000,
  maxQueueSize: 1000,
  maxRetries: 5,
};

const samplePayload: SegmentPayload = {
  type: 'track',
  event: 'Test Event',
  userId: 'u_1',
  messageId: 'msg_1',
};

describe('sendBatch (v0.2)', () => {
  it('POSTs to /v1/compat/segment/batch on the configured host', async () => {
    const fetchMock = mockFetch({ status: 202 });

    await sendBatch([samplePayload], baseConfig);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://ingest.test.example.com/v1/compat/segment/batch');
    expect(init.method).toBe('POST');
  });

  it('strips a trailing slash from the host so the URL stays canonical', async () => {
    const fetchMock = mockFetch({ status: 202 });

    await sendBatch([samplePayload], { ...baseConfig, host: 'https://ingest.test.example.com/' });

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('https://ingest.test.example.com/v1/compat/segment/batch');
  });

  it('sends a Bearer Authorization header with the apiKey', async () => {
    const fetchMock = mockFetch({ status: 202 });

    await sendBatch([samplePayload], baseConfig);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer jv_test_key');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('wraps the events in a `{ batch: [...] }` envelope', async () => {
    // Server's SegmentBatchDto expects { batch: SegmentEventDto[] }.
    // A bare array would 400 with a class-validator message.
    const fetchMock = mockFetch({ status: 202 });

    await sendBatch([samplePayload, samplePayload], baseConfig);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body).toHaveProperty('batch');
    expect(Array.isArray(body.batch)).toBe(true);
    expect(body.batch).toHaveLength(2);
  });

  it('resolves silently on an empty batch (defensive)', async () => {
    const fetchMock = mockFetch({ status: 202 });
    await sendBatch([], baseConfig);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resolves silently on 2xx', async () => {
    mockFetch({ status: 202, body: { received: 1, dropped_erased: 0 } });
    await expect(sendBatch([samplePayload], baseConfig)).resolves.toBeUndefined();
  });

  it('throws non-retryable TransportError on 4xx', async () => {
    mockFetch({ status: 401, body: { message: 'Invalid API key' } });

    await expect(sendBatch([samplePayload], baseConfig)).rejects.toMatchObject({
      name: 'TransportError',
      status: 401,
      retryable: false,
    });
  });

  it('throws retryable TransportError on 429', async () => {
    mockFetch({ status: 429, body: { message: 'Too Many Requests' } });

    await expect(sendBatch([samplePayload], baseConfig)).rejects.toMatchObject({
      status: 429,
      retryable: true,
    });
  });

  it('throws retryable TransportError on 5xx', async () => {
    mockFetch({ status: 503, body: { message: 'Service Unavailable' } });

    await expect(sendBatch([samplePayload], baseConfig)).rejects.toMatchObject({
      status: 503,
      retryable: true,
    });
  });

  it('treats network errors as retryable (no status)', async () => {
    mockFetch(new TypeError('fetch failed'));

    await expect(sendBatch([samplePayload], baseConfig)).rejects.toMatchObject({
      name: 'TransportError',
      retryable: true,
      status: undefined,
    });
  });

  it('flattens a class-validator array `message` into a readable string', async () => {
    mockFetch({
      status: 400,
      body: { message: ['event_name must be a string', 'user_id should not be empty'] },
    });

    try {
      await sendBatch([samplePayload], baseConfig);
      fail('expected throw');
    } catch (err) {
      expect((err as TransportError).message).toContain('event_name must be a string');
      expect((err as TransportError).message).toContain('user_id should not be empty');
    }
  });
});

describe('sendSingle (legacy v0.1)', () => {
  // Kept exported for back-compat. The v0.2 client never calls it
  // directly — v0.2 always batches via sendBatch. This test only
  // covers the URL path so we don't accidentally drift the legacy
  // export.
  it('still posts to /v1/compat/segment (no /batch suffix)', async () => {
    const fetchMock = mockFetch({ status: 202 });

    await sendSingle(samplePayload, baseConfig);

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('https://ingest.test.example.com/v1/compat/segment');
  });
});

describe('backoffMs', () => {
  // Deterministic random for assertion.
  const constRandom = (v: number) => () => v;

  it('returns 0 when the random draw is 0 (lower bound)', () => {
    expect(backoffMs(1, constRandom(0))).toBe(0);
  });

  it('scales exponentially: attempt 1 cap is BASE, attempt 2 cap is 2×BASE', () => {
    // base = 250 ms; attempt 1 max = 250; attempt 2 max = 500.
    // With full-jitter draw=1.0, we land on the cap minus 1ms
    // (floor of (random * exp)).
    const a1 = backoffMs(1, constRandom(0.9999));
    const a2 = backoffMs(2, constRandom(0.9999));
    expect(a1).toBeGreaterThan(240);
    expect(a1).toBeLessThanOrEqual(250);
    expect(a2).toBeGreaterThan(490);
    expect(a2).toBeLessThanOrEqual(500);
  });

  it('caps at BACKOFF_MAX_MS for very large attempt counts', () => {
    // 2^20 * 250 vastly exceeds 30s; backoff should saturate at 30s.
    const big = backoffMs(20, constRandom(0.9999));
    expect(big).toBeLessThanOrEqual(30_000);
    expect(big).toBeGreaterThan(29_000);
  });

  it('returns an integer (caller uses setTimeout)', () => {
    const v = backoffMs(3);
    expect(Number.isInteger(v)).toBe(true);
  });
});
