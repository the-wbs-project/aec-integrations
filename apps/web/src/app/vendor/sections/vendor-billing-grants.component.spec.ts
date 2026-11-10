import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AGREEMENT_CHECKBOX_LABELS,
  LEGAL_AGREEMENT_CURRENT_VERSIONS,
  type VendorAgreementAcceptance,
  type VendorBillingResponse,
  type VendorMeResponse,
  type VendorPendingGrant,
} from '@aeci/shared';

import { VendorApi } from '../vendor-api';
import {
  VENDOR_ACCEPTANCES_FIXTURE,
  VENDOR_BILLING_FIXTURE,
  VENDOR_ME_FIXTURE,
  VENDOR_PENDING_GRANT_FIXTURE,
} from '../vendor-fixtures';
import { VendorPortalStore } from '../vendor-portal-store';
import { VendorBillingSection } from './vendor-billing-section';

/**
 * AECI-1615: the "Subscriptions waiting for you" card on the owner's Billing tab. A
 * granted subscription starts only on an owner's affirmative accept (counsel Q5), so
 * the box starts unticked, the label is the checkout wording, Accept stays off until
 * the box and the title are given, and the agreement link is the version the grant
 * pins. A member sees no pending line: the billing read is owner-only.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

const WITH_GRANT: VendorBillingResponse = {
  ...VENDOR_BILLING_FIXTURE,
  pending_grants: [VENDOR_PENDING_GRANT_FIXTURE],
};
const AFTER_ACCEPT: VendorBillingResponse = { ...VENDOR_BILLING_FIXTURE, pending_grants: [] };

describe('VendorBillingSection: subscriptions waiting for you (AECI-1615)', () => {
  let getBilling: ReturnType<typeof vi.fn>;
  let acceptLicenseGrant: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    getBilling = vi.fn().mockResolvedValue(WITH_GRANT);
    acceptLicenseGrant = vi.fn();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideRouter([]),
        {
          provide: VendorApi,
          useValue: {
            getBilling,
            getAcceptances: vi.fn().mockResolvedValue({ acceptances: VENDOR_ACCEPTANCES_FIXTURE }),
            acceptLicenseGrant,
            getMe: vi.fn().mockResolvedValue(VENDOR_ME_FIXTURE),
          } as Partial<VendorApi>,
        },
        VendorPortalStore,
      ],
    });
  });

  afterEach(() => vi.restoreAllMocks());

  async function create(
    me: VendorMeResponse = VENDOR_ME_FIXTURE,
  ): Promise<ComponentFixture<VendorBillingSection>> {
    TestBed.inject(VendorPortalStore).seed(me);
    const fixture = TestBed.createComponent(VendorBillingSection);
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();
    return fixture;
  }

  async function settle(fixture: ComponentFixture<VendorBillingSection>): Promise<void> {
    fixture.detectChanges();
    await fixture.whenStable();
    await flush();
    await flush();
    fixture.detectChanges();
  }

  const q = <T extends Element>(el: HTMLElement, id: string) =>
    el.querySelector<T>(`[data-testid="${id}"]`);

  it('renders one entry per pending grant with its terms and the pinned version', async () => {
    const fixture = await create();
    const el = fixture.nativeElement as HTMLElement;

    const card = q(el, 'pending-grants')!;
    expect(card).not.toBeNull();
    expect(card.textContent).toContain('Subscriptions waiting for you');
    expect(el.querySelectorAll('[data-testid="pending-grant"]')).toHaveLength(1);
    expect(q(el, 'pending-grant-heading')?.textContent?.trim()).toBe('2 Managed subscriptions');
    expect(q(el, 'pending-grant-source')?.textContent).toContain('Complimentary, no charge');
    expect(q(el, 'pending-grant-ends')?.textContent?.trim()).not.toBe('');
    // The current version links the live page.
    expect(q(el, 'pending-grant-version-link')?.getAttribute('href')).toBe(
      '/legal/managed-plan-agreement',
    );
    expect(q(el, 'pending-grant-superseded')).toBeNull();

    // The box is unticked and its label is the checkout wording, exactly: the shared
    // constant whose hash the acceptance row stamps (ruling 16).
    const box = q<HTMLInputElement>(el, 'pending-grant-accept-box')!;
    expect(box.checked).toBe(false);
    const label = el.querySelector(`label[for="${box.id}"]`)!;
    const visible = label.cloneNode(true) as HTMLElement;
    visible.querySelectorAll('.sr-only').forEach((n) => n.remove());
    expect(visible.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      AGREEMENT_CHECKBOX_LABELS.managed_plan.text,
    );
    expect(label.querySelector('a')?.textContent).toContain('Managed plan agreement');
    expect(label.querySelector('a')?.getAttribute('href')).toBe('/legal/managed-plan-agreement');

    // The title is pre-filled from this seat's own claim.
    expect(q<HTMLInputElement>(el, 'pending-grant-title')!.value).toBe('Head of Partnerships');
  });

  it('links the archive when the pinned version is no longer current, and lists ban-term products', async () => {
    const banTerm: VendorPendingGrant = {
      ...VENDOR_PENDING_GRANT_FIXTURE,
      id: 'grant-ban',
      kind: 'ban_term',
      quantity: 1,
      terms_version: '1.0',
      terms_version_current: false,
      items: [
        {
          product: { id: 'p1', slug: 'summit-bim', name: 'Summit BIM' },
          product_id: 'p1',
          ends_at: '2027-03-31T00:00:00.000Z',
        },
      ],
    };
    getBilling.mockResolvedValue({ ...VENDOR_BILLING_FIXTURE, pending_grants: [banTerm] });
    const fixture = await create();
    const el = fixture.nativeElement as HTMLElement;

    expect(q(el, 'pending-grant-version-link')?.getAttribute('href')).toBe(
      '/legal/managed-plan-agreement/v1.0',
    );
    expect(q(el, 'pending-grant-superseded')).not.toBeNull();
    expect(q(el, 'pending-grant-products')?.textContent).toContain('Summit BIM');
  });

  it('keeps Accept disabled until the box is ticked and a title is given', async () => {
    getBilling.mockResolvedValue({ ...WITH_GRANT, checkout_signer_title: null });
    const fixture = await create();
    const el = fixture.nativeElement as HTMLElement;
    const accept = q<HTMLButtonElement>(el, 'pending-grant-accept')!;
    const box = q<HTMLInputElement>(el, 'pending-grant-accept-box')!;
    const title = q<HTMLInputElement>(el, 'pending-grant-title')!;

    expect(title.value).toBe('');
    expect(accept.disabled).toBe(true);

    box.click();
    await settle(fixture);
    expect(box.checked).toBe(true);
    expect(accept.disabled).toBe(true);

    title.value = '   ';
    title.dispatchEvent(new Event('input'));
    await settle(fixture);
    expect(accept.disabled).toBe(true);

    title.value = 'Head of Sales';
    title.dispatchEvent(new Event('input'));
    await settle(fixture);
    expect(accept.disabled).toBe(false);

    // Unticking turns it off again, and the box's error shows once touched.
    box.click();
    box.dispatchEvent(new Event('blur'));
    await settle(fixture);
    expect(accept.disabled).toBe(true);
    expect(box.getAttribute('aria-invalid')).toBe('true');
    const errorId = box.getAttribute('aria-describedby')!;
    expect(document.getElementById(errorId)?.textContent).toContain(
      'Tick the box to accept the Managed plan agreement.',
    );
    expect(acceptLicenseGrant).not.toHaveBeenCalled();
  });

  it('accepts with the pinned version, refetches billing and shows the warnings', async () => {
    acceptLicenseGrant.mockResolvedValue({
      grant_id: VENDOR_PENDING_GRANT_FIXTURE.id,
      status: 'accepted',
      acceptance_id: 'acc-1',
      license_ids: ['l1', 'l2'],
      warnings: [],
    });
    const fixture = await create();
    const el = fixture.nativeElement as HTMLElement;
    getBilling.mockResolvedValue(AFTER_ACCEPT);
    expect(getBilling).toHaveBeenCalledTimes(1);

    q<HTMLInputElement>(el, 'pending-grant-accept-box')!.click();
    await settle(fixture);
    q<HTMLButtonElement>(el, 'pending-grant-accept')!.click();
    await settle(fixture);

    expect(acceptLicenseGrant).toHaveBeenCalledWith(VENDOR_PENDING_GRANT_FIXTURE.id, {
      accepted: true,
      version: LEGAL_AGREEMENT_CURRENT_VERSIONS.managed_plan,
      signer_title: 'Head of Partnerships',
    });
    expect(getBilling).toHaveBeenCalledTimes(2);
    // The grant is gone from the card, and the notice says where the subscriptions went.
    expect(q(el, 'pending-grants')).toBeNull();
    const notice = q(el, 'grant-notice')!;
    expect(notice.getAttribute('role')).toBe('status');
    expect(notice.textContent).toContain('Subscriptions accepted');
    expect(notice.textContent).toContain('The 2 new subscriptions are in the pool below.');
  });

  it('names a product that was already licensed (ruling R6)', async () => {
    const banTerm: VendorPendingGrant = {
      ...VENDOR_PENDING_GRANT_FIXTURE,
      kind: 'ban_term',
      quantity: 1,
      items: [
        {
          product: { id: 'p1', slug: 'summit-bim', name: 'Summit BIM' },
          product_id: 'p1',
          ends_at: '2027-03-31T00:00:00.000Z',
        },
      ],
    };
    getBilling.mockResolvedValue({ ...VENDOR_BILLING_FIXTURE, pending_grants: [banTerm] });
    acceptLicenseGrant.mockResolvedValue({
      grant_id: banTerm.id,
      status: 'accepted',
      acceptance_id: 'acc-1',
      license_ids: ['l1'],
      warnings: [{ code: 'product_already_licensed', product_id: 'p1', message: 'x' }],
    });
    const fixture = await create();
    const el = fixture.nativeElement as HTMLElement;
    getBilling.mockResolvedValue(AFTER_ACCEPT);

    q<HTMLInputElement>(el, 'pending-grant-accept-box')!.click();
    await settle(fixture);
    q<HTMLButtonElement>(el, 'pending-grant-accept')!.click();
    await settle(fixture);

    expect(q(el, 'grant-notice')?.textContent).toContain(
      'Summit BIM already had a subscription, so its new one is in the pool.',
    );
  });

  it('names a ban-term product that left the account in the done notice', async () => {
    const banTerm: VendorPendingGrant = {
      ...VENDOR_PENDING_GRANT_FIXTURE,
      kind: 'ban_term',
      quantity: 1,
      items: [
        {
          product: { id: 'p1', slug: 'summit-bim', name: 'Summit BIM' },
          product_id: 'p1',
          ends_at: '2027-03-31T00:00:00.000Z',
        },
      ],
    };
    getBilling.mockResolvedValue({ ...VENDOR_BILLING_FIXTURE, pending_grants: [banTerm] });
    acceptLicenseGrant.mockResolvedValue({
      grant_id: banTerm.id,
      status: 'accepted',
      acceptance_id: 'acc-1',
      license_ids: ['l1'],
      warnings: [{ code: 'product_not_owned', product_id: 'p1', message: 'x' }],
    });
    const fixture = await create();
    const el = fixture.nativeElement as HTMLElement;
    getBilling.mockResolvedValue(AFTER_ACCEPT);

    q<HTMLInputElement>(el, 'pending-grant-accept-box')!.click();
    await settle(fixture);
    q<HTMLButtonElement>(el, 'pending-grant-accept')!.click();
    await settle(fixture);

    expect(q(el, 'grant-notice')?.textContent).toContain(
      'Summit BIM is no longer on your account, so its new subscription is in the pool.',
    );
  });

  it('shows a reload message and refetches on a 409 version change', async () => {
    acceptLicenseGrant.mockRejectedValue(
      new HttpErrorResponse({
        status: 409,
        error: { error: { code: 'LICENSE_GRANT_VERSION_CHANGED', message: 'x' } },
      }),
    );
    const fixture = await create();
    const el = fixture.nativeElement as HTMLElement;

    q<HTMLInputElement>(el, 'pending-grant-accept-box')!.click();
    await settle(fixture);
    q<HTMLButtonElement>(el, 'pending-grant-accept')!.click();
    await settle(fixture);

    expect(getBilling).toHaveBeenCalledTimes(2);
    const notice = q(el, 'grant-notice')!;
    expect(notice.getAttribute('role')).toBe('alert');
    expect(notice.textContent).toContain('We reloaded the page.');
    expect(document.activeElement).toBe(notice);
  });

  it('shows a reload message on a 422 when the grant is no longer pending', async () => {
    acceptLicenseGrant.mockRejectedValue(
      new HttpErrorResponse({
        status: 422,
        error: {
          error: {
            code: 'LICENSE_GRANT_NOT_PENDING',
            message: 'x',
            details: { state: 'withdrawn' },
          },
        },
      }),
    );
    const fixture = await create();
    const el = fixture.nativeElement as HTMLElement;
    getBilling.mockResolvedValue(AFTER_ACCEPT);

    q<HTMLInputElement>(el, 'pending-grant-accept-box')!.click();
    await settle(fixture);
    q<HTMLButtonElement>(el, 'pending-grant-accept')!.click();
    await settle(fixture);

    expect(q(el, 'pending-grants')).toBeNull();
    expect(q(el, 'grant-notice')?.textContent).toContain(
      'This grant is no longer waiting for you.',
    );
  });

  it('shows a member no pending line and makes no billing read', async () => {
    const fixture = await create({ ...VENDOR_ME_FIXTURE, seat_owner: false });
    const el = fixture.nativeElement as HTMLElement;
    expect(getBilling).not.toHaveBeenCalled();
    expect(q(el, 'pending-grants')).toBeNull();
    expect(q(el, 'billing-owners-only')).not.toBeNull();
  });

  it('labels a grant acceptance with its source and method', async () => {
    const grantAcceptance: VendorAgreementAcceptance = {
      ...VENDOR_ACCEPTANCES_FIXTURE[0]!,
      id: 'acc-grant',
      document: 'managed_plan',
      version: LEGAL_AGREEMENT_CURRENT_VERSIONS.managed_plan,
      source: 'grant',
      method: 'portal_checkbox',
      license_grant_id: 'grant-1',
      seat_role: 'owner',
    };
    TestBed.overrideProvider(VendorApi, {
      useValue: {
        getBilling,
        getAcceptances: vi.fn().mockResolvedValue({ acceptances: [grantAcceptance] }),
        acceptLicenseGrant,
        getMe: vi.fn().mockResolvedValue(VENDOR_ME_FIXTURE),
      } as Partial<VendorApi>,
    });
    const fixture = await create();
    const el = fixture.nativeElement as HTMLElement;
    expect(q(el, 'acceptance-grant')?.textContent?.trim()).toBe('Grant, accepted in the portal');
  });
});
