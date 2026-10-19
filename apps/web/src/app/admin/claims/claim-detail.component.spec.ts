/**
 * AECI-739 — `ClaimDetail` logic + structural a11y.
 *
 * The live axe pass runs in Playwright / static-serve on rendered routes (the
 * repo's component-level a11y convention — cf. `claim-queue.component.spec.ts`).
 * Here we assert the four load outcomes (loaded / 404 / 422-not-a-claim /
 * failed), the operator-note write incl. its dirty gate, clear-on-blank and error
 * mapping, the duplicate explanation in both its states, and the structural
 * invariants axe relies on: heading order and the single polite live region.
 *
 * AECI-1276 adds the audit trail: it loads after the claim, refetches after a
 * note save, is skipped on 404/422, and fails soft without hiding the claim.
 *
 * **404 and 422 are asserted separately on purpose.** The API distinguishes an
 * unknown id from a `kind='correction'` id, and a page that collapsed both into
 * "not found" would send an operator looking for a row that exists.
 *
 * Harness mirrors `claim-queue.component.spec.ts`: browser platform + a macrotask
 * `settle()` drains `afterNextRender`'s async load.
 */
import { HttpErrorResponse } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, provideRouter } from '@angular/router';
import { describe, expect, it, vi } from 'vitest';

import type {
  AdminAuditRow,
  AdminClaimAuditResponse,
  AdminClaimDetail,
  ClaimDuplicateSibling,
} from '@aeci/shared';

import { AdminClaimsApi } from './admin-claims-api';
import { ClaimDetail } from './claim-detail';

const CLAIM_ID = '00000000-0000-4000-8000-000000000001';
const SIBLING_ID = '00000000-0000-4000-8000-000000000009';
const VENDOR_ID = '00000000-0000-4000-8000-000000000002';

function makeSibling(over: Partial<ClaimDuplicateSibling> = {}): ClaimDuplicateSibling {
  return {
    id: SIBLING_ID,
    submitter_email: 'other@vendor.test',
    submitter_name: 'Other Person',
    status: 'open',
    created_at: '2026-05-01T00:00:00.000Z',
    match_reason: 'target',
    has_notes: false,
    ...over,
  };
}

function makeDetail(over: Partial<AdminClaimDetail> = {}): AdminClaimDetail {
  return {
    id: CLAIM_ID,
    kind: 'claim',
    status: 'open',
    target_type: 'product',
    target_id: 't-1',
    target: { id: 't-1', name: 'Procore', slug: 'procore' },
    submitter_email: 'submitter@vendor.test',
    submitter_name: 'Sam Submitter',
    submitter_role: 'Product Manager',
    submitter_linkedin_url: null,
    domain_match: 'match',
    body: 'We build this product and would like to claim the listing.',
    source_url: null,
    is_duplicate: false,
    has_auth_account: null,
    linear_issue_id: null,
    linear_issue_url: null,
    created_at: '2026-06-01T00:00:00.000Z',
    resolved_at: null,
    resolved_by: null,
    duplicate_of_request_id: null,
    existing_seats: [],
    seat_emails_available: true,
    related_requests: [],
    entitlement_vendor: { id: VENDOR_ID, name: 'Autodesk, Inc.', slug: 'autodesk' },
    product_roles: { application: 1, connector: 0, hybrid: 0, total: 1 },
    is_pure_connector_vendor: false,
    owned_integrations: { integrations: 0, connector_evidenced: 2, total: 2 },
    admin_notes: null,
    context_product: null,
    // AECI-1322: a resolved fixture was granted unless a test says otherwise.
    granted: (over.status ?? 'open') === 'resolved',
    routed_to_owners_at: null,
    owner_fallback_at: null,
    // AECI-1420: the claimant's existing seat. Default: unknown.
    claimant_seat: null,
    duplicate_siblings: [],
    ...over,
  };
}

interface ApiMock {
  getClaim: ReturnType<typeof vi.fn>;
  saveNotes: ReturnType<typeof vi.fn>;
  listAudit: ReturnType<typeof vi.fn>;
}

const ADMIN_ID = '00000000-0000-4000-8000-0000000000aa';

function makeAuditRow(over: Partial<AdminAuditRow> = {}): AdminAuditRow {
  return {
    id: '00000000-0000-4000-8000-0000000000a1',
    action: 'vendor_request.created',
    actor: null,
    actor_type: 'user',
    entity_type: 'vendor_request',
    entity_id: CLAIM_ID,
    created_at: '2026-06-01T00:00:00.000Z',
    before_state: null,
    after_state: { status: 'open' },
    ...over,
  };
}

function makeAudit(rows: AdminAuditRow[] = [makeAuditRow()]): AdminClaimAuditResponse {
  return { data: rows, page: 1, perPage: 25, total: rows.length, actor_emails_available: true };
}

/**
 * `detail` is the loaded claim; `failWith` makes the load reject instead.
 *
 * Two parameters rather than a `Detail | Error` union on purpose:
 * **`HttpErrorResponse` does not extend `Error`** (it extends `HttpResponseBase`),
 * so an `instanceof Error` discriminator silently returns the error object AS the
 * claim and the page renders a blank success. Ask for a failure explicitly.
 */
function makeApiMock(
  detail: AdminClaimDetail,
  failWith?: HttpErrorResponse,
  audit: AdminClaimAuditResponse | HttpErrorResponse = makeAudit(),
): ApiMock {
  return {
    listAudit: vi.fn(async () => {
      if (audit instanceof HttpErrorResponse) throw audit;
      return structuredClone(audit);
    }),
    getClaim: vi.fn(async () => {
      if (failWith) throw failWith;
      return structuredClone(detail);
    }),
    saveNotes: vi.fn(async (_id: string, notes: string | null) =>
      structuredClone({ ...detail, admin_notes: notes }),
    ),
  };
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

async function setup(api: ApiMock, id: string = CLAIM_ID) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: AdminClaimsApi, useValue: api },
      {
        provide: ActivatedRoute,
        useValue: { snapshot: { paramMap: new Map([['id', id]]) } },
      },
    ],
  });
  const fixture = TestBed.createComponent(ClaimDetail);
  fixture.detectChanges();
  await fixture.whenStable();
  await settle();
  fixture.detectChanges();
  return { fixture, api, el: fixture.nativeElement as HTMLElement };
}

function noteField(el: HTMLElement): HTMLTextAreaElement {
  const field = el.querySelector('#admin-claim-note-field');
  if (!field) throw new Error('No operator-note field');
  return field as HTMLTextAreaElement;
}

function buttonByText(root: HTMLElement, text: string): HTMLButtonElement {
  const btn = [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
  if (!btn) throw new Error(`No button "${text}"`);
  return btn as HTMLButtonElement;
}

async function typeNote(
  fixture: { detectChanges(): void },
  el: HTMLElement,
  value: string,
): Promise<void> {
  const field = noteField(el);
  field.value = value;
  field.dispatchEvent(new Event('input'));
  fixture.detectChanges();
  await settle();
  fixture.detectChanges();
}

describe('ClaimDetail', () => {
  describe('the heading names the entity (AECI-777)', () => {
    it('shows the claim\'s TARGET once loaded, not the words "Vendor claim"', async () => {
      // A claim has no name of its own; what an operator recognises it by is what
      // is being claimed.
      const { el } = await setup(makeApiMock(makeDetail()));
      expect(el.querySelector('#admin-claim-heading')?.textContent?.trim()).toBe('Procore');
    });

    it('falls back when the target row is gone, not to a blank heading', async () => {
      // A claim outlives a retracted product, so `target` can be null on a row
      // that still needs moderating.
      const { el } = await setup(makeApiMock(makeDetail({ target: null })));
      expect(el.querySelector('#admin-claim-heading')?.textContent?.trim()).toBe('Unknown product');
    });

    it('no longer renders a bespoke back link', async () => {
      const { el } = await setup(makeApiMock(makeDetail()));
      const hrefs = [...el.querySelectorAll('a')].map((a) => a.getAttribute('href'));
      expect(hrefs).not.toContain('/admin/claims');
    });
  });

  // ── AECI-847: the claimant-supplied LinkedIn profile ─────────────────────
  describe('the LinkedIn identity signal', () => {
    const linkedInHrefs = (el: HTMLElement) =>
      [...el.querySelectorAll('a')]
        .map((a) => a.getAttribute('href') ?? '')
        .filter((h) => h.includes('linkedin.com'));

    it("links the claimant's own profile when they supplied one", async () => {
      const { el } = await setup(
        makeApiMock(
          makeDetail({ submitter_linkedin_url: 'https://www.linkedin.com/in/sam-submitter' }),
        ),
      );
      expect(linkedInHrefs(el)).toEqual(['https://www.linkedin.com/in/sam-submitter']);
    });

    it('falls back to the name search only when nothing was supplied', async () => {
      const { el } = await setup(makeApiMock(makeDetail({ submitter_linkedin_url: null })));
      const hrefs = linkedInHrefs(el);
      expect(hrefs).toHaveLength(1);
      expect(hrefs[0]).toContain('/search/results/people/');
      expect(hrefs[0]).toContain('Sam%20Submitter');
    });

    // A guess shown beside real evidence reads as corroboration of it. Only one
    // person link is ever rendered.
    it('never shows the search guess alongside a supplied profile', async () => {
      const { el } = await setup(
        makeApiMock(makeDetail({ submitter_linkedin_url: 'https://uk.linkedin.com/in/sam' })),
      );
      expect(linkedInHrefs(el).some((h) => h.includes('/search/results/'))).toBe(false);
    });

    it('searches on the email when the claimant left their name blank', async () => {
      const { el } = await setup(
        makeApiMock(makeDetail({ submitter_name: null, submitter_linkedin_url: null })),
      );
      expect(linkedInHrefs(el)[0]).toContain(encodeURIComponent('submitter@vendor.test'));
    });
  });

  // AECI-1420: the same red box the queue shows, with no Grant to disable here.
  describe('account conflict box', () => {
    const OTHER = { id: 'v-other', slug: 'other-co', name: 'Other Co' };

    it('names the other vendor and links it', async () => {
      const { el } = await setup(
        makeApiMock(makeDetail({ claimant_seat: { kind: 'other_vendor', vendor: OTHER } })),
      );
      const box = el.querySelector<HTMLElement>('[data-testid="claim-account-conflict"]');
      expect(box?.textContent).toContain('This address already holds a seat on');
      expect(box?.textContent).toContain('Other Co');
      expect(box?.textContent).toContain('Reject it.');
      expect(box?.id).toBe('claim-account-conflict');
      expect(
        box?.querySelector('[data-testid="claim-account-conflict-vendor"]')?.getAttribute('href'),
      ).toBe('/admin/vendors/v-other');
    });

    it('says a site admin account cannot hold a vendor seat', async () => {
      const { el } = await setup(makeApiMock(makeDetail({ claimant_seat: { kind: 'admin' } })));
      const box = el.querySelector('[data-testid="claim-account-conflict"]');
      expect(box?.textContent).toContain('This address is a site admin account.');
      expect(box?.textContent).toContain('Reject it.');
    });

    it('says a rejected claim is rejected, without claiming who rejected it', async () => {
      const { el } = await setup(
        makeApiMock(
          makeDetail({
            status: 'rejected',
            claimant_seat: { kind: 'other_vendor', vendor: OTHER },
          }),
        ),
      );
      const box = el.querySelector('[data-testid="claim-account-conflict"]');
      expect(box?.textContent).toContain('This claim is rejected.');
      expect(box?.textContent).not.toContain('Reject it.');
    });

    it.each([
      ['none', { kind: 'none' as const }],
      ['unknown', null],
    ])('shows no box for claimant_seat %s', async (_label, seat) => {
      const { el } = await setup(makeApiMock(makeDetail({ claimant_seat: seat })));
      expect(el.querySelector('[data-testid="claim-account-conflict"]')).toBeNull();
    });
  });

  // AECI-1293: the claimant's comments, labelled. AECI-1365 removed the plan row.
  it('shows the comments and no plan interest row', async () => {
    const { el } = await setup(makeApiMock(makeDetail({ body: 'We make four products.' })));
    expect(el.textContent).not.toContain('Plan interest');
    const comments = el.querySelector('[data-testid="claim-detail-comments"]')!;
    expect(comments.textContent).toContain('Comments');
    expect(comments.textContent).toContain('We make four products.');
  });

  // AECI-1364: a claim is on the company; the product page it came from is named.
  it('shows "Came from" with the product page link (AECI-1364)', async () => {
    const { el } = await setup(
      makeApiMock(
        makeDetail({
          target_type: 'vendor',
          target: { id: VENDOR_ID, name: 'Autodesk, Inc.', slug: 'autodesk' },
          context_product: { id: 'p-1', name: 'Autodesk Construction Cloud', slug: 'acc' },
        }),
      ),
    );
    const row = el.querySelector('[data-testid="claim-detail-context-product"]');
    expect(row?.textContent).toContain('Came from');
    expect(row?.textContent).toContain('Autodesk Construction Cloud');
    expect(row?.querySelector('a')?.getAttribute('href')).toContain('/products/acc');
  });

  it('shows no "Came from" on a company-page claim (AECI-1364)', async () => {
    const { el } = await setup(makeApiMock(makeDetail({ context_product: null })));
    expect(el.querySelector('[data-testid="claim-detail-context-product"]')).toBeNull();
  });

  it('shows the owned-integration count beside the role breakdown (AECI-1041)', async () => {
    const { el } = await setup(makeApiMock(makeDetail()));
    expect(el.textContent).toContain('Integrations owned');
    expect(el.textContent).toContain('2 (via a connector)');
  });

  it('labels a seat by name, else by email, never "Unnamed seat" (AECI-1277)', async () => {
    const seat = { work_email_verified: false, created_at: '2026-05-01T00:00:00.000Z' };
    const { el } = await setup(
      makeApiMock(
        makeDetail({
          existing_seats: [
            { ...seat, display_name: 'Named Admin', email: 'named@procore.com' },
            { ...seat, display_name: null, email: 'holder@gmail.com' },
            { ...seat, display_name: null, email: null },
          ],
          seat_emails_available: false,
        }),
      ),
    );
    const text = el.textContent ?? '';
    expect(text).toContain('Named Admin');
    expect(text).not.toContain('named@procore.com');
    expect(text).toContain('holder@gmail.com');
    expect(text).toContain('Email unavailable');
    expect(text).not.toContain('Unnamed seat');
  });

  it('loads the claim by its route param', async () => {
    const { el, api } = await setup(makeApiMock(makeDetail()));
    expect(api.getClaim).toHaveBeenCalledWith(CLAIM_ID);
    expect(el.textContent).toContain('Procore');
    expect(el.textContent).toContain('submitter@vendor.test');
  });

  it('renders 404 as "no claim with that id"', async () => {
    const { el } = await setup(makeApiMock(makeDetail(), new HttpErrorResponse({ status: 404 })));
    expect(el.textContent).toContain('No claim with that id');
    expect(el.querySelector('#admin-claim-note-field')).toBeNull();
  });

  it('renders 422 as "that is a correction", NOT as not-found', async () => {
    // The two are different wrong turns: the row exists, it is just moderated
    // somewhere else. Collapsing them would send an operator hunting for it.
    const { el } = await setup(makeApiMock(makeDetail(), new HttpErrorResponse({ status: 422 })));
    expect(el.textContent).toContain('correction');
    expect(el.textContent).not.toContain('No claim with that id');
    const link = [...el.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(link).toContain('/admin/requests');
  });

  it('renders any other failure as retryable', async () => {
    const { el, fixture, api } = await setup(
      makeApiMock(makeDetail(), new HttpErrorResponse({ status: 500 })),
    );
    expect(el.querySelector('[role="alert"]')?.textContent).toContain("couldn't load");
    buttonByText(el, 'Try again').click();
    fixture.detectChanges();
    await settle();
    expect(api.getClaim).toHaveBeenCalledTimes(2);
  });

  describe('operator note', () => {
    it('seeds the field from the stored note and disables Save until it changes', async () => {
      const { el } = await setup(makeApiMock(makeDetail({ admin_notes: 'Parked.' })));
      expect(noteField(el).value).toBe('Parked.');
      expect(buttonByText(el, 'Save note').disabled).toBe(true);
    });

    it('saves a trimmed note and announces it', async () => {
      const { el, fixture, api } = await setup(makeApiMock(makeDetail()));
      await typeNote(fixture, el, '  Routed to the partnership track.  ');
      buttonByText(el, 'Save note').click();
      fixture.detectChanges();
      await settle();
      fixture.detectChanges();

      expect(api.saveNotes).toHaveBeenCalledWith(CLAIM_ID, 'Routed to the partnership track.');
      expect(el.querySelector('[role="status"]')?.textContent).toContain('saved');
      // Patched in place from the response — no refetch.
      expect(api.getClaim).toHaveBeenCalledTimes(1);
    });

    it('refetches the audit trail on page 1 after a save (AECI-1276)', async () => {
      const api = makeApiMock(makeDetail());
      const { el, fixture } = await setup(api);
      expect(api.listAudit).toHaveBeenCalledTimes(1);

      api.listAudit.mockResolvedValueOnce(
        makeAudit([
          makeAuditRow({
            id: '00000000-0000-4000-8000-0000000000a2',
            action: 'vendor_claim.note_updated',
            actor: { id: ADMIN_ID, display_name: 'Ops Admin', email: 'ops@aeci.test' },
            actor_type: 'admin',
            created_at: '2026-06-02T00:00:00.000Z',
            before_state: { admin_notes: null },
            after_state: { admin_notes: 'Parked.' },
          }),
          makeAuditRow(),
        ]),
      );
      await typeNote(fixture, el, 'Parked.');
      buttonByText(el, 'Save note').click();
      fixture.detectChanges();
      await settle();
      fixture.detectChanges();

      expect(api.listAudit).toHaveBeenCalledTimes(2);
      expect(api.listAudit).toHaveBeenLastCalledWith(CLAIM_ID, { page: 1, perPage: 25 });
      expect(el.querySelector('aec-audit-trail')?.textContent).toContain('Ops Admin');
    });

    it('sends null when the field is emptied — "clear" and "blank" are one action', async () => {
      const { el, fixture, api } = await setup(makeApiMock(makeDetail({ admin_notes: 'Parked.' })));
      await typeNote(fixture, el, '   ');
      buttonByText(el, 'Save note').click();
      fixture.detectChanges();
      await settle();
      fixture.detectChanges();

      expect(api.saveNotes).toHaveBeenCalledWith(CLAIM_ID, null);
      expect(el.querySelector('[role="status"]')?.textContent).toContain('cleared');
    });

    it('discards an edit back to the stored note', async () => {
      const { el, fixture, api } = await setup(makeApiMock(makeDetail({ admin_notes: 'Parked.' })));
      await typeNote(fixture, el, 'Unsaved change.');
      buttonByText(el, 'Discard changes').click();
      fixture.detectChanges();
      expect(noteField(el).value).toBe('Parked.');
      expect(api.saveNotes).not.toHaveBeenCalled();
    });

    it('surfaces a save failure without losing what was typed', async () => {
      const api = makeApiMock(makeDetail());
      api.saveNotes = vi.fn(async () => {
        throw new HttpErrorResponse({ status: 500 });
      });
      const { el, fixture } = await setup(api);
      await typeNote(fixture, el, 'Worth keeping.');
      buttonByText(el, 'Save note').click();
      fixture.detectChanges();
      await settle();
      fixture.detectChanges();

      expect(el.querySelector('[role="alert"]')?.textContent).toContain("couldn't save");
      expect(noteField(el).value).toBe('Worth keeping.');
    });

    it('says a 404 means the claim is gone — retrying cannot help', async () => {
      const api = makeApiMock(makeDetail());
      api.saveNotes = vi.fn(async () => {
        throw new HttpErrorResponse({ status: 404 });
      });
      const { el, fixture } = await setup(api);
      await typeNote(fixture, el, 'x');
      buttonByText(el, 'Save note').click();
      fixture.detectChanges();
      await settle();
      fixture.detectChanges();

      expect(el.querySelector('[role="alert"]')?.textContent).toContain('no longer exists');
    });
  });

  describe('duplicate explanation (§5.2 step 5)', () => {
    it('names the siblings behind the chip and flags a deliberately parked one', async () => {
      const { el } = await setup(
        makeApiMock(
          makeDetail({
            is_duplicate: true,
            duplicate_siblings: [makeSibling({ has_notes: true })],
          }),
        ),
      );
      expect(el.textContent).toContain('other@vendor.test');
      expect(el.textContent).toContain('Has an operator note');
      const links = [...el.querySelectorAll('a')].map((a) => a.getAttribute('href'));
      expect(links).toContain(`/admin/claims/${SIBLING_ID}`);
    });

    it('says so explicitly when nothing is flagged, rather than hiding the section', async () => {
      const { el } = await setup(makeApiMock(makeDetail()));
      expect(el.textContent).toContain('Not flagged');
    });
  });

  it('points "Manage billing" at the vendor Billing tab (AECI-1372)', async () => {
    const { el } = await setup(makeApiMock(makeDetail()));
    const link = [...el.querySelectorAll('a')].find(
      (a) => a.textContent?.trim() === 'Manage billing',
    );
    expect(link?.getAttribute('href')).toBe(`/admin/vendors/${VENDOR_ID}?tab=billing`);
    // AECI-1375: the vendor's name stays beside the link; the entitlement readout is gone.
    expect(link?.parentElement?.textContent).toContain('Autodesk, Inc.');
    const headings = [...el.querySelectorAll('h3, h4')].map((h) => h.textContent?.trim());
    expect(headings).not.toContain('Entitlement');
    expect(el.textContent).not.toContain('No entitlement on record');
  });

  it('explains in_review only at that status', async () => {
    const open = await setup(makeApiMock(makeDetail()));
    expect(open.el.textContent).not.toContain('This claim is in review');

    const inReview = await setup(makeApiMock(makeDetail({ status: 'in_review' })));
    expect(inReview.el.textContent).toContain('This claim is in review');
  });

  describe('audit trail (AECI-1276)', () => {
    it("loads the claim's trail and renders it under its own heading", async () => {
      const { el, api } = await setup(makeApiMock(makeDetail()));
      expect(api.listAudit).toHaveBeenCalledWith(CLAIM_ID, { page: 1, perPage: 25 });
      expect(el.querySelector('#admin-claim-audit')?.textContent?.trim()).toBe('Audit trail');
      const trail = el.querySelector('aec-audit-trail');
      expect(trail).not.toBeNull();
      expect(trail?.querySelectorAll('tbody tr').length).toBeGreaterThan(0);
    });

    it("links the vendor's audit trail when the claim's vendor is known", async () => {
      const { el } = await setup(makeApiMock(makeDetail()));
      const hrefs = [...el.querySelectorAll('#admin-claim-audit ~ p a')].map((a) =>
        a.getAttribute('href'),
      );
      expect(hrefs).toContain(`/admin/vendors/${VENDOR_ID}`);
    });

    it('omits the vendor link when no vendor resolved', async () => {
      const { el } = await setup(makeApiMock(makeDetail({ entitlement_vendor: null })));
      expect(el.querySelectorAll('#admin-claim-audit ~ p a')).toHaveLength(0);
    });

    it('fails soft: the claim, signals and note still render beside the retry', async () => {
      const { el } = await setup(
        makeApiMock(makeDetail(), undefined, new HttpErrorResponse({ status: 500 })),
      );
      expect(el.textContent).toContain('Procore');
      expect(el.querySelector('#admin-claim-signals')).not.toBeNull();
      expect(el.querySelector('#admin-claim-note-field')).not.toBeNull();
      const trail = el.querySelector('aec-audit-trail') as HTMLElement;
      expect(trail.querySelector('[role="alert"]')).not.toBeNull();
      expect(buttonByText(trail, 'Try again')).toBeTruthy();
      // The page-level failure state is not shown.
      expect(el.textContent).not.toContain("We couldn't load this claim");
    });

    it('retries the trail alone', async () => {
      const api = makeApiMock(makeDetail(), undefined, new HttpErrorResponse({ status: 500 }));
      const { el, fixture } = await setup(api);
      api.listAudit.mockResolvedValueOnce(makeAudit());
      buttonByText(el.querySelector('aec-audit-trail') as HTMLElement, 'Try again').click();
      fixture.detectChanges();
      await settle();
      fixture.detectChanges();
      expect(api.listAudit).toHaveBeenCalledTimes(2);
      expect(api.getClaim).toHaveBeenCalledTimes(1);
      expect(el.querySelector('aec-audit-trail [role="alert"]')).toBeNull();
    });

    it('does not fetch a trail on 404 or 422', async () => {
      const missing = await setup(
        makeApiMock(makeDetail(), new HttpErrorResponse({ status: 404 })),
      );
      expect(missing.api.listAudit).not.toHaveBeenCalled();
      const correction = await setup(
        makeApiMock(makeDetail(), new HttpErrorResponse({ status: 422 })),
      );
      expect(correction.api.listAudit).not.toHaveBeenCalled();
    });
  });

  describe('the has_auth_account signal is worded for the claim status (AECI-1278)', () => {
    function accountSignal(el: HTMLElement): string {
      const dt = [...el.querySelectorAll('dt')].find(
        (d) => d.textContent?.trim() === 'Claimant account',
      );
      return dt?.nextElementSibling?.textContent?.trim() ?? '';
    }

    const cases: [AdminClaimDetail['status'], boolean | null, string][] = [
      ['open', true, 'Existing account: approve links it'],
      ['open', false, 'No account: approve provisions one'],
      ['in_review', true, 'Existing account: approve links it'],
      ['resolved', true, 'Account exists (claim granted)'],
      ['resolved', false, 'No account found'],
      ['rejected', true, 'Existing account'],
      ['rejected', false, 'No account'],
      ['rejected', null, 'Account status unknown'],
    ];

    it.each(cases)('%s + %s reads "%s"', async (status, hasAccount, expected) => {
      const { el } = await setup(makeApiMock(makeDetail({ status, has_auth_account: hasAccount })));
      expect(accountSignal(el)).toBe(expected);
    });

    // AECI-1322: moving the Linear issue to Done resolves a claim with no grant.
    it.each([true, false, null])(
      'a resolved claim with no grant reads "Resolved without a grant" (account %s)',
      async (hasAccount) => {
        const { el } = await setup(
          makeApiMock(
            makeDetail({ status: 'resolved', granted: false, has_auth_account: hasAccount }),
          ),
        );
        expect(accountSignal(el)).toBe('Resolved without a grant');
      },
    );
  });

  describe('structural a11y', () => {
    it('keeps heading order h2 → h3 → h4 with no skips', async () => {
      const { el } = await setup(makeApiMock(makeDetail({ duplicate_siblings: [makeSibling()] })));
      expect(el.querySelectorAll('h2')).toHaveLength(1);
      expect(el.querySelectorAll('h3').length).toBeGreaterThan(0);
      expect(el.querySelector('h5, h6')).toBeNull();
    });

    it('exposes EXACTLY ONE polite live region', async () => {
      const { el } = await setup(makeApiMock(makeDetail({ duplicate_siblings: [makeSibling()] })));
      const regions = el.querySelectorAll('[role="status"]');
      expect(regions).toHaveLength(1);
      expect(regions[0].getAttribute('aria-live')).toBe('polite');
    });

    it('gives the note field a real label', async () => {
      const { el } = await setup(makeApiMock(makeDetail()));
      const label = el.querySelector('label[for="admin-claim-note-field"]');
      expect(label?.textContent?.trim()).toBeTruthy();
    });
  });
});
