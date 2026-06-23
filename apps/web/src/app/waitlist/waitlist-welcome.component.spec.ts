/**
 * Tests for `WaitlistWelcome` (AECI-243). The load-bearing guarantee is cache
 * neutrality: the SSR/pre-hydration render shows NOTHING; the banner appears only
 * after the `afterNextRender` reconciliation. Mirrors the `ConsentBanner` shape.
 *
 * The URL decision lives in `WaitlistWelcomeService.welcomeState()` (it reads
 * `location.search`), so it is fully mocked here — the component is just the
 * presentational reflection of that decision. This keeps the spec deterministic
 * and free of global `location`/`history` mutation (which jsdom only partially
 * supports — "navigation to another Document" — and which polluted across files
 * in CI).
 */
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { WaitlistWelcome } from './waitlist-welcome';
import { WaitlistWelcomeService } from './waitlist-welcome.service';

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

function create(state: { showBanner: boolean; token: string | null }) {
  const welcome = {
    welcomeState: vi.fn(() => state),
    logAttribution: vi.fn(),
    dismiss: vi.fn(),
  };
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: WaitlistWelcomeService, useValue: welcome },
    ],
  });
  const fixture = TestBed.createComponent(WaitlistWelcome);
  return { fixture, welcome, el: fixture.nativeElement as HTMLElement };
}

async function hydrate(fixture: ReturnType<typeof create>['fixture']) {
  fixture.detectChanges();
  await fixture.whenStable();
  await settle();
  fixture.detectChanges();
}

describe('WaitlistWelcome', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('reveals the banner and logs the token for a waitlist arrival', async () => {
    const { fixture, welcome, el } = create({ showBanner: true, token: 'xyz' });
    await hydrate(fixture);
    expect(el.querySelector('#waitlist-dismiss')).not.toBeNull();
    expect(el.textContent).toContain('Thanks for waiting');
    expect(welcome.logAttribution).toHaveBeenCalledWith('xyz');
  });

  it('stays hidden and logs nothing when there is no waitlist arrival', async () => {
    const { fixture, welcome, el } = create({ showBanner: false, token: null });
    await hydrate(fixture);
    expect(el.querySelector('#waitlist-dismiss')).toBeNull();
    expect(welcome.logAttribution).toHaveBeenCalledWith(null);
  });

  it('shows for a waitlist arrival with no token (and logs nothing)', async () => {
    const { fixture, welcome, el } = create({ showBanner: true, token: null });
    await hydrate(fixture);
    expect(el.querySelector('#waitlist-dismiss')).not.toBeNull();
    expect(welcome.logAttribution).toHaveBeenCalledWith(null);
  });

  it('dismiss persists the decision and hides the banner', async () => {
    const { fixture, welcome, el } = create({ showBanner: true, token: 'xyz' });
    await hydrate(fixture);
    (el.querySelector('#waitlist-dismiss') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(welcome.dismiss).toHaveBeenCalledTimes(1);
    expect(el.querySelector('#waitlist-dismiss')).toBeNull();
  });
});
