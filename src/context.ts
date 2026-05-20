import type { ChurnLoopContext } from './types';
import { SDK_NAME, SDK_VERSION } from './version';
import { isBrowser } from './env';
import { getGlobals } from './globals';

// Stage 21a — auto-attached `$context` on every event.
//
// Universal SDK pattern (Segment, PostHog, Mixpanel all do this).
// Costs the customer nothing and gives ops a free pivot ("how many
// events from SDK 0.1.x are still in the wild?", "did this bug
// affect Chrome only?").
//
// Resolved fresh per event (NOT cached) so SPA page transitions
// reflect the current URL. Cost is negligible — a handful of
// global reads.

export function buildContext(): ChurnLoopContext {
  const ctx: ChurnLoopContext = {
    library: { name: SDK_NAME, version: SDK_VERSION },
  };

  if (isBrowser()) {
    // Browser-only fields. Each guarded individually because some
    // environments (test harnesses, embedded webviews) don't
    // expose every field.
    const nav = typeof navigator !== 'undefined' ? navigator : undefined;
    const doc = typeof document !== 'undefined' ? document : undefined;
    const loc = typeof location !== 'undefined' ? location : undefined;

    ctx.page = {
      ...(loc?.href ? { url: loc.href } : {}),
      ...(doc?.referrer ? { referrer: doc.referrer } : {}),
      ...(doc?.title ? { title: doc.title } : {}),
    };
    if (nav?.userAgent) ctx.userAgent = nav.userAgent;
    if (nav?.language) ctx.locale = nav.language;
  } else {
    // Node (and node-like edge runtimes that expose process).
    // We deliberately omit the runtime field on Workers / Deno
    // since `process.versions.node` is missing there — the
    // library field still says it came from this SDK.
    const nodeVersion = getGlobals().process?.versions?.node;
    if (nodeVersion) {
      ctx.runtime = { name: 'node', version: nodeVersion };
    }
  }

  return ctx;
}
