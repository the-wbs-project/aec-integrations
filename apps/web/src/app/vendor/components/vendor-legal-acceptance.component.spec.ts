import {
  HttpClient,
  HttpErrorResponse,
  provideHttpClient,
  withInterceptors,
} from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ApiErrorCode,
  portalAcceptanceLabel,
  type AcceptLegalVersionResponse,
  type VendorLegalAcceptanceResponse,
} from '@aeci/shared';

import { VendorApi } from '../vendor-api';
import { VendorDashboardTabbed } from '../vendor-dashboard-tabbed';
import { VENDOR_ME_FIXTURE } from '../vendor-fixtures';
import { LEGAL_DISMISSED_KEY, VendorLegalAcceptanceState } from '../vendor-legal-acceptance-state';
import {
  LEGAL_NOTHING_PENDING_FIXTURE,
  LEGAL_OPTIONAL_MANAGED_FIXTURE,
  LEGAL_OPTIONAL_TERMS_FIXTURE,
  LEGAL_REQUIRED_MEMBER_FIXTURE,
  LEGAL_REQUIRED_OWNER_FIXTURE,
} from '../vendor-legal-fixtures';
import { vendorLegalRequiredInterceptor } from '../vendor-legal-required';
import { VendorPortalStore } from '../vendor-portal-store';

/**
 * AECI-1677: the acceptance screen in the portal shell (`STAGE_2_VENDOR_PORTAL_SPEC.md`
 * §6.24). The shell renders it in place of the tabs in required mode, above them in
 * optional mode, and nothing at all while nothing is pending.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

const COMPANY = VENDOR_ME_FIXTURE.vendor.company_name;

describe('the acceptance screen in the portal shell (AECI-1677)', () => {
  let acceptLegalVersion: ReturnType<typeof vi.fn>;
  let getLegalAcceptance: ReturnType<typeof vi.fn>;
  let openBillingPortal: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sessionStorage.clear();
    acceptLegalVersion = vi.fn();
    getLegalAcceptance = vi.fn();
    openBillingPortal = vi.fn();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(withInterceptors([vendorLegalRequiredInterceptor])),
        provideHttpClientTesting(),
        provideRouter([]),
        {
          provide: VendorApi,
          useValue: {
            acceptLegalVersion,
            getLegalAcceptance,
            openBillingPortal,
          } as Partial<VendorApi>,
        },
        VendorPortalStore,
        VendorLegalAcceptanceState,
      ],
    });
  });
  afterEach(() => vi.restoreAllMocks());

  async function shell(
    state: VendorLegalAcceptanceResponse | null,
    { clientReady = true } = {},
  ): Promise<ComponentFixture<VendorDashboardTabbed>> {
    TestBed.inject(VendorPortalStore).seed(VENDOR_ME_FIXTURE);
    TestBed.inject(VendorLegalAcceptanceState).seed(state);
    // What `VendorPage` does after the first render in the browser.
    if (clientReady) TestBed.inject(VendorLegalAcceptanceState).loadDismissed();
    const fixture = TestBed.createComponent(VendorDashboardTabbed);
    fixture.componentRef.setInput('me', VENDOR_ME_FIXTURE);
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();
    return fixture;
  }

  const q = (f: ComponentFixture<unknown>, id: string) =>
    (f.nativeElement as HTMLElement).querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const nav = (f: ComponentFixture<unknown>) =>
    (f.nativeElement as HTMLElement).querySelector('aec-vendor-portal-nav');
  const text = (el: Element | null) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

  it.each([
    ['nothing pending', LEGAL_NOTHING_PENDING_FIXTURE],
    ['a failed read (null fails open)', null],
  ])('shows no screen and the tabs with %s', async (_l, state) => {
    const f = await shell(state);
    expect(q(f, 'legal-accept')).toBeNull();
    expect(nav(f)).not.toBeNull();
  });

  describe('required mode', () => {
    it('replaces the tabs for an owner, with the box, the read link and the summary', async () => {
      const f = await shell(LEGAL_REQUIRED_OWNER_FIXTURE);
      expect(nav(f)).toBeNull();
      expect(f.nativeElement.querySelector('router-outlet')).toBeNull();
      expect(q(f, 'legal-accept')?.dataset['mode']).toBe('required');
      expect(text(q(f, 'legal-accept-heading'))).toBe('Accept the Vendor Terms, version 1.3');
      const read = q(f, 'legal-accept-read') as HTMLAnchorElement;
      expect(read.getAttribute('href')).toBe('/legal/vendor-terms/v1.3');
      expect(read.target).toBe('_blank');
      expect(q(f, 'legal-accept-summary')?.querySelectorAll('li')).toHaveLength(2);
      const box = q(f, 'legal-accept-box') as HTMLInputElement;
      expect(box.checked).toBe(false);
      // The label is the words the server records.
      expect(text(q(f, 'legal-accept-label'))).toBe(
        portalAcceptanceLabel('vendor_terms', '1.3', COMPANY),
      );
      expect(q(f, 'legal-accept-dismiss')).toBeNull();
      expect((q(f, 'legal-accept-submit') as HTMLButtonElement).disabled).toBe(true);
      expect((q(f, 'legal-accept-legal-name') as HTMLInputElement).value).toBe(
        'Northwind Software, Inc.',
      );
    });

    it('tells a member who the owners are, with no box', async () => {
      const f = await shell(LEGAL_REQUIRED_MEMBER_FIXTURE);
      expect(nav(f)).toBeNull();
      expect(text(q(f, 'legal-accept-heading'))).toBe('An owner needs to accept the Vendor Terms');
      expect(q(f, 'legal-accept-box')).toBeNull();
      expect(text(q(f, 'legal-accept-owners'))).toBe(
        'The owners at your company are Priya Raman, Sam Okafor.',
      );
      getLegalAcceptance.mockResolvedValue(LEGAL_REQUIRED_MEMBER_FIXTURE);
      q(f, 'legal-accept-check')?.click();
      await flush();
      f.detectChanges();
      expect(text(q(f, 'legal-accept-check-note'))).toContain('No owner has accepted yet');
    });

    it('records the accept, opens the portal, and moves the focus to the confirmation', async () => {
      const res: AcceptLegalVersionResponse = {
        document: 'vendor_terms',
        version: '1.3',
        accepted_at: '2026-12-16T15:04:00.000Z',
        state: LEGAL_NOTHING_PENDING_FIXTURE,
      };
      acceptLegalVersion.mockResolvedValue(res);
      const f = await shell(LEGAL_REQUIRED_OWNER_FIXTURE);
      (q(f, 'legal-accept-box') as HTMLInputElement).click();
      f.detectChanges();
      (q(f, 'legal-accept-submit') as HTMLButtonElement).click();
      await flush();
      f.detectChanges();
      await flush();
      f.detectChanges();
      expect(acceptLegalVersion).toHaveBeenCalledWith({
        document: 'vendor_terms',
        version: '1.3',
        accepted: true,
        signer_title: 'Head of Partnerships',
        company_legal_name: 'Northwind Software, Inc.',
      });
      expect(q(f, 'legal-accept')).toBeNull();
      expect(nav(f)).not.toBeNull();
      const heading = q(f, 'legal-accepted-heading');
      expect(text(heading)).toBe('You accepted the Vendor Terms, version 1.3');
      expect(document.activeElement).toBe(heading);
      expect(text(q(f, 'legal-accepted'))).toContain('The portal is now open for every seat.');
    });

    it('says what to do when the version is no longer pending, and re-reads', async () => {
      acceptLegalVersion.mockRejectedValue(
        new HttpErrorResponse({
          status: 422,
          error: { error: { code: ApiErrorCode.LEGAL_ACCEPTANCE_NOT_PENDING } },
        }),
      );
      getLegalAcceptance.mockResolvedValue(LEGAL_REQUIRED_OWNER_FIXTURE);
      const f = await shell(LEGAL_REQUIRED_OWNER_FIXTURE);
      (q(f, 'legal-accept-box') as HTMLInputElement).click();
      f.detectChanges();
      (q(f, 'legal-accept-submit') as HTMLButtonElement).click();
      await flush();
      f.detectChanges();
      expect(text(q(f, 'legal-accept-error'))).toContain('no longer waiting for your acceptance');
      expect(getLegalAcceptance).toHaveBeenCalled();
    });
  });

  describe('optional mode', () => {
    it('shows above the tabs with "Not now", which hides it for the session', async () => {
      const f = await shell(LEGAL_OPTIONAL_TERMS_FIXTURE);
      expect(nav(f)).not.toBeNull();
      expect(q(f, 'legal-accept')?.dataset['mode']).toBe('optional');
      expect(text(q(f, 'legal-accept'))).toContain(
        `This version changes the liability, indemnity, disputes or content license sections in a way that reduces your rights. That change applies to ${COMPANY} only after an owner seat accepts it. Until then the earlier version applies to you.`,
      );
      q(f, 'legal-accept-dismiss')?.click();
      f.detectChanges();
      expect(q(f, 'legal-accept')).toBeNull();
      expect(JSON.parse(sessionStorage.getItem(LEGAL_DISMISSED_KEY) ?? '[]')).toEqual([
        'vendor_terms@1.3',
      ]);
    });

    it('a dismissal in this session keeps the prompt hidden on the next load', async () => {
      sessionStorage.setItem(LEGAL_DISMISSED_KEY, JSON.stringify(['vendor_terms@1.3']));
      TestBed.inject(VendorLegalAcceptanceState).loadDismissed();
      const f = await shell(LEGAL_OPTIONAL_TERMS_FIXTURE);
      expect(q(f, 'legal-accept')).toBeNull();
    });

    it('renders exactly this text for the Managed plan click, nothing about a subscription ending', async () => {
      const f = await shell(LEGAL_OPTIONAL_MANAGED_FIXTURE);
      expect(text(q(f, 'legal-accept-label'))).toBe(
        portalAcceptanceLabel('managed_plan', '1.1', COMPANY),
      );
      // Block boundaries carry no whitespace in textContent, so compare with spaces removed.
      const squash = (v: string) => v.replace(/\s+/g, '');
      expect(squash(text(q(f, 'legal-accept')))).toBe(
        squash(
          [
            'Managed plan agreement, version 1.1, is ready for you to accept',
            'Version 1.1 of the Managed plan agreement takes effect on Jan 31, 2027. Because your company pays monthly, we ask an owner seat to accept it here.',
            'What changes',
            'Refunds for an annual subscription are pro rata for unused whole months.',
            'Read version 1.1 of the Managed plan agreement (opens in a new tab)',
            'Your name',
            'We have no name on file for your seat. We record it with your acceptance.',
            'Your title',
            'We record your title with your acceptance.',
            'Company legal name',
            'The registered name of the company you accept for.',
            `I have read and accept the Managed plan agreement, version 1.1, on behalf of ${COMPANY}.`,
            'Accept version 1.1',
            'Not now',
            'You can keep using the portal. We ask again on your next visit.',
            "We record your name and title, the company's legal name, the time and the version. Owner seats can see the record on the Billing tab.",
          ].join(' '),
        ),
      );
    });

    it('waits for the client: no optional prompt before the dismissals are read', async () => {
      const f = await shell(LEGAL_OPTIONAL_TERMS_FIXTURE, { clientReady: false });
      expect(q(f, 'legal-accept')).toBeNull();
      expect(nav(f)).not.toBeNull();
    });

    it('still renders the required screen before the client is ready (SSR)', async () => {
      const f = await shell(LEGAL_REQUIRED_OWNER_FIXTURE, { clientReady: false });
      expect(q(f, 'legal-accept')?.dataset['mode']).toBe('required');
    });

    it('never prompts a member seat', async () => {
      const f = await shell({ ...LEGAL_OPTIONAL_TERMS_FIXTURE, can_accept: false });
      expect(q(f, 'legal-accept')).toBeNull();
    });
  });

  describe('review fixes', () => {
    it('offers a blocked owner the Stripe portal, and leaves for it', async () => {
      openBillingPortal.mockResolvedValue({ url: 'https://billing.stripe.example/session' });
      const assign = vi.fn();
      vi.spyOn(globalThis, 'location', 'get').mockReturnValue({
        ...globalThis.location,
        assign,
      } as Location);
      const f = await shell(LEGAL_REQUIRED_OWNER_FIXTURE);
      expect(text(q(f, 'legal-accept'))).toContain('You can still manage or cancel your billing.');
      const button = q(f, 'legal-accept-billing') as HTMLButtonElement;
      expect(text(button)).toBe('Manage billing in Stripe');
      button.click();
      await flush();
      expect(openBillingPortal).toHaveBeenCalledTimes(1);
      expect(assign).toHaveBeenCalledWith('https://billing.stripe.example/session');
    });

    it('says what to do when Stripe will not open', async () => {
      openBillingPortal.mockRejectedValue(new HttpErrorResponse({ status: 503 }));
      const f = await shell(LEGAL_REQUIRED_OWNER_FIXTURE);
      q(f, 'legal-accept-billing')?.click();
      await flush();
      f.detectChanges();
      expect(text(q(f, 'legal-accept-billing-error'))).toBe(
        'We could not open Stripe just now. Try again in a moment.',
      );
    });

    it('offers no Stripe action without Stripe billing, or to a member', async () => {
      const noStripe = await shell({ ...LEGAL_REQUIRED_OWNER_FIXTURE, stripe_billing: false });
      expect(q(noStripe, 'legal-accept-billing')).toBeNull();
      const member = await shell(LEGAL_REQUIRED_MEMBER_FIXTURE);
      expect(q(member, 'legal-accept-billing')).toBeNull();
    });

    it('asks for the name when none is on file, and sends it', async () => {
      acceptLegalVersion.mockResolvedValue({
        document: 'managed_plan',
        version: '1.1',
        accepted_at: '2026-12-16T15:04:00.000Z',
        state: LEGAL_NOTHING_PENDING_FIXTURE,
      });
      const f = await shell(LEGAL_OPTIONAL_MANAGED_FIXTURE);
      const set = (id: string, value: string) => {
        const el = q(f, id) as HTMLInputElement;
        el.value = value;
        el.dispatchEvent(new Event('input'));
      };
      (q(f, 'legal-accept-box') as HTMLInputElement).click();
      set('legal-accept-title', 'CFO');
      set('legal-accept-legal-name', 'Summit BIM, LLC');
      f.detectChanges();
      // The name is required while it is asked for.
      expect((q(f, 'legal-accept-submit') as HTMLButtonElement).disabled).toBe(true);
      set('legal-accept-name', 'Ivy Invited');
      f.detectChanges();
      (q(f, 'legal-accept-submit') as HTMLButtonElement).click();
      await flush();
      expect(acceptLegalVersion).toHaveBeenCalledWith(
        expect.objectContaining({ signer_name: 'Ivy Invited', signer_title: 'CFO' }),
      );
    });

    it('does not ask for a name the server already has', async () => {
      const f = await shell(LEGAL_REQUIRED_OWNER_FIXTURE);
      expect(q(f, 'legal-accept-name')).toBeNull();
    });

    it('closing the confirmation moves the focus to the page heading', async () => {
      const f = await shell(LEGAL_NOTHING_PENDING_FIXTURE);
      TestBed.inject(VendorLegalAcceptanceState).accepted({
        document: 'vendor_terms',
        version: '1.3',
        accepted_at: '2026-12-16T15:04:00.000Z',
        state: LEGAL_NOTHING_PENDING_FIXTURE,
      });
      f.detectChanges();
      await flush();
      q(f, 'legal-accepted-close')?.click();
      f.detectChanges();
      const h1 = (f.nativeElement as HTMLElement).querySelector('h1');
      expect(h1?.getAttribute('tabindex')).toBe('-1');
      expect(document.activeElement).toBe(h1);
    });

    it('a write refused with LEGAL_ACCEPTANCE_REQUIRED re-reads the state and shows the screen', async () => {
      getLegalAcceptance.mockResolvedValue(LEGAL_REQUIRED_OWNER_FIXTURE);
      const f = await shell(LEGAL_NOTHING_PENDING_FIXTURE);
      expect(nav(f)).not.toBeNull();
      const http = TestBed.inject(HttpClient);
      const ctrl = TestBed.inject(HttpTestingController);
      http.patch('/api/vendor/profile', {}).subscribe({ error: () => undefined });
      ctrl.expectOne('/api/vendor/profile').flush(
        {
          error: {
            code: 'LEGAL_ACCEPTANCE_REQUIRED',
            details: { document: 'vendor_terms', version: '1.3' },
          },
        },
        { status: 403, statusText: 'Forbidden' },
      );
      await flush();
      f.detectChanges();
      await flush();
      f.detectChanges();
      expect(getLegalAcceptance).toHaveBeenCalledTimes(1);
      expect(q(f, 'legal-accept')?.dataset['mode']).toBe('required');
      expect(nav(f)).toBeNull();
    });

    it('ignores other 403s and calls outside the vendor API', async () => {
      const f = await shell(LEGAL_NOTHING_PENDING_FIXTURE);
      const http = TestBed.inject(HttpClient);
      const ctrl = TestBed.inject(HttpTestingController);
      http.patch('/api/vendor/profile', {}).subscribe({ error: () => undefined });
      ctrl
        .expectOne('/api/vendor/profile')
        .flush({ error: { code: 'FORBIDDEN' } }, { status: 403, statusText: 'Forbidden' });
      http.post('/api/reviews', {}).subscribe({ error: () => undefined });
      ctrl
        .expectOne('/api/reviews')
        .flush(
          { error: { code: 'LEGAL_ACCEPTANCE_REQUIRED' } },
          { status: 403, statusText: 'Forbidden' },
        );
      await flush();
      f.detectChanges();
      expect(getLegalAcceptance).not.toHaveBeenCalled();
    });
  });
});
