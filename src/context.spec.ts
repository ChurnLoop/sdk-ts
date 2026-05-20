import { buildContext } from './context';
import { SDK_NAME, SDK_VERSION } from './version';

describe('buildContext', () => {
  it('always emits library name + version', () => {
    const ctx = buildContext();
    expect(ctx.library).toEqual({ name: SDK_NAME, version: SDK_VERSION });
  });

  it('in Node, populates runtime.node with process.versions.node', () => {
    const ctx = buildContext();
    expect(ctx.runtime).toEqual({
      name: 'node',
      version: process.versions.node,
    });
  });

  it('in Node, does NOT populate browser-only fields', () => {
    // The auto-attached context block must not lie about which
    // runtime emitted it — `page` / `userAgent` / `locale` would
    // mislead downstream queries.
    const ctx = buildContext();
    expect(ctx.page).toBeUndefined();
    expect(ctx.userAgent).toBeUndefined();
    expect(ctx.locale).toBeUndefined();
  });
});
