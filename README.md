# @churnloop/sdk

[![npm version](https://img.shields.io/npm/v/@churnloop/sdk)](https://www.npmjs.com/package/@churnloop/sdk)
[![license](https://img.shields.io/npm/l/@churnloop/sdk)](LICENSE)
[![node](https://img.shields.io/node/v/@churnloop/sdk)](https://nodejs.org)

Official JavaScript / TypeScript SDK for the [ChurnLoop](https://churnloop.com) analytics + intervention platform.

- Isomorphic (Node 18+, every modern browser)
- Zero runtime dependencies
- ~7 KB unminified, much smaller after gzip
- TypeScript types built in
- Inbound-webhook signature verification helper included

> **Status:** v0.2.0. `track()`, `identify()`, `page()`, `screen()`, batching (size + time + shutdown triggers), exponential-backoff retry, and webhook verification all work end-to-end.

---

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Canonical event names](#canonical-event-names)
- [Webhook signature verification](#webhook-signature-verification)
- [Recipes](#recipes)
  - [Hashing user IDs](#recipe-hashing-user-ids)
  - [Migrating from Segment](#recipe-migrating-from-segment)
  - [Verifying webhooks in Express](#recipe-verifying-webhooks-in-express)
  - [Verifying webhooks in Next.js](#recipe-verifying-webhooks-in-nextjs)
  - [Verifying webhooks in a Cloudflare Worker](#recipe-verifying-webhooks-in-a-cloudflare-worker)
- [Privacy & consent](#privacy--consent)
- [Error handling](#error-handling)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

---

## Install

```bash
pnpm add @churnloop/sdk
# or
npm install @churnloop/sdk
# or
yarn add @churnloop/sdk
```

Requires Node 18+ (for native `fetch`). Works in every modern browser.

---

## Quick start

```ts
import { ChurnLoop, StandardEvent } from '@churnloop/sdk';

const churnloop = new ChurnLoop({ apiKey: process.env.CHURNLOOP_API_KEY });

// Track an event using a canonical name
churnloop.track({
  event: StandardEvent.UserSignedUp,
  userId: 'user_123',
  properties: { plan: 'free', source: 'organic' },
});

// ... or any custom string
churnloop.track({
  event: 'Cart Abandoned',
  userId: 'user_123',
  properties: { items: 3, value_usd: 89.5 },
});

// In a script / shutdown hook, await the in-flight send:
await churnloop.flush();
```

The event flows to the ChurnLoop ingest, gets dedupe-keyed by `messageId` (the SDK auto-generates one if you don't pass it), and lands in your analytics + intervention pipeline.

---

## Configuration

```ts
new ChurnLoop({
  apiKey: string,           // required — falls back to CHURNLOOP_API_KEY env var
  host?: string,            // default: configured ingest host; falls back to CHURNLOOP_HOST
  timeoutMs?: number,       // default: 30000
  disabled?: boolean,       // default: false; falls back to CHURNLOOP_DISABLED === 'true'
  flushAt?: number,         // default: 100 (flush when queue reaches this many events)
  flushInterval?: number,   // default: 1000 ms (flush if events sit longer than this)
  maxQueueSize?: number,    // default: 1000 (drop oldest when exceeded)
  maxRetries?: number,      // default: 5 (retry retryable failures with backoff)
  onError?: (err, ctx) => void,  // called on dropped events
});
```

### Environment variables (Node only)

| Variable | Effect |
|---|---|
| `CHURNLOOP_API_KEY` | Used when `apiKey` is omitted |
| `CHURNLOOP_HOST` | Override ingest host |
| `CHURNLOOP_DISABLED=true` | Disable all network calls (useful in tests) |

### `disabled` mode

`new ChurnLoop({ apiKey: '...', disabled: true })` returns a client where every method is a no-op. Useful for:

- Unit tests in customer code (no fake network calls)
- Local dev (events don't end up in production telemetry)
- Consent flows where the user opted out (see [Privacy & consent](#privacy--consent))

---

## Canonical event names

The SDK exports a `StandardEvent` const with canonical names for common SaaS lifecycle events:

```ts
import { StandardEvent } from '@churnloop/sdk';

StandardEvent.UserSignedUp;        // 'User Signed Up'
StandardEvent.UserSignedIn;        // 'User Signed In'
StandardEvent.OnboardingCompleted; // 'Onboarding Completed'
StandardEvent.SubscriptionStarted; // 'Subscription Started'
StandardEvent.Invited;             // 'Invited'
StandardEvent.InviteAccepted;      // 'Invite Accepted'
// ... see src/types.ts for the full list
```

**Why use them?** Customers using standard names benefit from cross-tenant features ChurnLoop ships out of the box:

- **Built-in dashboards** — your activation funnel (`UserSignedUp` → `OnboardingCompleted`) works without configuration
- **Playbook templates** — drop-in interventions that recognise standard events ("trigger this email if a user reaches `Invited` but no `InviteAccepted` within 3 days")
- **Cross-tenant benchmarks** — privacy-respecting aggregates ("your activation rate vs. the p50 across all ChurnLoop customers")
- **Shared models** (roadmap) — retention / churn / activation models trained on cross-tenant standard-event data

You can mix freely:

```ts
// Canonical
churnloop.track({ event: StandardEvent.UserSignedUp, userId, properties: { plan: 'free' } });

// Custom — works exactly the same, but doesn't get cross-tenant features
churnloop.track({ event: 'Custom Internal Action', userId, properties: { ... } });
```

**Naming convention:** Title Case, past-tense for completed actions. Matches the [Segment Spec](https://segment.com/docs/connections/spec/) so customers migrating from Segment can reuse their existing event taxonomy.

### Versioning the vocabulary

`StandardEvent` is part of the SDK's SemVer contract:

- **Adding entries** → minor version bump
- **Never renaming or removing entries** — would silently break customers' dashboards. If a name needs to evolve, we add the new name and keep the old.

---

## Webhook signature verification

ChurnLoop signs outbound webhooks (digest delivered, intervention executed, campaign goal reached, etc.) so you can verify they came from us:

```ts
import { verifyWebhook } from '@churnloop/sdk';

const result = await verifyWebhook({
  rawBody,                          // byte-exact request body (string)
  signatureHeader: req.headers['x-churnloop-signature'],
  secret: process.env.CHURNLOOP_WEBHOOK_SECRET,
});

if (!result.valid) {
  // result.reason is one of:
  //   'malformed_signature' | 'timestamp_out_of_range'
  //   | 'signature_mismatch' | 'crypto_unavailable'
  return res.status(403).send('invalid signature');
}

// Safe to parse + handle.
const event = JSON.parse(rawBody);
```

### Contract

| Field | Value |
|---|---|
| Signing header | `X-ChurnLoop-Signature: t=<unix>,v1=<hex>` |
| Algorithm | HMAC-SHA256 over `${timestamp}.${rawBody}` |
| Default tolerance | 300 seconds (5 minutes) |
| Replay protection | Reject signatures older than `toleranceSeconds` |
| Constant-time comparison | Yes (timing-attack-safe) |

### Key things to know

1. **`rawBody` must be the byte-exact request body.** Any framework that JSON-parses before you see the body breaks the signature. Use raw-body middleware (see recipes below).
2. **`verifyWebhook` never throws.** Failures return `{ valid: false, reason }`. Log the reason; never return it to the sender (would be a verification oracle).
3. **The same SDK works in Node and browsers.** Uses Web Crypto (`globalThis.crypto.subtle`), available in Node 18+ and every modern browser. No `node:crypto` import.

---

## Recipes

### Recipe: Hashing user IDs

The SDK requires `userId` on every call. If you don't want to ship raw internal identifiers to ChurnLoop, hash them on your side with a secret only you hold:

```ts
import { createHmac } from 'node:crypto';

const HASH_SECRET = process.env.CHURNLOOP_USER_HASH_SECRET; // your secret

function hashUserId(internalId: string): string {
  return createHmac('sha256', HASH_SECRET).update(internalId).digest('hex');
}

churnloop.track({
  event: StandardEvent.UserSignedUp,
  userId: hashUserId('user_internal_12345'),
});
```

The same internal id always hashes to the same value, so per-user analytics still work. The raw id never leaves your infrastructure.

The SDK does **not** hash on your behalf — keeping the secret on your side is the entire point.

### Recipe: Migrating from Segment

The SDK's `track()` shape matches Segment's `analytics-node`:

```ts
// Before — Segment
import Analytics from 'analytics-node';
const analytics = new Analytics('YOUR_WRITE_KEY');
analytics.track({
  event: 'Order Completed',
  userId: 'user_123',
  properties: { revenue: 99 },
});

// After — ChurnLoop
import { ChurnLoop } from '@churnloop/sdk';
const churnloop = new ChurnLoop({ apiKey: 'cl_...' });
churnloop.track({
  event: 'Order Completed',
  userId: 'user_123',
  properties: { revenue: 99 },
});
```

Same event names, same property shapes — your existing event taxonomy keeps working. If you want the cross-tenant features, swap `'Order Completed'` for `StandardEvent.SubscriptionStarted` / etc. where a canonical name applies.

### Recipe: Verifying webhooks in Express

The body must reach the handler unparsed. Use `express.raw()` for the webhook route specifically:

```ts
import express from 'express';
import { verifyWebhook } from '@churnloop/sdk';

const app = express();

app.post(
  '/webhooks/churnloop',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const rawBody = (req.body as Buffer).toString('utf8');
    const signature = req.header('x-churnloop-signature');

    if (!signature) return res.status(400).send('missing signature');

    const result = await verifyWebhook({
      rawBody,
      signatureHeader: signature,
      secret: process.env.CHURNLOOP_WEBHOOK_SECRET!,
    });

    if (!result.valid) {
      console.warn('ChurnLoop webhook verification failed:', result.reason);
      return res.status(403).send('invalid signature');
    }

    const event = JSON.parse(rawBody);
    // ... handle the event ...
    res.status(200).send('ok');
  },
);
```

### Recipe: Verifying webhooks in Next.js

Next.js App Router (route handlers):

```ts
// app/api/webhooks/churnloop/route.ts
import { verifyWebhook } from '@churnloop/sdk';

export async function POST(req: Request) {
  const rawBody = await req.text(); // un-parsed body
  const signature = req.headers.get('x-churnloop-signature') ?? '';

  const result = await verifyWebhook({
    rawBody,
    signatureHeader: signature,
    secret: process.env.CHURNLOOP_WEBHOOK_SECRET!,
  });

  if (!result.valid) {
    return new Response('invalid signature', { status: 403 });
  }

  const event = JSON.parse(rawBody);
  // ... handle ...
  return new Response('ok', { status: 200 });
}
```

### Recipe: Verifying webhooks in a Cloudflare Worker

Web Crypto is built in, so this works out of the box:

```ts
import { verifyWebhook } from '@churnloop/sdk';

export default {
  async fetch(request: Request, env: { CHURNLOOP_WEBHOOK_SECRET: string }) {
    if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });

    const rawBody = await request.text();
    const result = await verifyWebhook({
      rawBody,
      signatureHeader: request.headers.get('x-churnloop-signature') ?? '',
      secret: env.CHURNLOOP_WEBHOOK_SECRET,
    });
    if (!result.valid) return new Response('invalid signature', { status: 403 });

    const event = JSON.parse(rawBody);
    // ... handle ...
    return new Response('ok');
  },
};
```

---

## Privacy & consent

The SDK does **not** check `navigator.doNotTrack` or any other consent signal. You should gate the `ChurnLoop` constructor behind your own consent infrastructure (OneTrust, Cookiebot, your custom flow):

```ts
const churnloop = userHasConsented()
  ? new ChurnLoop({ apiKey: process.env.CHURNLOOP_API_KEY })
  : new ChurnLoop({ apiKey: process.env.CHURNLOOP_API_KEY, disabled: true });
```

This keeps the consent boundary where it belongs — with the integration that knows your jurisdiction, your policy, and your user's choices — rather than building a half-baked consent model into the SDK.

---

## Error handling

`track()` never throws. Errors flow through the `onError` hook (defaults to `console.warn`):

```ts
const churnloop = new ChurnLoop({
  apiKey: process.env.CHURNLOOP_API_KEY,
  onError: (err, ctx) => {
    Sentry.captureException(err, { extra: { droppedEvents: ctx.droppedEvents } });
  },
});
```

Errors the SDK reports:

| Cause | Reported via | Retryable? |
|---|---|---|
| Missing `event` or `userId` | `onError` (dropped locally) | No (caller bug) |
| Invalid API key (401) | `onError` | No |
| Insufficient permissions or quota exceeded (403) | `onError` | No |
| Validation failure on the server (400) | `onError` | No |
| Rate-limited (429) | `onError` after retries exhausted | Yes (exponential backoff) |
| 5xx / network failure | `onError` after retries exhausted | Yes (exponential backoff) |

The transport surfaces a `TransportError` with a `retryable` flag.

---

## Roadmap

| Version | Adds |
|---|---|
| **v0.1.0** | `track()`, `StandardEvent`, `$context`, webhook verification |
| **v0.2.0** *(current)* | `identify`, `page`, `screen`, `flush()`; batching (size + time + shutdown); exponential-backoff retry; queue overflow drop policy |
| **v0.3.0** | `pagehide` / `beforeExit` shutdown drains; browser `sendBeacon` for final flush; CSP-friendly distribution |
| **v1.0.0** | Public API frozen; SemVer guarantees |
| **Future** | Python SDK, Go SDK, vertical event specs (E-Commerce, Video) |

---

## Contributing

Issues and PRs welcome at [github.com/ChurnLoop/sdk-ts](https://github.com/ChurnLoop/sdk-ts/issues).

---

## License

Apache-2.0
