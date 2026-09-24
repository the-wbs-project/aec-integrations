import { DOCUMENT, formatDate } from '@angular/common';
import {
  Component,
  Injector,
  LOCALE_ID,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';

import type {
  AdminConnectorStubState,
  VendorConnectorCatalogResponse,
  VendorConnectorListing,
  VendorConnectorMapping,
} from '@aeci/shared';

import { AecSelect, type AecSelectOption } from '../../shared/aec-select/aec-select';
import { VendorApi } from '../vendor-api';
import { VendorPortalStore } from '../vendor-portal-store';

import {
  catalogueConfidenceLabel,
  catalogueDeciderLabel,
  catalogueMappingSummary,
  catalogueStatusLabel,
} from './vendor-catalogue-labels';
import {
  VendorConnectorMappingForm,
  type CatalogueMappingSaved,
} from './vendor-connector-mapping-form';

type LoadState = 'idle' | 'loading' | 'loaded' | 'failed';

/** Listings per page. The API caps it at 50; 25 keeps a page scannable. */
export const CATALOGUE_PAGE_SIZE = 25;

/** A DOM-safe id stem from a review-app record id. */
function domId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '-');
}

/**
 * The connector catalogue seat's Catalogue tab (AECI-1083 —
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.16, `STAGE_2_SPEC.md` §8.9(1)).
 *
 * Every listing in the connector product's published catalogue, with what each one
 * is on AECi. On a catalogue AECi has handed over (`managed_by = 'vendor'`) each
 * match has an Edit control over AECI-724's PATCH. On one the review lane still
 * writes, the tab is read-only and says the AECi team maintains it: the PATCH would
 * be a 409, and a control that can only fail is not rendered (the admin screen's
 * rule, `ADMIN_PANEL_SPEC.md` §5.9).
 *
 * ── A PRODUCT TAB, NOT A VENDOR SECTION ─────────────────────────────────────
 * A catalogue belongs to one connector product (`connector_catalogs` is unique on
 * `connector_product_id`), and a vendor can hold more than one. So it sits in the
 * product row beside Integrations, shown only on `connector`-role products.
 *
 * ── LIVE ────────────────────────────────────────────────────────────────────
 * The read is inside the AECI-516 cursor as the `catalogue` scope. When it moves
 * (a colleague's edit, an operator's, the lane handed over or taken back), the store
 * bumps {@link VendorPortalStore.catalogueRevision} and this re-reads the page it has
 * open without blanking it. With a form open it does not: it says the list changed
 * and offers a reload, because replacing a half-edited form is worse than a stale one
 * (`STAGE_2_REALTIME_SPEC.md` §6).
 *
 * ── WHAT IT CANNOT DO ──────────────────────────────────────────────────────
 * Add a match to a listing that has none: there is no create endpoint (AECI-724 edits
 * existing rows). The tab says so plainly instead of offering a dead control.
 */
@Component({
  selector: 'aec-vendor-connector-catalogue',
  imports: [AecSelect, VendorConnectorMappingForm],
  host: { class: 'block' },
  template: `
    <section aria-labelledby="vendor-catalogue-heading" data-catalogue>
      <div class="max-w-[52ch] space-y-2">
        <h2 id="vendor-catalogue-heading" class="m-0">
          <!-- The size lives on the span: styles.css sizes h2 outside any cascade
               layer, so a text utility on the h2 itself is dead. -->
          <span
            class="block font-display text-xl font-semibold text-(--text-primary)"
            i18n="@@vendor.catalogue.heading"
            >Catalogue</span
          >
        </h2>
        <p class="text-sm leading-relaxed text-(--text-secondary)">{{ intro() }}</p>
      </div>

      @if (state() === 'failed' && !response()) {
        <div class="mt-6 space-y-2" data-catalogue-failed>
          <p class="text-sm text-(--text-primary)" i18n="@@vendor.catalogue.failed">
            Could not load this catalogue.
          </p>
          <button
            type="button"
            [class]="secondaryButtonClass"
            (click)="reload()"
            i18n="@@vendor.catalogue.retry"
          >
            Try again
          </button>
        </div>
      } @else if (!response()) {
        <p class="mt-6 text-sm text-(--text-secondary)" i18n="@@vendor.catalogue.loading">
          Loading the catalogue…
        </p>
      } @else if (catalog(); as c) {
        <p class="mt-3 text-sm text-(--text-secondary)" data-catalogue-summary>
          <span i18n="@@vendor.catalogue.summary.listings">{c.listings, plural,
            =1 {1 listing}
            other {{{ c.listings }} listings}
          }</span
          ><span aria-hidden="true"> · </span
          ><span i18n="@@vendor.catalogue.summary.unmatched">{c.unmatched, plural,
            =0 {every listing has a match}
            =1 {1 with no match yet}
            other {{{ c.unmatched }} with no match yet}
          }</span
          ><span aria-hidden="true"> · </span><span>{{ asOf() }}</span>
        </p>

        @if (c.managed_by === 'review') {
          <p
            class="mt-4 max-w-[52ch] rounded-(--radius-md) border border-(--border-default) bg-(--surface-sunken) px-4 py-3 text-sm leading-relaxed text-(--text-primary)"
            data-catalogue-review-managed
            i18n="@@vendor.catalogue.reviewManaged"
          >
            The AECi team maintains this catalogue for now, so it is read-only here. Once it is
            handed to your company, you can change each match on this tab.
          </p>
        } @else {
          <p
            class="mt-4 max-w-[52ch] text-sm leading-relaxed text-(--text-secondary)"
            data-catalogue-vendor-managed
            i18n="@@vendor.catalogue.vendorManaged"
          >
            Your company maintains this catalogue. You can change any match below. A listing with no
            match yet is matched by the AECi team. You cannot add a match here yet.
          </p>
        }

        @if (listAlert()) {
          <p
            id="vendor-catalogue-alert"
            tabindex="-1"
            role="alert"
            class="mt-4 max-w-[52ch] rounded-(--radius-md) border border-(--border-strong) bg-(--surface-raised) px-4 py-3 text-sm font-medium text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
            data-catalogue-alert
          >
            {{ listAlert() }}
          </p>
        }

        @if (state() === 'failed') {
          <!-- A refresh that failed keeps the last good list on screen. -->
          <div
            class="mt-4 flex max-w-[52ch] flex-wrap items-center gap-3 text-sm text-(--text-primary)"
            data-catalogue-refresh-failed
          >
            <span i18n="@@vendor.catalogue.refreshFailed"
              >Could not refresh the list. It shows what was loaded last.</span
            >
            <button
              type="button"
              [class]="secondaryButtonClass"
              (click)="reload()"
              i18n="@@vendor.catalogue.retry"
            >
              Try again
            </button>
          </div>
        }

        @if (stale()) {
          <div
            class="mt-4 flex max-w-[52ch] flex-wrap items-center gap-3 rounded-(--radius-md) bg-(--surface-sunken) px-4 py-3 text-sm text-(--text-primary)"
            data-catalogue-stale
          >
            <span i18n="@@vendor.catalogue.stale">This catalogue changed elsewhere.</span>
            <button
              type="button"
              [class]="secondaryButtonClass"
              (click)="discardAndReload()"
              i18n="@@vendor.catalogue.stale.reload"
            >
              Reload the list
            </button>
          </div>
        }

        <form
          role="search"
          class="mt-6 flex flex-col gap-4 sm:flex-row sm:items-end"
          [attr.aria-label]="filterLabel"
          (submit)="$event.preventDefault(); applySearch()"
        >
          <div class="min-w-0 sm:w-72">
            <label
              for="vendor-catalogue-search"
              [class]="labelClass"
              i18n="@@vendor.catalogue.search"
              >Find a listing</label
            >
            <div class="mt-1 flex gap-2">
              <input
                id="vendor-catalogue-search"
                type="search"
                autocomplete="off"
                [class]="inputClass"
                [value]="searchDraft()"
                (input)="searchDraft.set(inputValue($event))"
              />
              <button
                type="submit"
                [class]="secondaryButtonClass"
                i18n="@@vendor.catalogue.search.submit"
              >
                Search
              </button>
            </div>
          </div>
          <div class="sm:w-60">
            <aec-select
              i18n-label="@@vendor.catalogue.filter"
              label="Show"
              layout="stacked"
              idPrefix="vendor-catalogue-filter"
              [options]="filterOptions"
              [value]="filter()"
              (changed)="applyFilter($event)"
            />
          </div>
        </form>

        @if (listings().length === 0) {
          <p
            class="mt-6 rounded-(--radius-md) border border-(--border-default) bg-(--surface-raised) p-4 text-sm text-(--text-primary)"
            data-catalogue-empty
          >
            {{ emptyMessage() }}
          </p>
        } @else {
          <ul
            class="m-0 mt-6 list-none divide-y divide-(--border-default) rounded-(--radius-md) border border-(--border-default) bg-(--surface-raised) p-0"
            [attr.aria-busy]="refreshing() ? 'true' : null"
            data-catalogue-list
          >
            @for (listing of listings(); track listing.id) {
              <li class="px-4 py-4 sm:px-5" data-listing [attr.data-listing-id]="listing.id">
                <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <h3 class="m-0 min-w-0">
                    <!-- Body face at 16px, on the span: the h3 element rule is
                         unlayered serif at 20px, and Source Serif has an 18px floor.
                         A list of thirty is scanned, not read. -->
                    <span
                      class="block font-body text-base font-semibold break-words text-(--text-primary)"
                      >{{ listingName(listing) }}</span
                    >
                  </h3>
                  @if (listing.url) {
                    <a
                      [href]="listing.url"
                      target="_blank"
                      rel="noopener noreferrer"
                      class="inline-flex min-h-6 items-center text-sm text-(--accent-primary) underline underline-offset-2 focus-visible:rounded-(--radius-sm) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                      ><span i18n="@@vendor.catalogue.viewListing">View listing</span
                      ><span class="sr-only">{{ newTabSuffix(listing) }}</span></a
                    >
                  }
                </div>
                @if (listing.mappings.length === 0) {
                  <p class="mt-2 text-sm text-(--text-secondary)" i18n="@@vendor.catalogue.noMatch">
                    No match recorded yet.
                  </p>
                } @else {
                  <ul class="m-0 mt-2 list-none space-y-3 p-0">
                    @for (m of listing.mappings; track m.id) {
                      <li data-mapping [attr.data-mapping-id]="m.id">
                        <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
                          <p class="m-0 text-sm font-medium text-(--text-primary)">
                            {{ summary(m) }}
                          </p>
                          @if (m.publishable) {
                            <span
                              class="inline-flex items-center rounded-full bg-(--surface-sunken) px-2.5 py-0.5 text-xs font-medium text-(--text-primary)"
                              i18n="@@vendor.catalogue.publishable"
                              >Counts toward reach</span
                            >
                          }
                          @if (editable() && editingId() !== m.id) {
                            <button
                              type="button"
                              [id]="editButtonId(m)"
                              [class]="editButtonClass"
                              [disabled]="editingId() !== null"
                              (click)="openEdit(m)"
                            >
                              <span i18n="@@vendor.catalogue.edit">Edit</span
                              ><span class="sr-only">{{ editSuffix(listing) }}</span>
                            </button>
                          }
                        </div>
                        <p class="mt-1 text-xs text-(--text-secondary)">
                          @if (decider(m); as who) {
                            <span>{{ who }}</span
                            ><span aria-hidden="true"> · </span>
                          }
                          <span>{{ confidenceLine(m) }}</span>
                          @if (m.evidence_url) {
                            <span aria-hidden="true"> · </span
                            ><a
                              [href]="m.evidence_url"
                              target="_blank"
                              rel="noopener noreferrer"
                              class="text-(--accent-primary) underline underline-offset-2 focus-visible:rounded-(--radius-sm) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                              ><span i18n="@@vendor.catalogue.evidence">Evidence</span
                              ><span class="sr-only">{{ newTabSuffix(listing) }}</span></a
                            >
                          }
                        </p>
                        @if (editingId() === m.id) {
                          <aec-vendor-connector-mapping-form
                            [mapping]="m"
                            [listing]="listingName(listing)"
                            [idPrefix]="formIdPrefix(m)"
                            (saved)="onSaved(listing, $event)"
                            (cancelled)="closeEdit(m)"
                            (reclaimed)="onReclaimed()"
                          />
                        }
                      </li>
                    }
                  </ul>
                }
              </li>
            }
          </ul>

          @if (pageCount() > 1) {
            <nav
              class="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm"
              [attr.aria-label]="pagingLabel"
            >
              <button
                type="button"
                [class]="secondaryButtonClass"
                [disabled]="page() <= 1 || editingId() !== null"
                (click)="goToPage(page() - 1)"
                i18n="@@vendor.catalogue.page.previous"
              >
                Previous
              </button>
              <span class="text-(--text-secondary)" data-catalogue-page>{{ pageLabel() }}</span>
              <button
                type="button"
                [class]="secondaryButtonClass"
                [disabled]="page() >= pageCount() || editingId() !== null"
                (click)="goToPage(page() + 1)"
                i18n="@@vendor.catalogue.page.next"
              >
                Next
              </button>
            </nav>
          }
        }
      } @else {
        <p
          class="mt-6 max-w-[52ch] rounded-(--radius-md) border border-(--border-default) bg-(--surface-raised) p-4 text-sm leading-relaxed text-(--text-primary)"
          data-catalogue-none
          i18n="@@vendor.catalogue.none"
        >
          AECi does not hold a catalogue for this product yet. When it does, its listings appear
          here.
        </p>
      }
    </section>
  `,
})
export class VendorConnectorCatalogue {
  /** The owned `connector`-role product whose catalogue this is. */
  readonly productId = input.required<string>();
  readonly productName = input.required<string>();

  private readonly api = inject(VendorApi);
  private readonly store = inject(VendorPortalStore);
  private readonly locale = inject(LOCALE_ID);
  private readonly injector = inject(Injector);
  private readonly document = inject(DOCUMENT);

  protected readonly state = signal<LoadState>('idle');
  protected readonly response = signal<VendorConnectorCatalogResponse | null>(null);
  protected readonly refreshing = signal(false);

  protected readonly page = signal(1);
  protected readonly filter = signal<AdminConnectorStubState | null>(null);
  protected readonly search = signal('');
  protected readonly searchDraft = signal('');

  /** The mapping whose form is open. One at a time. */
  protected readonly editingId = signal<string | null>(null);
  /** The cursor moved while a form was open (§6: defer, never overwrite). */
  protected readonly stale = signal(false);
  /** A list-level failure: the lane taken back while a form was open. */
  protected readonly listAlert = signal('');

  /** Browser-only: the read carries the session cookie and never runs during SSR. */
  private readonly rendered = signal(false);
  /** Each load gets a ticket, so a slower earlier answer cannot overwrite a newer one. */
  private ticket = 0;

  protected readonly catalog = computed(() => this.response()?.catalog ?? null);
  protected readonly listings = computed(() => this.response()?.data ?? []);
  protected readonly editable = computed(() => this.catalog()?.managed_by === 'vendor');
  protected readonly pageCount = computed(() => {
    const r = this.response();
    return r ? Math.max(1, Math.ceil(r.total / r.perPage)) : 1;
  });

  protected readonly intro = computed(
    () =>
      $localize`:@@vendor.catalogue.intro:Every listing in ${this.productName()}:PRODUCT:'s published catalogue, and which product on AECi each one is. A match confirmed by AECi or by your company counts toward that product's reach.`,
  );

  protected readonly asOf = computed(() => {
    const at = this.catalog()?.last_ingested_at ?? null;
    if (at === null) {
      return $localize`:@@vendor.catalogue.asOf.none:catalogue date not recorded`;
    }
    const date = formatDate(at, 'MMMM d, y', this.locale, 'UTC');
    return $localize`:@@vendor.catalogue.asOf:as of ${date}:date:`;
  });

  protected readonly pageLabel = computed(
    () =>
      $localize`:@@vendor.catalogue.page.label:Page ${this.page()}:PAGE: of ${this.pageCount()}:COUNT:`,
  );

  protected readonly emptyMessage = computed(() =>
    this.search() || this.filter()
      ? $localize`:@@vendor.catalogue.empty.filtered:No listing matches that search and filter.`
      : $localize`:@@vendor.catalogue.empty:This catalogue has no listings yet.`,
  );

  protected readonly filterOptions: readonly AecSelectOption[] = [
    { value: null, label: $localize`:@@vendor.catalogue.filter.all:All listings` },
    { value: 'undecided', label: $localize`:@@vendor.catalogue.filter.undecided:No match yet` },
    ...(['mapped', 'ruled_out', 'out_of_scope', 'no_record', 'ambiguous_parked'] as const).map(
      (value) => ({ value, label: catalogueStatusLabel(value) }),
    ),
  ];

  protected readonly filterLabel = $localize`:@@vendor.catalogue.filter.aria:Find listings`;
  protected readonly pagingLabel = $localize`:@@vendor.catalogue.page.aria:Catalogue pages`;

  constructor() {
    afterNextRender(() => this.rendered.set(true));

    // Load on first render, and again whenever the product or a filter changes.
    effect(() => {
      if (!this.rendered()) return;
      const id = this.productId();
      this.page();
      this.filter();
      this.search();
      if (!id) return;
      // A filter, search or page change keeps the controls and the current rows on
      // screen (`aria-busy` on the list) rather than blanking the section.
      untracked(() => void this.load({ quiet: this.response() !== null }));
    });

    // The live cursor. The first value is the baseline, not a change.
    let seen: number | null = null;
    effect(() => {
      const revision = this.store.catalogueRevision();
      if (seen === null) {
        seen = revision;
        return;
      }
      if (revision === seen) return;
      seen = revision;
      untracked(() => {
        if (this.editingId() !== null) {
          this.stale.set(true);
        } else if (this.response()) {
          void this.load({ quiet: true });
        }
      });
    });
  }

  protected inputValue(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected listingName(listing: VendorConnectorListing): string {
    return listing.label ?? listing.slug;
  }

  protected summary(m: VendorConnectorMapping): string {
    return catalogueMappingSummary(m);
  }

  protected decider(m: VendorConnectorMapping): string | null {
    return catalogueDeciderLabel(m.decided_by);
  }

  protected confidenceLine(m: VendorConnectorMapping): string {
    const level = catalogueConfidenceLabel(m.confidence);
    return $localize`:@@vendor.catalogue.confidenceLine:Confidence: ${level}:LEVEL:`;
  }

  protected editSuffix(listing: VendorConnectorListing): string {
    const name = this.listingName(listing);
    return $localize`:@@vendor.catalogue.editFor: the match for ${name}:LISTING:`;
  }

  protected newTabSuffix(listing: VendorConnectorListing): string {
    const name = this.listingName(listing);
    return $localize`:@@vendor.catalogue.newTab: for ${name}:LISTING:, opens in a new tab`;
  }

  protected editButtonId(m: VendorConnectorMapping): string {
    return `vendor-catalogue-edit-${domId(m.id)}`;
  }

  protected formIdPrefix(m: VendorConnectorMapping): string {
    return `vendor-catalogue-form-${domId(m.id)}`;
  }

  protected applySearch(): void {
    if (this.editingId() !== null) return;
    this.page.set(1);
    this.search.set(this.searchDraft().trim());
  }

  protected applyFilter(value: string | null): void {
    if (this.editingId() !== null) return;
    this.page.set(1);
    this.filter.set((value as AdminConnectorStubState | null) ?? null);
  }

  protected goToPage(page: number): void {
    this.page.set(Math.min(Math.max(1, page), this.pageCount()));
  }

  protected reload(): void {
    void this.load({ quiet: this.response() !== null });
  }

  protected openEdit(m: VendorConnectorMapping): void {
    this.listAlert.set('');
    this.editingId.set(m.id);
    // Focus the form's first control: the status picker's trigger.
    this.focusAfterRender(`${this.formIdPrefix(m)}-status-trigger`);
  }

  protected closeEdit(m: VendorConnectorMapping): void {
    this.editingId.set(null);
    this.focusAfterRender(this.editButtonId(m));
    this.catchUp();
  }

  protected onSaved(listing: VendorConnectorListing, saved: CatalogueMappingSaved): void {
    // Splice the PATCH echo in: it is the committed row, so no refetch is needed.
    this.response.update((r) =>
      r
        ? {
            ...r,
            data: r.data.map((l) =>
              l.id === listing.id
                ? {
                    ...l,
                    mappings: l.mappings.map((m) =>
                      m.id === saved.mapping.id ? saved.mapping : m,
                    ),
                  }
                : l,
            ),
          }
        : r,
    );
    this.closeEdit(saved.mapping);
  }

  /** `409 CATALOG_REVIEW_MANAGED` mid-edit: the lane went back to the review app. */
  protected onReclaimed(): void {
    this.editingId.set(null);
    this.stale.set(false);
    this.listAlert.set(
      $localize`:@@vendor.catalogue.reclaimed:The AECi team took this catalogue back while you were editing, so your change was not saved. The list below is now read-only.`,
    );
    void this.load({ quiet: true });
    this.focusAfterRender('vendor-catalogue-alert');
  }

  /** The stale affordance: drop the open form and take the server's copy. */
  protected discardAndReload(): void {
    this.editingId.set(null);
    this.stale.set(false);
    void this.load({ quiet: true });
  }

  /** A form closed while the list was stale: catch up now. */
  private catchUp(): void {
    if (!this.stale()) return;
    this.stale.set(false);
    void this.load({ quiet: true });
  }

  private focusAfterRender(id: string): void {
    afterNextRender(() => this.document.getElementById(id)?.focus(), { injector: this.injector });
  }

  /**
   * Read the current page. `quiet` keeps the list on screen while it refreshes
   * (a background revalidation must never blank the surface); a first load or a
   * filter change shows the loading line instead.
   */
  private async load({ quiet }: { quiet: boolean }): Promise<void> {
    const productId = this.productId();
    const ticket = ++this.ticket;
    if (quiet) this.refreshing.set(true);
    else {
      this.state.set('loading');
      this.response.set(null);
    }
    try {
      const res = await this.api.getConnectorCatalog(productId, {
        page: this.page(),
        perPage: CATALOGUE_PAGE_SIZE,
        state: this.filter(),
        search: this.search(),
      });
      if (ticket !== this.ticket) return;
      this.response.set(res);
      this.state.set('loaded');
      // A page past the end (a filter shrank the set) walks back to the last page.
      const last = Math.max(1, Math.ceil(res.total / res.perPage));
      if (this.page() > last) this.page.set(last);
    } catch {
      if (ticket !== this.ticket) return;
      this.state.set('failed');
    } finally {
      if (ticket === this.ticket) this.refreshing.set(false);
    }
  }

  protected readonly labelClass =
    'block text-xs font-bold tracking-[0.08em] text-(--text-secondary) uppercase';
  protected readonly inputClass =
    'w-full rounded-(--radius-md) border border-(--border-default) bg-(--surface-base) px-3 py-2 text-sm text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';
  /** Disabled is a surface swap, never opacity (DESIGN.md, AECI-982). */
  protected readonly secondaryButtonClass =
    'inline-flex min-h-10 shrink-0 items-center justify-center rounded-(--radius-md) border border-(--border-default) bg-(--surface-base) px-4 py-2 text-sm font-medium text-(--text-primary) transition-colors hover:bg-(--surface-sunken) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) disabled:cursor-not-allowed disabled:bg-(--surface-sunken) disabled:text-(--text-secondary)';
  /** A real button with a 32px target, never the admin's bare underlined link
   *  (AECI-1079's 24px floor). */
  protected readonly editButtonClass =
    'inline-flex min-h-8 items-center rounded-(--radius-md) border border-(--border-default) bg-(--surface-base) px-3 py-1 text-sm font-medium text-(--text-primary) transition-colors hover:bg-(--surface-sunken) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) disabled:cursor-not-allowed disabled:bg-(--surface-sunken) disabled:text-(--text-secondary)';
}
