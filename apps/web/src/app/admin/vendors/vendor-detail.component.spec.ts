/**
 * AECI-652 — `VendorDetail` logic + structural a11y.
 *
 * Three groups earn their keep beyond the happy path:
 *
 *  - **The seats tri-state.** `null` means the roster is unavailable; `[]` means
 *    the vendor genuinely has none; and `seat_emails_available: false` means every
 *    blank email is the seam's fault, not the account's. Conflating any two of
 *    those is what made "Account status unknown" read as a data fact for a day in
 *    production.
 *  - **The scope boundary.** This screen can revoke a seat and cannot ban a
 *    person. Asserted so a later PR cannot quietly cross it.
 *  - **The diff renderer.** `before_state`/`after_state` are free-form JSON from
 *    ~34 writers across the life of the schema, in a table nothing prunes — so a
 *    scalar, an added key and a removed key all have to render rather than throw.
 */
import { HttpErrorResponse } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AdminAuditRow,
  AdminVendorAuditResponse,
  AdminVendorDetail,
  AdminVendorSeatRow,
} from '@aeci/shared';

import { AdminEntitlementApi } from '../entitlement/admin-entitlement-api';
import { AdminVendorsApi } from './admin-vendors-api';
import { SeatProvisionApi } from './seat-provision-api';
import { VendorDetail } from './vendor-detail';

const VENDOR_ID = '00000000-0000-4000-8000-000000000010';
const SEAT_ID = '00000000-0000-4000-8000-000000000020';

function makeSeat(over: Partial<AdminVendorSeatRow> = {}): AdminVendorSeatRow {
  return {
    user_id: SEAT_ID,
    display_name: 'Ada Lovelace',
    email: 'ada@autodesk.com',
    banned: false,
    owner: true,
    role: 'vendor_admin',
    work_email_verified: true,
    created_at: '2026-02-01T00:00:00.000Z',
    ...over,
  };
}

function makeVendor(over: Partial<AdminVendorDetail> = {}): AdminVendorDetail {
  return {
    id: VENDOR_ID,
    slug: 'autodesk',
    company_name: 'Autodesk, Inc.',
    description: null,
    website: 'https://autodesk.com',
    headquarters: 'San Francisco, CA',
    logo_url: null,
    verified: true,
    promotion_status: 'promoted',
    maintained_by: 'aeci',
    last_reviewed_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-08-20T00:00:00.000Z',
    entitlement: null,
    seats: [makeSeat()],
    seat_emails_available: true,
    pending_invites: [],
    product_count: 4,
    // AECI-738: the §5.2 payer test. Default is a mixed vendor — 3 endpoint
    // products and 1 connector, i.e. the Autodesk shape the flag must NOT catch.
    product_roles: { application: 3, connector: 1, hybrid: 0, total: 4 },
    is_pure_connector_vendor: false,
    integration_count: 2,
    claim_counts: { open: 1, in_review: 0, resolved: 2, rejected: 1 },
    ...over,
  };
}

function makeAuditRow(over: Partial<AdminAuditRow> = {}): AdminAuditRow {
  return {
    id: '00000000-0000-4000-8000-000000000100',
    action: 'vendor_entitlement.set',
    actor: { id: SEAT_ID, display_name: 'Ada Lovelace', email: 'ada@autodesk.com' },
    actor_type: 'admin',
    entity_type: 'vendor_entitlement',
    entity_id: VENDOR_ID,
    created_at: '2026-08-20T00:00:00.000Z',
    before_state: null,
    after_state: null,
    ...over,
  };
}

interface ApiMock {
  getVendor: ReturnType<typeof vi.fn>;
  listAudit: ReturnType<typeof vi.fn>;
  revokeSeat: ReturnType<typeof vi.fn>;
}

function makeApiMock(vendor: AdminVendorDetail, auditRows: AdminAuditRow[] = []): ApiMock {
  const audit: AdminVendorAuditResponse = {
    data: auditRows,
    page: 1,
    perPage: 25,
    total: auditRows.length,
    actor_emails_available: true,
  };
  return {
    getVendor: vi.fn(async () => structuredClone(vendor)),
    listAudit: vi.fn(async () => structuredClone(audit)),
    revokeSeat: vi.fn(async () => undefined),
  };
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

/** `SeatProvisionApi`, stubbed (AECI-740). A second optional argument rather than
 *  a field on {@link ApiMock}, because the provision endpoint has its own client
 *  by design — the ONE writer of `role = 'vendor_admin'` gets exactly one caller,
 *  so the blast radius is greppable. */
type ProvisionMock = { provisionSeat: ReturnType<typeof vi.fn> };

async function setup(api: ApiMock, provisionApi: ProvisionMock = { provisionSeat: vi.fn() }) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: AdminVendorsApi, useValue: api },
      { provide: AdminEntitlementApi, useValue: { setEntitlement: vi.fn() } },
      { provide: SeatProvisionApi, useValue: provisionApi },
      {
        provide: ActivatedRoute,
        useValue: { snapshot: { paramMap: new Map([['id', VENDOR_ID]]) } },
      },
    ],
  });
  const fixture = TestBed.createComponent(VendorDetail);
  fixture.detectChanges();
  await fixture.whenStable();
  await settle();
  fixture.detectChanges();
  return { fixture, api, provisionApi, el: fixture.nativeElement as HTMLElement };
}

function buttonByText(root: HTMLElement, text: string): HTMLButtonElement | undefined {
  return [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) as
    | HTMLButtonElement
    | undefined;
}

/** The expanded diff, which lives in the row the toggle controls. Scoped rather
 *  than `querySelector('table')`: since AECI-694 the seats, the invites and the
 *  audit trail are all tables, and the first one on the page is the seats table. */
function diffTable(el: HTMLElement): HTMLTableElement | null {
  return el.querySelector('[id^="audit-diff-"] table');
}

describe('VendorDetail', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => vi.restoreAllMocks());

  it('renders all four sections', async () => {
    const { el } = await setup(makeApiMock(makeVendor()));
    const headings = [...el.querySelectorAll('h3')].map((h) => h.textContent?.trim());
    expect(headings).toEqual(['Basics', 'Entitlement', 'Seats', 'Audit trail']);
  });

  it('renders the basics and all four claim-count buckets', async () => {
    const { el } = await setup(makeApiMock(makeVendor()));
    expect(el.textContent).toContain('Autodesk, Inc.');
    expect(el.textContent).toContain('San Francisco, CA');
    // Three buckets would give an operator numbers that quietly fail to sum.
    expect(el.textContent).toContain('Claims open');
    expect(el.textContent).toContain('In review');
    expect(el.textContent).toContain('Approved');
    expect(el.textContent).toContain('Rejected');
  });

  it('renders a 404 as "no vendor with that id", not as a retryable failure', async () => {
    const api = makeApiMock(makeVendor());
    api.getVendor.mockRejectedValueOnce({ status: 404 });
    const { el } = await setup(api);
    expect(el.textContent).toContain('No vendor with that id');
    expect(el.querySelector('[role="alert"]')).toBeNull();
  });

  it('renders any other failure as retryable', async () => {
    const api = makeApiMock(makeVendor());
    api.getVendor.mockRejectedValueOnce({ status: 500 });
    const { el } = await setup(api);
    expect(el.querySelector('[role="alert"]')).toBeTruthy();
    expect(buttonByText(el, 'Try again')).toBeTruthy();
  });

  describe('entitlement section', () => {
    it('hosts exactly one control and gives it the section heading', async () => {
      const { el } = await setup(makeApiMock(makeVendor()));
      const controls = el.querySelectorAll('aec-entitlement-control');
      expect(controls).toHaveLength(1);
      expect(
        controls[0].querySelector('[aria-labelledby="admin-vendor-entitlement"]'),
      ).toBeTruthy();
    });

    it("updates in place from the control's output, with no refetch of the vendor", async () => {
      const { fixture, api } = await setup(makeApiMock(makeVendor()));
      const before = api.getVendor.mock.calls.length;

      fixture.componentInstance['onEntitlementChanged']({
        vendor_id: VENDOR_ID,
        tier: 'verified',
        status: 'active',
        period_start: null,
        period_end: null,
        granted_at: '2026-08-27T00:00:00.000Z',
        ended_at: null,
        verified: true,
        payer: null,
        amount: null,
        terms: null,
        arranged_by: null,
        invoice_ref: null,
        notes: null,
      });
      await settle();
      fixture.detectChanges();

      // The PATCH returns the committed readout, so a refetch would be a round
      // trip to learn what we were just handed.
      expect(api.getVendor).toHaveBeenCalledTimes(before);
      // The audit trail DID gain a row, though — leaving it stale would put a
      // visible disagreement on the page.
      expect(api.listAudit.mock.calls.length).toBeGreaterThan(1);
    });

    it("routes the control's announcement into the page's live region", async () => {
      const { fixture, el } = await setup(makeApiMock(makeVendor()));
      fixture.componentInstance['onAnnounce']('Entitlement granted.');
      fixture.detectChanges();
      expect(el.querySelector('[role="status"]')?.textContent).toContain('Entitlement granted.');
    });
  });

  describe('the public-page link (AECI-694)', () => {
    it('opens the public page in a new tab, and says so', async () => {
      // An operator opens it to CHECK something against the admin record, so
      // navigating away from the record is the wrong outcome. That is also why
      // it is an href rather than a `routerLink`: an in-app navigation cannot
      // meaningfully open a second tab.
      const { el } = await setup(makeApiMock(makeVendor()));
      const link = [...el.querySelectorAll('a')].find((a) => a.textContent?.trim() === 'View Page');
      expect(link?.getAttribute('href')).toBe('/vendors/autodesk');
      expect(link?.getAttribute('target')).toBe('_blank');
      // Without `noopener` the new browsing context gets a handle on this one.
      expect(link?.getAttribute('rel')).toContain('noopener');
      expect(el.textContent).toContain('opens in a new tab');
    });
  });

  describe('seats', () => {
    it('lists each seat with role, ban state and work-email verification', async () => {
      const { el } = await setup(
        makeApiMock(
          makeVendor({
            seats: [
              makeSeat(),
              makeSeat({
                user_id: '00000000-0000-4000-8000-000000000021',
                display_name: 'Ben',
                banned: true,
                owner: false,
              }),
            ],
          }),
        ),
      );
      expect(el.textContent).toContain('Ada Lovelace');
      expect(el.textContent).toContain('vendor_admin');
      expect(el.textContent).toContain('Work email verified');
      // A banned seat stays on the roster: a ban is a per-seat lock, not a
      // removal, and hiding it leaves nobody able to see why a colleague is out.
      expect(el.textContent).toContain('Ben');
      expect(el.textContent).toContain('Banned');
    });

    it('labels the timestamp "Account created", not "granted"', async () => {
      // `profiles.created_at` is account creation; the seat grant is a
      // `vendor_claim.granted` audit row. Mislabelling it would put a confidently
      // wrong date in front of an operator.
      const { el } = await setup(makeApiMock(makeVendor()));
      expect(el.textContent).toContain('Account created');
      expect(el.textContent).not.toContain('Seat granted');
    });

    it('renders "unavailable" for a null roster, never an empty list', async () => {
      const { el } = await setup(makeApiMock(makeVendor({ seats: null })));
      expect(el.textContent).toContain('The seat roster is unavailable');
      expect(el.textContent).not.toContain('No one has portal access');
    });

    it('renders the genuine empty state for []', async () => {
      const { el } = await setup(makeApiMock(makeVendor({ seats: [] })));
      expect(el.textContent).toContain('No one has portal access');
    });

    it('says the EMAILS are unavailable when the GoTrue seam is down — and still lists the seats', async () => {
      const { el } = await setup(
        makeApiMock(
          makeVendor({ seats: [makeSeat({ email: null })], seat_emails_available: false }),
        ),
      );
      expect(el.textContent).toContain('Email addresses are unavailable');
      expect(el.textContent).toContain('Email unavailable');
      expect(el.textContent).toContain('Ada Lovelace');
    });

    it('says "no email on file" when the seam worked and the account has none', async () => {
      // The distinction the 2026-08-24 incident lacked: a blank means different
      // things depending on whether the lookup succeeded.
      const { el } = await setup(
        makeApiMock(
          makeVendor({ seats: [makeSeat({ email: null })], seat_emails_available: true }),
        ),
      );
      expect(el.textContent).toContain('No email on file');
      expect(el.textContent).not.toContain('Email unavailable');
    });

    it('offers Remove seat and NO ban control — ban lives on the user page', async () => {
      // The scope boundary, asserted so a later PR cannot quietly cross it. A
      // revoke un-grants one vendor's access; a ban locks the human out of AECi
      // entirely. Peer buttons would invite the wrong one.
      //
      // AECI-692 moved only the DESTINATION. The old link pointed at
      // `/admin/reviewers`, which listed only already-banned people and whose one
      // control was Unban — so "Ban this person" for an unbanned seat landed on a
      // page that neither contained them nor could ban anyone. It now points at
      // the person. The "no ban control HERE" half is unchanged and is the part
      // that matters.
      const { el } = await setup(makeApiMock(makeVendor()));
      expect(buttonByText(el, 'Remove seat')).toBeTruthy();
      expect(buttonByText(el, 'Ban')).toBeUndefined();
      expect(buttonByText(el, 'Open user page')).toBeUndefined();
      const userLink = [...el.querySelectorAll('a')].find(
        (a) => a.textContent?.trim() === 'Open user page',
      );
      expect(userLink?.getAttribute('href')).toBe(`/admin/users/${SEAT_ID}`);
    });

    it('confirms before revoking, and says the removal has no undo here', async () => {
      const { el, fixture, api } = await setup(makeApiMock(makeVendor()));

      buttonByText(el, 'Remove seat')!.click();
      fixture.detectChanges();
      expect(el.textContent).toContain('there is no undo on this screen');
      expect(api.revokeSeat).not.toHaveBeenCalled();

      buttonByText(el, 'Confirm removal')!.click();
      await settle();
      fixture.detectChanges();

      expect(api.revokeSeat).toHaveBeenCalledWith(VENDOR_ID, SEAT_ID);
      expect(el.textContent).toContain('No one has portal access');
    });

    it('announces that the revoke left the entitlement and badge alone', async () => {
      const { el, fixture } = await setup(makeApiMock(makeVendor()));
      buttonByText(el, 'Remove seat')!.click();
      fixture.detectChanges();
      buttonByText(el, 'Confirm removal')!.click();
      await settle();
      fixture.detectChanges();

      const live = el.querySelector('[role="status"]')?.textContent ?? '';
      expect(live).toContain('Ada Lovelace');
      expect(live).toContain('entitlement and badge are unchanged');
    });

    it('keeps the seat and explains a 404 rather than dropping the row', async () => {
      const api = makeApiMock(makeVendor());
      api.revokeSeat.mockRejectedValueOnce({ status: 404 });
      const { el, fixture } = await setup(api);

      buttonByText(el, 'Remove seat')!.click();
      fixture.detectChanges();
      buttonByText(el, 'Confirm removal')!.click();
      await settle();
      fixture.detectChanges();

      expect(el.textContent).toContain('already gone');
      expect(el.textContent).toContain('Ada Lovelace');
    });

    it('lists pending invites when there are any', async () => {
      const { el } = await setup(
        makeApiMock(
          makeVendor({
            pending_invites: [
              {
                id: '00000000-0000-4000-8000-000000000070',
                email: 'new@autodesk.com',
                invited_by: 'Ada Lovelace',
                expires_at: '2026-09-10T00:00:00.000Z',
                created_at: '2026-08-27T00:00:00.000Z',
              },
            ],
          }),
        ),
      );
      expect(el.textContent).toContain('Pending invites');
      expect(el.textContent).toContain('new@autodesk.com');
    });
  });

  describe('audit trail', () => {
    it('renders the action, actor and entity', async () => {
      const { el } = await setup(makeApiMock(makeVendor(), [makeAuditRow()]));
      expect(el.textContent).toContain('vendor_entitlement.set');
      expect(el.textContent).toContain('Ada Lovelace');
      expect(el.textContent).toContain('vendor_entitlement');
    });

    it('names a system row "System", never "unknown"', async () => {
      // A null actor is not a failed lookup — it is a cron or the promote
      // Workflow. Saying "unknown" would suggest something went wrong.
      const { el } = await setup(
        makeApiMock(makeVendor(), [
          makeAuditRow({ actor: null, actor_type: 'system', action: 'promote.blocked' }),
        ]),
      );
      expect(el.textContent).toContain('System');
      expect(el.textContent).not.toContain('unknown');
    });

    it('refetches with the chosen scope and resets to page 1', async () => {
      const { el, fixture, api } = await setup(makeApiMock(makeVendor(), [makeAuditRow()]));
      fixture.componentInstance['goToAuditPage'](3);
      await settle();
      fixture.detectChanges();

      buttonByText(el, 'Done by its people')!.click();
      await settle();
      fixture.detectChanges();

      const last = api.listAudit.mock.calls.at(-1)![1] as Record<string, unknown>;
      expect(last['scope']).toBe('actor');
      // A narrower scope on page 4 would land on an empty page that reads as
      // "nothing happened".
      expect(last['page']).toBe(1);
    });

    it("renders an object diff over the union of both sides' keys", async () => {
      const { el, fixture } = await setup(
        makeApiMock(makeVendor(), [
          makeAuditRow({
            before_state: { status: 'active', payer: 'Acme' },
            after_state: { status: 'revoked', invoice_ref: 'PO-9' },
          }),
        ]),
      );
      buttonByText(el, 'Show changes')!.click();
      fixture.detectChanges();

      const text = diffTable(el)?.textContent ?? '';
      expect(text).toContain('status');
      expect(text).toContain('changed');
      // A key present only on one side must still appear — dropping it would hide
      // exactly the field that moved.
      expect(text).toContain('payer');
      expect(text).toContain('removed');
      expect(text).toContain('invoice_ref');
      expect(text).toContain('added');
    });

    it('states the change in words, not by colour alone', async () => {
      const { el, fixture } = await setup(
        makeApiMock(makeVendor(), [
          makeAuditRow({ before_state: { a: 1 }, after_state: { a: 2 } }),
        ]),
      );
      buttonByText(el, 'Show changes')!.click();
      fixture.detectChanges();
      expect(diffTable(el)?.textContent).toContain('changed');
    });

    it('renders a SCALAR snapshot as a single value row instead of throwing', async () => {
      // These rows outlive the code that wrote them and nothing prunes the table,
      // so a shape this renderer has never seen has to degrade, not crash.
      const { el, fixture } = await setup(
        makeApiMock(makeVendor(), [
          makeAuditRow({ before_state: 'a bare string', after_state: 42 }),
        ]),
      );
      buttonByText(el, 'Show changes')!.click();
      fixture.detectChanges();
      const text = diffTable(el)?.textContent ?? '';
      expect(text).toContain('value');
      expect(text).toContain('a bare string');
      expect(text).toContain('42');
    });

    it('offers no diff toggle for a row with no snapshots', async () => {
      const { el } = await setup(makeApiMock(makeVendor(), [makeAuditRow()]));
      expect(buttonByText(el, 'Show changes')).toBeUndefined();
    });

    it('renders the empty state for a scope with no rows', async () => {
      const { el } = await setup(makeApiMock(makeVendor(), []));
      expect(el.textContent).toContain('Nothing recorded for this scope');
    });

    it('says that reading the ledger records nothing', async () => {
      const { el } = await setup(makeApiMock(makeVendor(), [makeAuditRow()]));
      expect(el.textContent).toContain('opening it records nothing');
    });

    it('says what happened in English, and still shows the raw token (AECI-694)', async () => {
      // The description is what makes the ledger readable by someone who has not
      // memorised the vocabulary; the token is what makes a row greppable against
      // a log line. Both, not either.
      const { el } = await setup(makeApiMock(makeVendor(), [makeAuditRow()]));
      expect(el.textContent).toContain('Entitlement set');
      expect(el.textContent).toContain('vendor_entitlement.set');
    });
  });

  describe('accessibility (structural)', () => {
    it('renders seats, invites and the audit trail as named, scoped tables (AECI-694)', async () => {
      const { el } = await setup(
        makeApiMock(
          makeVendor({
            pending_invites: [
              {
                id: '00000000-0000-4000-8000-0000000009f1',
                email: 'new@autodesk.com',
                invited_by: 'Ada Lovelace',
                expires_at: '2026-09-10T00:00:00.000Z',
                created_at: '2026-08-20T00:00:00.000Z',
              },
            ],
          }),
          [makeAuditRow()],
        ),
      );
      const tables = [...el.querySelectorAll('table')];
      expect(tables.length).toBeGreaterThanOrEqual(3);
      for (const table of tables) {
        expect(table.querySelector('caption')?.textContent?.trim()).toBeTruthy();
        for (const th of table.querySelectorAll('thead th')) {
          expect(th.getAttribute('scope')).toBe('col');
        }
      }
    });

    it('nests headings without skipping levels (shell owns h1; h2 → h3 sections)', async () => {
      const { el } = await setup(makeApiMock(makeVendor(), [makeAuditRow()]));
      expect(el.querySelectorAll('h1')).toHaveLength(0);
      expect(el.querySelectorAll('h2')).toHaveLength(1);
      expect(el.querySelectorAll('h3')).toHaveLength(4);
      expect(el.querySelector('h4, h5, h6')).toBeNull();
    });

    it('exposes EXACTLY ONE polite live region for the whole page', async () => {
      // The entitlement control and the seat revoke both feed it. A control that
      // rendered its own would give this page two.
      const { el } = await setup(makeApiMock(makeVendor(), [makeAuditRow()]));
      const regions = el.querySelectorAll('[role="status"]');
      expect(regions).toHaveLength(1);
      expect(regions[0].getAttribute('aria-live')).toBe('polite');
    });

    it('gives the audit scope switch an accessible group name', async () => {
      const { el } = await setup(makeApiMock(makeVendor(), [makeAuditRow()]));
      const group = el.querySelector('[role="group"]');
      const labelId = group?.getAttribute('aria-labelledby');
      expect(labelId).toBeTruthy();
      expect(el.querySelector(`#${labelId}`)?.textContent?.trim()).toBeTruthy();
    });

    it('wires the diff toggle to what it controls', async () => {
      const { el } = await setup(
        makeApiMock(makeVendor(), [makeAuditRow({ after_state: { a: 1 } })]),
      );
      const toggle = buttonByText(el, 'Show changes')!;
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(toggle.getAttribute('aria-controls')).toBeTruthy();
    });
  });
});

/** The §5.2 payer-test row (AECI-738). */
describe('VendorDetail — products by role', () => {
  it('names every role, including application', async () => {
    const { el } = await setup(makeApiMock(makeVendor()));
    // Autodesk owns a connector-role product and is a major endpoint account.
    // The breakdown must say so rather than leave the operator to infer
    // "endpoint" from an absent chip on a public page.
    expect(el.textContent).toContain('3 application');
    expect(el.textContent).toContain('1 connector');
    expect(el.textContent).not.toContain('pure connector');
  });

  it('marks a vendor whose every product is a connector', async () => {
    const { el } = await setup(
      makeApiMock(
        makeVendor({
          product_count: 2,
          product_roles: { application: 0, connector: 2, hybrid: 0, total: 2 },
          is_pure_connector_vendor: true,
        }),
      ),
    );
    expect(el.textContent).toContain('pure connector');
    expect(el.textContent).toContain('not sold verification');
  });

  it('shows a vendor with no products as unrecorded, never as a carve-out', async () => {
    const { el } = await setup(
      makeApiMock(
        makeVendor({
          product_count: 0,
          product_roles: { application: 0, connector: 0, hybrid: 0, total: 0 },
          is_pure_connector_vendor: false,
        }),
      ),
    );
    expect(el.textContent).toContain('No products on record');
    expect(el.textContent).not.toContain('pure connector');
  });
});

// ─── AECI-740: provisioning a seat ───────────────────────────────────────────

/**
 * The provision control's two load-bearing properties.
 *
 * **It warns and never gates.** `product_role` is curated upstream in the review
 * app, so a mis-roled record must not hard-block a legitimate operator — the
 * AECI-738 rule verbatim (`STAGE_2_VENDOR_PORTAL_SPEC.md` §5.2 step 1). A test
 * rather than a comment because "add a `[disabled]`" is the obvious-looking
 * hardening somebody will reach for, and it would break the endpoint's whole
 * purpose on exactly the vendors most likely to be mis-roled.
 *
 * **The announcement names what did NOT happen.** A screen-reader user must not
 * have to go and read the Basics table to find out whether provisioning verified
 * the vendor.
 */
describe('VendorDetail — provisioning a seat (AECI-740)', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => vi.restoreAllMocks());

  const openForm = async (el: HTMLElement, fixture: { detectChanges(): void }) => {
    buttonByText(el, 'Add a seat')!.click();
    fixture.detectChanges();
    await settle();
    fixture.detectChanges();
  };

  /** Type an address. The submit button is legitimately disabled while the field
   *  is empty — that is field validation, NOT the payer-test gate — so every
   *  "stays enabled" assertion has to fill it first or it proves nothing. */
  const typeEmail = (
    el: HTMLElement,
    fixture: { detectChanges(): void },
    value = 'ops@mindcloud.example',
  ) => {
    const input = el.querySelector<HTMLInputElement>('input[type="email"]')!;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  };

  it('renders the control, and says what the seat is NOT', async () => {
    const { el } = await setup(makeApiMock(makeVendor()));

    expect(el.querySelector('aec-provision-seat-control')).toBeTruthy();
    const text = el.textContent ?? '';
    // The distinction from Grant, stated on the page rather than assumed.
    expect(text).toContain('opens no entitlement');
    expect(text).toContain('does not turn on the verified badge');
  });

  it('warns on a vendor that owns endpoint products, WITHOUT disabling the action', async () => {
    // The default fixture is the Autodesk shape — 3 application + 1 connector —
    // i.e. an ordinary paying vendor that the carve-out must not catch.
    const { el, fixture } = await setup(makeApiMock(makeVendor()));
    await openForm(el, fixture);
    typeEmail(el, fixture);

    expect(el.textContent).toContain('This vendor owns endpoint products');
    const submit = buttonByText(el, 'Add the seat');
    expect(submit).toBeTruthy();
    // THE assertion. The banner warns; it does not gate.
    expect(submit!.disabled).toBe(false);
  });

  it('shows no warning for a pure connector vendor — the case it is built for', async () => {
    const vendor = makeVendor({
      product_roles: { application: 0, connector: 2, hybrid: 0, total: 2 },
      is_pure_connector_vendor: true,
    });
    const { el, fixture } = await setup(makeApiMock(vendor));
    await openForm(el, fixture);

    expect(el.textContent).not.toContain('This vendor owns endpoint products');
    expect(el.textContent).not.toContain('role is unknown');
  });

  it('treats a vendor with NO products as unknown, not exempt', async () => {
    // AECI-738's rule: zero products never reads as the carve-out.
    const vendor = makeVendor({
      product_count: 0,
      product_roles: { application: 0, connector: 0, hybrid: 0, total: 0 },
      is_pure_connector_vendor: false,
    });
    const { el, fixture } = await setup(makeApiMock(vendor));
    await openForm(el, fixture);
    typeEmail(el, fixture);

    expect(el.textContent).toContain('role is unknown');
    expect(buttonByText(el, 'Add the seat')!.disabled).toBe(false);
  });

  it('refreshes the roster and the audit trail, and announces what did not happen', async () => {
    const api = makeApiMock(makeVendor());
    const provision = {
      provisionSeat: vi.fn(async () => ({
        user_id: SEAT_ID,
        vendor_id: VENDOR_ID,
        email: 'ops@mindcloud.example',
        identity_outcome: 'invited' as const,
        seat_created: true,
        seat_owner: true,
        banned: false,
        noop: false,
        entitlement_granted: false as const,
        verified: false,
        is_pure_connector_vendor: true,
        product_roles: { application: 0, connector: 1, hybrid: 0, total: 1 },
      })),
    };
    const { el, fixture } = await setup(api, provision);
    await openForm(el, fixture);

    typeEmail(el, fixture);

    buttonByText(el, 'Add the seat')!.click();
    await settle();
    fixture.detectChanges();
    await settle();
    fixture.detectChanges();

    expect(provision.provisionSeat).toHaveBeenCalledWith(VENDOR_ID, {
      email: 'ops@mindcloud.example',
    });
    // A provision writes a seat row AND an audit row, so both reload.
    expect(api.getVendor).toHaveBeenCalledTimes(2);
    expect(api.listAudit).toHaveBeenCalledTimes(2);

    const status = el.querySelector('[role="status"]');
    expect(status?.textContent).toContain('Seat added');
    // Load-bearing: the operator must not have to read the Basics table to learn
    // that provisioning did not verify the vendor.
    expect(status?.textContent).toContain('verified badge is unchanged');
  });

  it('disables submit on an empty address — field validation, not the gate', async () => {
    // The complement to the two tests above: without this, a control that was
    // disabled for the WRONG reason could still make them pass by being enabled
    // once an address is typed.
    const { el, fixture } = await setup(makeApiMock(makeVendor()));
    await openForm(el, fixture);

    expect(buttonByText(el, 'Add the seat')!.disabled).toBe(true);
    typeEmail(el, fixture);
    expect(buttonByText(el, 'Add the seat')!.disabled).toBe(false);
  });

  it('renders the 503 as a configuration fact, not a failure', async () => {
    // `SUPABASE_SERVICE_ROLE_KEY` is legitimately absent on local dev and every
    // PR preview, so 503 is the DEFAULT outcome there — the same seam and the
    // same copy discipline the claim queue already carries.
    const provision = {
      provisionSeat: vi.fn(async () => {
        throw new HttpErrorResponse({ status: 503 });
      }),
    };
    const { el, fixture } = await setup(makeApiMock(makeVendor()), provision);
    await openForm(el, fixture);

    typeEmail(el, fixture);

    buttonByText(el, 'Add the seat')!.click();
    await settle();
    fixture.detectChanges();

    expect(el.textContent).toContain("account service isn't configured");
    expect(el.textContent).toContain('Nothing was changed');
  });

  it('wires every control to a label and a description, under one live region', async () => {
    // Structural a11y, asserted here because `/admin` needs a real admin session
    // and cannot be reached by the axe e2e lane without one. Four properties:
    // both fields are labelled, both carry their hint via aria-describedby, the
    // failure message is an alert, and the PAGE still owns exactly one live
    // region — the extraction contract `EntitlementControl` established.
    const { el, fixture } = await setup(makeApiMock(makeVendor()));
    await openForm(el, fixture);

    for (const field of ['detail-provision-email', 'detail-provision-reason']) {
      const input = el.querySelector<HTMLElement>(`#${field}`)!;
      expect(el.querySelector(`label[for="${field}"]`)?.textContent?.trim()).toBeTruthy();
      expect(input.getAttribute('aria-describedby')).toBe(`${field}-hint`);
      expect(el.querySelector(`#${field}-hint`)).toBeTruthy();
    }

    // The control is labelled by the section heading it sits under, so it is not
    // an unnamed region to a screen reader.
    const control = el.querySelector('aec-provision-seat-control > div')!;
    expect(control.getAttribute('aria-labelledby')).toBe('admin-vendor-seats');

    // Still exactly one. The control must not render its own.
    expect(el.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(control.querySelector('[role="status"]')).toBeNull();
  });

  it('still cannot ban, and still cannot manage an entitlement from the control', async () => {
    // The scope boundary, re-asserted now that this section has TWO write
    // actions rather than one. Adding a seat is not verifying a vendor.
    const { el, fixture } = await setup(makeApiMock(makeVendor()));
    await openForm(el, fixture);

    const control = el.querySelector('aec-provision-seat-control')!;
    expect(buttonByText(control as HTMLElement, 'Ban')).toBeUndefined();
    expect(buttonByText(control as HTMLElement, 'Set entitlement')).toBeUndefined();
  });
});
