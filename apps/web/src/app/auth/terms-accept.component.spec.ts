/**
 * AECI-1637 (counsel Q63, ruling 53) — `/auth/terms`, the one Terms tick box. Pins: the
 * box starts unticked, its label is `TERMS_CHANGE_BOX_LABEL` word for word, Continue
 * without the tick sends nothing, the tick posts the version and goes to `next`, a 422
 * goes to `next` too, and a 401 goes back to sign-in.
 */
import { HttpErrorResponse } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { describe, expect, it, vi } from 'vitest';

import { TERMS_CHANGE_BOX_LABEL } from '@aeci/shared';

import { AccountApi } from '../account/account-api';
import { EARLY_INPUT_KEY } from '../shared/form-field/early-input';
import { TermsAcceptPage, termsAcceptNextPath, termsAcceptVersion } from './terms-accept';

const PENDING = {
  version: '1.2',
  effective_at: '2027-01-15T12:00:00.000Z',
  summary: ['The disputes section moves to arbitration.', 'The liability limit is lower.'],
  previous_version: '1.1',
};

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

async function setup(
  params: Record<string, string> = { version: '1.2', next: '/account' },
  accept: () => Promise<unknown> = async () => ({ version: '1.2', accepted_at: 'x' }),
  pendingRead: () => Promise<unknown> = async () => ({ pending: PENDING }),
) {
  const api = { acceptTerms: vi.fn(accept), getTermsPending: vi.fn(pendingRead) };
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: AccountApi, useValue: api },
      {
        provide: ActivatedRoute,
        useValue: { snapshot: { queryParamMap: convertToParamMap(params) } },
      },
    ],
  });
  const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
  const fixture = TestBed.createComponent(TermsAcceptPage);
  const hard = vi
    .spyOn(
      fixture.componentInstance as unknown as { hardNavigate: (u: string) => void },
      'hardNavigate',
    )
    .mockImplementation(() => {});
  fixture.detectChanges();
  await fixture.whenStable();
  await settle();
  fixture.detectChanges();
  return { fixture, api, navigate, hard, el: fixture.nativeElement as HTMLElement };
}

async function submit(fixture: { detectChanges(): void }, el: HTMLElement): Promise<void> {
  el.querySelector<HTMLButtonElement>('[data-testid="terms-accept-continue"]')!.click();
  await settle();
  await settle();
  fixture.detectChanges();
}

function tick(el: HTMLElement): void {
  const box = el.querySelector<HTMLInputElement>('[data-testid="terms-accept-box"]')!;
  box.checked = true;
  box.dispatchEvent(new Event('change'));
}

describe('TermsAcceptPage', () => {
  it('the box starts unticked and its label is TERMS_CHANGE_BOX_LABEL word for word', async () => {
    const { el } = await setup();
    const box = el.querySelector<HTMLInputElement>('[data-testid="terms-accept-box"]')!;
    expect(box.type).toBe('checkbox');
    expect(box.checked).toBe(false);
    expect(
      el
        .querySelector('[data-testid="terms-accept-label"]')!
        .textContent!.replace(/\s+/g, ' ')
        .trim(),
    ).toBe(TERMS_CHANGE_BOX_LABEL);
    // The label wraps the box, so clicking the words ticks it.
    expect(box.closest('label')?.getAttribute('for')).toBe('terms-accept-box');
  });

  it('links the version the reader is asked to accept, in a new tab', async () => {
    const { el } = await setup();
    const link = el.querySelector<HTMLAnchorElement>('[data-testid="terms-accept-read"]')!;
    expect(link.getAttribute('href')).toBe('/legal/terms/v1.2');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.textContent).toContain('Read version 1.2 of the Terms of Service');
    expect(link.textContent).toContain('(opens in a new tab)');
  });

  it('Continue without the tick sends nothing, shows the error and focuses the box', async () => {
    const { fixture, el, api, navigate } = await setup();
    await submit(fixture, el);
    expect(api.acceptTerms).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    const box = el.querySelector<HTMLInputElement>('[data-testid="terms-accept-box"]')!;
    expect(box.getAttribute('aria-invalid')).toBe('true');
    expect(box.getAttribute('aria-describedby')).toBe('terms-accept-error');
    expect(el.querySelector('#terms-accept-error')?.getAttribute('role')).toBe('alert');
    expect(document.activeElement).toBe(box);
  });

  it('with the tick it posts the version, then goes to next', async () => {
    const { fixture, el, api, navigate } = await setup();
    tick(el);
    fixture.detectChanges();
    await submit(fixture, el);
    expect(api.acceptTerms).toHaveBeenCalledWith('1.2');
    expect(navigate).toHaveBeenCalledWith('/account');
  });

  it('a 422 (nothing waits any more) goes to next too', async () => {
    const { fixture, el, navigate } = await setup(undefined, async () => {
      throw new HttpErrorResponse({ status: 422 });
    });
    tick(el);
    fixture.detectChanges();
    await submit(fixture, el);
    expect(navigate).toHaveBeenCalledWith('/account');
  });

  it('a 401 goes back to sign-in, returning to the original destination', async () => {
    const { fixture, el, navigate, hard } = await setup(undefined, async () => {
      throw new HttpErrorResponse({ status: 401 });
    });
    tick(el);
    fixture.detectChanges();
    await submit(fixture, el);
    expect(navigate).not.toHaveBeenCalled();
    // The original destination, not this page: the next sign-in re-checks the box.
    expect(hard).toHaveBeenCalledWith('/auth/login?return=%2Faccount');
  });

  it('a 401 keeps a seat invitation destination', async () => {
    const { fixture, el, hard } = await setup(
      { version: '1.2', next: '/vendor/invite/tok-1' },
      async () => {
        throw new HttpErrorResponse({ status: 401 });
      },
    );
    tick(el);
    fixture.detectChanges();
    await submit(fixture, el);
    expect(hard).toHaveBeenCalledWith('/auth/login?return=%2Fvendor%2Finvite%2Ftok-1');
  });

  it('Continue is enabled once hydrated (it renders disabled until then)', async () => {
    const { el } = await setup();
    expect(
      el.querySelector<HTMLButtonElement>('[data-testid="terms-accept-continue"]')!.disabled,
    ).toBe(false);
  });

  it('another failure stays on the page with a message', async () => {
    const { fixture, el, navigate } = await setup(undefined, async () => {
      throw new HttpErrorResponse({ status: 500 });
    });
    tick(el);
    fixture.detectChanges();
    await submit(fixture, el);
    expect(navigate).not.toHaveBeenCalled();
    expect(el.textContent).toContain('Something went wrong. Please try again.');
  });

  it('with no valid version it shows no box and goes on to next', async () => {
    const { el, navigate } = await setup({ version: '<x>', next: '/account' });
    expect(el.querySelector('[data-testid="terms-accept-box"]')).toBeNull();
    expect(navigate).toHaveBeenCalledWith('/account');
  });
});

describe('TermsAcceptPage: what changes, and the way out', () => {
  it('shows the date, the published summary and links to both versions', async () => {
    const { el } = await setup();
    const changes = el.querySelector('[data-testid="terms-accept-changes"]')!;
    expect(changes.textContent).toContain('What changes on January 15, 2027');
    expect(changes.textContent).toContain('The disputes section moves to arbitration.');
    expect(changes.textContent).toContain('The liability limit is lower.');
    const prev = el.querySelector<HTMLAnchorElement>('[data-testid="terms-accept-read-previous"]')!;
    expect(prev.getAttribute('href')).toBe('/legal/terms/v1.1');
    expect(prev.textContent).toContain('Read version 1.1, the one that applies to you now');
  });

  it('no earlier acceptance: no second link', async () => {
    const { el } = await setup(undefined, undefined, async () => ({
      pending: { ...PENDING, previous_version: null },
    }));
    expect(el.querySelector('[data-testid="terms-accept-read-previous"]')).toBeNull();
  });

  it('nothing pending any more: goes straight to next', async () => {
    const { el, navigate } = await setup(undefined, undefined, async () => ({ pending: null }));
    expect(navigate).toHaveBeenCalledWith('/account');
    expect(el.querySelector('[data-testid="terms-accept-changes"]')).toBeNull();
  });

  it('a newer version from the server replaces the query version', async () => {
    const { fixture, el, api } = await setup(undefined, undefined, async () => ({
      pending: { ...PENDING, version: '1.3' },
    }));
    expect(el.querySelector('[data-testid="terms-accept-read"]')!.getAttribute('href')).toBe(
      '/legal/terms/v1.3',
    );
    tick(el);
    fixture.detectChanges();
    await submit(fixture, el);
    expect(api.acceptTerms).toHaveBeenCalledWith('1.3');
  });

  it('a failed read keeps the page usable without the summary', async () => {
    const { fixture, el, api, navigate } = await setup(undefined, undefined, async () => {
      throw new HttpErrorResponse({ status: 500 });
    });
    expect(el.querySelector('[data-testid="terms-accept-changes"]')).toBeNull();
    tick(el);
    fixture.detectChanges();
    await submit(fixture, el);
    expect(api.acceptTerms).toHaveBeenCalledWith('1.2');
    expect(navigate).toHaveBeenCalledWith('/account');
  });

  it('"Not now" goes to next and posts nothing', async () => {
    const { el, api, navigate } = await setup();
    el.querySelector<HTMLButtonElement>('[data-testid="terms-accept-not-now"]')!.click();
    await settle();
    expect(api.acceptTerms).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('/account');
    expect(el.textContent).toContain("we'll ask again the next time you sign in");
  });
});

describe('termsAcceptVersion / termsAcceptNextPath', () => {
  it('accepts dotted digits only', () => {
    expect(termsAcceptVersion('1.2')).toBe('1.2');
    expect(termsAcceptVersion(null)).toBeNull();
    expect(termsAcceptVersion('1.2"')).toBeNull();
  });

  it('narrows next to a same-origin path and never back to itself', () => {
    expect(termsAcceptNextPath('/products/acme')).toBe('/products/acme');
    expect(termsAcceptNextPath('//evil.com')).toBe('/');
    expect(termsAcceptNextPath('/auth/terms?version=1.2')).toBe('/');
    expect(termsAcceptNextPath(null)).toBe('/');
  });
});

/**
 * AECI-1720. Before hydration the page shows the version from `?version=` and no summary,
 * and the server's pending version can differ. So the box is disabled until the app is
 * live (`aecConsent`), no tick made before hydration is ever carried, and a tick given
 * while another version was shown is taken away when the server's version arrives.
 */
describe('TermsAcceptPage: ticks and the version shown (AECI-1720)', () => {
  const win = window as unknown as Record<string, unknown>;

  it('never carries a tick the recorder kept from before hydration', async () => {
    win[EARLY_INPUT_KEY] = {
      take: () => ({ value: 'on', checked: true }),
      stop() {},
    };
    try {
      const { fixture, el, api } = await setup();
      const box = el.querySelector<HTMLInputElement>('[data-testid="terms-accept-box"]')!;
      expect(box.checked).toBe(false);
      expect(box.hasAttribute('aecConsent')).toBe(true);
      expect(box.disabled).toBe(false);
      await submit(fixture, el);
      expect(api.acceptTerms).not.toHaveBeenCalled();
    } finally {
      delete win[EARLY_INPUT_KEY];
    }
  });

  function deferredPending(version: string) {
    let resolve!: () => void;
    const gate = new Promise<void>((r) => (resolve = r));
    return {
      release: () => resolve(),
      read: async () => {
        await gate;
        return { pending: { ...PENDING, version } };
      },
    };
  }

  it("unticks when the server's pending version differs from the one shown", async () => {
    const pending = deferredPending('1.3');
    const { fixture, el, api } = await setup(undefined, undefined, pending.read);
    tick(el);
    fixture.detectChanges();
    pending.release();
    await settle();
    await settle();
    fixture.detectChanges();

    const box = el.querySelector<HTMLInputElement>('[data-testid="terms-accept-box"]')!;
    expect(box.checked).toBe(false);
    await submit(fixture, el);
    expect(api.acceptTerms).not.toHaveBeenCalled();

    tick(el);
    fixture.detectChanges();
    await submit(fixture, el);
    expect(api.acceptTerms).toHaveBeenCalledWith('1.3');
  });

  it("keeps the tick when the server's version is the one shown", async () => {
    const pending = deferredPending('1.2');
    const { fixture, el, api } = await setup(undefined, undefined, pending.read);
    tick(el);
    fixture.detectChanges();
    pending.release();
    await settle();
    await settle();
    fixture.detectChanges();
    expect(el.querySelector<HTMLInputElement>('[data-testid="terms-accept-box"]')!.checked).toBe(
      true,
    );
    await submit(fixture, el);
    expect(api.acceptTerms).toHaveBeenCalledWith('1.2');
  });
});
