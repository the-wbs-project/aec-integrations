import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
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

  beforeEach(() => {
    sessionStorage.clear();
    acceptLegalVersion = vi.fn();
    getLegalAcceptance = vi.fn();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideRouter([]),
        {
          provide: VendorApi,
          useValue: { acceptLegalVersion, getLegalAcceptance } as Partial<VendorApi>,
        },
        VendorPortalStore,
        VendorLegalAcceptanceState,
      ],
    });
  });
  afterEach(() => vi.restoreAllMocks());

  async function shell(
    state: VendorLegalAcceptanceResponse | null,
  ): Promise<ComponentFixture<VendorDashboardTabbed>> {
    TestBed.inject(VendorPortalStore).seed(VENDOR_ME_FIXTURE);
    TestBed.inject(VendorLegalAcceptanceState).seed(state);
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
        'Until then, the earlier version applies to you.',
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

    it('names the Managed plan version, and says nothing about ending a subscription', async () => {
      const f = await shell(LEGAL_OPTIONAL_MANAGED_FIXTURE);
      expect(text(q(f, 'legal-accept-heading'))).toBe(
        'Managed plan agreement, version 1.1, is ready for you to accept',
      );
      expect(text(q(f, 'legal-accept-label'))).toBe(
        portalAcceptanceLabel('managed_plan', '1.1', COMPANY),
      );
      const all = text(q(f, 'legal-accept')).toLowerCase();
      for (const word of ['cancel', 'end', 'pause', 'charge again']) {
        expect(all.includes(` ${word} `), word).toBe(false);
      }
    });

    it('never prompts a member seat', async () => {
      const f = await shell({ ...LEGAL_OPTIONAL_TERMS_FIXTURE, can_accept: false });
      expect(q(f, 'legal-accept')).toBeNull();
    });
  });
});
