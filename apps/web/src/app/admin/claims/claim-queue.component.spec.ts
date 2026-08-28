/**
 * AECI-521 — `ClaimQueue` logic + structural a11y.
 *
 * The live axe pass runs in Playwright / static-serve on rendered routes (the
 * repo's component-level a11y convention — cf. `request-queue.component.spec.ts`).
 * Here we assert the reviewer-assist logic (load, status filter re-fetch, target
 * link + fallback, the verification signals — domain-match, has_auth_account,
 * existing seats, prior requests, the LinkedIn link — and the approve/reject
 * actions incl. the entitlement note, the 409 conflict / 503 unavailable / 422
 * race paths) and the structural invariants axe relies on (heading order, the
 * status group's accessible name, the polite live region).
 *
 * The entitlement set/renew/clear form is NOT tested here any more — AECI-652
 * moved it to `admin/entitlement/entitlement-control`, which has its own spec.
 * What stayed is the readout and the link out, plus the single-live-region
 * assertion that the extraction could have silently broken.
 *
 * Harness mirrors `request-queue.component.spec.ts`: browser platform + a macrotask
 * `settle()` drains `afterNextRender`'s async load.
 */
import { HttpErrorResponse } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AdminClaim,
  ListVendorClaimsResponse,
  ModerateClaimInput,
  ModerateClaimResponse,
  VendorEntitlementResponse,
} from '@aeci/shared';

import { AdminClaimsApi } from './admin-claims-api';
import { ClaimQueue } from './claim-queue';

function makeClaim(over: Partial<AdminClaim> & { id: string }): AdminClaim {
  return {
    id: over.id,
    kind: 'claim',
    status: over.status ?? 'open',
    target_type: over.target_type ?? 'product',
    target_id: over.target_id ?? `t-${over.id}`,
    target:
      'target' in over ? over.target! : { id: `t-${over.id}`, name: 'Procore', slug: 'procore' },
    submitter_email: over.submitter_email ?? 'submitter@vendor.test',
    submitter_name: over.submitter_name ?? 'Sam Submitter',
    submitter_role: over.submitter_role ?? 'Product Manager',
    domain_match: over.domain_match ?? 'pending',
    body: over.body ?? 'We build this product and would like to claim the listing.',
    source_url: over.source_url ?? null,
    is_duplicate: over.is_duplicate ?? false,
    has_auth_account: over.has_auth_account ?? null,
    linear_issue_id: over.linear_issue_id ?? null,
    linear_issue_url: over.linear_issue_url ?? null,
    created_at: over.created_at ?? '2026-06-01T00:00:00.000Z',
    resolved_at: over.resolved_at ?? null,
    resolved_by: over.resolved_by ?? null,
    duplicate_of_request_id: over.duplicate_of_request_id ?? null,
    existing_seats: 'existing_seats' in over ? over.existing_seats! : [],
    related_requests: 'related_requests' in over ? over.related_requests! : [],
    // AECI-532: the resolved target vendor + its entitlement, so the queue can render
    // the entitlement column and address the set/renew/clear control.
    entitlement_vendor:
      'entitlement_vendor' in over
        ? over.entitlement_vendor!
        : { id: VENDOR_ID, name: 'Autodesk, Inc.', slug: 'autodesk' },
    entitlement: 'entitlement' in over ? over.entitlement! : null,
  };
}

const VENDOR_ID = '00000000-0000-4000-8000-000000000002';

/** An `active` entitlement readout, i.e. the vendor currently holds the badge. */
function activeEntitlement(
  over: Partial<VendorEntitlementResponse> = {},
): VendorEntitlementResponse {
  return {
    vendor_id: VENDOR_ID,
    tier: 'verified',
    status: 'active',
    period_start: null,
    period_end: '2027-09-01',
    granted_at: '2026-06-01T00:00:00.000Z',
    ended_at: null,
    verified: true,
    payer: null,
    amount: null,
    terms: null,
    arranged_by: null,
    invoice_ref: 'PO-4471',
    notes: null,
    ...over,
  };
}

interface ApiMock {
  listClaims: ReturnType<typeof vi.fn>;
  moderate: ReturnType<typeof vi.fn>;
}

function makeApiMock(rows: AdminClaim[], total = rows.length): ApiMock {
  const page: ListVendorClaimsResponse = { data: rows, page: 1, perPage: 100, total };
  return {
    listClaims: vi.fn(async () => structuredClone(page)),
    moderate: vi.fn(
      async (id: string, input: ModerateClaimInput): Promise<ModerateClaimResponse> => ({
        request: makeClaim({ id, status: input.action === 'approve' ? 'resolved' : 'rejected' }),
        grant:
          input.action === 'approve'
            ? {
                user_id: '00000000-0000-4000-8000-000000000001',
                vendor_id: '00000000-0000-4000-8000-000000000002',
                verified: true,
                identity_outcome: 'linked',
                seat_created: false,
                // AECI-612: the grant now opens a `vendor_entitlements` row in the
                // same batch, and reports the tier it landed on.
                tier: 'verified',
                entitlement_created: true,
              }
            : null,
      }),
    ),
  };
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

async function setup(api: ApiMock) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: AdminClaimsApi, useValue: api },
    ],
  });
  const fixture = TestBed.createComponent(ClaimQueue);
  fixture.detectChanges();
  await fixture.whenStable();
  await settle();
  fixture.detectChanges();
  return { fixture, api, el: fixture.nativeElement as HTMLElement };
}

function cardFor(el: HTMLElement, targetName: string): HTMLElement {
  const article = [...el.querySelectorAll('article')].find((a) =>
    a.querySelector('h3')?.textContent?.includes(targetName),
  );
  if (!article) throw new Error(`No card for "${targetName}"`);
  return article as HTMLElement;
}

function buttonByText(root: HTMLElement, text: string): HTMLButtonElement {
  const btn = [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
  if (!btn) throw new Error(`No button "${text}"`);
  return btn as HTMLButtonElement;
}

/** Open the approve form and type the arrangement note, then return the card. */
function typeApproveNote(
  fixture: { detectChanges(): void },
  card: HTMLElement,
  note: string,
): void {
  buttonByText(card, 'Grant vendor account').click();
  fixture.detectChanges();
  const textarea = card.querySelector('textarea') as HTMLTextAreaElement;
  textarea.value = note;
  textarea.dispatchEvent(new Event('input'));
  fixture.detectChanges();
}

describe('ClaimQueue', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => vi.restoreAllMocks());

  it('loads the open queue and renders each claim in full', async () => {
    const { el, api } = await setup(
      makeApiMock([makeClaim({ id: 'c1', submitter_email: 'amy@vendor.test' })]),
    );
    expect(api.listClaims).toHaveBeenCalledWith({ status: 'open', page: 1, perPage: 100 });
    expect(el.textContent).toContain('Procore');
    expect(el.textContent).toContain('amy@vendor.test');
    expect(el.textContent).toContain('claim the listing');
    expect(el.querySelector('article h3 a')?.getAttribute('href')).toContain('/products/procore');
  });

  it('links a vendor target to the vendor detail page', async () => {
    const { el } = await setup(
      makeApiMock([
        makeClaim({
          id: 'c1',
          target_type: 'vendor',
          target: { id: 'v1', name: 'Autodesk', slug: 'autodesk' },
        }),
      ]),
    );
    expect(el.querySelector('article h3 a')?.getAttribute('href')).toContain('/vendors/autodesk');
  });

  it('renders a non-linked fallback when the target is missing', async () => {
    const { el } = await setup(makeApiMock([makeClaim({ id: 'c1', target: null })]));
    expect(el.querySelector('article h3 a')).toBeNull();
    expect(cardFor(el, 'Unknown product').textContent).toContain('Unknown product');
  });

  it('flags a likely duplicate', async () => {
    const { el } = await setup(makeApiMock([makeClaim({ id: 'c1', is_duplicate: true })]));
    expect(el.textContent).toContain('Possible duplicate');
  });

  it('warns on a domain mismatch', async () => {
    const { el } = await setup(makeApiMock([makeClaim({ id: 'c1', domain_match: 'no_match' })]));
    expect(cardFor(el, 'Procore').textContent).toContain('Domain mismatch');
  });

  it('renders the has_auth_account signal (link vs provision vs unknown)', async () => {
    const linked = await setup(makeApiMock([makeClaim({ id: 'c1', has_auth_account: true })]));
    expect(linked.el.textContent).toContain('approve links it');

    const provision = await setup(makeApiMock([makeClaim({ id: 'c2', has_auth_account: false })]));
    expect(provision.el.textContent).toContain('approve provisions one');

    const unknown = await setup(makeApiMock([makeClaim({ id: 'c3', has_auth_account: null })]));
    expect(unknown.el.textContent).toContain('Account status unknown');
  });

  it('renders the existing-seats roster, the empty first-claim state, and the unavailable state', async () => {
    const withSeats = await setup(
      makeApiMock([
        makeClaim({
          id: 'c1',
          existing_seats: [
            {
              display_name: 'Existing Admin',
              work_email_verified: true,
              created_at: '2026-05-01T00:00:00.000Z',
            },
          ],
        }),
      ]),
    );
    expect(withSeats.el.textContent).toContain('Existing Admin');
    expect(withSeats.el.textContent).toContain('work email verified');
    expect(withSeats.el.textContent).toContain('existing seat');

    const first = await setup(makeApiMock([makeClaim({ id: 'c2', existing_seats: [] })]));
    expect(first.el.textContent).toContain('First claim');

    const degraded = await setup(makeApiMock([makeClaim({ id: 'c3', existing_seats: null })]));
    expect(degraded.el.textContent).toContain('Unavailable');
  });

  it('renders prior requests + the duplicate-chain note', async () => {
    const { el } = await setup(
      makeApiMock([
        makeClaim({
          id: 'c1',
          duplicate_of_request_id: 'd0000000-0000-4000-8000-000000000000',
          related_requests: [
            {
              id: 'p1',
              kind: 'correction',
              status: 'resolved',
              target_type: 'vendor',
              created_at: '2026-05-01T00:00:00.000Z',
            },
          ],
        }),
      ]),
    );
    expect(el.textContent).toContain('prior request');
    expect(el.textContent).toContain('correction');
    expect(el.textContent).toContain('Flagged against an earlier request');
  });

  it('builds a LinkedIn people-search link from the submitter name', async () => {
    const { el } = await setup(
      makeApiMock([makeClaim({ id: 'c1', submitter_name: 'Sam Submitter' })]),
    );
    const link = cardFor(el, 'Procore').querySelector<HTMLAnchorElement>('a[href*="linkedin.com"]');
    expect(link).not.toBeNull();
    expect(link!.getAttribute('href')).toContain('Sam%20Submitter');
    expect(link!.getAttribute('target')).toBe('_blank');
    expect(link!.getAttribute('rel')).toContain('noopener');
  });

  it('refetches with the status filter', async () => {
    const { el, fixture, api } = await setup(makeApiMock([makeClaim({ id: 'c1' })]));
    const group = el.querySelector('[aria-labelledby="admin-claims-status-label"]') as HTMLElement;
    buttonByText(group, 'Rejected').click();
    await settle();
    fixture.detectChanges();
    expect(api.listClaims).toHaveBeenLastCalledWith({ status: 'rejected', page: 1, perPage: 100 });
  });

  it('approves with an arrangement note: passes entitlement.notes and drops the row', async () => {
    const api = makeApiMock([
      makeClaim({ id: 'c1' }),
      makeClaim({ id: 'c2', target: { id: 't2', name: 'Bluebeam', slug: 'bluebeam' } }),
    ]);
    const { el, fixture } = await setup(api);
    typeApproveNote(fixture, cardFor(el, 'Procore'), '  PO #4471, USD 5k/yr  ');
    buttonByText(cardFor(el, 'Procore'), 'Confirm grant').click();
    await settle();
    fixture.detectChanges();
    expect(api.moderate).toHaveBeenCalledWith('c1', {
      action: 'approve',
      entitlement: { notes: 'PO #4471, USD 5k/yr' },
    });
    expect(el.querySelectorAll('article')).toHaveLength(1);
    expect(el.textContent).toContain('Bluebeam');
  });

  it('approves without a note: omits entitlement', async () => {
    const api = makeApiMock([makeClaim({ id: 'c1' })]);
    const { el, fixture } = await setup(api);
    buttonByText(cardFor(el, 'Procore'), 'Grant vendor account').click();
    fixture.detectChanges();
    buttonByText(cardFor(el, 'Procore'), 'Confirm grant').click();
    await settle();
    fixture.detectChanges();
    expect(api.moderate).toHaveBeenCalledWith('c1', { action: 'approve' });
    expect(el.querySelector('article')).toBeNull();
  });

  it('rejects with an optional reason: passes the reason and drops the row', async () => {
    const api = makeApiMock([makeClaim({ id: 'c1' })]);
    const { el, fixture } = await setup(api);
    buttonByText(cardFor(el, 'Procore'), 'Reject').click();
    fixture.detectChanges();
    const textarea = cardFor(el, 'Procore').querySelector('textarea') as HTMLTextAreaElement;
    textarea.value = 'Not a real claim.';
    textarea.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    buttonByText(cardFor(el, 'Procore'), 'Confirm rejection').click();
    await settle();
    fixture.detectChanges();
    expect(api.moderate).toHaveBeenCalledWith('c1', {
      action: 'reject',
      reason: 'Not a real claim.',
    });
    expect(el.querySelector('article')).toBeNull();
  });

  it('keeps the row and shows the conflict message on a 409', async () => {
    const api = makeApiMock([makeClaim({ id: 'c1' })]);
    api.moderate.mockRejectedValueOnce(new HttpErrorResponse({ status: 409 }));
    const { el, fixture } = await setup(api);
    buttonByText(cardFor(el, 'Procore'), 'Grant vendor account').click();
    fixture.detectChanges();
    buttonByText(cardFor(el, 'Procore'), 'Confirm grant').click();
    await settle();
    fixture.detectChanges();
    expect(el.querySelector('article')).not.toBeNull();
    expect(cardFor(el, 'Procore').querySelector('[role="alert"]')?.textContent).toContain(
      'already claims a different vendor',
    );
  });

  it('keeps the row and explains the 503 grant-unavailable state (AECI-530)', async () => {
    const api = makeApiMock([makeClaim({ id: 'c1' })]);
    api.moderate.mockRejectedValueOnce(new HttpErrorResponse({ status: 503 }));
    const { el, fixture } = await setup(api);
    buttonByText(cardFor(el, 'Procore'), 'Grant vendor account').click();
    fixture.detectChanges();
    buttonByText(cardFor(el, 'Procore'), 'Confirm grant').click();
    await settle();
    fixture.detectChanges();
    expect(el.querySelector('article')).not.toBeNull();
    expect(cardFor(el, 'Procore').querySelector('[role="alert"]')?.textContent).toContain(
      'Reject still works',
    );
  });

  it('drops the row and announces on a 422 (already moderated)', async () => {
    const api = makeApiMock([makeClaim({ id: 'c1' })]);
    api.moderate.mockRejectedValueOnce(new HttpErrorResponse({ status: 422 }));
    const { el, fixture } = await setup(api);
    buttonByText(cardFor(el, 'Procore'), 'Reject').click();
    fixture.detectChanges();
    buttonByText(cardFor(el, 'Procore'), 'Confirm rejection').click();
    await settle();
    fixture.detectChanges();
    expect(el.querySelector('article')).toBeNull();
    expect(el.querySelector('[role="status"]')?.textContent).toContain('already moderated');
  });

  it('hides moderation actions on terminal rows', async () => {
    const { el } = await setup(makeApiMock([makeClaim({ id: 'c1', status: 'resolved' })]));
    const labels = [...cardFor(el, 'Procore').querySelectorAll('button')].map((b) =>
      b.textContent?.trim(),
    );
    expect(labels).not.toContain('Grant vendor account');
    expect(labels).not.toContain('Reject');
  });

  it('renders the empty state when nothing matches', async () => {
    const { el } = await setup(makeApiMock([], 0));
    expect(el.textContent).toContain('No claims match');
    expect(el.querySelector('article')).toBeNull();
  });

  it('shows a retryable state when the initial load fails, then recovers', async () => {
    const api = makeApiMock([makeClaim({ id: 'c1' })]);
    api.listClaims.mockRejectedValueOnce(new Error('boom'));
    const { el, fixture } = await setup(api);
    expect(el.querySelector('[role="alert"]')?.textContent).toContain("couldn't load");
    buttonByText(el, 'Try again').click();
    await settle();
    fixture.detectChanges();
    expect(el.querySelectorAll('article')).toHaveLength(1);
  });

  // ── Entitlement control (AECI-532 / STAGE_2_PAID_TIERS_SPEC.md §5) ─────────

  describe('entitlement readout + link (the CONTROL moved out in AECI-652)', () => {
    it('renders the status readout without any form control', async () => {
      const { el } = await setup(makeApiMock([makeClaim({ id: 'c1' })]));
      const card = cardFor(el, 'Procore');
      expect(card.textContent).toContain('No entitlement on record');
      // The set/renew/clear form lives on /admin/vendors/:id now. A second copy
      // here would mean a second copy of the §5.2/§5.3/§5.4 copy invariants, and
      // those are the sentences whose drift causes an incident.
      expect(() => buttonByText(card, 'Grant entitlement')).toThrow();
      expect(() => buttonByText(card, 'Clear entitlement')).toThrow();
      expect(card.querySelector('aec-entitlement-control')).toBeNull();
    });

    it('shows the active term and paperwork', async () => {
      const { el } = await setup(
        makeApiMock([makeClaim({ id: 'c1', entitlement: activeEntitlement() })]),
      );
      const card = cardFor(el, 'Procore');
      expect(card.textContent).toContain('Verified: entitlement active');
      // Formatted, and formatted the SAME way as `/admin/vendors/:id` — both
      // readouts share `entitlementTermLabel` so they cannot drift (AECI-694).
      expect(card.textContent).toContain('Sep 1, 2027');
      expect(card.textContent).toContain('PO-4471'); // the arrangement is admin-side
    });

    it('links out to the vendor page by VENDOR id, not by claim or target id', async () => {
      // A product claim's entitlement belongs to that product's PRIMARY vendor, so
      // `target_id` cannot address it — which is why the row carries a resolved
      // `entitlement_vendor` at all.
      const { el } = await setup(makeApiMock([makeClaim({ id: 'c1' })]));
      const card = cardFor(el, 'Procore');
      const link = [...card.querySelectorAll('a')].find(
        (a) => a.textContent?.trim() === 'Manage entitlement',
      );
      expect(link?.getAttribute('href')).toBe(`/admin/vendors/${VENDOR_ID}`);
    });

    it('renders no link when the claim has no vendor to act on', async () => {
      const { el } = await setup(makeApiMock([makeClaim({ id: 'c1', entitlement_vendor: null })]));
      const card = cardFor(el, 'Procore');
      expect(card.textContent).toContain('Unavailable');
      expect(
        [...card.querySelectorAll('a')].some((a) => a.textContent?.trim() === 'Manage entitlement'),
      ).toBe(false);
    });

    it('stays visible on a resolved claim — renewing a months-old grant is ordinary', async () => {
      const { el } = await setup(
        makeApiMock([
          makeClaim({ id: 'c1', status: 'resolved', entitlement: activeEntitlement() }),
        ]),
      );
      const card = cardFor(el, 'Procore');
      // The moderation buttons are gone (terminal row) but the readout is not.
      expect(() => buttonByText(card, 'Grant vendor account')).toThrow();
      expect(card.textContent).toContain('Verified: entitlement active');
    });
  });

  describe('accessibility (structural)', () => {
    it('nests headings without skipping levels (shell owns h1; h2 → h3 card → h4 signals)', async () => {
      const { el } = await setup(
        makeApiMock([
          makeClaim({ id: 'c1' }),
          makeClaim({ id: 'c2', target: { id: 't2', name: 'Bluebeam', slug: 'bluebeam' } }),
        ]),
      );
      expect(el.querySelectorAll('h1')).toHaveLength(0);
      expect(el.querySelectorAll('h2')).toHaveLength(1);
      expect(el.querySelectorAll('h3')).toHaveLength(2); // one per card
      // Two h4 subsections per card: verification signals + entitlement (AECI-532).
      expect(el.querySelectorAll('h4')).toHaveLength(4);
      expect(el.querySelector('h5, h6')).toBeNull();
    });

    it('gives the status filter an accessible group name', async () => {
      const { el } = await setup(makeApiMock([makeClaim({ id: 'c1' })]));
      const group = el.querySelector('[role="group"]');
      const labelId = group?.getAttribute('aria-labelledby');
      expect(labelId).toBeTruthy();
      expect(el.querySelector(`#${labelId}`)?.textContent?.trim()).toBeTruthy();
    });

    it('exposes EXACTLY ONE polite live region, however many rows are on screen', async () => {
      // The count is the point. The entitlement control used to be inline, once
      // per row; a version of it that rendered its own `role="status"` would give
      // this page N live regions, and a `querySelector` assertion would keep
      // passing on the first one. That is why the extracted control announces
      // through an output instead.
      const { el } = await setup(
        makeApiMock([
          makeClaim({ id: 'c1' }),
          makeClaim({ id: 'c2', target: { id: 't2', name: 'Bluebeam', slug: 'bluebeam' } }),
        ]),
      );
      const regions = el.querySelectorAll('[role="status"]');
      expect(regions).toHaveLength(1);
      expect(regions[0].getAttribute('aria-live')).toBe('polite');
    });
  });
});
