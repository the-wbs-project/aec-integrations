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
 * AECI-739 added the operator-note READOUT, the per-card detail link and the
 * `in_review` filter tab; the note is written on `/admin/claims/:id`, so what is
 * asserted here is that a parked claim is legible from the LIST.
 *
 * The entitlement set/renew/clear form left this page in AECI-652, and AECI-1375
 * retired it and the entitlement readout. What stays is the target vendor's name
 * and the "Manage billing" link, plus the single-live-region assertion.
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
} from '@aeci/shared';

import { AdminSummaryStore } from '../admin-summary.store';
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
    submitter_linkedin_url: over.submitter_linkedin_url ?? null,
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
    seat_emails_available: over.seat_emails_available ?? true,
    related_requests: 'related_requests' in over ? over.related_requests! : [],
    // AECI-532: the resolved target vendor, so the card can link to its Billing tab.
    entitlement_vendor:
      'entitlement_vendor' in over
        ? over.entitlement_vendor!
        : { id: VENDOR_ID, name: 'Autodesk, Inc.', slug: 'autodesk' },
    // AECI-738: the §5.2 payer test. Default is an ordinary endpoint vendor.
    product_roles:
      'product_roles' in over
        ? over.product_roles!
        : { application: 1, connector: 0, hybrid: 0, total: 1 },
    is_pure_connector_vendor:
      'is_pure_connector_vendor' in over ? over.is_pure_connector_vendor! : false,
    // AECI-1041: the §5.2 step 1a owner test. Default owns nothing.
    owned_integrations:
      'owned_integrations' in over
        ? over.owned_integrations!
        : { integrations: 0, connector_evidenced: 0, total: 0 },
    // AECI-739: the operator note. Default is "no note".
    admin_notes: 'admin_notes' in over ? over.admin_notes! : null,
    // AECI-1364: the product page the claim came from. Default: a company-page claim.
    context_product: 'context_product' in over ? over.context_product! : null,
    // AECI-1322: a resolved fixture was granted unless a test says otherwise.
    granted: over.granted ?? (over.status ?? 'open') === 'resolved',
    // AECI-1368: owner routing. Default: never routed.
    routed_to_owners_at: over.routed_to_owners_at ?? null,
    owner_fallback_at: over.owner_fallback_at ?? null,
  };
}

const VENDOR_ID = '00000000-0000-4000-8000-000000000002';

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
                // AECI-1367: every approval lands on Free.
                tier: 'unclaimed',
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
  const store = TestBed.inject(AdminSummaryStore);
  const fixture = TestBed.createComponent(ClaimQueue);
  fixture.detectChanges();
  await fixture.whenStable();
  await settle();
  fixture.detectChanges();
  return { fixture, api, store, el: fixture.nativeElement as HTMLElement };
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

/** Open the approve confirmation. AECI-1367: there is nothing to pick. */
function openApprove(fixture: { detectChanges(): void }, card: HTMLElement): void {
  buttonByText(card, 'Grant vendor account').click();
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

  // AECI-1364: a claim sent from a product page is on the company, and names the page.
  it('shows "Came from" with a link to the product page the claim was sent from', async () => {
    const { el } = await setup(
      makeApiMock([
        makeClaim({
          id: 'c1',
          target_type: 'vendor',
          target: { id: 'v1', name: 'Procore Technologies', slug: 'procore-technologies' },
          context_product: { id: 'p1', name: 'Procore', slug: 'procore' },
        }),
      ]),
    );
    const row = el.querySelector('[data-testid="claim-context-product"]');
    expect(row?.textContent).toContain('Came from');
    expect(row?.textContent).toContain('Procore');
    expect(row?.querySelector('a')?.getAttribute('href')).toContain('/products/procore');
    expect(el.querySelector('article h3 a')?.getAttribute('href')).toContain(
      '/vendors/procore-technologies',
    );
  });

  it('shows no "Came from" on a company-page claim', async () => {
    const { el } = await setup(makeApiMock([makeClaim({ id: 'c1', context_product: null })]));
    expect(el.querySelector('[data-testid="claim-context-product"]')).toBeNull();
  });

  it('flags a likely duplicate', async () => {
    const { el } = await setup(makeApiMock([makeClaim({ id: 'c1', is_duplicate: true })]));
    expect(el.textContent).toContain('Possible duplicate');
  });

  it('warns on a domain mismatch', async () => {
    const { el } = await setup(makeApiMock([makeClaim({ id: 'c1', domain_match: 'no_match' })]));
    expect(cardFor(el, 'Procore').textContent).toContain('Domain mismatch');
  });

  describe('the has_auth_account signal is worded for the claim status (AECI-1278)', () => {
    /** The "Claimant account" value, read from its own `<dd>` so other copy on the
     *  card (action buttons, help text) cannot satisfy the assertion. */
    function accountSignal(el: HTMLElement): string {
      const dt = [...el.querySelectorAll('dt')].find(
        (d) => d.textContent?.trim() === 'Claimant account',
      );
      return dt?.nextElementSibling?.textContent?.trim() ?? '';
    }

    const cases: [AdminClaim['status'], boolean | null, string][] = [
      ['open', true, 'Existing account: approve links it'],
      ['open', false, 'No account: approve provisions one'],
      ['open', null, 'Account status unknown'],
      ['in_review', true, 'Existing account: approve links it'],
      ['in_review', false, 'No account: approve provisions one'],
      ['resolved', true, 'Account exists (claim granted)'],
      ['resolved', false, 'No account found'],
      ['resolved', null, 'Account status unknown'],
      ['rejected', true, 'Existing account'],
      ['rejected', false, 'No account'],
      ['rejected', null, 'Account status unknown'],
    ];

    it.each(cases)('%s + %s reads "%s"', async (status, hasAccount, expected) => {
      const { el } = await setup(
        makeApiMock([makeClaim({ id: 'c1', status, has_auth_account: hasAccount })]),
      );
      expect(accountSignal(el)).toBe(expected);
    });

    // AECI-1322: the Linear webhook resolves a claim with no grant behind it.
    it.each([true, false, null])(
      'a resolved claim with no grant reads "Resolved without a grant" (account %s)',
      async (hasAccount) => {
        const { el } = await setup(
          makeApiMock([
            makeClaim({
              id: 'c1',
              status: 'resolved',
              granted: false,
              has_auth_account: hasAccount,
            }),
          ]),
        );
        expect(accountSignal(el)).toBe('Resolved without a grant');
      },
    );

    it('never offers an approve action on a decided claim', async () => {
      for (const status of ['resolved', 'rejected'] as const) {
        for (const hasAccount of [true, false]) {
          const { el } = await setup(
            makeApiMock([makeClaim({ id: 'c1', status, has_auth_account: hasAccount })]),
          );
          expect(accountSignal(el)).not.toContain('approve');
        }
      }
    });
  });

  it('renders the existing-seats roster, the empty first-claim state, and the unavailable state', async () => {
    const withSeats = await setup(
      makeApiMock([
        makeClaim({
          id: 'c1',
          existing_seats: [
            {
              display_name: 'Existing Admin',
              email: 'admin@autodesk.com',
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

  it('labels a seat by its email when it has no display name, never "Unnamed seat" (AECI-1277)', async () => {
    const seat = { work_email_verified: false, created_at: '2026-05-01T00:00:00.000Z' };
    const { el } = await setup(
      makeApiMock([
        makeClaim({
          id: 'c1',
          existing_seats: [
            { ...seat, display_name: 'Named Admin', email: 'named@autodesk.com' },
            { ...seat, display_name: null, email: 'holder@gmail.com' },
            { ...seat, display_name: '   ', email: 'blank@gmail.com' },
          ],
        }),
      ]),
    );
    const text = el.textContent ?? '';
    expect(text).toContain('Named Admin');
    // The name wins; the email is the fallback, not a second line.
    expect(text).not.toContain('named@autodesk.com');
    expect(text).toContain('holder@gmail.com');
    expect(text).toContain('blank@gmail.com');
    expect(text).not.toContain('Unnamed seat');
  });

  it('says why a nameless seat has no email: seam down vs. none on file (AECI-1277)', async () => {
    const seat = {
      display_name: null,
      email: null,
      work_email_verified: false,
      created_at: '2026-05-01T00:00:00.000Z',
    };
    const down = await setup(
      makeApiMock([makeClaim({ id: 'c1', existing_seats: [seat], seat_emails_available: false })]),
    );
    expect(down.el.textContent).toContain('Email unavailable');

    const none = await setup(
      makeApiMock([makeClaim({ id: 'c2', existing_seats: [seat], seat_emails_available: true })]),
    );
    expect(none.el.textContent).toContain('No email on file');
    expect(none.el.textContent).not.toContain('Email unavailable');
  });

  it('renders the product-role breakdown, the no-products state, and the unavailable state', async () => {
    const ordinary = await setup(
      makeApiMock([
        makeClaim({
          id: 'c1',
          product_roles: { application: 2, connector: 1, hybrid: 0, total: 3 },
        }),
      ]),
    );
    // `application` is SPELLED OUT. `RoleBadge` hides it, which is right for a
    // per-product chip and wrong here: "2 are application" is the affirmative
    // answer to the payer test, and inferring it from an absent chip is the
    // defect AECI-738 exists to remove.
    expect(ordinary.el.textContent).toContain('2 application');
    expect(ordinary.el.textContent).toContain('1 connector');

    const noProducts = await setup(
      makeApiMock([
        makeClaim({
          id: 'c2',
          product_roles: { application: 0, connector: 0, hybrid: 0, total: 0 },
        }),
      ]),
    );
    // Unknown, NOT exempt — and visibly distinct from "unavailable".
    expect(noProducts.el.textContent).toContain('No products on record');

    const degraded = await setup(
      makeApiMock([makeClaim({ id: 'c3', product_roles: null, is_pure_connector_vendor: null })]),
    );
    expect(degraded.el.textContent).toContain('Unavailable');
  });

  // AECI-1367 (Chris's ruling 2026-10-14): a connector vendor is approved like anyone
  // else. The parking banners are gone. One neutral flag remains.
  it.each([
    ['owns no integrations', { integrations: 0, connector_evidenced: 0, total: 0 }],
    ['owns integrations', { integrations: 1, connector_evidenced: 3, total: 4 }],
    ['owned count unavailable', null],
  ])(
    'shows the neutral connector flag on a pure-connector claim that %s, with Grant enabled',
    async (_label, owned) => {
      const { el } = await setup(
        makeApiMock([
          makeClaim({
            id: 'c1',
            product_roles: { application: 0, connector: 2, hybrid: 0, total: 2 },
            is_pure_connector_vendor: true,
            owned_integrations: owned,
          }),
        ]),
      );
      const card = cardFor(el, 'Procore');
      const flag = card.querySelector('[data-testid="claim-connector-flag"]');
      expect(flag?.textContent).toContain('Connector vendor: contact them directly');
      // None of the retired park procedure survives.
      expect(card.textContent).not.toContain('do not Grant or Reject');
      expect(card.textContent).not.toContain('a paying owner');
      expect(card.textContent).not.toContain('check what it owns before you act');
      expect(card.textContent).not.toContain('partnership track');
      const buttons = [...card.querySelectorAll('button')].filter((b) =>
        /Grant vendor account|Reject/.test(b.textContent ?? ''),
      );
      expect(buttons.length).toBe(2);
      expect(buttons.every((b) => !b.disabled)).toBe(true);
    },
  );

  // AECI-1368: a claim routed to the company's owners warns and never gates.
  it('shows "With owners until" on a routed claim, with Grant and Reject still enabled', async () => {
    const { el } = await setup(
      makeApiMock([makeClaim({ id: 'c1', routed_to_owners_at: '2026-10-14T10:00:00.000Z' })]),
    );
    const card = cardFor(el, 'Procore');
    const flag = card.querySelector('[data-testid="claim-owner-routed"]');
    expect(flag?.textContent).toContain('With owners until');
    // 2026-10-14 + 7 days.
    expect(flag?.textContent).toContain('Oct 21, 2026');
    const buttons = [...card.querySelectorAll('button')].filter((b) =>
      /Grant vendor account|Reject/.test(b.textContent ?? ''),
    );
    expect(buttons.length).toBe(2);
    expect(buttons.every((b) => !b.disabled)).toBe(true);
  });

  it('says a claim came back from the owners once the fallback ran', async () => {
    const { el } = await setup(
      makeApiMock([makeClaim({ id: 'c1', owner_fallback_at: '2026-10-21T14:00:00.000Z' })]),
    );
    const card = cardFor(el, 'Procore');
    expect(card.querySelector('[data-testid="claim-owner-routed"]')).toBeNull();
    expect(card.querySelector('[data-testid="claim-owner-fallback"]')?.textContent).toContain(
      'did not decide within 7 days',
    );
  });

  it('shows no owner flag on an unrouted or decided claim', async () => {
    const { el } = await setup(
      makeApiMock([
        makeClaim({ id: 'c1' }),
        makeClaim({
          id: 'c2',
          status: 'resolved',
          routed_to_owners_at: '2026-10-14T10:00:00.000Z',
        }),
      ]),
    );
    expect(el.querySelector('[data-testid="claim-owner-routed"]')).toBeNull();
  });

  it('still reads the owned-integrations signal on a connector claim', async () => {
    const { el } = await setup(
      makeApiMock([
        makeClaim({
          id: 'c1',
          product_roles: { application: 0, connector: 1, hybrid: 0, total: 1 },
          is_pure_connector_vendor: true,
          owned_integrations: { integrations: 1, connector_evidenced: 3, total: 4 },
        }),
      ]),
    );
    const card = cardFor(el, 'Procore');
    expect(card.textContent).toContain('Integrations owned');
    expect(card.textContent).toContain('4 (1 direct, 3 via a connector)');
  });

  it.each([
    ['an ordinary vendor claim', makeClaim({ id: 'c1' })],
    ['a role signal that is unavailable', makeClaim({ id: 'c1', is_pure_connector_vendor: null })],
    [
      'a decided connector claim',
      makeClaim({ id: 'c1', status: 'resolved', is_pure_connector_vendor: true }),
    ],
  ])('shows no connector flag on %s', async (_label, claim) => {
    const { el } = await setup(makeApiMock([claim]));
    expect(el.querySelector('[data-testid="claim-connector-flag"]')).toBeNull();
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

  // ── AECI-847: the claimant-supplied LinkedIn profile ──────────────────────
  // Mirrors the `claim-detail.component.spec.ts` block: the built search is the
  // FALLBACK, and the two surfaces must tell one story.
  describe('the LinkedIn identity signal', () => {
    const linkedInHrefs = (card: HTMLElement) =>
      [...card.querySelectorAll('a')]
        .map((a) => a.getAttribute('href') ?? '')
        .filter((h) => h.includes('linkedin.com'));

    it("links the claimant's own profile when they supplied one", async () => {
      const { el } = await setup(
        makeApiMock([
          makeClaim({
            id: 'c1',
            submitter_linkedin_url: 'https://www.linkedin.com/in/sam-submitter',
          }),
        ]),
      );
      expect(linkedInHrefs(cardFor(el, 'Procore'))).toEqual([
        'https://www.linkedin.com/in/sam-submitter',
      ]);
    });

    // A guess shown beside real evidence reads as corroboration of it. Only one
    // person link is ever rendered.
    it('never shows the search guess alongside a supplied profile', async () => {
      const { el } = await setup(
        makeApiMock([
          makeClaim({ id: 'c1', submitter_linkedin_url: 'https://uk.linkedin.com/in/sam' }),
        ]),
      );
      const hrefs = linkedInHrefs(cardFor(el, 'Procore'));
      expect(hrefs).toHaveLength(1);
      expect(hrefs[0]).not.toContain('/search/results/');
    });

    // Two rows in one page resolve independently — a supplied profile on one card
    // must not suppress the fallback on the other.
    it('resolves the link per row, not per page', async () => {
      const { el } = await setup(
        makeApiMock([
          makeClaim({
            id: 'c1',
            submitter_linkedin_url: 'https://www.linkedin.com/in/sam-submitter',
          }),
          makeClaim({
            id: 'c2',
            target: { id: 't2', name: 'Bluebeam', slug: 'bluebeam' },
            submitter_linkedin_url: null,
          }),
        ]),
      );
      expect(linkedInHrefs(cardFor(el, 'Procore'))).toEqual([
        'https://www.linkedin.com/in/sam-submitter',
      ]);
      expect(linkedInHrefs(cardFor(el, 'Bluebeam'))[0]).toContain('/search/results/people/');
    });
  });

  it('refetches with the status filter', async () => {
    const { el, fixture, api } = await setup(makeApiMock([makeClaim({ id: 'c1' })]));
    const group = el.querySelector('[aria-labelledby="admin-claims-status-label"]') as HTMLElement;
    buttonByText(group, 'Rejected').click();
    await settle();
    fixture.detectChanges();
    expect(api.listClaims).toHaveBeenLastCalledWith({ status: 'rejected', page: 1, perPage: 100 });
  });

  // ── Approve lands on Free (AECI-1367) ──────────────────────────────────────

  it('approves with no plan and drops the row', async () => {
    const api = makeApiMock([
      makeClaim({ id: 'c1' }),
      makeClaim({ id: 'c2', target: { id: 't2', name: 'Bluebeam', slug: 'bluebeam' } }),
    ]);
    const { el, fixture } = await setup(api);
    openApprove(fixture, cardFor(el, 'Procore'));
    buttonByText(cardFor(el, 'Procore'), 'Confirm grant').click();
    await settle();
    fixture.detectChanges();
    expect(api.moderate).toHaveBeenCalledWith('c1', { action: 'approve' });
    expect(el.querySelectorAll('article')).toHaveLength(1);
    expect(el.textContent).toContain('Bluebeam');
    expect(el.querySelector('[role="status"]')?.textContent).toContain('Free plan');
  });

  it('has no plan fieldset, radios, arrangement notes or verified-badge help (AECI-1272)', async () => {
    const { el, fixture } = await setup(makeApiMock([makeClaim({ id: 'c1' })]));
    const card = cardFor(el, 'Procore');
    openApprove(fixture, card);
    const form = card.querySelector('form') as HTMLFormElement;
    expect(form.querySelector('fieldset')).toBeNull();
    expect(form.querySelectorAll('input[type="radio"]')).toHaveLength(0);
    expect(form.querySelector('textarea')).toBeNull();
    expect(form.textContent).not.toContain('Payment / arrangement notes');
    expect(form.textContent).not.toContain('verified badge');
    expect(form.textContent).toContain('Free plan');
    // Nothing to pick, so Confirm is live at once.
    expect(buttonByText(card, 'Confirm grant').disabled).toBe(false);
  });

  // AECI-1365: the plan question is gone, so neither the card nor the approve form
  // carries a plan answer.
  it('shows no plan interest row and no "They asked about" line', async () => {
    const { el, fixture } = await setup(
      makeApiMock([makeClaim({ id: 'c1', body: 'Four products.' })]),
    );
    const card = cardFor(el, 'Procore');
    expect(card.textContent).not.toContain('Plan interest');
    expect(card.textContent).toContain('Four products.');
    openApprove(fixture, card);
    expect(card.textContent).not.toContain('They asked about');
  });

  it('Enter-to-submit approves too', async () => {
    const api = makeApiMock([makeClaim({ id: 'c1' })]);
    const { el, fixture } = await setup(api);
    const card = cardFor(el, 'Procore');
    openApprove(fixture, card);
    (card.querySelector('form') as HTMLFormElement).dispatchEvent(
      new Event('submit', { cancelable: true }),
    );
    await settle();
    expect(api.moderate).toHaveBeenCalledWith('c1', { action: 'approve' });
  });

  // ── The nav badge (AECI-922) ───────────────────────────────────────────────
  // This queue got its own counter when the Operations category started summing
  // three of them. Before that the screen deliberately decremented nothing.

  it('decrements the claims badge after a successful grant', async () => {
    const api = makeApiMock([makeClaim({ id: 'c1' })]);
    const { el, fixture, store } = await setup(api);
    store.seed({ reviews: 5, requests: 2, claims: 3 });
    openApprove(fixture, cardFor(el, 'Procore'));
    buttonByText(cardFor(el, 'Procore'), 'Confirm grant').click();
    await settle();
    fixture.detectChanges();
    expect(store.pendingClaims()).toBe(2);
    // Only this queue moves; the other two are a different backlog.
    expect(store.pendingReviews()).toBe(5);
    expect(store.pendingRequests()).toBe(2);
  });

  // `pending_claims` counts `open` claims. The In review tab moderates rows that
  // were never in that count, so decrementing there would walk the badge below
  // the real backlog with nothing to resync it until the next visit to /admin.
  it('does not decrement when the moderated claim was in_review, not open', async () => {
    const api = makeApiMock([makeClaim({ id: 'c1', status: 'in_review' })]);
    const { el, fixture, store } = await setup(api);
    store.seed({ claims: 3 });
    buttonByText(cardFor(el, 'Procore'), 'Reject').click();
    fixture.detectChanges();
    buttonByText(cardFor(el, 'Procore'), 'Confirm rejection').click();
    await settle();
    fixture.detectChanges();
    expect(api.moderate).toHaveBeenCalledWith('c1', { action: 'reject' });
    expect(store.pendingClaims()).toBe(3);
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
    openApprove(fixture, cardFor(el, 'Procore'));
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
    openApprove(fixture, cardFor(el, 'Procore'));
    buttonByText(cardFor(el, 'Procore'), 'Confirm grant').click();
    await settle();
    fixture.detectChanges();
    expect(el.querySelector('article')).not.toBeNull();
    expect(cardFor(el, 'Procore').querySelector('[role="alert"]')?.textContent).toContain(
      'Reject still works',
    );
  });

  it('drops the row on a 422 (already moderated) without decrementing', async () => {
    const api = makeApiMock([makeClaim({ id: 'c1' })]);
    api.moderate.mockRejectedValueOnce(new HttpErrorResponse({ status: 422 }));
    const { el, fixture, store } = await setup(api);
    store.seed({ claims: 3 });
    buttonByText(cardFor(el, 'Procore'), 'Reject').click();
    fixture.detectChanges();
    buttonByText(cardFor(el, 'Procore'), 'Confirm rejection').click();
    await settle();
    fixture.detectChanges();
    expect(el.querySelector('article')).toBeNull();
    expect(el.querySelector('[role="status"]')?.textContent).toContain('already moderated');
    // The admin who raced us already decremented.
    expect(store.pendingClaims()).toBe(3);
  });

  it('drops the row on a 409 CLAIM_ALREADY_DECIDED (an owner decided first)', async () => {
    const api = makeApiMock([makeClaim({ id: 'c1' })]);
    api.moderate.mockRejectedValueOnce(
      new HttpErrorResponse({
        status: 409,
        error: { error: { code: 'CLAIM_ALREADY_DECIDED', message: 'decided' } },
      }),
    );
    const { el, fixture } = await setup(api);
    openApprove(fixture, cardFor(el, 'Procore'));
    buttonByText(cardFor(el, 'Procore'), 'Confirm grant').click();
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

  // ── Billing link (AECI-532; readout retired in AECI-1375) ──────────────────

  describe('the target vendor and the Billing link', () => {
    it('shows the vendor name and no entitlement readout or form control', async () => {
      const { el } = await setup(makeApiMock([makeClaim({ id: 'c1' })]));
      const card = cardFor(el, 'Procore');
      expect(card.textContent).toContain('Autodesk, Inc.');
      // AECI-1375: licenses are the plan; the entitlement status line is gone.
      expect(card.textContent).not.toContain('No entitlement on record');
      expect(card.textContent).not.toContain('Account active: entitlement active');
      expect(() => buttonByText(card, 'Grant entitlement')).toThrow();
      expect(() => buttonByText(card, 'Clear entitlement')).toThrow();
      expect(card.querySelector('aec-entitlement-control')).toBeNull();
    });

    it('links out to the vendor page by VENDOR id, not by claim or target id', async () => {
      // A product claim's licenses belong to that product's PRIMARY vendor, so
      // `target_id` cannot address it. That is why the row carries a resolved
      // `entitlement_vendor` at all.
      const { el } = await setup(makeApiMock([makeClaim({ id: 'c1' })]));
      const card = cardFor(el, 'Procore');
      const link = [...card.querySelectorAll('a')].find(
        (a) => a.textContent?.trim() === 'Manage billing',
      );
      // AECI-1372: the license view and the grant live on the Billing tab.
      expect(link?.getAttribute('href')).toBe(`/admin/vendors/${VENDOR_ID}?tab=billing`);
    });

    it('renders no link when the claim has no vendor to act on', async () => {
      const { el } = await setup(makeApiMock([makeClaim({ id: 'c1', entitlement_vendor: null })]));
      const card = cardFor(el, 'Procore');
      expect(
        [...card.querySelectorAll('a')].some((a) => a.textContent?.trim() === 'Manage billing'),
      ).toBe(false);
    });

    it('stays visible on a resolved claim: managing a months-old grant is ordinary', async () => {
      const { el } = await setup(makeApiMock([makeClaim({ id: 'c1', status: 'resolved' })]));
      const card = cardFor(el, 'Procore');
      // The moderation buttons are gone (terminal row) but the link is not.
      expect(() => buttonByText(card, 'Grant vendor account')).toThrow();
      expect(
        [...card.querySelectorAll('a')].some((a) => a.textContent?.trim() === 'Manage billing'),
      ).toBe(true);
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
      // One h4 subsection per card: verification signals. The entitlement h4 is
      // gone with its readout (AECI-1375).
      expect(el.querySelectorAll('h4')).toHaveLength(2);
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
      // The count is the point. A per-row control that rendered its own
      // `role="status"` would give this page N live regions, and a
      // `querySelector` assertion would keep passing on the first one.
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

  // ── AECI-739: the parked claim, legible from the list ──────────────────────

  describe('operator note + detail route (AECI-739)', () => {
    it('renders the note on the CARD — a parked claim must be legible from the queue', async () => {
      const { el } = await setup(
        makeApiMock([
          makeClaim({ id: 'c1', admin_notes: 'Connector vendor — partnership track, 2026-09-01.' }),
        ]),
      );
      const card = cardFor(el, 'Procore');
      expect(card.textContent).toContain('Connector vendor — partnership track, 2026-09-01.');
    });

    it('shows no note block when there is no note', async () => {
      const { el } = await setup(makeApiMock([makeClaim({ id: 'c1' })]));
      expect(cardFor(el, 'Procore').textContent).not.toContain('Operator note');
    });

    it('links each card to its detail route', async () => {
      const { el } = await setup(makeApiMock([makeClaim({ id: 'c1' })]));
      const links = [...cardFor(el, 'Procore').querySelectorAll('a')].map((a) =>
        a.getAttribute('href'),
      );
      expect(links).toContain('/admin/claims/c1');
    });

    it('offers an In review filter and re-fetches with that status', async () => {
      // The status the API could not express at all until AECI-739 widened its
      // query enum — so a claim addressable at /admin/claims/:id was findable in
      // no queue tab.
      const api = makeApiMock([makeClaim({ id: 'c1' })]);
      const { el, fixture } = await setup(api);
      const tab = buttonByText(el, 'In review');
      tab.click();
      fixture.detectChanges();
      await settle();
      expect(api.listClaims).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: 'in_review' }),
      );
    });
  });
});
