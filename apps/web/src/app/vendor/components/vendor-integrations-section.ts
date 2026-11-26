import { Location, NgTemplateOutlet } from '@angular/common';
import {
  Component,
  DestroyRef,
  type OnInit,
  afterNextRender,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';

import type { VendorIntegration } from '@aeci/shared';

import { AecButton } from '../../shared/button/button';
import { AecCard } from '../../shared/card/card';
import { Chip, type ChipTone } from '../../shared/chip/chip';
import { FIELD_INPUT_CLASS, FIELD_LABEL_CLASS } from '../../shared/form-field/form-field-classes';
import { AecIcon } from '../../shared/icon/icon';
import type { AecIconName } from '../../shared/icon/icon-registry';
import { LogoOrInitial } from '../../shared/logo-or-initial/logo-or-initial';
import {
  INTEGRATION_STATUS_KEYS,
  howYouGetIt,
  otherCompanyName,
  ownsBoth,
  sharedSummary,
  statusChipLabel,
  statusLabel,
  statusTone,
  contestsFor,
  type IntegrationStatusKey,
} from '../integration-detail/integration-detail-model';
import { claimsOnRecord, waitingByProduct } from '../overview/vendor-overview-model';
import { VendorPortalAnnouncer } from '../vendor-announcer';
import { integrationCanAuthor } from '../vendor-capabilities';
import { VendorPortalStore } from '../vendor-portal-store';
import {
  STATUS_CHIP_ICON,
  STATUS_CHIP_TONE,
} from '../integration-detail/integration-detail-styles';
import { PORTAL_NOTICE_BODY_CLASS, PORTAL_NOTICE_CLASS } from '../shared/portal-notice';

import { VendorIntegrationCreate, type VendorIntegrationLink } from './vendor-integration-create';
import { VendorProductRequestsList } from './vendor-product-requests-list';
import {
  type CounterpartSide,
  EMPTY_FILTER,
  type IntegrationFilter,
  type StatusFilter,
  filterFromParams,
  filterToParams,
  groupByCounterpart,
  isFilterActive,
  matchesFilter,
  statusOf,
  statusTallies,
} from './vendor-integration-list-model';
import { SEGMENTED_CLASS, segmentClass } from '../shared/portal-segmented';

/**
 * The product's Integrations list (AECI-606, reshaped by AECI-1149 /
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.17.1): every integration touching this
 * product, grouped by the product it connects to. **Each integration row is a link
 * to its own page** (`…/integrations/:integrationId`), where everything about it is
 * read and changed. The inline card and data-flow lanes this list used to expand
 * into were retired by AECI-1156.
 *
 * ── WHAT A ROW SHOWS ────────────────────────────────────────────────────────
 * The other product's mark and name, "by {company}", one line saying what is
 * shared ("Models and drawings are sent to Navisworks"), and the status pill of
 * §6.17.2. A counterpart with one integration shows that row directly; a
 * counterpart with several is a group of rows.
 *
 * ── FILTERS ─────────────────────────────────────────────────────────────────
 * Search, "Integrates with", and status chips over the §6.17.2 set, computed by the
 * same `integrationStatus` the page shows. Every value is URL state when the
 * section is routed, so a filtered view can be shared. `?status=conflict` and
 * `?status=needs_you` from older links map to their nearest key.
 *
 * ── STATE ───────────────────────────────────────────────────────────────────
 * The list is `VendorPortalStore`'s one vendor-wide `integrations` read, filtered to
 * this product; the live cursor keeps it fresh (`STAGE_2_REALTIME_SPEC.md` §2.2).
 * Statuses that depend on change requests read the store's vendor-wide contests,
 * narrowed per integration.
 *
 * Results are announced through the shell's one live region
 * (`VendorPortalAnnouncer`), never a `role="status"` here. The loading and failure
 * paragraphs are the section's state, not announcements.
 */
@Component({
  selector: 'aec-vendor-integrations-section',
  imports: [
    NgTemplateOutlet,
    RouterLink,
    AecButton,
    AecCard,
    AecIcon,
    Chip,
    LogoOrInitial,
    VendorIntegrationCreate,
    VendorProductRequestsList,
  ],
  template: `
    <div class="space-y-6" [attr.aria-busy]="loading() ? 'true' : null">
      <!-- AECI-2045 QA: on a Sync Service's tab this list sits under its own heading,
           below the pairs the product delivers, so each section has a true heading. -->
      @if (heading(); as h) {
        <h2 id="vendor-endpoint-integrations-heading" class="m-0">
          <span class="block font-display text-xl font-semibold text-(--text-primary)">{{
            h
          }}</span>
        </h2>
      }
      <p class="max-w-[30rem] text-sm text-(--text-secondary)" i18n="@@vendor.attest.intro">
        These are the integrations on record for your products. Open one to check what data is
        shared and to fix anything that is wrong. The other company sees the same integration from
        their side.
      </p>

      @if (anyAuthorable() && loaded()) {
        <p class="text-sm text-(--text-secondary)" data-testid="integrations-summary">
          {{ summaryLine() }}
        </p>
      }

      <!-- AECI-1011. A seat is the whole gate for listing an integration
           (AECI-1003 decision 15), unlike answering. AECI-2045 QA: a pure Sync Service's
           tab offers its own create instead, so this one and the product requests it
           feeds are left out there (offerCreate). -->
      @if (offerCreate()) {
        <aec-vendor-integration-create
          [contextProductId]="contextProductId()"
          [withProductName]="createWithName()"
          [deepLink]="urlState()"
          [integrationLink]="createLink"
          (requested)="requests.reload()"
        />
        <!-- AECI-1377: the vendor's product requests. Renders nothing when there are none. -->
        <aec-vendor-product-requests-list #requests [routed]="urlState()" />
      }

      @if (!anyAuthorable()) {
        <div [class]="noticeClass">
          <p [class]="noticeBodyClass" i18n="@@vendor.attest.readOnly.listUnavailable">
            You can review everything on record here. Answering is not available for these
            integrations right now. Contact AEC Integrations if this does not change.
          </p>
        </div>
      }

      @if (loading()) {
        <p class="text-sm text-(--text-secondary)" i18n="@@vendor.attest.loading">
          Loading your integrations…
        </p>
      } @else if (failed()) {
        <div class="space-y-2">
          <p class="text-sm text-(--text-primary)" i18n="@@vendor.attest.failed">
            Could not load your integrations.
          </p>
          <button
            aecButton
            variant="secondary"
            compact
            type="button"
            (click)="reload()"
            i18n="@@vendor.attest.retry"
          >
            Try again
          </button>
        </div>
      } @else if (integrations().length === 0 && heading()) {
        <!-- AECI-2045 QA: under its own heading on a Sync Service's tab, the empty list
             speaks of this product only, never of "your products". -->
        <p
          class="max-w-prose text-sm text-(--text-secondary)"
          i18n="@@vendor.attest.empty.endpoint"
        >
          No integrations that connect to this product are on record yet. AEC Integrations adds them
          from public sources, and you can add one your company offers above.
        </p>
      } @else if (integrations().length === 0) {
        <p class="max-w-prose text-sm text-(--text-secondary)" i18n="@@vendor.attest.empty">
          No integrations are on record for your products yet. AEC Integrations adds integrations
          from public sources, and you can add one your company offers above. When one appears you
          can confirm what data it moves.
        </p>
      } @else {
        <div class="space-y-4" role="search" [attr.aria-label]="filterRegionLabel">
          <div class="flex flex-wrap items-end gap-4">
            <div class="min-w-0 flex-1 basis-64 space-y-2">
              <label
                for="vendor-integrations-query"
                [class]="labelClass"
                i18n="@@vendor.attest.filter.query.label"
                >Search</label
              >
              <input
                id="vendor-integrations-query"
                type="search"
                autocomplete="off"
                [value]="filter().query"
                [attr.placeholder]="queryPlaceholder"
                (input)="onQuery($event)"
                [class]="inputClass"
              />
            </div>
            <div class="w-full space-y-2 sm:w-64">
              <label
                for="vendor-integrations-side"
                [class]="labelClass"
                i18n="@@vendor.attest.filter.side.label"
                >Integrates with</label
              >
              <div class="relative">
                <select
                  id="vendor-integrations-side"
                  (change)="onSide($event)"
                  [class]="selectClass"
                >
                  @for (option of sideOptions; track option.value) {
                    <option [value]="option.value" [selected]="option.value === filter().side">
                      {{ option.label }}
                    </option>
                  }
                </select>
                <span
                  class="pointer-events-none absolute end-4 top-1/2 flex -translate-y-1/2 text-(--text-secondary)"
                >
                  <aec-icon name="chevron-down" decorative [size]="4" />
                </span>
              </div>
            </div>
          </div>

          <!-- The portal's own status toggles, kept (ruled 2026-11-24), on the site's
               segmented pressed-toggle recipe (DESIGN.md §5 "Segmented control"). -->
          <div [class]="segmentedClass" role="group" [attr.aria-label]="statusGroupLabel">
            @for (chip of statusChips(); track chip.value) {
              <button
                type="button"
                [class]="segmentClass(filter().status === chip.value)"
                [attr.aria-pressed]="filter().status === chip.value"
                [attr.data-testid]="'status-chip-' + chip.value"
                (click)="onStatus(chip.value)"
              >
                @if (filter().status === chip.value) {
                  <aec-icon name="check" decorative [size]="4" />
                }
                {{ chip.label }}
                <span class="font-normal tabular-nums">{{ chip.count }}</span>
              </button>
            }
          </div>

          @if (filterActive()) {
            <div
              class="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-(--text-secondary)"
            >
              <span>{{ resultLine() }}</span>
              <button
                aecButton
                variant="ghost"
                type="button"
                (click)="clearFilters()"
                i18n="@@vendor.attest.filter.clear"
              >
                Clear filters
              </button>
            </div>
          }
        </div>

        @if (groups().length === 0) {
          <p class="text-sm text-(--text-secondary)" i18n="@@vendor.attest.filter.none">
            No integrations match these filters.
          </p>
        } @else {
          <!-- One card divided by hairlines, like mock-up 13's "What needs you" rows. -->
          <ul
            aecCard
            class="m-0 list-none divide-y divide-(--border-default) overflow-hidden p-0"
            data-testid="integration-list"
          >
            @for (group of groups(); track group.key) {
              @if (group.integrations.length === 1) {
                <li>
                  <ng-container
                    *ngTemplateOutlet="
                      row;
                      context: { $implicit: group.integrations[0], nested: false }
                    "
                  />
                </li>
              } @else {
                <li [attr.aria-labelledby]="'group-' + group.key">
                  <div class="flex items-center gap-3 px-6 pt-4 pb-1">
                    <aec-logo-or-initial
                      [claimStatus]="'stored'"
                      [src]="group.otherProduct.logo_url"
                      [name]="group.otherProduct.name"
                      size="sm"
                    />
                    <h2 [id]="'group-' + group.key" class="m-0 min-w-0">
                      <span
                        class="block truncate font-body text-base font-semibold text-(--text-primary)"
                        >{{ group.otherProduct.name }}</span
                      >
                    </h2>
                    <span class="text-sm text-(--text-secondary)">{{
                      countLine(group.integrations.length)
                    }}</span>
                  </div>
                  <ul class="m-0 list-none p-0 ps-8">
                    @for (integration of group.integrations; track integration.id) {
                      <li>
                        <ng-container
                          *ngTemplateOutlet="row; context: { $implicit: integration, nested: true }"
                        />
                      </li>
                    }
                  </ul>
                </li>
              }
            }
          </ul>
        }
      }
    </div>

    <ng-template #row let-integration let-nested="nested">
      <a
        [routerLink]="linkFor(integration)"
        class="flex items-center gap-4 px-6 py-4 text-(--text-primary) no-underline transition-colors hover:bg-(--surface-sunken) focus-visible:outline-3 focus-visible:-outline-offset-3 focus-visible:outline-(--accent-primary)"
        [attr.data-testid]="'integration-row-' + integration.id"
      >
        @if (!nested) {
          <aec-logo-or-initial
            [claimStatus]="'stored'"
            [src]="integration.other_product.logo_url"
            [name]="integration.other_product.name"
            size="sm"
          />
        }
        <!-- Below 640px the status chip drops under the text, so a long name keeps
             the row's width instead of breaking a word per line. -->
        <span
          class="flex min-w-0 flex-1 flex-col items-start gap-2 sm:flex-row sm:items-center sm:gap-4"
        >
          <span class="min-w-0 flex-1 break-words">
            <span class="flex flex-wrap items-baseline gap-x-2">
              <span class="font-semibold text-(--text-primary)">{{
                primaryName(integration, nested)
              }}</span>
              @if (byLine(integration); as by) {
                <span class="text-sm text-(--text-secondary)">{{ by }}</span>
              }
            </span>
            <span class="mt-1 block text-sm text-(--text-secondary)">{{
              summary(integration)
            }}</span>
          </span>
          <aec-chip
            class="shrink-0"
            density="dense"
            [tone]="chipTone(integration)"
            [icon]="chipIcon(integration)"
            [attr.data-status-tone]="tone(integration)"
            >{{ statusText(integration) }}</aec-chip
          >
        </span>
        <span class="flex shrink-0 text-(--text-secondary)">
          <aec-icon name="chevron-right" decorative [mirrorRtl]="true" />
        </span>
      </a>
    </ng-template>
  `,
})
export class VendorIntegrationsSection implements OnInit {
  private readonly store = inject(VendorPortalStore);
  private readonly announcer = inject(VendorPortalAnnouncer);

  /** The screen's product holds `attestation.author` (AECI-623). Rows widen it, see `rowCanAuthor`. */
  readonly canAuthor = input.required<boolean>();
  readonly vendorName = input.required<string>();

  /**
   * Show only the integrations filed under THIS product (AECI-666). Filtering
   * happens here, not in the request: the store holds ONE vendor-wide read, and the
   * freshness cursor scopes it the same way. Required since AECI-1811: the unscoped
   * `null` mode served only the single-page concept AECI-1809 deleted, and the one
   * caller (`VendorIntegrationsPage`) always passes a product id, `''` while it
   * resolves, which lists nothing rather than flashing every product's rows.
   */
  readonly contextProductId = input.required<string>();

  /** Mirror the filter into the URL (AECI-999). Only the routed page turns this on. */
  readonly urlState = input(false);

  /**
   * AECI-2045 QA (the Same-Behavior Rule). A pure Sync Service offers one "Add an
   * integration", its own; the ordinary create is left out of its tab. Default on.
   */
  readonly offerCreate = input(true);
  /** On a hybrid Sync Service, the ordinary create's trigger names what it adds. */
  readonly createWithName = input<string | null>(null);
  /** A heading over the list, on a Sync Service's tab, where it is the second section. */
  readonly heading = input<string | null>(null);

  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly location = inject(Location);
  private readonly destroyRef = inject(DestroyRef);

  private readonly myVendorId = computed(() => this.store.me()?.vendor.id ?? null);

  protected readonly integrations = computed(() => {
    const scope = this.contextProductId();
    return this.store.integrations().filter((i) => i.context_product.id === scope);
  });

  /**
   * Whether the caller may answer on this row. `canAuthor` is the screen's own
   * gate; a row also opens when the caller owns both endpoints and the OTHER one
   * holds `attestation.author`, which is when the server's
   * `requireAttestationCapability` passes too (AECI-1355). Without the second half
   * a Free product's tab locked a row its detail page lets the vendor answer.
   */
  private readonly rowCanAuthor = computed(() => {
    const screen = this.canAuthor();
    const products = this.store.me()?.products ?? [];
    return (integration: VendorIntegration) =>
      screen || integrationCanAuthor(integration, products);
  });

  /** Any row in scope answerable: drives the summary line and the read-only note. */
  protected readonly anyAuthorable = computed(() => {
    const can = this.rowCanAuthor();
    return this.canAuthor() || this.integrations().some(can);
  });

  private readonly statusInputs = computed(() => ({
    contests: this.store.contests(),
    canAuthor: this.rowCanAuthor(),
  }));

  protected readonly filter = signal<IntegrationFilter>(EMPTY_FILTER);
  protected readonly filterActive = computed(() => isFilterActive(this.filter()));

  private readonly visible = computed(() => {
    const filter = this.filter();
    const inputs = this.statusInputs();
    return this.integrations().filter((i) => matchesFilter(i, filter, inputs));
  });

  protected readonly groups = computed(() => groupByCounterpart(this.visible()));

  protected readonly statusChips = computed(() => {
    const filter = this.filter();
    const inputs = this.statusInputs();
    const tallies = statusTallies(this.integrations(), filter, inputs);
    const withoutStatus: IntegrationFilter = { ...filter, status: 'all' };
    const all = this.integrations().filter((i) => matchesFilter(i, withoutStatus, inputs)).length;
    const chips: { value: StatusFilter; label: string; count: number }[] = [
      { value: 'all', label: $localize`:@@vendor.attest.filter.status.all:All`, count: all },
    ];
    for (const key of INTEGRATION_STATUS_KEYS) {
      const count = tallies.get(key) ?? 0;
      // A chip that would give zero results is noise, unless it is the one
      // selected, which must stay visible so it can be turned off.
      if (count > 0 || filter.status === key) {
        chips.push({ value: key, label: statusChipLabel(key), count });
      }
    }
    return chips;
  });

  protected readonly resultLine = computed(() => {
    const shown = this.visible().length;
    const total = this.integrations().length;
    return $localize`:@@vendor.im.list.result:Showing ${shown}:shown: of ${total}:total: integrations`;
  });

  protected readonly filterRegionLabel = $localize`:@@vendor.attest.filter.aria:Filter integrations`;
  protected readonly statusGroupLabel = $localize`:@@vendor.attest.filter.status.aria:Filter by status`;
  protected readonly queryPlaceholder = $localize`:@@vendor.im.list.placeholder:Product, connector or type of data`;
  protected readonly sideOptions: readonly { value: CounterpartSide; label: string }[] = [
    { value: 'any', label: $localize`:@@vendor.attest.filter.side.any:Any product` },
    { value: 'own', label: $localize`:@@vendor.attest.filter.side.own:Your own products` },
    {
      value: 'other',
      label: $localize`:@@vendor.im.list.side.other:Other companies' products`,
    },
  ];

  private announceTimer: ReturnType<typeof setTimeout> | null = null;

  protected readonly loading = this.store.integrationsLoading;
  protected readonly failed = this.store.integrationsFailed;
  protected readonly loaded = computed(() => !this.loading() && !this.failed());

  /** Distinct rows of data, and those waiting on the caller (AECI-993 dedupe). */
  protected readonly summaryLine = computed(() => {
    const integrations = this.integrations();
    const total = claimsOnRecord(integrations).total;
    const awaiting = waitingByProduct(integrations.filter(this.rowCanAuthor())).total;
    return $localize`:@@vendor.im.list.summary:${total}:total: rows of data on record · ${awaiting}:awaiting: need your answer`;
  });

  protected readonly labelClass = FIELD_LABEL_CLASS;
  protected readonly inputClass = FIELD_INPUT_CLASS;
  protected readonly selectClass = `${FIELD_INPUT_CLASS} cursor-pointer appearance-none pe-12`;
  protected readonly noticeClass = PORTAL_NOTICE_CLASS;
  protected readonly noticeBodyClass = PORTAL_NOTICE_BODY_CLASS;
  protected readonly segmentedClass = SEGMENTED_CLASS;

  /** One status toggle: Forest when pressed, with a tick so the state is not colour alone. */
  protected segmentClass(pressed: boolean): string {
    return segmentClass(pressed);
  }

  /** The row's status on the shared chip, in the portal's existing tones (no new ones). */
  protected chipTone(integration: VendorIntegration): ChipTone {
    return STATUS_CHIP_TONE[this.tone(integration)];
  }

  protected chipIcon(integration: VendorIntegration): AecIconName | null {
    return STATUS_CHIP_ICON[this.tone(integration)];
  }

  constructor() {
    afterNextRender(() => {
      void this.store.ensure('integrations');
      // Statuses that depend on change requests read the vendor-wide contests.
      void this.store.ensure('contests');
    });
    this.destroyRef.onDestroy(() => {
      if (this.announceTimer !== null) clearTimeout(this.announceTimer);
    });
  }

  ngOnInit(): void {
    if (!this.urlState()) return;
    this.filter.set(filterFromParams(this.route.snapshot.queryParamMap));
  }

  /** The page's route. Relative from the routed list (`…/integrations`), and from
   *  the portal root on the single-page concept, which has no route of its own. */
  protected linkFor(integration: VendorIntegration): readonly string[] {
    return this.integrationRoute(integration.id, integration.context_product.slug);
  }

  private integrationRoute(id: string, productSlug: string): readonly string[] {
    return this.urlState()
      ? ['..', 'integrations', id]
      : ['products', productSlug, 'integrations', id];
  }

  /** The create form's links to a likely duplicate and to its receipt's row
   *  (AECI-1953). The same route as {@link linkFor}, by id and product slug. */
  protected readonly createLink: VendorIntegrationLink = (id, productSlug) =>
    this.integrationRoute(id, productSlug);

  protected primaryName(integration: VendorIntegration, nested: boolean): string {
    if (!nested) return integration.other_product.name;
    return (
      integration.mechanism_name ??
      integration.name ??
      howYouGetIt(integration.mechanism_kind, integration.powered_by?.name ?? null)
    );
  }

  protected byLine(integration: VendorIntegration): string | null {
    if (ownsBoth(integration)) {
      return $localize`:@@vendor.im.list.yourProduct:Your product`;
    }
    const company = otherCompanyName(integration, this.myVendorId());
    return company ? $localize`:@@vendor.im.list.by:by ${company}:company:` : null;
  }

  protected summary(integration: VendorIntegration): string {
    return sharedSummary(integration);
  }

  private statusKey(integration: VendorIntegration): IntegrationStatusKey {
    return statusOf(integration, this.statusInputs());
  }

  protected statusText(integration: VendorIntegration): string {
    return statusLabel(
      this.statusKey(integration),
      contestsFor(this.store.contests(), integration.id),
    );
  }

  protected tone(integration: VendorIntegration) {
    return statusTone(this.statusKey(integration));
  }

  protected countLine(n: number): string {
    return $localize`:@@vendor.im.list.count:${n}:count: integrations`;
  }

  protected onQuery(event: Event): void {
    this.setFilter({ ...this.filter(), query: (event.target as HTMLInputElement).value });
  }

  protected onSide(event: Event): void {
    this.setFilter({
      ...this.filter(),
      side: (event.target as HTMLSelectElement).value as CounterpartSide,
    });
  }

  protected onStatus(status: StatusFilter): void {
    this.setFilter({ ...this.filter(), status });
  }

  protected clearFilters(): void {
    this.setFilter(EMPTY_FILTER);
  }

  private setFilter(next: IntegrationFilter): void {
    this.filter.set(next);
    this.writeUrl();
    this.scheduleResultAnnouncement();
  }

  /** Replace the URL's query without a router navigation, which would reset the
   *  scroll on every keystroke. */
  private writeUrl(): void {
    if (!this.urlState()) return;
    const tree = this.router.createUrlTree([], {
      relativeTo: this.route,
      queryParams: filterToParams(this.filter()),
      queryParamsHandling: 'merge',
    });
    this.location.replaceState(this.router.serializeUrl(tree));
  }

  /** Debounced so typing a query does not queue one utterance per keystroke. */
  private scheduleResultAnnouncement(): void {
    if (this.announceTimer !== null) clearTimeout(this.announceTimer);
    this.announceTimer = setTimeout(() => {
      this.announceTimer = null;
      this.announcer.announce(
        this.filterActive()
          ? this.resultLine()
          : $localize`:@@vendor.attest.filter.live.cleared:Showing every integration.`,
      );
    }, 600);
  }

  /** The retry beside the failure state announces its outcome, because the state
   *  paragraphs are not a live region. */
  protected reload(): void {
    void this.store.reload('integrations').then(() => {
      this.announcer.announce(
        this.failed()
          ? $localize`:@@vendor.attest.live.reloadFailed:Your integrations could not be loaded.`
          : $localize`:@@vendor.attest.live.reloaded:Your integrations are up to date.`,
      );
    });
  }
}
