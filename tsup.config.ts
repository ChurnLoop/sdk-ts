import { defineConfig } from 'tsup';

// Stage 21a — SDK build config.
//
// Dual output (CJS + ESM) so the package works in any consumer
// regardless of their module system. Types emitted from a single
// source so `import type` works across both targets.
//
// `splitting: false` — we ship a single entrypoint; chunk splitting
// would yield smaller files at the cost of customers having to
// vendor multiple files. Single-file is friendlier.
//
// `sourcemap: true` — matches the SDK plan's decision (debuggability,
// effectively free).
//
// `treeshake: true` — for the CJS bundle especially, drops anything
// unreferenced from index.ts. The ESM build is shaken by the
// consumer's bundler too.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  target: 'es2022',
  minify: false,
});
