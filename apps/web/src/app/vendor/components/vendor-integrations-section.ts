import { Location } from '@angular/common';
import {
  Component,
  DestroyRef,
  type OnInit,
  afterNextRender,
  afterRenderEffect,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChildren,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';

import { mirrorContextDirection } from '@aeci/shared';
import type {
  DataObjectOption,
  ProductVersion,
  VendorClaim,
  VendorIntegration,
} from '@aeci/shared';

import { claimsOnRecord, waitingByProduct } from '../overview/vendor-overview-model';
import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorApi } from '../vendor-api';
import { VendorPortalStore } from '../vendor-portal-store';

import { healthLabel } from './vendor-attestation-labels';
import { claimOutcomeLine } from './vendor-claim-outcome';
import { VendorCounterpartGroup } from './vendor-counterpart-group';
import {
  type CounterpartGroup,
  type CounterpartSide,
  EMPTY_FILTER,
  HEALTH_ORDER,
  type HealthFilter,
  type IntegrationFilter,
  filterFromParams,
  filterToParams,
  groupByCounterpart,
  healthTallies,
  isFilterActive,
  matchesFilter,
  openSlugsFromParam,
  openSlugsToParam,
} from './vendor-integration-health';

/**
 * The Integrations tab's body (AECI-606 / `STAGE_2_ATTESTATIONS_SPEC.md` §6):
 * every integration touching a product this vendor owns, what each side has said
 * about each data flow, and the controls to say something.
 *
 * ── WHY THIS FETCHES, WHEN THE DASHBOARD IS "PRESENTATIONAL" ────────────────
 * §6 says the dashboard component takes its payload as an input and must stay
 * that way, because it renders both `/preview/vendor-dashboard` and the gated
 * `/vendor` route. That holds — `VendorDashboardTabbed` still takes only `me`.
 * The rule lands one level down, exactly as it already does for
 * `vendor-seat-roster.ts` and `vendor-products-section.ts`: a child injects
 * `VendorApi`, and the preview shadows `VendorApi` through DI. So the same
 * component runs verbatim on both surfaces with no conditional code, and the
 * heavier read stays off every other tab's SSR path.
 *
 * ── STATE (AECI-628) ────────────────────────────────────────────────────────
 * The integration list is owned by {@link VendorPortalStore}, not by this
 * component: a revalidation loop has to be able to refresh it while the tab is
 * closed, and an optimistic attestation write has to be able to roll back to an
 * exact prior value that survives the `@switch` destroying this component.
 * Everything else about the reconciliation contract is unchanged.
 *
 * Writes reconcile from the echo (`POST`/`PUT` both return the recomputed claim,
 * agreement included), so there is no refetch on the common path; the echo is
 * spliced into the store through `apply(...).commit()`. `DELETE` is the
 * exception: it answers `204` with no body, and the claim cannot be
 * reconstructed locally, because `counterparty` is a *lossy* reduction of every
 * other voter — with a third vendor in play, dropping the caller's own row can
 * leave a genuine `conflict` that a local guess would render as `single_source`.
 * The contract is explicit that the dashboard never re-derives
 * `computeAgreement`. So a retract triggers one targeted re-read, and that read
 * stays HERE rather than becoming `store.revalidate(['integrations'])`: the
 * store would replace the whole list, and splicing the one claim by id is what
 * keeps a concurrent write on another claim from being clobbered.
 *
 * The vocabulary and per-product version lists are NOT store state. They are
 * lookup tables this tab uses to render its controls, they never change under
 * the reader, and they are read straight from `VendorApi` (which is also what
 * keeps the preview's DI shadow working for them).
 *
 * Per-claim busy/error state lives in `VendorAttestationControl`, one instance
 * per claim — the component boundary is the scoping mechanism, so there is no
 * map keyed by claim id to keep in sync.
 *
 * ── ANNOUNCEMENTS (AECI-631 / §6.3) ─────────────────────────────────────────
 * This tab used to own the surface's live region. It no longer does: the region
 * was hoisted to `vendor-dashboard-tabbed.ts` and this component announces
 * through {@link VendorPortalAnnouncer}. Two things made the move necessary
 * rather than cosmetic. The `@switch` in the shell DESTROYS this component on a
 * tab switch, taking a region mid-announcement with it; and the integration card
 * carried a second `role="status"` of its own, so one event could queue two
 * competing utterances.
 *
 * The wording still originates here, because this component is the one place
 * that sees every write's result and can therefore name the subject ("RFIs ·
 * position saved") rather than saying something vague. Only the channel moved.
 *
 * The loading and failure paragraphs are deliberately NOT live regions. They are
 * the state of this section, not announcements, and a `role="status"` on each
 * would put three regions back on the page. The block carries `aria-busy` while
 * it loads, and the one moment where silence would be wrong — a vendor pressing
 * "Try again" and getting no feedback — announces its outcome explicitly.
 *
 * ── NO LAYOUT SHIFT UNDER THE POINTER (§6.3) ────────────────────────────────
 * A revalidation that reflows the control the vendor is about to click is a
 * worse outcome than the staleness it fixes. Two properties hold that here, and
 * both are load-bearing rather than incidental. `loading()` is false while the
 * store reports `refreshing` — it distinguishes "no data yet" from "we have data
 * and are checking" precisely so a background fetch cannot swap the card list
 * for the loading paragraph or drop the summary line. And every `@for` tracks by a
 * stable id (counterpart key, integration id, claim id), so a poll returning the
 * same integrations patches the lanes that changed instead of tearing down and
 * rebuilding the list under the cursor. Groups are ordered by name, never by
 * health, for the same reason (AECI-999 / §6.3).
 *
 * ── COPY ────────────────────────────────────────────────────────────────────
 * §6's discipline, enforced here and in `vendor-attestation-labels.ts`: no
 * instant-search promise, nothing implying attestation affects ranking or
 * placement, and active access framed as an account status arranged with AEC
 * Integrations.
 */
@Component({
  selector: 'aec-vendor-integrations-section',
  imports: [VendorCounterpartGroup],
  styles: [':host { display: block; }'],
  template: `
    <div class="space-y-6" [attr.aria-busy]="loading() ? 'true' : null">
      <p class="max-w-prose text-sm text-(--text-secondary)" i18n="@@vendor.attest.intro">
        These are the integrations we have on record for your products. Confirm the data flows that
        are real, and say so when one is not. The other vendor sees the same list from their side.
      </p>

      @if (canWrite() && loaded()) {
        <p class="text-sm text-(--text-secondary)">{{ summaryLine() }}</p>
      }

      @if (!canWrite()) {
        <!--
          The plan read-out itself lives ONCE, on the Overview panel
          (vendor-plan-panel.ts, AECI-614). This is only the local consequence, so
          it states what is closed here and does not restate the status chip.
        -->
        <div class="rounded-(--radius-md) border border-(--border-default) p-4">
          <p class="text-sm text-(--text-secondary)" i18n="@@vendor.attest.readOnly">
            You can review everything on record here. Confirming data flows and adding new ones
            opens up with active vendor access. That access is arranged with AEC Integrations, not
            something you switch on from this portal.
          </p>
        </div>
      }

      @if (loading()) {
        <!--
          No role="status" here: this is the section's state, not an
          announcement, and the surface has exactly one announcement channel
          (the shell's region). aria-busy on the wrapper above is what tells
          assistive tech this block is still settling.
        -->
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
          from public sources; when one appears you can confirm what data it moves.
        </p>
      } @else {
        @if (dataObjectsFailed() && canWrite()) {
          <p class="text-sm text-(--text-secondary)" i18n="@@vendor.attest.vocabularyFailed">
            The data object list could not be loaded, so new data flows cannot be added right now.
          </p>
        }

        <!--
          AECI-999 (section 6.3). The filter bar. Every value is URL state when
          the section is routed, so a filtered, opened view can be shared with
          another vendor administrator. Results are announced through the shell's
          one live region, never a role="status" here.
        -->
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
                  border border-(--border-default) bg-(--surface-base) px-2.5 text-xs font-semibold
                  text-(--text-secondary) transition-colors hover:text-(--text-primary)
                  focus-visible:outline-2 focus-visible:outline-offset-2
                  focus-visible:outline-(--accent-primary)"
                [attr.aria-pressed]="filter().health === chip.value"
                (click)="onHealth(chip.value)"
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
          <div class="space-y-3">
            @for (group of groups(); track group.key) {
              <aec-vendor-counterpart-group
                [group]="group"
                [expanded]="isOpen(group)"
                [vendorName]="vendorName()"
                [canWrite]="canWrite()"
                [dataObjects]="dataObjects()"
                [versions]="versionsForProduct(group.contextProduct.id)"
                (toggled)="toggleGroup(group)"
                (claimChanged)="onClaimChanged($event)"
                (claimCreated)="onClaimCreated($event)"
                (retracted)="onRetracted($event)"
              />
            }
          </div>
        }
      }
    </div>
  `,
})
export class VendorIntegrationsSection implements OnInit {
  private readonly api = inject(VendorApi);
  private readonly store = inject(VendorPortalStore);
  private readonly announcer = inject(VendorPortalAnnouncer);

  readonly verified = input.required<boolean>();
  readonly vendorName = input.required<string>();

  /**
   * Show only the integrations filed under THIS product (AECI-666). `null` keeps
   * the whole attestable surface, which is what the single-page concept
   * (`vendor-dashboard-single.ts`) still renders — it has no product selection to
   * filter by.
   *
   * Filtering happens here rather than in the request on purpose: the store holds
   * ONE vendor-wide `GET /api/vendor/integrations`, and the AECI-627 freshness
   * cursor scopes its `integrations` scope with the same vendor-wide predicate.
   * Fetching per product would break that invariant ("every cursor query reuses
   * the scoping predicate of the handler it is a cursor for") and turn one call
   * into one per product, for a payload already bounded by the vendor's catalog.
   */
  readonly contextProductId = input<string | null>(null);

  /**
   * Mirror the filter and the open groups into the URL (AECI-999). Only the
   * routed page turns this on. The single-page concept renders the same section
   * with no route of its own, where writing query params would be noise.
   */
  readonly urlState = input(false);

  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly location = inject(Location);
  private readonly destroyRef = inject(DestroyRef);

  private readonly groupRows = viewChildren(VendorCounterpartGroup);

  private readonly allIntegrations = this.store.integrations;

  /** The surface as this tab shows it. The server emits one entry per owned
   *  endpoint, so filtering by `context_product.id` is what files an integration
   *  under a product — including listing an owns-both integration under both. */
  protected readonly integrations = computed(() => {
    const scope = this.contextProductId();
    const all = this.allIntegrations();
    return scope === null ? all : all.filter((i) => i.context_product.id === scope);
  });
  // ── Drill-down state (AECI-999 / §6.3) ──────────────────────────────────────

  protected readonly filter = signal<IntegrationFilter>(EMPTY_FILTER);
  protected readonly filterActive = computed(() => isFilterActive(this.filter()));

  /** Counterpart product slugs whose group row is open. Everything starts closed. */
  private readonly openSlugs = signal<ReadonlySet<string>>(new Set());

  /**
   * Integration ids that stay listed even after they stop matching the filter.
   *
   * Without this, "Needs your input" plus an Affirm would make the integration
   * vanish the instant the optimistic patch lands, taking the control, its busy
   * state and any rollback error with it. An integration is pinned when its group
   * is opened, and the pins reset whenever the filter changes.
   */
  private readonly pinnedIds = signal<ReadonlySet<string>>(new Set());

  private readonly visibleIntegrations = computed(() => {
    const filter = this.filter();
    const pinned = this.pinnedIds();
    return this.integrations().filter((i) => pinned.has(i.id) || matchesFilter(i, filter));
  });

  protected readonly groups = computed(() =>
    groupByCounterpart(this.visibleIntegrations(), this.integrations()),
  );

  private readonly totalGroups = computed(() => groupByCounterpart(this.integrations()).length);

  protected readonly statusChips = computed(() => {
    const filter = this.filter();
    const tallies = healthTallies(this.integrations(), filter);
    // Not the sum of the tallies: "Needs your input" overlaps "Conflict".
    const withoutHealth: IntegrationFilter = { ...filter, health: 'all' };
    const all = this.integrations().filter((i) => matchesFilter(i, withoutHealth)).length;
    const chips: { value: HealthFilter; label: string; count: number }[] = [
      { value: 'all', label: $localize`:@@vendor.attest.filter.status.all:All`, count: all },
    ];
    for (const health of HEALTH_ORDER) {
      const count = tallies.get(health) ?? 0;
      // A chip that would give zero results is noise, unless it is the one
      // selected, which must stay visible so it can be turned off.
      if (count > 0 || filter.health === health) {
        chips.push({ value: health, label: healthLabel(health), count });
      }
    }
    return chips;
  });

  protected readonly resultLine = computed(
    () =>
      $localize`:@@vendor.attest.filter.result:Showing ${this.groups().length}:shown: of ${this.totalGroups()}:total: products`,
  );

  protected readonly filterRegionLabel = $localize`:@@vendor.attest.filter.aria:Filter integrations`;
  protected readonly statusGroupLabel = $localize`:@@vendor.attest.filter.status.aria:Filter by status`;
  protected readonly queryPlaceholder = $localize`:@@vendor.attest.filter.query.placeholder:Product, connector or data object`;
  protected readonly sideOptions: readonly { value: CounterpartSide; label: string }[] = [
    { value: 'any', label: $localize`:@@vendor.attest.filter.side.any:Any product` },
    { value: 'own', label: $localize`:@@vendor.attest.filter.side.own:Your own products` },
    {
      value: 'other',
      label: $localize`:@@vendor.attest.filter.side.other:Other vendors' products`,
    },
  ];

  private announceTimer: ReturnType<typeof setTimeout> | null = null;

  protected readonly loading = this.store.integrationsLoading;
  protected readonly failed = this.store.integrationsFailed;
  protected readonly dataObjects = signal<readonly DataObjectOption[]>([]);
  protected readonly dataObjectsFailed = signal(false);
  protected readonly versionsByProduct = signal<ReadonlyMap<string, readonly ProductVersion[]>>(
    new Map(),
  );

  /** Set after a create or a pivot; consumed once the lane exists. */
  private readonly pendingFocusClaimId = signal<string | null>(null);

  protected readonly canWrite = computed(() => this.verified());
  protected readonly loaded = computed(() => !this.loading() && !this.failed());

  /**
   * The two counts, and why only one of them is gated (AECI-705 / §14).
   *
   * `total` stays every claim on record: the vendor can read all of them, and
   * under-reporting the surface would contradict its own public pair pages.
   *
   * `awaiting` counts only claims on an **attestable** edge. This phrase is the
   * in-portal half of the prompt the acceptance criterion forbids: on a
   * connector-powered edge it would tell a vendor that plumbing it never built is
   * waiting on its confirmation, which is exactly the sentence the detector
   * suppression exists to stop sending by email.
   *
   * Both are distinct claim ids (AECI-993). Unscoped, the list carries an
   * owns-both integration once per endpoint, so `flatMap(...).length` would
   * count its claims twice.
   */
  protected readonly summaryLine = computed(() => {
    const integrations = this.integrations();
    const total = claimsOnRecord(integrations).total;
    const awaiting = waitingByProduct(integrations).total;
    return $localize`:@@vendor.attest.summary:${total}:total: data flows on record · ${awaiting}:awaiting: waiting on your confirmation`;
  });

  protected readonly retryClass =
    'rounded-(--radius-sm) border border-(--border-default) px-3 py-1.5 text-sm font-medium text-(--text-primary) transition-colors hover:border-(--border-strong) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';

  constructor() {
    afterNextRender(() => void this.load('ensure'));

    this.destroyRef.onDestroy(() => {
      if (this.announceTimer !== null) clearTimeout(this.announceTimer);
    });

    // A shared link can open a group before the list has loaded. Once the list
    // is there, pin what those groups show, so the first write in them behaves
    // like one made after a click.
    effect(() => {
      if (!this.loaded() || this.integrations().length === 0) return;
      untracked(() => this.pinOpenGroups());
    });

    // `afterRenderEffect`, not `afterNextRender`: focus has to move repeatedly —
    // after every create and every duplicate pivot — and only once the lane it
    // targets actually exists.
    afterRenderEffect(() => {
      const claimId = this.pendingFocusClaimId();
      if (!claimId) return;
      for (const group of this.groupRows()) {
        if (group.hasClaim(claimId)) group.focusClaim(claimId);
      }
      this.pendingFocusClaimId.set(null);
    });
  }

  ngOnInit(): void {
    if (!this.urlState()) return;
    const params = this.route.snapshot.queryParamMap;
    this.filter.set(filterFromParams(params));
    this.openSlugs.set(openSlugsFromParam(params.get('open')));
  }

  protected versionsForProduct(contextProductId: string): readonly ProductVersion[] {
    // The caller's OWN endpoint product only. §8.2 requires a version stamp to
    // belong to the attesting side's endpoint, so offering the counterpart's
    // releases here would generate guaranteed 400s.
    return this.versionsByProduct().get(contextProductId) ?? [];
  }

  protected isOpen(group: CounterpartGroup): boolean {
    return this.openSlugs().has(group.otherProduct.slug);
  }

  protected toggleGroup(group: CounterpartGroup): void {
    const slug = group.otherProduct.slug;
    const next = new Set(this.openSlugs());
    if (next.has(slug)) {
      next.delete(slug);
    } else {
      next.add(slug);
      this.pinnedIds.update((ids) => new Set([...ids, ...group.integrations.map((i) => i.id)]));
    }
    this.openSlugs.set(next);
    this.writeUrl();
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

  protected onHealth(health: HealthFilter): void {
    this.setFilter({ ...this.filter(), health });
  }

  protected clearFilters(): void {
    this.setFilter(EMPTY_FILTER);
  }

  /**
   * A new filter is a new question, so it starts from a clean slate: every
   * group closes and every pin drops. Keeping groups open across a filter change
   * would leave rows listed that the new filter excludes.
   */
  private setFilter(next: IntegrationFilter): void {
    this.filter.set(next);
    this.openSlugs.set(new Set());
    this.pinnedIds.set(new Set());
    this.writeUrl();
    this.scheduleResultAnnouncement();
  }

  private pinOpenGroups(): void {
    const open = this.openSlugs();
    if (open.size === 0) return;
    const filter = this.filter();
    const ids = this.integrations()
      .filter((i) => open.has(i.other_product.slug) && matchesFilter(i, filter))
      .map((i) => i.id);
    if (ids.length === 0) return;
    this.pinnedIds.update((pinned) => new Set([...pinned, ...ids]));
  }

  /**
   * Replace the URL's query without a router navigation. A navigation would
   * trip `withInMemoryScrolling`'s reset and throw the vendor back to the top of
   * the page on every keystroke and every row they open.
   */
  private writeUrl(): void {
    if (!this.urlState()) return;
    const tree = this.router.createUrlTree([], {
      relativeTo: this.route,
      queryParams: { ...filterToParams(this.filter()), open: openSlugsToParam(this.openSlugs()) },
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

  /**
   * The retry beside the failure state. It announces its outcome because it is
   * the one path where the section's own state paragraphs are not enough: the
   * vendor deliberately pressed a button, and the loading/failure text is not a
   * live region, so without this a retry is silent for a screen-reader user.
   */
  protected reload(): void {
    void this.load('reload').then(() => {
      this.announcer.announce(
        this.failed()
          ? $localize`:@@vendor.attest.live.reloadFailed:Your integrations could not be loaded.`
          : $localize`:@@vendor.attest.live.reloaded:Your integrations are up to date.`,
      );
    });
  }

  /**
   * `ensure` on mount (the store may already hold the list from an earlier visit
   * to this tab), `reload` from the retry button. The two secondary reads are
   * component-local, so they run on both paths.
   */
  private async load(mode: 'ensure' | 'reload'): Promise<void> {
    await (mode === 'ensure'
      ? this.store.ensure('integrations')
      : this.store.reload('integrations'));
    if (this.store.integrationsFailed()) return;

    // Both secondary reads degrade without blocking the list: an unseeded
    // vocabulary or a versions outage removes an affordance, it does not remove
    // the surface.
    void this.loadVocabulary();
    void this.loadVersions();
  }

  private async loadVocabulary(): Promise<void> {
    try {
      const res = await this.api.getDataObjects();
      this.dataObjects.set(res.data_objects);
      this.dataObjectsFailed.set(res.data_objects.length === 0);
    } catch {
      this.dataObjectsFailed.set(true);
    }
  }

  private async loadVersions(): Promise<void> {
    const productIds = [...new Set(this.integrations().map((i) => i.context_product.id))];
    const results = await Promise.allSettled(
      productIds.map(
        async (id) => [id, (await this.api.listProductVersions(id)).versions] as const,
      ),
    );
    const next = new Map<string, readonly ProductVersion[]>();
    for (const result of results) {
      if (result.status === 'fulfilled') next.set(result.value[0], result.value[1]);
    }
    this.versionsByProduct.set(next);
  }

  /** Splice one claim in place, leaving every other object identity untouched so
   *  `@for`'s `track claim.id` only rebuilds the lane that actually changed.
   *
   *  `commit()` because the patch IS the server's answer: these all come from a
   *  write echo or a targeted re-read, so there is nothing left to reconcile.
   *
   *  ── IT SPLICES INTO EVERY ENTRY OF THE INTEGRATION (AECI-666) ─────────────
   *  The store holds one entry per OWNED ENDPOINT, so an integration whose two
   *  endpoints this vendor owns is in the list twice. Matching on
   *  `integration_id` therefore hits both — which is correct, not a bug: a write
   *  fills every slot the caller owns and §4 dedupes voters by vendor, so the two
   *  entries are one position seen from two sides and must never disagree.
   *
   *  What DOES differ between them is `direction`, which is context-relative. The
   *  echo comes back framed against the tab the vendor acted from, so splicing it
   *  verbatim into the other entry would render that flow backwards. `mirrored`
   *  re-frames it for the entries on the far side. */
  private applyClaim(claim: VendorClaim, mode: 'replace' | 'append'): void {
    const authoredFrom = this.contextProductId();
    const framedFor = (integration: VendorIntegration): VendorClaim =>
      authoredFrom === null || integration.context_product.id === authoredFrom
        ? claim
        : { ...claim, direction: mirrorContextDirection(claim.direction) };

    this.store
      .apply('integrations', (list) =>
        list.map((integration) => {
          if (integration.id !== claim.integration_id) return integration;
          const framed = framedFor(integration);
          const claims =
            mode === 'append'
              ? [...integration.claims, framed]
              : integration.claims.map((c) => (c.id === framed.id ? framed : c));
          return { ...integration, claims };
        }),
      )
      .commit();
  }

  /**
   * The other endpoint's product name for a claim, or `null` when the echo names
   * an integration the store has not loaded.
   *
   * Every entry for one integration shares an `other_product` in the caller's own
   * frame, so the first match is the right one — the same assumption
   * {@link applyClaim} makes when it splices into all of them.
   */
  private otherProductNameFor(claim: VendorClaim): string | null {
    return (
      this.store.integrations().find((integration) => integration.id === claim.integration_id)
        ?.other_product.name ?? null
    );
  }

  /**
   * Announce what the write actually did, not that it was written (AECI-961).
   *
   * "Position saved" was true and useless: it told a vendor who had just denied a
   * false claim nothing about whether anyone would hear about it. The stance and
   * the §6.2 outcome sentence go through the one shell live region together, and
   * the outcome half is the exact string the lane prints, so the spoken and the
   * printed receipt cannot drift.
   *
   * The outcome names the counterparty product, so a claim whose integration is
   * not in the store degrades to the stance alone rather than announcing a
   * sentence with a hole in it.
   */
  private announceOutcome(claim: VendorClaim, stance: string): void {
    const other = this.otherProductNameFor(claim);
    this.announcer.announce(
      other === null ? stance : `${stance} ${claimOutcomeLine(claim, other)}`,
    );
  }

  protected onClaimChanged(claim: VendorClaim): void {
    this.applyClaim(claim, 'replace');
    const asserted = claim.mine[0]?.asserted ?? false;
    this.announceOutcome(
      claim,
      asserted
        ? $localize`:@@vendor.attest.live.affirmed:${claim.data_object_name}:dataObject: · you confirmed this flow.`
        : $localize`:@@vendor.attest.live.denied:${claim.data_object_name}:dataObject: · you denied this flow.`,
    );
  }

  protected onClaimCreated(claim: VendorClaim): void {
    // Appended, not re-sorted: the new lane appears directly above the form the
    // vendor just used, where their attention already is.
    this.applyClaim(claim, 'append');
    this.announceOutcome(
      claim,
      $localize`:@@vendor.attest.live.added:${claim.data_object_name}:dataObject: · data flow added.`,
    );
    this.pendingFocusClaimId.set(claim.id);
  }

  protected async onRetracted(claimId: string): Promise<void> {
    this.announcer.announce($localize`:@@vendor.attest.live.cleared:Position withdrawn.`);
    // See the header: a 204 carries nothing to reconcile from, and the agreement
    // must not be guessed. One targeted re-read, spliced by id so a concurrent
    // write on another claim is not clobbered.
    try {
      const res = await this.api.getIntegrations();
      const fresh = res.integrations.flatMap((i) => i.claims).find((claim) => claim.id === claimId);
      if (fresh) this.applyClaim(fresh, 'replace');
      else this.store.apply('integrations', () => res.integrations).commit();
    } catch {
      // The write committed; only the refresh failed. Leave the list as it is
      // rather than showing a stale claim as an error.
    }
  }
}
