import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { ActivatedRoute } from '@angular/router';

import type { VendorSeat } from '@aeci/shared';

import { VendorDashboardSingle } from '../../vendor/vendor-dashboard-single';
import { VendorDashboardTabbed } from '../../vendor/vendor-dashboard-tabbed';
import { VENDOR_CREATE_FORM_START_OPEN } from '../../vendor/components/vendor-integration-create';
import { VENDOR_EDIT_FORM_START_OPEN } from '../../vendor/components/vendor-integration-ownership';
import { VENDOR_RETIRE_CONFIRM_START_OPEN } from '../../vendor/components/vendor-owned-retire';
import { VendorApi } from '../../vendor/vendor-api';
import { VendorPortalStore } from '../../vendor/vendor-portal-store';
import {
  VENDOR_ME_CONNECTOR_SEAT_FIXTURE,
  VENDOR_ME_DOWNGRADED_FIXTURE,
  VENDOR_ME_EXPIRING_FIXTURE,
  VENDOR_ME_LARGE_CATALOG_FIXTURE,
  VENDOR_ME_FIXTURE,
  VENDOR_ME_UNVERIFIED_FIXTURE,
  VENDOR_SEATS_FIXTURE,
} from '../../vendor/vendor-fixtures';
import { VENDOR_ME_CONNECTOR_SEAT_REVIEW_FIXTURE } from '../../vendor/vendor-catalogue-fixtures';
import { PreviewVendorApi } from './preview-vendor-api';

type Concept = 'a' | 'b';
type FixtureKey =
  | 'verified'
  | 'expiring'
  | 'downgraded'
  | 'unverified'
  | 'connector-seat'
  | 'connector-seat-review'
  | 'large-catalog';

const FIXTURE_KEYS: readonly FixtureKey[] = [
  'verified',
  'expiring',
  'downgraded',
  'unverified',
  'connector-seat',
  'connector-seat-review',
  'large-catalog',
];

/** `?fixture=<key>` picks the preset on first paint, so an e2e or the design
 *  detector (which reads only the first render) can land on it by URL. */
function fixtureFrom(value: string | null): FixtureKey {
  return FIXTURE_KEYS.includes(value as FixtureKey) ? (value as FixtureKey) : 'verified';
}

/** A single-seat roster for the no-access/new-vendor fixture. */
const SINGLE_SEAT_FIXTURE: readonly VendorSeat[] = [
  {
    user_id: '00000000-0000-4000-8000-0000000052c1',
    display_name: 'Sam Okafor',
    email: 'sam@northwind.example.com',
    banned: false,
    created_at: '2026-07-10T12:00:00.000Z',
    is_self: true,
    owner: true,
  },
];

/**
 * Dev-only preview for the AECI-522 vendor dashboard. It renders the TWO
 * information-architecture concepts as live-toggleable options so the PO can
 * choose one in the running app before it's wired into the real gated `/vendor`
 * route (the `unified-home-preview` precedent, AECI-270 / `docs/design/LESSONS.md`
 * "build all and then I chose"):
 *
 *   - **a · Tabbed** — a side-nav over one panel (Overview / Profile / Products /
 *     Seats). Focused surfaces; scales to more sections later.
 *   - **b · Single page** — the whole surface on one scroll. Fewer clicks; longer
 *     page.
 *
 * A second toggle swaps the ENTITLEMENT STATE (AECI-614 /
 * `docs/STAGE_2_PAID_TIERS_SPEC.md` §8), which is what the plan panel and the
 * read-only forms are reviewed against. All four states are here — active with a
 * far term, active and expiring soon, downgraded after a revoke, and never
 * active — because §8 asks specifically for the DOWNGRADED state to get sign-off
 * before the gated route is wired: it is the panel a customer AECi wants back
 * will read.
 *
 * The real dashboard components are used verbatim — only the {@link VendorApi} is
 * shadowed with a fixture-backed fake ({@link PreviewVendorApi}) so edits are
 * exercisable without a session. Route: `/preview/vendor-dashboard`,
 * production-blocked by `isPreviewPath`. Don't link to it from product navigation.
 *
 * {@link VendorPortalStore} (AECI-628) is provided HERE, alongside the API
 * shadow, for the same reason: the store is deliberately not `providedIn: 'root'`,
 * so declaring it on this element is what makes it resolve `PreviewVendorApi`
 * instead of the real client. Providing it any higher would send the preview's
 * section reads at the live API. This component is the preview's surface owner,
 * so it seeds the store the way `VendorPage` seeds it on the real route.
 */
@Component({
  selector: 'app-vendor-dashboard-preview',
  imports: [VendorDashboardTabbed, VendorDashboardSingle],
  providers: [
    PreviewVendorApi,
    { provide: VendorApi, useExisting: PreviewVendorApi },
    VendorPortalStore,
    // AECI-1011: `?create=open` renders the "Add an integration" form open on first
    // paint, so the design detector (which reads only the first render) sees it. Use
    // it on a child route, e.g. `products/summit-model-coordination/integrations`:
    // the bare `/preview/vendor-dashboard` redirects and drops the query. `?concept=b`
    // on a child route selects the single-page concept the same way.
    {
      provide: VENDOR_CREATE_FORM_START_OPEN,
      useFactory: () => inject(ActivatedRoute).snapshot.queryParamMap.get('create') === 'open',
    },
    // AECI-1090: `?edit=<integration id>` renders that card's owner edit form open on
    // first paint, for the same reason. The claimed connector-delivered row is
    // `00000000-0000-4000-8000-00000000531b`, under summit-model-coordination.
    {
      provide: VENDOR_EDIT_FORM_START_OPEN,
      useFactory: () => inject(ActivatedRoute).snapshot.queryParamMap.get('edit'),
    },
    // AECI-1091: `?retire=<integration id>` renders that owned row's retire
    // confirmation open on first paint. The claimed evidenced pair is
    // `00000000-0000-4000-8000-00000000531a`, under summit-model-coordination.
    {
      provide: VENDOR_RETIRE_CONFIRM_START_OPEN,
      useFactory: () => inject(ActivatedRoute).snapshot.queryParamMap.get('retire'),
    },
  ],
  template: `
    <!-- Dev-only concept switcher. Not part of the surface under review. -->
    <div
      class="sticky top-0 z-40 border-b border-(--border-default) bg-(--surface-sunken)"
      role="region"
      aria-label="Concept switcher (dev only)"
    >
      <div class="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-6 py-3 md:px-8">
        <div class="flex flex-wrap items-center gap-2">
          <span class="aec-overline text-(--text-secondary)">AECI-522 concept</span>
          <button
            type="button"
            [class]="tabClass(concept() === 'a')"
            [attr.aria-pressed]="concept() === 'a'"
            (click)="concept.set('a')"
          >
            a · Tabbed
          </button>
          <button
            type="button"
            [class]="tabClass(concept() === 'b')"
            [attr.aria-pressed]="concept() === 'b'"
            (click)="concept.set('b')"
          >
            b · Single page
          </button>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <span class="aec-overline text-(--text-secondary)">AECI-614 entitlement state</span>
          @for (f of fixtures; track f.key) {
            <button
              type="button"
              [class]="tabClass(fixture() === f.key)"
              [attr.aria-pressed]="fixture() === f.key"
              (click)="fixture.set(f.key)"
            >
              {{ f.label }}
            </button>
          }
        </div>
      </div>
    </div>

    <div class="bg-(--surface-base)">
      @switch (concept()) {
        @case ('a') {
          <aec-vendor-dashboard-tabbed [me]="activeMe()" />
        }
        @case ('b') {
          <aec-vendor-dashboard-single [me]="activeMe()" />
        }
      }
    </div>
  `,
})
export class VendorDashboardPreview {
  private readonly previewApi = inject(PreviewVendorApi);
  private readonly store = inject(VendorPortalStore);

  protected readonly concept = signal<Concept>(
    inject(ActivatedRoute).snapshot.queryParamMap.get('concept') === 'b' ? 'b' : 'a',
  );
  protected readonly fixture = signal<FixtureKey>(
    fixtureFrom(inject(ActivatedRoute).snapshot.queryParamMap.get('fixture')),
  );

  /** The four §8 entitlement states, in the order a vendor would meet them. */
  protected readonly fixtures: ReadonlyArray<{ key: FixtureKey; label: string }> = [
    { key: 'verified', label: 'Active · far term' },
    { key: 'expiring', label: 'Active · expiring soon' },
    { key: 'downgraded', label: 'Downgraded · revoked' },
    { key: 'unverified', label: 'No access · new' },
    // AECI-724: the §8.9 connector seat. No entitlement row, like the one above,
    // and a different panel on purpose: it is never sold the access that one offers.
    // AECI-1083: open Products → Agave → Catalogue. This preset's catalogue is
    // vendor-managed, so every match has Edit.
    { key: 'connector-seat', label: 'Catalogue seat · connector' },
    // AECI-1083: the same seat on a catalogue the AECi team still maintains, so the
    // Catalogue tab is read-only. Same product slug, so the URL carries over.
    { key: 'connector-seat-review', label: 'Catalogue seat · AECi-managed' },
    // Not an entitlement state: a catalog big enough to show how the product
    // list page (§6.11) reads at length. Two products cannot.
    { key: 'large-catalog', label: 'Active · 20 products' },
  ];

  protected readonly activeMe = computed(() => {
    switch (this.fixture()) {
      case 'expiring':
        return VENDOR_ME_EXPIRING_FIXTURE;
      case 'downgraded':
        return VENDOR_ME_DOWNGRADED_FIXTURE;
      case 'large-catalog':
        return VENDOR_ME_LARGE_CATALOG_FIXTURE;
      case 'unverified':
        return VENDOR_ME_UNVERIFIED_FIXTURE;
      case 'connector-seat':
        return VENDOR_ME_CONNECTOR_SEAT_FIXTURE;
      case 'connector-seat-review':
        return VENDOR_ME_CONNECTOR_SEAT_REVIEW_FIXTURE;
      default:
        return VENDOR_ME_FIXTURE;
    }
  });

  /** The downgraded vendor keeps its seats: clearing an entitlement does not
   *  revoke them (§5.2), and the preview has to show that it doesn't. */
  private readonly activeSeats = computed(() =>
    this.fixture() === 'unverified' ||
    this.fixture() === 'connector-seat' ||
    this.fixture() === 'connector-seat-review'
      ? SINGLE_SEAT_FIXTURE
      : VENDOR_SEATS_FIXTURE,
  );

  constructor() {
    // Keep the fixture-backed fake pointed at whichever fixture is on screen, so
    // the seat roster + product saves operate on matching data.
    //
    // Both fixtures get the SAME integrations surface, deliberately. `GET
    // /api/vendor/integrations` is ownership-gated but not account-access-gated, so a
    // vendor without active access really does see its full attestable surface — and the
    // read-only rendering of it is the thing this toggle exists to review. (The
    // empty-surface state has no verification dimension and is covered by
    // `vendor-integrations-section.component.spec.ts` instead.)
    //
    // Seeding the store in the SAME effect keeps the two in step: the sections
    // read `me` from the store, the fake answers the section reads, and toggling
    // a fixture has to move both or the panel and the roster would disagree.
    effect(() => {
      const me = this.activeMe();
      const seats = this.activeSeats();
      untracked(() => {
        this.previewApi.setFixture(me, seats);
        this.store.seed(me);
      });
    });
  }

  protected tabClass(active: boolean): string {
    const base =
      'rounded-(--radius-sm) border px-3 py-1.5 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';
    return active
      ? `${base} border-(--accent-primary) text-(--accent-primary)`
      : `${base} border-(--border-default) text-(--text-secondary) hover:text-(--text-primary)`;
  }
}
