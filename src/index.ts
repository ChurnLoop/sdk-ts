// Public entry point for @churnloop/sdk.
//
// Everything exported here is part of the SemVer contract.
// Anything not exported is an internal implementation detail and
// can change without a major bump.
//
// Relative imports use the explicit `.js` extension so the source
// is consumable under both `moduleResolution: "bundler"` (the
// SDK's own tsconfig) AND `moduleResolution: "nodenext"` (the
// monorepo root, when apps/api imports via path mapping for
// dogfooding). Standard practice for ESM-compatible TS libraries.

export { ChurnLoop } from './client';
export { TransportError } from './transport';

export { StandardEvent } from './types';
export type {
  EventName,
  EventProperties,
  ErrorHandler,
  IdentifyInput,
  ChurnLoopContext,
  ChurnLoopOptions,
  PageInput,
  ScreenInput,
  StandardEventName,
  TrackInput,
  UserTraits,
} from './types';

export { SDK_NAME, SDK_VERSION } from './version';

export { verifyWebhook } from './webhook-verify';
export type {
  VerifyWebhookInput,
  VerifyWebhookResult,
  VerifyFailureReason,
} from './webhook-verify';
