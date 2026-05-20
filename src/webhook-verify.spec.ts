import { createHmac } from 'node:crypto';
import { verifyWebhook } from './webhook-verify';

// Build a valid ChurnLoop-shape signature header using the same
// algorithm the worker uses to sign outbound webhooks (Stage 7d).
// Using node:crypto here rather than Web Crypto keeps the test
// fixture sync + readable; the verifier itself uses Web Crypto.
function sign(
  rawBody: string,
  secret: string,
  timestamp: number,
): string {
  const hex = createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
  return `t=${timestamp},v1=${hex}`;
}

const SECRET = 'whsec_test_some_secret_value';
const NOW = 1_780_000_000; // fixed point in 2026

describe('verifyWebhook', () => {
  describe('happy path', () => {
    it('accepts a freshly-signed webhook from ChurnLoop', async () => {
      const rawBody = JSON.stringify({ type: 'intervention.executed', data: { id: 'i_1' } });
      const sig = sign(rawBody, SECRET, NOW);

      const result = await verifyWebhook({
        rawBody,
        signatureHeader: sig,
        secret: SECRET,
        nowSeconds: NOW,
      });

      expect(result).toEqual({ valid: true });
    });

    it('accepts a signature within the default tolerance window (5 min)', async () => {
      const rawBody = '{}';
      // Signed 4 minutes ago — under the 5 min default tolerance.
      const sig = sign(rawBody, SECRET, NOW - 4 * 60);

      const result = await verifyWebhook({
        rawBody,
        signatureHeader: sig,
        secret: SECRET,
        nowSeconds: NOW,
      });

      expect(result.valid).toBe(true);
    });
  });

  describe('replay protection', () => {
    it('rejects a signature older than the tolerance window', async () => {
      // 10 minutes old > 5 minute default — likely a replayed
      // capture rather than a real delivery.
      const rawBody = '{}';
      const sig = sign(rawBody, SECRET, NOW - 10 * 60);

      const result = await verifyWebhook({
        rawBody,
        signatureHeader: sig,
        secret: SECRET,
        nowSeconds: NOW,
      });

      expect(result).toEqual({ valid: false, reason: 'timestamp_out_of_range' });
    });

    it('rejects a signature timestamped too far in the future', async () => {
      // Clock skew or attacker pre-signing — same rejection logic.
      const rawBody = '{}';
      const sig = sign(rawBody, SECRET, NOW + 10 * 60);

      const result = await verifyWebhook({
        rawBody,
        signatureHeader: sig,
        secret: SECRET,
        nowSeconds: NOW,
      });

      expect(result).toEqual({ valid: false, reason: 'timestamp_out_of_range' });
    });

    it('respects a custom toleranceSeconds override', async () => {
      // Behind a slow queue: customer widens the window to 30
      // minutes; signature signed 20 minutes ago is now valid.
      const rawBody = '{}';
      const sig = sign(rawBody, SECRET, NOW - 20 * 60);

      const result = await verifyWebhook({
        rawBody,
        signatureHeader: sig,
        secret: SECRET,
        toleranceSeconds: 30 * 60,
        nowSeconds: NOW,
      });

      expect(result.valid).toBe(true);
    });
  });

  describe('signature validation', () => {
    it('rejects when the body has been tampered with after signing', async () => {
      // The signed timestamp is fine, the secret is right, but
      // someone edited the body. This is the core attack the
      // signature defends against.
      const rawBody = JSON.stringify({ amount: 100 });
      const sig = sign(rawBody, SECRET, NOW);
      const tamperedBody = JSON.stringify({ amount: 10000 });

      const result = await verifyWebhook({
        rawBody: tamperedBody,
        signatureHeader: sig,
        secret: SECRET,
        nowSeconds: NOW,
      });

      expect(result).toEqual({ valid: false, reason: 'signature_mismatch' });
    });

    it('rejects when the secret is wrong', async () => {
      const rawBody = '{}';
      const sig = sign(rawBody, SECRET, NOW);

      const result = await verifyWebhook({
        rawBody,
        signatureHeader: sig,
        secret: 'whsec_wrong_secret',
        nowSeconds: NOW,
      });

      expect(result).toEqual({ valid: false, reason: 'signature_mismatch' });
    });
  });

  describe('malformed input', () => {
    it('rejects an empty signature header', async () => {
      const result = await verifyWebhook({
        rawBody: '{}',
        signatureHeader: '',
        secret: SECRET,
      });

      expect(result).toEqual({ valid: false, reason: 'malformed_signature' });
    });

    it('rejects a header missing the t= entry', async () => {
      const result = await verifyWebhook({
        rawBody: '{}',
        signatureHeader: 'v1=abcdef',
        secret: SECRET,
        nowSeconds: NOW,
      });

      expect(result).toEqual({ valid: false, reason: 'malformed_signature' });
    });

    it('rejects a header missing the v1= entry', async () => {
      const result = await verifyWebhook({
        rawBody: '{}',
        signatureHeader: `t=${NOW}`,
        secret: SECRET,
        nowSeconds: NOW,
      });

      expect(result).toEqual({ valid: false, reason: 'malformed_signature' });
    });

    it('rejects a v1 value that is not hex', async () => {
      const result = await verifyWebhook({
        rawBody: '{}',
        signatureHeader: `t=${NOW},v1=not-hex-at-all`,
        secret: SECRET,
        nowSeconds: NOW,
      });

      expect(result).toEqual({ valid: false, reason: 'malformed_signature' });
    });

    it('rejects a non-numeric timestamp', async () => {
      const result = await verifyWebhook({
        rawBody: '{}',
        signatureHeader: 't=not-a-number,v1=abcdef',
        secret: SECRET,
        nowSeconds: NOW,
      });

      expect(result).toEqual({ valid: false, reason: 'malformed_signature' });
    });

    it('tolerates whitespace around separator entries', async () => {
      // Defensive: some proxies / gateways re-serialise headers
      // with extra whitespace. The verifier accepts that.
      const rawBody = '{}';
      const sig = sign(rawBody, SECRET, NOW);
      // Inject spaces.
      const spaced = sig.replace(',', ' , ');

      const result = await verifyWebhook({
        rawBody,
        signatureHeader: spaced,
        secret: SECRET,
        nowSeconds: NOW,
      });

      expect(result.valid).toBe(true);
    });

    it('tolerates a future signature scheme appearing in the same header (forward compat)', async () => {
      // If we ever add v2, customers using older SDKs still
      // verify against the v1 entry without breaking.
      const rawBody = '{}';
      const sig = sign(rawBody, SECRET, NOW);
      const forwardCompat = `${sig},v2=futurealgorithm`;

      const result = await verifyWebhook({
        rawBody,
        signatureHeader: forwardCompat,
        secret: SECRET,
        nowSeconds: NOW,
      });

      expect(result.valid).toBe(true);
    });
  });
});
