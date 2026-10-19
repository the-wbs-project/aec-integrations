import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AcceptVendorProposalResponse, VendorMeResponse } from '@aeci/shared';

import { expectVendorDocsLink } from '../components/vendor-docs-link.testing';
import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorApi } from '../vendor-api';
import { VENDOR_ME_FIXTURE } from '../vendor-fixtures';
import { VendorPortalStore } from '../vendor-portal-store';
import { VENDOR_PROPOSALS_FIXTURE } from '../vendor-proposal-fixtures';
import { VendorProposalsSection } from './vendor-proposals-section';

/**
 * The owner-only "Proposed products" tab (AECI-1417, E6b.5). An owner sees each open
 * proposal with what an accept would create, the values it would drop marked, and
 * Accept / Decline behind an inline confirmation. A member sees a note and the section
 * never calls the owner-only read. After an accept, the dropped values and a link to
 * the new product stay on screen. A stale refusal re-reads the list.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

const [READY, BLOCKED] = VENDOR_PROPOSALS_FIXTURE;

const ACCEPTED: AcceptVendorProposalResponse = {
  proposal_id: READY!.id,
  product: { id: 'p-new', slug: 'summit-clash-review', name: 'Summit Clash Review' },
  dropped: [{ facet: 'category', value: 'Drone Ops' }],
};

describe('VendorProposalsSection', () => {
  let listProposals: ReturnType<typeof vi.fn>;
  let acceptProposal: ReturnType<typeof vi.fn>;
  let declineProposal: ReturnType<typeof vi.fn>;
  let getMe: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    listProposals = vi
      .fn()
      .mockResolvedValue({ proposals: VENDOR_PROPOSALS_FIXTURE, truncated: false });
    acceptProposal = vi.fn().mockResolvedValue(ACCEPTED);
    declineProposal = vi.fn().mockResolvedValue(undefined);
    getMe = vi.fn().mockResolvedValue(VENDOR_ME_FIXTURE);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideRouter([]),
        {
          provide: VendorApi,
          useValue: { listProposals, acceptProposal, declineProposal, getMe } as Partial<VendorApi>,
        },
        VendorPortalStore,
      ],
    });
  });

  afterEach(() => vi.restoreAllMocks());

  async function create(
    me: VendorMeResponse = VENDOR_ME_FIXTURE,
  ): Promise<ComponentFixture<VendorProposalsSection>> {
    TestBed.inject(VendorPortalStore).seed(me);
    const fixture = TestBed.createComponent(VendorProposalsSection);
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();
    return fixture;
  }

  async function settle(fixture: ComponentFixture<VendorProposalsSection>): Promise<void> {
    fixture.detectChanges();
    await fixture.whenStable();
    await flush();
    fixture.detectChanges();
  }

  const el = (f: ComponentFixture<VendorProposalsSection>) => f.nativeElement as HTMLElement;
  const cards = (f: ComponentFixture<VendorProposalsSection>) =>
    el(f).querySelectorAll('[data-testid="proposal-card"]');
  const click = (root: Element, testId: string) =>
    (root.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement).click();

  it('shows a member a note and never calls the owner-only read', async () => {
    const fixture = await create({ ...VENDOR_ME_FIXTURE, seat_owner: false });
    expect(el(fixture).querySelector('[data-testid="proposals-owners-only"]')).not.toBeNull();
    expect(listProposals).not.toHaveBeenCalled();
    expect(cards(fixture)).toHaveLength(0);
  });

  it('shows an owner the empty state when nothing is waiting', async () => {
    listProposals.mockResolvedValue({ proposals: [], truncated: false });
    const fixture = await create();
    expect(listProposals).toHaveBeenCalledTimes(1);
    expect(el(fixture).querySelector('[data-testid="proposals-empty"]')).not.toBeNull();
    expectVendorDocsLink(el(fixture), 'editing-profile-and-products');
  });

  it('lists each proposal with its companies, its terms and the values it would drop', async () => {
    const fixture = await create();
    const [first, second] = Array.from(cards(fixture));
    expect(cards(fixture)).toHaveLength(2);

    expect(first!.textContent).toContain('Summit Clash Review');
    expect(first!.textContent).toContain('Runs clash detection on federated models');
    expect(first!.querySelector('[data-testid="proposal-vendors"]')!.textContent).toContain(
      'Northwind Estimating',
    );
    expect(first!.querySelectorAll('[data-testid="proposal-term"]')).toHaveLength(3);
    expect(first!.querySelectorAll('[data-testid="proposal-term-dropped"]')).toHaveLength(0);

    const dropped = second!.querySelectorAll('[data-testid="proposal-term-dropped"]');
    expect(Array.from(dropped).map((d) => d.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      'Drone Ops Not added',
      'Surveying Not added',
    ]);
    expect(second!.querySelector('[data-testid="proposal-dropped-note"]')).not.toBeNull();
    // A linked company is gone, so Accept is unavailable and the card says why.
    expect(second!.querySelector('[data-testid="proposal-vendor-missing"]')).not.toBeNull();
    expect(
      (second!.querySelector('[data-testid="proposal-accept"]') as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('accepts after the confirmation, then shows the dropped values and a link to the product', async () => {
    const announce = vi.spyOn(TestBed.inject(VendorPortalAnnouncer), 'announce');
    const fixture = await create();
    const card = cards(fixture)[0]!;

    click(card, 'proposal-accept');
    await settle(fixture);
    expect(acceptProposal).not.toHaveBeenCalled();
    const submit = card.querySelector('[data-testid="proposal-confirm-submit"]');
    expect(document.activeElement).toBe(submit);

    click(card, 'proposal-confirm-submit');
    await settle(fixture);

    expect(acceptProposal).toHaveBeenCalledWith(READY!.id);
    expect(cards(fixture)).toHaveLength(1);
    const outcome = el(fixture).querySelector('[data-testid="proposals-outcome"]')!;
    expect(outcome.textContent).toContain('Summit Clash Review was added to your listing.');
    expect(
      outcome.querySelector('[data-testid="proposals-outcome-dropped"]')!.textContent,
    ).toContain('Category: Drone Ops');
    expect(
      outcome.querySelector('[data-testid="proposals-outcome-link"]')!.getAttribute('href'),
    ).toContain('products/summit-clash-review');
    expect(document.activeElement).toBe(outcome);
    expect(announce).toHaveBeenCalledWith('Summit Clash Review was added to your listing.');
    // `/me` is revalidated so the new product joins the Products tab.
    expect(getMe).toHaveBeenCalled();
  });

  it('cancels the confirmation without a request and returns focus to its button', async () => {
    const fixture = await create();
    const card = cards(fixture)[0]!;
    click(card, 'proposal-decline');
    await settle(fixture);
    click(card, 'proposal-confirm-cancel');
    await settle(fixture);
    expect(declineProposal).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(card.querySelector('[data-testid="proposal-decline"]'));
  });

  it('declines after the confirmation and removes the card', async () => {
    const announce = vi.spyOn(TestBed.inject(VendorPortalAnnouncer), 'announce');
    const fixture = await create();
    const card = cards(fixture)[0]!;
    click(card, 'proposal-decline');
    await settle(fixture);
    click(card, 'proposal-confirm-submit');
    await settle(fixture);

    expect(declineProposal).toHaveBeenCalledWith(READY!.id);
    expect(acceptProposal).not.toHaveBeenCalled();
    expect(cards(fixture)).toHaveLength(1);
    expect(el(fixture).querySelector('[data-testid="proposals-outcome"]')).toBeNull();
    expect(announce).toHaveBeenCalledWith('Summit Clash Review was declined and not added.');
  });

  it('re-reads the list and shows why when another owner decided first', async () => {
    acceptProposal.mockRejectedValue(
      new HttpErrorResponse({
        status: 409,
        error: { error: { code: 'PROPOSAL_ALREADY_DECIDED', message: 'decided' } },
      }),
    );
    const fixture = await create();
    listProposals.mockResolvedValue({ proposals: [BLOCKED], truncated: false });
    const card = cards(fixture)[0]!;
    click(card, 'proposal-accept');
    await settle(fixture);
    click(card, 'proposal-confirm-submit');
    await settle(fixture);

    expect(listProposals).toHaveBeenCalledTimes(2);
    const stale = el(fixture).querySelector('[data-testid="proposals-stale"]')!;
    expect(stale.textContent).toContain('Another owner already decided this proposal.');
    expect(document.activeElement).toBe(stale);
    expect(cards(fixture)).toHaveLength(1);
  });

  it('keeps any other failure on the card', async () => {
    acceptProposal.mockRejectedValue(new HttpErrorResponse({ status: 500 }));
    const fixture = await create();
    const card = cards(fixture)[0]!;
    click(card, 'proposal-accept');
    await settle(fixture);
    click(card, 'proposal-confirm-submit');
    await settle(fixture);

    expect(card.querySelector('[data-testid="proposal-error"]')!.textContent).toContain(
      'Could not accept the proposal.',
    );
    expect(listProposals).toHaveBeenCalledTimes(1);
    expect(cards(fixture)).toHaveLength(2);
  });

  it('shows a retry line when the read fails', async () => {
    listProposals.mockRejectedValueOnce(new HttpErrorResponse({ status: 500 }));
    const fixture = await create();
    expect(el(fixture).textContent).toContain('Could not load proposed products.');
    (el(fixture).querySelector('button') as HTMLButtonElement).click();
    await settle(fixture);
    expect(cards(fixture)).toHaveLength(2);
  });
});
