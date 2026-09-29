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
import { ID_STYLES } from '../integration-detail/integration-detail-styles';
import { claimsOnRecord, waitingByProduct } from '../overview/vendor-overview-model';
import { VendorPortalAnnouncer } from '../vendor-announcer';
import { vendorHasActiveEntitlement } from '../vendor-capabilities';
import { VendorPortalStore } from '../vendor-portal-store';

import { VendorIntegrationCreate } from './vendor-integration-create';
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
  imports: [NgTemplateOutlet, RouterLink, LogoOrInitial, VendorIntegrationCreate],
  styles: [ID_STYLES],
  template: `
    <div class="space-y-6" [attr.aria-busy]="loading() ? 'true' : null">
      <p class="max-w-prose text-sm text-(--text-secondary)" i18n="@@vendor.attest.intro">
        These are the integrations on record for your products. Open one to check what data is
        shared and to fix anything that is wrong. The other company sees the same integration from
        their side.
      </p>

      @if (canAuthor() && loaded()) {
        <p class="text-sm text-(--text-secondary)" data-testid="integrations-summary">
          {{ summaryLine() }}
        </p>
      }

      <!-- AECI-1011. A seat is the whole gate for listing an integration
           (AECI-1003 decision 15), unlike answering. -->
      <aec-vendor-integration-create [contextProductId]="contextProductId()" />

      @if (!canAuthor()) {
        <div class="rounded-(--radius-md) border border-(--border-default) p-4">
          <p class="text-sm text-(--text-secondary)" i18n="@@vendor.attest.readOnly">
            You can review everything on record here. Confirming data flows and adding new ones
            opens up with active vendor access. That access is arranged with AEC Integrations, not
            something you switch on from this portal.
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
            type="button"
            [class]="retryClass"
            (click)="reload()"
            i18n="@@vendor.attest.retry"
          >
            Try again
          </button>
        </div>
      } @else if (integrations().length === 0) {
        <p class="max-w-prose text-sm text-(--text-secondary)" i18n="@@vendor.attest.empty">
          No integrations are on record for your products yet. AEC Integrations adds integrations
          from public sources, and you can add one your company offers above. When one appears you
          can confirm what data it moves.
        </p>
      } @else {
        <div
          class="space-y-3 rounded-(--radius-md) border border-(--border-default) bg-(--surface-raised) p-4"
          role="search"
          [attr.aria-label]="filterRegionLabel"
        >
          <div class="flex flex-wrap items-end gap-3">
            <div class="min-w-0 flex-1 basis-64">
              <label
                for="vendor-integrations-query"
                class="block text-xs font-medium text-(--text-secondary)"
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
                class="mt-1 w-full rounded-(--radius-sm) border border-(--border-default)
                  bg-(--surface-base) px-3 py-2 text-sm text-(--text-primary)
                  focus-visible:outline-2 focus-visible:outline-offset-2
                  focus-visible:outline-(--accent-primary)"
              />
            </div>
            <div>
              <label
                for="vendor-integrations-side"
                class="block text-xs font-medium text-(--text-secondary)"
                i18n="@@vendor.attest.filter.side.label"
                >Integrates with</label
              >
              <div class="relative mt-1">
                <select
                  id="vendor-integrations-side"
                  (change)="onSide($event)"
                  class="appearance-none rounded-(--radius-sm) border border-(--border-default)
                    bg-(--surface-base) py-2 pe-9 ps-3 text-sm text-(--text-primary)
                    focus-visible:outline-2 focus-visible:outline-offset-2
                    focus-visible:outline-(--accent-primary)"
                >
                  @for (option of sideOptions; track option.value) {
                    <option [value]="option.value" [selected]="option.value === filter().side">
                      {{ option.label }}
                    </option>
                  }
                </select>
                <svg
                  class="pointer-events-none absolute end-3 top-1/2 h-4 w-4 -translate-y-1/2 text-(--text-secondary)"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </div>
            </div>
          </div>

          <div
            class="flex flex-wrap items-center gap-2"
            role="group"
            [attr.aria-label]="statusGroupLabel"
          >
            @for (chip of statusChips(); track chip.value) {
              <button
                type="button"
                class="aec-period inline-flex min-h-8 cursor-pointer items-center gap-1.5 rounded-(--radius-sm)
                  border border-(--border-default) bg-(--surface-base) px-2.5 py-1 text-xs font-semibold
                  text-(--text-secondary) transition-colors hover:text-(--text-primary)
                  focus-visible:outline-2 focus-visible:outline-offset-2
                  focus-visible:outline-(--accent-primary)"
                [attr.aria-pressed]="filter().status === chip.value"
                [attr.data-testid]="'status-chip-' + chip.value"
                (click)="onStatus(chip.value)"
              >
                {{ chip.label }}
                <span class="font-normal tabular-nums">{{ chip.count }}</span>
              </button>
            }
          </div>

          @if (filterActive()) {
            <div
              class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-(--text-secondary)"
            >
              <span>{{ resultLine() }}</span>
              <button
                type="button"
                class="cursor-pointer font-medium text-(--text-primary) underline decoration-(--border-strong)
                  underline-offset-4 hover:text-(--accent-primary) focus-visible:outline-2
                  focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
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
          <ul
            class="id-card m-0 list-none divide-y divide-(--border-default) p-0"
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
                  <div class="flex items-center gap-3 px-5 pt-4 pb-1">
                    <aec-logo-or-initial
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
        class="flex items-center gap-4 px-5 py-4 text-(--text-primary) no-underline transition-colors hover:bg-(--surface-sunken) focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--accent-primary)"
        [attr.data-testid]="'integration-row-' + integration.id"
      >
        @if (!nested) {
          <aec-logo-or-initial
            [src]="integration.other_product.logo_url"
            [name]="integration.other_product.name"
            size="sm"
          />
        }
        <span class="min-w-0 flex-1">
          <span class="flex flex-wrap items-baseline gap-x-2">
            <span class="font-semibold text-(--text-primary)">{{
              primaryName(integration, nested)
            }}</span>
            @if (byLine(integration); as by) {
              <span class="text-sm text-(--text-secondary)">{{ by }}</span>
            }
          </span>
          <span class="mt-0.5 block text-sm text-(--text-secondary)">{{
            summary(integration)
          }}</span>
        </span>
        <span class="id-pill shrink-0" [attr.data-tone]="tone(integration)">
          @switch (tone(integration)) {
            @case ('ok') {
              <svg
                aria-hidden="true"
                class="h-3 w-3"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="3"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M20 6 9 17l-5-5" />
              </svg>
            }
            @case ('conflict') {
              <svg
                aria-hidden="true"
                class="h-3 w-3"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="3"
                stroke-linecap="round"
              >
                <path d="M7 7l10 10M17 7L7 17" />
              </svg>
            }
            @case ('attention') {
              <span
                aria-hidden="true"
                class="h-2 w-2 rounded-full bg-(--accent-secondary-deep)"
              ></span>
            }
            @default {
              <span aria-hidden="true" class="h-2 w-2 rounded-full bg-(--text-secondary)"></span>
            }
          }
          {{ statusText(integration) }}
        </span>
        <svg
          aria-hidden="true"
          class="h-5 w-5 shrink-0 text-(--text-secondary) rtl:-scale-x-100"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="m9 18 6-6-6-6" />
        </svg>
      </a>
    </ng-template>
  `,
})
export class VendorIntegrationsSection implements OnInit {
  private readonly store = inject(VendorPortalStore);
  private readonly announcer = inject(VendorPortalAnnouncer);

  /** Holds `attestation.author` (AECI-623). */
  readonly canAuthor = input.required<boolean>();
  readonly vendorName = input.required<string>();

  /**
   * Show only the integrations filed under THIS product (AECI-666). `null` keeps
   * the whole surface, which the single-page concept (`vendor-dashboard-single.ts`)
   * still renders. Filtering happens here, not in the request: the store holds ONE
   * vendor-wide read, and the freshness cursor scopes it the same way.
   */
  readonly contextProductId = input<string | null>(null);

  /** Mirror the filter into the URL (AECI-999). Only the routed page turns this on. */
  readonly urlState = input(false);

  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly location = inject(Location);
  private readonly destroyRef = inject(DestroyRef);

  private readonly entitled = vendorHasActiveEntitlement(this.store);
  private readonly myVendorId = computed(() => this.store.me()?.vendor.id ?? null);

  protected readonly integrations = computed(() => {
    const scope = this.contextProductId();
    const all = this.store.integrations();
    return scope === null ? all : all.filter((i) => i.context_product.id === scope);
  });

  private readonly statusInputs = computed(() => ({
    contests: this.store.contests(),
    entitled: this.entitled(),
    canAuthor: this.canAuthor(),
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
    const awaiting = waitingByProduct(integrations).total;
    return $localize`:@@vendor.im.list.summary:${total}:total: rows of data on record · ${awaiting}:awaiting: need your answer`;
  });

  protected readonly retryClass =
    'rounded-(--radius-sm) border border-(--border-default) px-3 py-1.5 text-sm font-medium text-(--text-primary) transition-colors hover:border-(--border-strong) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';

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
    return this.urlState()
      ? ['..', 'integrations', integration.id]
      : ['products', integration.context_product.slug, 'integrations', integration.id];
  }

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
