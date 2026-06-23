/**
 * Tests for `WaitlistWelcome` (AECI-243). The load-bearing guarantee is cache
 * neutrality: the SSR/pre-hydration render shows NOTHING; the banner appears only
 * after the `afterNextRender` reconciliation, and only for a `?ref=waitlist`
 * arrival that hasn't been dismissed. Mirrors the `ConsentBanner` test shape.
 *
 * The component reads query params straight from `location.search` (the shell is
 * not a routed outlet, so an injected ActivatedRoute carries no query params), so
 * the tests drive the URL with `history.replaceState`.
 */
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { WaitlistWelcome } from './waitlist-welcome';
import { WaitlistWelcomeService } from './waitlist-welcome.service';

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

function create(params: Record<string, string>, dismissed = false) {
  const query = new URLSearchParams(params).toString();
  history.replaceState({}, '', query ? `/?${query}` : '/');
  const welcome = {
    isDismissed: vi.fn(() => dismissed),
    dismiss: vi.fn(),
    logAttribution: vi.fn(),
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
  beforeEach(() => {
    TestBed.resetTestingModule();
    history.replaceState({}, '', '/');
  });

  it('reveals the banner for a waitlist arrival and logs the token', async () => {
    const { fixture, welcome, el } = create({ ref: 'waitlist', token: 'xyz' });
    await hydrate(fixture);
    expect(el.querySelector('#waitlist-dismiss')).not.toBeNull();
    expect(el.textContent).toContain('Thanks for waiting');
    expect(welcome.logAttribution).toHaveBeenCalledWith('xyz');
  });

  it('stays hidden and logs nothing when there are no query params', async () => {
    const { fixture, welcome, el } = create({});
    await hydrate(fixture);
    expect(el.querySelector('#waitlist-dismiss')).toBeNull();
    expect(welcome.logAttribution).not.toHaveBeenCalled();
  });

  it('stays hidden for a non-waitlist ref (and does not log its token)', async () => {
    const { fixture, welcome, el } = create({ ref: 'newsletter', token: 'abc' });
    await hydrate(fixture);
    expect(el.querySelector('#waitlist-dismiss')).toBeNull();
    expect(welcome.logAttribution).not.toHaveBeenCalled();
  });

  it('shows for a waitlist arrival with no token, but logs nothing', async () => {
    const { fixture, welcome, el } = create({ ref: 'waitlist' });
    await hydrate(fixture);
    expect(el.querySelector('#waitlist-dismiss')).not.toBeNull();
    expect(welcome.logAttribution).toHaveBeenCalledWith(null);
  });

  it('stays hidden when already dismissed', async () => {
    const { fixture, el } = create({ ref: 'waitlist', token: 'xyz' }, true);
    await hydrate(fixture);
    expect(el.querySelector('#waitlist-dismiss')).toBeNull();
  });

  it('dismiss persists the decision and hides the banner', async () => {
    const { fixture, welcome, el } = create({ ref: 'waitlist', token: 'xyz' });
    await hydrate(fixture);
    (el.querySelector('#waitlist-dismiss') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(welcome.dismiss).toHaveBeenCalledTimes(1);
    expect(el.querySelector('#waitlist-dismiss')).toBeNull();
  });
});
