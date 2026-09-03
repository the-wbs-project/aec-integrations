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

import type { AdminClaimDetail, ClaimDuplicateSibling } from '@aeci/shared';

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
    related_requests: [],
    entitlement_vendor: { id: VENDOR_ID, name: 'Autodesk, Inc.', slug: 'autodesk' },
    entitlement: null,
    product_roles: { application: 1, connector: 0, hybrid: 0, total: 1 },
    is_pure_connector_vendor: false,
    admin_notes: null,
    duplicate_siblings: [],
    ...over,
  };
}

interface ApiMock {
  getClaim: ReturnType<typeof vi.fn>;
  saveNotes: ReturnType<typeof vi.fn>;
}

/**
 * `detail` is the loaded claim; `failWith` makes the load reject instead.
 *
 * Two parameters rather than a `Detail | Error` union on purpose:
 * **`HttpErrorResponse` does not extend `Error`** (it extends `HttpResponseBase`),
 * so an `instanceof Error` discriminator silently returns the error object AS the
 * claim and the page renders a blank success. Ask for a failure explicitly.
 */
function makeApiMock(detail: AdminClaimDetail, failWith?: HttpErrorResponse): ApiMock {
  return {
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

  it('explains in_review only at that status', async () => {
    const open = await setup(makeApiMock(makeDetail()));
    expect(open.el.textContent).not.toContain('This claim is in review');

    const inReview = await setup(makeApiMock(makeDetail({ status: 'in_review' })));
    expect(inReview.el.textContent).toContain('This claim is in review');
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
