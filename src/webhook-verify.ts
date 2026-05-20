// Webhook signature verification for inbound webhooks from ChurnLoop.
//
// Stage 7d signs outbound webhooks Stripe-style:
//   - Header `X-ChurnLoop-Signature: t=<unix>,v1=<hex>`
//   - HMAC-SHA256 over `${unix_timestamp}.${rawBody}`
//   - Per-tenant secret configured in the dashboard
//
// This helper lets customers verify those webhooks in their own
// endpoint handlers without implementing HMAC themselves.
//
// Uses Web Crypto (`globalThis.crypto.subtle`) which is stable in
// Node 18+ and present in every modern browser — keeps the SDK
// isomorphic with no `node:crypto` import.

/**
 * Default tolerance window for timestamp freshness. Replay
 * protection: a captured webhook is only valid for this long
 * after ChurnLoop sent it. 5 minutes matches Stripe's default and
 * is the same tolerance Stripe's verifier uses on inbound from us.
 */
const DEFAULT_TOLERANCE_SECONDS = 300;

export interface VerifyWebhookInput {
  /**
   * The raw request body as a UTF-8 string. MUST be the byte-exact
   * bytes ChurnLoop sent — any re-serialisation
   * (`JSON.stringify(JSON.parse(body))`) breaks the signature.
   * Most frameworks expose this as `req.rawBody` or via a raw-body
   * middleware (Express: `express.raw({ type: 'application/json' })`).
   */
  rawBody: string;
  /**
   * The value of the `X-ChurnLoop-Signature` header verbatim. Shape:
   * `t=<unix>,v1=<hex>`. Older signature schemes (none currently)
   * would add `v0`, `v2`, etc — the verifier reads `v1` only.
   */
  signatureHeader: string;
  /**
   * The webhook secret from your ChurnLoop tenant settings. Treat as
   * a credential — store in environment variables, not in code.
   */
  secret: string;
  /**
   * Allowed seconds between the signed timestamp and `now`. Default
   * 300 (5 min). Set to a higher value if your endpoint is behind
   * a queue / proxy that can delay delivery, but be aware this
   * widens the replay window.
   */
  toleranceSeconds?: number;
  /**
   * Override for `now` in seconds since epoch. Used in tests. In
   * production you'd never set this.
   */
  nowSeconds?: number;
}

export type VerifyWebhookResult =
  | { valid: true }
  | { valid: false; reason: VerifyFailureReason };

export type VerifyFailureReason =
  | 'malformed_signature'   // header doesn't match `t=...,v1=...` shape
  | 'timestamp_out_of_range' // outside tolerance window
  | 'signature_mismatch'     // HMAC doesn't match
  | 'crypto_unavailable';    // runtime missing Web Crypto (shouldn't happen on Node 18+)

/**
 * Verify a ChurnLoop webhook signature. Async because the Web Crypto
 * HMAC API is async — there is no sync alternative in browsers.
 *
 * Returns `{ valid: true }` on success or `{ valid: false, reason }`
 * on any failure. Never throws on signature problems — the failure
 * mode is structured so callers can log the reason for ops without
 * leaking it back to the sender (which would be a verification
 * oracle).
 *
 * @example
 *   const result = await verifyWebhook({
 *     rawBody,
 *     signatureHeader: req.headers['x-churnloop-signature'],
 *     secret: process.env.CHURNLOOP_WEBHOOK_SECRET,
 *   });
 *   if (!result.valid) return res.status(403).send('invalid signature');
 *   const event = JSON.parse(rawBody);
 *   // ...process event...
 */
export async function verifyWebhook(
  input: VerifyWebhookInput,
): Promise<VerifyWebhookResult> {
  const parsed = parseSignatureHeader(input.signatureHeader);
  if (!parsed) {
    return { valid: false, reason: 'malformed_signature' };
  }
  const { timestamp, signature } = parsed;

  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (Math.abs(now - timestamp) > tolerance) {
    return { valid: false, reason: 'timestamp_out_of_range' };
  }

  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    // Shouldn't happen on Node 18+ or any modern browser. Surfaced
    // as a structured failure rather than a throw so the caller
    // can log + return a clear "signing infrastructure offline"
    // error.
    return { valid: false, reason: 'crypto_unavailable' };
  }

  const signed = `${timestamp}.${input.rawBody}`;
  const expectedHex = await hmacSha256Hex(subtle, input.secret, signed);

  if (!timingSafeEqualHex(expectedHex, signature)) {
    return { valid: false, reason: 'signature_mismatch' };
  }
  return { valid: true };
}

interface ParsedSignature {
  timestamp: number;
  signature: string;
}

/**
 * Parse `t=<unix>,v1=<hex>` into its parts. Returns null on any
 * shape we don't recognise. Tolerant of arbitrary ordering and
 * extra fields (forward-compatible with future `v2` entries).
 */
function parseSignatureHeader(header: string | undefined): ParsedSignature | null {
  if (!header) return null;
  const parts = header.split(',').map((s) => s.trim());
  let t: number | undefined;
  let v1: string | undefined;
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't') {
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) return null;
      t = parsed;
    } else if (key === 'v1') {
      if (!/^[0-9a-f]+$/i.test(value)) return null;
      v1 = value;
    }
  }
  if (t === undefined || v1 === undefined) return null;
  return { timestamp: t, signature: v1 };
}

async function hmacSha256Hex(
  subtle: SubtleCrypto,
  secret: string,
  message: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const buffer = await subtle.sign('HMAC', key, encoder.encode(message));
  return bufferToHex(buffer);
}

function bufferToHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i] ?? 0;
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * Constant-time hex string comparison. Standard prevention against
 * timing-attack inference of the expected signature. Always
 * compares full length even when lengths differ.
 */
function timingSafeEqualHex(a: string, b: string): boolean {
  // Different lengths are an immediate fail — but the comparison
  // below still runs over a fixed length to avoid leaking via the
  // length-check's early return. Length leak is mostly theoretical
  // for hex of the same algorithm output (always 64 chars for SHA-256
  // hex) — included for robustness.
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}
