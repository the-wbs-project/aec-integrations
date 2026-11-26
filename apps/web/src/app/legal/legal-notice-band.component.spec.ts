/**
 * Tests for `LegalNoticeBand` (AECI-1592). The load-bearing guarantees: the server
 * renders the band from the date alone, so the cached HTML is the same for every
 * visitor, and the browser takes the server's answer and never reads its own clock.
 */
import { PLATFORM_ID, TransferState, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  LEGAL_NOTICES_DATA,
  LEGAL_NOTICE_ACTIVE_IDS,
  LEGAL_NOTICE_DISMISSED_KEY,
  LEGAL_NOTICE_NOW,
  LegalNoticeBand,
} from './legal-notice-band';
import type { LegalInForceNotice, LegalNotice } from './legal-notices';

const PRIVACY: LegalNotice = {
  slug: 'privacy',
  title: 'Privacy Policy',
  version: '1.2',
  effectiveDate: '2027-03-31',
  effectiveDateLabel: 'March 31, 2027',
  summary: 'We change how long we keep visit records.',
};
const TERMS: LegalNotice = {
  ...PRIVACY,
  slug: 'terms',
  title: 'Terms of Service',
  version: '1.3',
  summary: 'We change the disputes section.',
};
/** AECI-1870: the first in-force versions took effect on January 15, 2027. */
const IN_FORCE: LegalInForceNotice = {
  kind: 'in-force',
  effectiveDate: '2027-01-15',
  effectiveDateLabel: 'January 15, 2027',
  documents: [{ slug: 'terms', version: '1.2' }],
};
const INSIDE = Date.UTC(2027, 2, 10);
const OUTSIDE = Date.UTC(2027, 1, 1);

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

function configure(platform: 'server' | 'browser', now: number, notices: readonly LegalNotice[]) {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: PLATFORM_ID, useValue: platform },
      { provide: LEGAL_NOTICES_DATA, useValue: notices },
      { provide: LEGAL_NOTICE_NOW, useValue: () => now },
    ],
  });
}

async function render() {
  const fixture = TestBed.createComponent(LegalNoticeBand);
  fixture.detectChanges();
  await fixture.whenStable();
  await settle();
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement };
}

/** A browser render with the ids the server passed over. */
async function renderInBrowser(activeIds: string[] | null, notices = [PRIVACY, TERMS]) {
  // The browser's own clock says outside, to prove it is not read.
  configure('browser', OUTSIDE, notices);
  if (activeIds) TestBed.inject(TransferState).set(LEGAL_NOTICE_ACTIVE_IDS, activeIds);
  return render();
}

function dismissButtons(el: HTMLElement): HTMLButtonElement[] {
  return Array.from(el.querySelectorAll<HTMLButtonElement>('[data-testid="legal-notice-dismiss"]'));
}

function stored(): string | null {
  return localStorage.getItem(LEGAL_NOTICE_DISMISSED_KEY);
}

describe('LegalNoticeBand', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    localStorage.clear();
  });
  afterEach(() => vi.restoreAllMocks());

  describe('on the server', () => {
    it('renders the notice inside the window, with what changes and the link', async () => {
      configure('server', INSIDE, [PRIVACY]);
      const { el } = await render();
      const region = el.querySelector('[role="region"]');
      expect(region?.getAttribute('aria-label')).toBe('Notice of changes to the Privacy Policy');
      expect(region?.textContent).toContain(
        'Changes to the Privacy Policy take effect on March 31, 2027.',
      );
      expect(region?.textContent).toContain(PRIVACY.summary);
      expect(el.querySelector('a')?.getAttribute('href')).toBe('/legal/privacy/v1.2');
    });

    it('renders nothing outside the window and writes no state', async () => {
      configure('server', OUTSIDE, [PRIVACY]);
      const { el } = await render();
      expect(el.querySelector('[role="region"]')).toBeNull();
      expect(TestBed.inject(TransferState).hasKey(LEGAL_NOTICE_ACTIVE_IDS)).toBe(false);
    });

    it('passes the active ids to the browser', async () => {
      configure('server', INSIDE, [PRIVACY]);
      await render();
      expect(TestBed.inject(TransferState).get(LEGAL_NOTICE_ACTIVE_IDS, [])).toEqual([
        'privacy@1.2',
      ]);
    });

    it('ignores a stored dismissal, so the HTML is the same for every visitor', async () => {
      configure('server', INSIDE, [PRIVACY]);
      const clean = (await render()).el.innerHTML;

      TestBed.resetTestingModule();
      localStorage.setItem(LEGAL_NOTICE_DISMISSED_KEY, JSON.stringify(['privacy@1.2']));
      configure('server', INSIDE, [PRIVACY]);
      const dismissed = (await render()).el.innerHTML;

      expect(dismissed).toBe(clean);
    });
  });

  describe('in the browser', () => {
    it('takes the server ids and ignores its own clock', async () => {
      const { el } = await renderInBrowser(['privacy@1.2']);
      expect(el.querySelectorAll('[role="region"]')).toHaveLength(1);
      expect(el.textContent).toContain('Privacy Policy');
    });

    it('renders nothing when the server passed no ids', async () => {
      const { el } = await renderInBrowser(null);
      expect(el.querySelector('[role="region"]')).toBeNull();
    });

    it('gives each notice its own region and dismiss label', async () => {
      const { el } = await renderInBrowser(['privacy@1.2', 'terms@1.3']);
      expect(
        Array.from(el.querySelectorAll('[role="region"]')).map((r) => r.getAttribute('aria-label')),
      ).toEqual([
        'Notice of changes to the Privacy Policy',
        'Notice of changes to the Terms of Service',
      ]);
      expect(dismissButtons(el).map((b) => b.getAttribute('aria-label'))).toEqual([
        'Dismiss the notice about the Privacy Policy',
        'Dismiss the notice about the Terms of Service',
      ]);
    });

    it('dismiss hides that notice only, and stores its id', async () => {
      const { fixture, el } = await renderInBrowser(['privacy@1.2', 'terms@1.3']);
      dismissButtons(el)[0]!.click();
      fixture.detectChanges();
      expect(el.querySelectorAll('[role="region"]')).toHaveLength(1);
      expect(el.textContent).toContain('Terms of Service');
      expect(JSON.parse(stored()!)).toEqual(['privacy@1.2']);
    });

    it('a stored dismissal hides the notice on the next load', async () => {
      localStorage.setItem(LEGAL_NOTICE_DISMISSED_KEY, JSON.stringify(['privacy@1.2']));
      const { el } = await renderInBrowser(['privacy@1.2']);
      expect(el.querySelector('[role="region"]')).toBeNull();
    });

    it('a dismissal does not hide the next version of the same document', async () => {
      localStorage.setItem(LEGAL_NOTICE_DISMISSED_KEY, JSON.stringify(['privacy@1.1']));
      const { el } = await renderInBrowser(['privacy@1.2']);
      expect(el.querySelectorAll('[role="region"]')).toHaveLength(1);
    });

    it('moves focus to the main region on dismiss with no ring, and cleans up after', async () => {
      const main = document.createElement('main');
      main.id = 'main';
      document.body.appendChild(main);
      try {
        const { fixture, el } = await renderInBrowser(['privacy@1.2']);
        dismissButtons(el)[0]!.click();
        fixture.detectChanges();
        expect(document.activeElement).toBe(main);
        expect(main.style.outline).toBe('none');
        main.blur();
        expect(main.hasAttribute('tabindex')).toBe(false);
        expect(main.style.outline).toBe('');
      } finally {
        main.remove();
      }
    });

    it('removes the id of an ended notice and keeps a live one', async () => {
      localStorage.setItem(
        LEGAL_NOTICE_DISMISSED_KEY,
        JSON.stringify(['privacy@1.1', 'terms@1.3']),
      );
      await renderInBrowser(['terms@1.3', 'privacy@1.2']);
      expect(JSON.parse(stored()!)).toEqual(['terms@1.3']);
    });

    it('removes the key when no notice is active, which the Privacy Policy promises', async () => {
      localStorage.setItem(LEGAL_NOTICE_DISMISSED_KEY, JSON.stringify(['privacy@1.2']));
      await renderInBrowser(null, []);
      expect(stored()).toBeNull();
    });

    it('treats a malformed stored value as no dismissal', async () => {
      localStorage.setItem(LEGAL_NOTICE_DISMISSED_KEY, '{not json');
      const { el } = await renderInBrowser(['privacy@1.2']);
      expect(el.querySelectorAll('[role="region"]')).toHaveLength(1);
    });

    it('still dismisses for this page when storage throws', async () => {
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('blocked');
      });
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('blocked');
      });
      const { fixture, el } = await renderInBrowser(['privacy@1.2']);
      dismissButtons(el)[0]!.click();
      fixture.detectChanges();
      expect(el.querySelector('[role="region"]')).toBeNull();
    });
  });

  // AECI-1870 (ruling 68): the notice that the documents are now in force.
  describe('the in-force notice', () => {
    it('renders the lead and the Read them link to /legal from the effective day', async () => {
      configure('server', Date.UTC(2027, 0, 15), [IN_FORCE]);
      const { el } = await render();
      const region = el.querySelector('[role="region"]');
      expect(region?.getAttribute('aria-label')).toBe(
        'Notice that our legal documents are now in force',
      );
      expect(region?.textContent).toContain(
        'Our legal documents are now in force from January 15, 2027.',
      );
      const link = el.querySelector('a');
      expect(link?.textContent?.trim()).toBe('Read them');
      expect(link?.getAttribute('href')).toBe('/legal');
      expect(region?.textContent).not.toMatch(/—/);
    });

    it('renders nothing the day before and on day 15', async () => {
      configure('server', Date.UTC(2027, 0, 14, 23, 59), [IN_FORCE]);
      expect((await render()).el.querySelector('[role="region"]')).toBeNull();
      TestBed.resetTestingModule();
      configure('server', Date.UTC(2027, 0, 29), [IN_FORCE]);
      expect((await render()).el.querySelector('[role="region"]')).toBeNull();
    });

    it('is dismissible like a change notice, and stores its own id', async () => {
      const { fixture, el } = await renderInBrowser(
        ['in-force@2027-01-15', 'privacy@1.2'],
        [IN_FORCE, PRIVACY],
      );
      expect(dismissButtons(el).map((b) => b.getAttribute('aria-label'))).toEqual([
        'Dismiss the notice that our legal documents are now in force',
        'Dismiss the notice about the Privacy Policy',
      ]);
      dismissButtons(el)[0]!.click();
      fixture.detectChanges();
      expect(el.querySelectorAll('[role="region"]')).toHaveLength(1);
      expect(JSON.parse(stored()!)).toEqual(['in-force@2027-01-15']);
    });

    it('removes its stored dismissal once its window has ended', async () => {
      localStorage.setItem(LEGAL_NOTICE_DISMISSED_KEY, JSON.stringify(['in-force@2027-01-15']));
      await renderInBrowser(null, [IN_FORCE]);
      expect(stored()).toBeNull();
    });
  });
});
