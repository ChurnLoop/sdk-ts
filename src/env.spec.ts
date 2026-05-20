import { isBrowser, resolveConfig } from './env';

describe('env', () => {
  const ORIGINAL_ENV = process.env;
  beforeEach(() => {
    // Each test gets a clean env so CHURNLOOP_* doesn't leak between cases.
    process.env = { ...ORIGINAL_ENV };
    delete process.env.CHURNLOOP_API_KEY;
    delete process.env.CHURNLOOP_HOST;
    delete process.env.CHURNLOOP_DISABLED;
  });
  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  describe('resolveConfig', () => {
    it('takes apiKey from constructor options', () => {
      const cfg = resolveConfig({ apiKey: 'cl_test_123' });
      expect(cfg.apiKey).toBe('cl_test_123');
    });

    it('falls back to CHURNLOOP_API_KEY env var when apiKey is omitted', () => {
      process.env.CHURNLOOP_API_KEY = 'cl_env_456';
      const cfg = resolveConfig({});
      expect(cfg.apiKey).toBe('cl_env_456');
    });

    it('constructor option takes precedence over env var', () => {
      process.env.CHURNLOOP_API_KEY = 'cl_env_456';
      const cfg = resolveConfig({ apiKey: 'cl_explicit' });
      expect(cfg.apiKey).toBe('cl_explicit');
    });

    it('throws at construction time when no apiKey is available', () => {
      // Loud failure beats silent dropped events — caller knows
      // immediately if they wired the config wrong.
      expect(() => resolveConfig({})).toThrow(/apiKey is required/);
    });

    it('falls back to CHURNLOOP_HOST when host is omitted', () => {
      process.env.CHURNLOOP_HOST = 'https://staging.example.com';
      const cfg = resolveConfig({ apiKey: 'cl_test' });
      expect(cfg.host).toBe('https://staging.example.com');
    });

    it('falls back to a default host when neither option nor env is set', () => {
      const cfg = resolveConfig({ apiKey: 'cl_test' });
      // Don't lock in the exact default — just confirm it's a URL.
      expect(cfg.host).toMatch(/^https?:\/\//);
    });

    it('treats CHURNLOOP_DISABLED=true as disabled', () => {
      process.env.CHURNLOOP_DISABLED = 'true';
      const cfg = resolveConfig({ apiKey: 'cl_test' });
      expect(cfg.disabled).toBe(true);
    });

    it('treats CHURNLOOP_DISABLED=anything-else as enabled', () => {
      // Defensive: only the literal 'true' disables. '1', 'yes', etc.
      // do nothing, so a customer's CI env var like CHURNLOOP_DISABLED=1
      // doesn't accidentally silence prod.
      process.env.CHURNLOOP_DISABLED = '1';
      const cfg = resolveConfig({ apiKey: 'cl_test' });
      expect(cfg.disabled).toBe(false);
    });

    it('constructor disabled:true overrides env var disabled=false', () => {
      const cfg = resolveConfig({ apiKey: 'cl_test', disabled: true });
      expect(cfg.disabled).toBe(true);
    });
  });

  describe('isBrowser', () => {
    it('returns false in Node (jest test environment)', () => {
      expect(isBrowser()).toBe(false);
    });
  });
});
