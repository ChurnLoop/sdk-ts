// SDK version, baked at build time. The string is replaced by tsup
// at build time via... actually we just hand-maintain it for v0.x
// and bump in lockstep with package.json's `version`. A
// pre-publish script will eventually generate this.
//
// Used in the auto-attached $context so server-side observers can
// see "events from SDK version X" without per-customer
// instrumentation.
export const SDK_VERSION = '0.2.0';
export const SDK_NAME = 'churnloop-sdk-js';
