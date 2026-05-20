// Stage 21a — SDK jest config.
//
// Standalone (does not extend the root config) because:
//   - The SDK is a publish target, not a service. Future SDK-specific
//     test setup (jsdom for browser tests, etc.) belongs scoped here,
//     not in the monorepo root.
//   - Avoids importing `@jarvis/*` workspace aliases — the SDK MUST
//     remain self-contained so customers installing from npm don't
//     need the monorepo.
//
// Root `npx jest` still picks these up via the root `roots` array
// pointing at packages/; that runs this config indirectly via the
// rootDir below being absolute to the package, not the monorepo.
module.exports = {
  rootDir: __dirname,
  testEnvironment: 'node',
  testRegex: '.*\\.spec\\.ts$',
  moduleFileExtensions: ['js', 'json', 'ts'],
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        // The SDK's own tsconfig — strict mode etc. — applies here
        // so tests fail under the same rules as production code.
        tsconfig: '<rootDir>/tsconfig.json',
      },
    ],
  },
  collectCoverageFrom: ['src/**/*.ts'],
};
