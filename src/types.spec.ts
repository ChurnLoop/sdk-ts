import { StandardEvent } from './types';

describe('StandardEvent', () => {
  it('exports the canonical lifecycle event names', () => {
    // Lock the core Tier-1 vocabulary so an accidental rename or
    // removal in a future refactor fails CI — these names are
    // part of the SDK's SemVer contract per sdk-plan.md.
    expect(StandardEvent.UserSignedUp).toBe('User Signed Up');
    expect(StandardEvent.UserSignedIn).toBe('User Signed In');
    expect(StandardEvent.UserSignedOut).toBe('User Signed Out');
    expect(StandardEvent.UserDeleted).toBe('User Deleted');
    expect(StandardEvent.OnboardingStarted).toBe('Onboarding Started');
    expect(StandardEvent.OnboardingCompleted).toBe('Onboarding Completed');
    expect(StandardEvent.SubscriptionStarted).toBe('Subscription Started');
    expect(StandardEvent.SubscriptionUpgraded).toBe('Subscription Upgraded');
    expect(StandardEvent.SubscriptionDowngraded).toBe('Subscription Downgraded');
    expect(StandardEvent.SubscriptionCanceled).toBe('Subscription Canceled');
    expect(StandardEvent.PaymentFailed).toBe('Payment Failed');
    expect(StandardEvent.Invited).toBe('Invited');
    expect(StandardEvent.InviteAccepted).toBe('Invite Accepted');
    expect(StandardEvent.FeatureUsed).toBe('Feature Used');
    expect(StandardEvent.Searched).toBe('Searched');
  });

  it('values are Title Case with spaces (matches Segment Spec convention)', () => {
    // Naming convention enforcement — keeps the vocabulary
    // predictable and portable for customers migrating from
    // Segment.
    for (const value of Object.values(StandardEvent)) {
      expect(value).toMatch(/^[A-Z][a-z]+(?:\s[A-Z][a-z]+)*$/);
    }
  });
});
