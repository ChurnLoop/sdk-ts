// Minimal ambient typings for the few global APIs the SDK touches
// across runtimes. Declared locally (rather than pulling in
// `@types/node` or `lib.dom.d.ts` entries we don't need) so the
// SDK's type surface stays small and self-contained — no
// transitive dependencies leak into customers' compilation.
//
// We only declare the shape we actually USE. If we ever need
// `process.platform` etc., add the field here.

interface NodeProcessLike {
  env?: Record<string, string | undefined>;
  versions?: { node?: string };
}

interface GlobalShape {
  process?: NodeProcessLike;
}

/**
 * Typed `globalThis` access. Caller does `getGlobals().process?.env`
 * — no type error on missing-in-browser, no DOM lib needed.
 */
export function getGlobals(): GlobalShape {
  return globalThis as unknown as GlobalShape;
}
