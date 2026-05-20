// Public types for @churnloop/sdk consumers.
//
// Loose by design (see sdk-plan.md decision 7): `properties` /
// `traits` are open Record<string, unknown> so consumers extend
// freely. Validation lives at the ingest server, not here.

/**
 * Canonical event-name vocabulary. Shipping a fixed set of names
 * lets us build cross-tenant rollups, ship-with-semantics playbook
 * templates, and (eventually) train cross-tenant models without
 * per-customer schema mapping. See sdk-plan.md for the rationale.
 *
 * Customers MAY pass arbitrary strings as the `event` field; they
 * are not constrained to this list. Using a standard name enables
 * the cross-tenant features, that's the only difference.
 *
 * Versioning contract:
 *   - Adding entries → minor version bump.
 *   - Renaming or removing an entry would silently break customers'
 *     dashboards; we do NOT do that. If a name needs to evolve,
 *     add the new name and keep the old.
 */
export const StandardEvent = {
  // User lifecycle
  UserSignedUp: 'User Signed Up',
  UserSignedIn: 'User Signed In',
  UserSignedOut: 'User Signed Out',
  UserDeleted: 'User Deleted',

  // Onboarding
  OnboardingStarted: 'Onboarding Started',
  OnboardingCompleted: 'Onboarding Completed',

  // Subscription / billing
  SubscriptionStarted: 'Subscription Started',
  SubscriptionUpgraded: 'Subscription Upgraded',
  SubscriptionDowngraded: 'Subscription Downgraded',
  SubscriptionCanceled: 'Subscription Canceled',
  PaymentFailed: 'Payment Failed',

  // Team / workspace
  Invited: 'Invited',
  InviteAccepted: 'Invite Accepted',

  // Generic engagement (use sparingly; prefer specific names)
  FeatureUsed: 'Feature Used',
  Searched: 'Searched',
} as const;

export type StandardEventName = (typeof StandardEvent)[keyof typeof StandardEvent];

/**
 * The `event` field accepts standard names (with IDE autocomplete)
 * or any custom string. There's no validation at the SDK boundary —
 * the ingest server is the source of truth for event-name rules.
 */
export type EventName = StandardEventName | (string & {});

/** Free-form payload attached to events. Serialised to JSON. */
export type EventProperties = Record<string, unknown>;

/** User attributes set via `identify`. Serialised as `traits`. */
export type UserTraits = Record<string, unknown>;

/**
 * Auto-attached context block — the SDK populates this on every
 * event. Consumers see it on the server side in
 * `properties.$context`. Includes library version + runtime
 * platform fields so ops can answer "which SDK version are we
 * seeing in the wild?" without per-customer instrumentation.
 */
export interface ChurnLoopContext {
  library: {
    name: string;
    version: string;
  };
  /** Populated on Node only. */
  runtime?: {
    name: 'node';
    version: string;
  };
  /** Populated in browsers only. */
  page?: {
    url?: string;
    referrer?: string;
    title?: string;
  };
  /** Populated in browsers only. */
  userAgent?: string;
  /** Populated in browsers only. */
  locale?: string;
}

/** Hook for non-fatal SDK errors (failed flushes, dropped events). */
export type ErrorHandler = (
  error: Error,
  context: { droppedEvents: number },
) => void;

export interface ChurnLoopOptions {
  /**
   * Required. Bearer token from the ChurnLoop API-keys page (starts
   * with `cl_`). Falls back to `process.env.CHURNLOOP_API_KEY` if
   * omitted on Node.
   */
  apiKey?: string;

  /**
   * Ingest host. Default: `https://ingest.churnloop.com`.
   * Override for self-hosted or staging environments. Falls back
   * to `process.env.CHURNLOOP_HOST` if omitted on Node.
   */
  host?: string;

  /** Per-request timeout in milliseconds. Default 30_000. */
  timeoutMs?: number;

  /**
   * Disable network calls. Useful for unit tests in customer code.
   * Falls back to `process.env.CHURNLOOP_DISABLED === 'true'` on Node.
   * When disabled, all methods are no-ops; nothing is queued or sent.
   */
  disabled?: boolean;

  // ── v0.2 batching + retry ────────────────────────────────────

  /**
   * Flush the queue once it reaches this many buffered events.
   * Default: 100 (matches the server-side Segment batch endpoint
   * cap). Lower values increase request count; higher values are
   * rejected by the server.
   */
  flushAt?: number;

  /**
   * Flush the queue if events have been sitting longer than this
   * many milliseconds since the first buffered event. Default:
   * 1000. Tradeoff: lower = more requests but fresher data;
   * higher = fewer requests but events delayed.
   */
  flushInterval?: number;

  /**
   * Hard cap on the in-memory queue. When exceeded, the OLDEST
   * events are dropped (with `onError` callback). Protects
   * against unbounded memory growth if the upstream ingest is
   * unreachable for an extended period. Default: 1000.
   */
  maxQueueSize?: number;

  /**
   * Maximum retry attempts on retryable failures (network errors,
   * 429, 5xx). Each attempt waits an exponential backoff with
   * jitter. Default: 5 (≈30s total wall-clock max). After
   * exhaustion the batch's events are dropped via `onError`.
   */
  maxRetries?: number;

  /**
   * Called when a non-fatal error occurs (failed flush after
   * exhausted retries, queue overflow drops). Defaults to
   * `console.warn`. Use to wire to your error tracker.
   */
  onError?: ErrorHandler;
}

/**
 * Arguments accepted by `track()`. Mirror Segment's analytics-node
 * shape so customers migrating from Segment can swap with one
 * import change.
 */
export interface TrackInput {
  event: EventName;
  userId: string;
  properties?: EventProperties;
  /**
   * Optional numeric value for the event (e.g. revenue, score, duration).
   * Must be a finite number — stored in a dedicated ClickHouse column so
   * it can be aggregated (sum, max, avg) in playbook conditions and
   * analytics without JSON extraction.
   */
  value?: number;
  /**
   * ISO 8601 timestamp. If omitted, the ingest server stamps
   * server-receive time. The ingest server rejects timestamps
   * outside `[now - 7 days, now + 5 minutes]`.
   */
  timestamp?: string;
  /**
   * Stable id for deduplication. If omitted, the SDK generates a
   * UUID v4. Reusing an id (e.g., on retry) is the dedup contract.
   */
  messageId?: string;
}

/**
 * Arguments accepted by `identify()`. Sets / updates user traits
 * on the server. Maps to Segment's `identify` shape.
 */
export interface IdentifyInput {
  userId: string;
  traits?: UserTraits;
  timestamp?: string;
  messageId?: string;
}

/**
 * Arguments accepted by `page()`. Browser SPA navigation events;
 * Segment's `page` shape. The `name` is optional but recommended —
 * server-side analytics treats unnamed pages as `(unnamed)`.
 */
export interface PageInput {
  userId: string;
  name?: string;
  properties?: EventProperties;
  timestamp?: string;
  messageId?: string;
}

/**
 * Arguments accepted by `screen()`. Mobile / native screen-view
 * events; Segment's `screen` shape. Same fields as `page` —
 * separate method so the server-side `$screen` synthetic event is
 * emitted distinctly from `$page`.
 */
export interface ScreenInput {
  userId: string;
  name?: string;
  properties?: EventProperties;
  timestamp?: string;
  messageId?: string;
}
