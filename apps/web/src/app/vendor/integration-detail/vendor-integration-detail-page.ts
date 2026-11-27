import { DOCUMENT, isPlatformBrowser } from '@angular/common';
import {
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  PLATFORM_ID,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
  viewChildren,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { map } from 'rxjs';

import type { PairContest, SyncServicePairVeto } from '@aeci/shared';

import { BAND_WRAP_CLASS } from '../../shared/band-wrap';
import { AecButton } from '../../shared/button/button';
import { AecCard } from '../../shared/card/card';
import { AecIcon } from '../../shared/icon/icon';
import { LogoOrInitial } from '../../shared/logo-or-initial/logo-or-initial';
import { injectInPageHrefFor } from '../../shared/in-page-href';
import { NewTabIcon } from '../../shared/new-tab-icon/new-tab-icon';
import { VendorContestsList } from '../components/vendor-contests-list';
import { STANDALONE_LINK_CLASS, VendorDocsLink } from '../components/vendor-docs-link';
import { selfDisclaimOn, selfDisclaimStands } from '../components/vendor-not-ours';
import { VendorOwnedFlows, ownedDirectionText } from '../components/vendor-owned-flows';
import { ownedRowsForProduct } from '../components/vendor-owned-integrations';
import { VendorOwnedRetire } from '../components/vendor-owned-retire';
import { VendorPairRightsList } from '../components/vendor-pair-rights-list';
import { vendorProductContext } from '../sections/vendor-product-context';
import { VendorPortalStore } from '../vendor-portal-store';

import { IntegrationChangeRequests } from './integration-change-requests';
import {
  contestsFor,
  isSectionId,
  needsItems,
  possessive,
  statusExplain,
  statusLabel,
  statusTone,
  integrationStatus,
  NO_OWNED_ROW_RIGHTS,
  ownedIntegrationStatus,
  ownedNeedsItems,
  ownedRowRights,
  ownedStatusExplain,
  ownedStatusLabel,
  type OwnedStatusKey,
  type IntegrationStatusKey,
  type NeedItem,
  type SectionId,
} from './integration-detail-model';
import { IntegrationDetailState } from './integration-detail-state';
import { ID_STYLES, IN_TEXT_LINK } from './integration-detail-styles';
import { IntegrationLinksSection } from './integration-links';
import { IntegrationOverview } from './integration-overview';
import { IntegrationSettings } from './integration-settings';
import {
  VendorSyncServiceRights,
  type SyncRightsTarget,
} from '../components/vendor-sync-service-rights';
import { IntegrationSharedData } from './integration-shared-data';
import { OwnedIntegrationOverview } from './owned-integration-overview';
import { VendorTip } from './vendor-tip';

/**
 * The sticky bar's height plus a gap, in CSS pixels. The scroll-spy reads the
 * section under this line, and every jump target declares the same clearance as
 * `scroll-mt-20` (5rem). Never `ViewportScroller.setOffset()` (ANGULAR_STYLE_GUIDE.md §3).
 */
const SPY_TOP_PX = 80;

/**
 * `…/products/:productSlug/integrations/:integrationId`: one integration's page
 * (AECI-1149, `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.17.1, §6.17.2).
 *
 * ── WHICH ENTRY ─────────────────────────────────────────────────────────────
 * The entry of the store's `integrations` whose `id` is `:integrationId` AND whose
 * `context_product` is the routed product. `id` alone is not unique (AECI-666): an
 * owns-both integration has a page under each of its products. No request carries
 * the id before the list says it is the caller's, so a foreign id cannot be
 * probed. "Not found" is decided only once the list has settled.
 *
 * ── SSR ─────────────────────────────────────────────────────────────────────
 * The store never fetches on the server, so SSR renders the loading state, and the
 * list lands after hydration. The sticky bar and the scroll-spy are browser-only;
 * SSR marks Overview current.
 *
 * ── THE FIRST LOAD OF A `#section` LINK ─────────────────────────────────────
 * `InitialFragmentScroller` scrolls on the first `NavigationEnd`, and this page's
 * sections do not exist yet then: they render once the list lands. So the page
 * lands the fragment itself, once, when its sections first render. That is the
 * same gap that scroller closes, one step later. It is not a second scroll model.
 */
@Component({
  selector: 'aec-vendor-integration-detail-page',
  imports: [
    RouterLink,
    AecButton,
    AecCard,
    AecIcon,
    LogoOrInitial,
    NewTabIcon,
    VendorTip,
    IntegrationOverview,
    IntegrationSharedData,
    IntegrationLinksSection,
    IntegrationChangeRequests,
    IntegrationSettings,
    VendorSyncServiceRights,
    VendorDocsLink,
    OwnedIntegrationOverview,
    VendorOwnedFlows,
    VendorContestsList,
    VendorOwnedRetire,
    VendorPairRightsList,
  ],
  providers: [IntegrationDetailState],
  styles: [ID_STYLES],
  template: `
    <nav
      i18n-aria-label="@@vendor.im.breadcrumb.aria"
      aria-label="Integration breadcrumb"
      class="-mt-2"
    >
      <a routerLink=".." [class]="backLinkClass">
        <aec-icon name="chevron-left" decorative [size]="4" [mirrorRtl]="true" />
        <span i18n="@@vendor.im.back">All integrations</span>
      </a>
    </nav>

    @if (shell(); as sh) {
      @if (showSlim()) {
        <section
          [attr.aria-label]="slimLabel()"
          data-testid="integration-sticky-bar"
          class="fixed inset-x-0 top-0 z-30 border-b border-(--border-default) bg-(--surface-base)"
        >
          <div [class]="slimWrapClass">
            <span aria-hidden="true" class="hidden shrink-0 items-center sm:flex">
              <aec-logo-or-initial
                [claimStatus]="'stored'"
                [src]="sh.a.logo_url"
                [name]="sh.a.name"
                size="sm"
              />
              <span class="h-px w-3 bg-(--border-strong)"></span>
              <aec-logo-or-initial
                [claimStatus]="'stored'"
                [src]="sh.b.logo_url"
                [name]="sh.b.name"
                size="sm"
              />
            </span>
            <p class="min-w-0 truncate font-display text-t-20 font-semibold text-(--text-primary)">
              {{ title() }}
            </p>
            <aec-vendor-tip
              variant="pill"
              [label]="statusText()"
              [tone]="tone()"
              [lines]="[statusHelp()]"
            />
            <a
              [href]="publicHref()"
              target="_blank"
              rel="noopener"
              [attr.aria-label]="publicAria()"
              [class]="publicLinkClass"
              class="ms-auto shrink-0"
              ><span i18n="@@vendor.im.viewPublic">View public page</span>
              <aec-new-tab-icon [announce]="false"
            /></a>
          </div>
        </section>
      }

      <div #titleBlock aecCard class="mt-2 flex flex-wrap items-start justify-between gap-4 p-6">
        <div class="flex min-w-0 items-start gap-4">
          <span aria-hidden="true" class="flex shrink-0 items-center pt-1">
            <aec-logo-or-initial
              [claimStatus]="'stored'"
              [src]="sh.a.logo_url"
              [name]="sh.a.name"
              size="sm"
            />
            <span class="h-px w-3 bg-(--border-strong)"></span>
            <aec-logo-or-initial
              [claimStatus]="'stored'"
              [src]="sh.b.logo_url"
              [name]="sh.b.name"
              size="sm"
            />
          </span>
          <div class="min-w-0">
            <h2
              #titleHeading
              tabindex="-1"
              class="break-words text-(--text-primary) focus:outline-none"
              data-testid="integration-title"
            >
              {{ title() }}
            </h2>
            <div class="mt-2">
              <aec-vendor-tip
                variant="pill"
                testId="integration-status"
                [label]="statusText()"
                [tone]="tone()"
                [lines]="[statusHelp()]"
              />
            </div>
          </div>
        </div>
        <a
          [href]="publicHref()"
          target="_blank"
          rel="noopener"
          [attr.aria-label]="publicAria()"
          [class]="publicLinkClass"
          ><span i18n="@@vendor.im.viewPublic">View public page</span>
          <aec-new-tab-icon [announce]="false"
        /></a>
      </div>

      <section
        aecCard
        class="mt-6 p-6 text-sm"
        aria-labelledby="integration-needs-heading"
        data-testid="integration-needs"
      >
        <h3 id="integration-needs-heading" class="text-(--text-primary)">
          @if (needs().yours.length > 0) {
            <span i18n="@@vendor.im.needs.heading">Things that need you</span>
          } @else {
            <span i18n="@@vendor.im.needs.none">Nothing needs you right now</span>
          }
        </h3>
        @if (needs().yours.length > 0) {
          <ul [class]="needListClass">
            @for (item of needs().yours; track item.key) {
              <li class="flex items-start gap-3 py-3">
                <span class="mt-1 flex shrink-0 text-(--text-primary)">
                  <aec-icon name="exclamation" decorative [size]="4" />
                </span>
                <button type="button" [class]="needLinkClass" (click)="jumpToItem(item)">
                  {{ item.text }}
                </button>
              </li>
            }
          </ul>
        }
        @if (needs().waiting.length > 0) {
          <h4 class="aec-overline mt-6 text-(--text-secondary)" i18n="@@vendor.im.needs.waiting">
            Waiting on someone else
          </h4>
          <ul [class]="needListClass">
            @for (item of needs().waiting; track item.key) {
              <li class="flex items-start gap-3 py-3">
                <span class="mt-1 flex shrink-0 text-(--text-secondary)">
                  <aec-icon name="clock" decorative [size]="4" />
                </span>
                <button type="button" [class]="needLinkClass" (click)="jumpToItem(item)">
                  {{ item.text }}
                </button>
              </li>
            }
          </ul>
        }
      </section>

      <div class="mt-8 grid gap-8 lg:grid-cols-[13rem_minmax(0,1fr)]">
        <nav
          i18n-aria-label="@@vendor.im.sections.aria"
          aria-label="Integration sections"
          class="lg:sticky lg:top-20 lg:self-start"
        >
          <ul class="m-0 list-none border-s border-(--border-default) p-0">
            @for (item of navItems(); track item.id) {
              <li>
                <a
                  [href]="hrefFor()(item.id)"
                  data-smooth-scroll
                  [class]="navLinkClass"
                  [attr.aria-current]="active() === item.id ? 'location' : null"
                  [attr.data-testid]="'section-nav-' + item.id"
                  (click)="onNav(item.id)"
                  >{{ item.label }}</a
                >
              </li>
            }
          </ul>
        </nav>

        <div class="min-w-0 space-y-6">
          @if (integration(); as i) {
            <section
              #spy
              id="overview"
              data-section="overview"
              aecCard
              class="scroll-mt-20 p-6"
              aria-labelledby="overview-heading"
            >
              <h3
                id="overview-heading"
                tabindex="-1"
                class="text-(--text-primary) focus:outline-none"
                i18n="@@vendor.im.section.overview"
              >
                Overview
              </h3>
              <p><aec-vendor-docs-link page="owning-an-integration" /></p>
              <div class="mt-2"><aec-integration-overview [integration]="i" /></div>
            </section>

            <section
              #spy
              id="data-shared"
              data-section="data-shared"
              aecCard
              class="scroll-mt-20 p-6"
              aria-labelledby="data-shared-heading"
            >
              <aec-integration-shared-data [integration]="i" />
            </section>

            <section
              #spy
              id="links"
              data-section="links"
              aecCard
              class="scroll-mt-20 p-6"
              aria-labelledby="links-heading"
            >
              <aec-integration-links [integration]="i" />
            </section>

            <section
              #spy
              id="change-requests"
              data-section="change-requests"
              aecCard
              class="scroll-mt-20 p-6"
              aria-labelledby="change-requests-heading"
            >
              <aec-integration-change-requests [integration]="i" />
              @if (syncRightsTarget(); as rights) {
                <!-- AECI-2110 (§11e.6): an endpoint vendor's rights on a Sync Service row. -->
                <div class="mt-6" data-sync-service-rights>
                  <aec-vendor-sync-service-rights
                    [target]="rights"
                    (changed)="reloadIntegrations()"
                  />
                </div>
              }
            </section>

            <section
              #spy
              id="settings"
              data-section="settings"
              aecCard
              class="scroll-mt-20 p-6"
              aria-labelledby="settings-heading"
            >
              <h3
                id="settings-heading"
                tabindex="-1"
                class="text-(--text-primary) focus:outline-none"
                i18n="@@vendor.im.section.settings"
              >
                Settings
              </h3>
              <div class="mt-4"><aec-integration-settings [integration]="i" /></div>
            </section>
          } @else if (ownedRow(); as o) {
            <!-- AECI-2045: a row the company owns but makes neither product of, or a pair. -->
            <section
              #spy
              id="overview"
              data-section="overview"
              aecCard
              class="scroll-mt-20 p-6"
              aria-labelledby="overview-heading"
              data-testid="owned-detail"
            >
              <h3
                id="overview-heading"
                tabindex="-1"
                class="text-(--text-primary) focus:outline-none"
                i18n="@@vendor.im.section.overview"
              >
                Overview
              </h3>
              <p><aec-vendor-docs-link page="owning-an-integration" /></p>
              <div class="mt-2"><aec-owned-integration-overview [row]="o" /></div>
            </section>

            <section
              #spy
              id="data-shared"
              data-section="data-shared"
              aecCard
              class="scroll-mt-20 p-6"
              aria-labelledby="data-shared-heading"
            >
              <h3
                id="data-shared-heading"
                tabindex="-1"
                class="text-(--text-primary) focus:outline-none"
                i18n="@@vendor.im.section.dataShared"
              >
                Data that's shared
              </h3>
              @if (o.sync_service) {
                <aec-vendor-owned-flows [row]="o" [labelledBy]="'data-shared-heading'" />
              } @else {
                <p
                  class="mt-2 max-w-prose text-sm text-(--text-secondary)"
                  data-testid="owned-flows-note"
                >
                  @if (o.claimed_at) {
                    <span i18n="@@vendor.im.owned.flows.frozen"
                      >These rows stay as they were when your company claimed this integration. A
                      connector product delivers it, so they cannot be changed here.</span
                    >
                  } @else {
                    <span i18n="@@vendor.im.owned.flows.aeci"
                      >AEC Integrations keeps these rows up to date. A connector product delivers
                      this integration, so they cannot be changed here.</span
                    >
                  }
                </p>
                @if (o.flows.length === 0) {
                  <p class="mt-3 text-sm text-(--text-primary)" i18n="@@vendor.im.owned.flows.none">
                    No data is listed for this integration yet.
                  </p>
                } @else {
                  <ul class="mt-3 list-none divide-y divide-(--border-default) p-0 text-sm">
                    @for (flow of o.flows; track flow.id) {
                      <li class="flex flex-wrap justify-between gap-2 py-2">
                        <span class="font-medium text-(--text-primary)">{{
                          flow.data_object_name
                        }}</span>
                        <span class="text-(--text-secondary)">{{
                          flowDirection(o, flow.direction)
                        }}</span>
                      </li>
                    }
                  </ul>
                }
              }
            </section>

            <section
              #spy
              id="change-requests"
              data-section="change-requests"
              aecCard
              class="scroll-mt-20 p-6"
              aria-labelledby="change-requests-heading"
            >
              <h3
                id="change-requests-heading"
                tabindex="-1"
                class="text-(--text-primary) focus:outline-none"
                i18n="@@vendor.im.section.changeRequests"
              >
                Change requests
              </h3>
              <aec-vendor-contests-list
                class="mt-2"
                [integrationId]="o.id"
                [labelledBy]="'change-requests-heading'"
              />
              <!-- AECI-2045: on a Sync Service pair, the data flow reports the owner
                   received and the endpoint vendors' removals, narrowed to this pair. -->
              @if (o.sync_service) {
                <aec-vendor-pair-rights-list
                  class="mt-6"
                  [integrationId]="o.id"
                  [labelledBy]="'change-requests-heading'"
                  (loaded)="pairRights.set($event)"
                />
              }
            </section>

            <section
              #spy
              id="settings"
              data-section="settings"
              aecCard
              class="scroll-mt-20 p-6"
              aria-labelledby="settings-heading"
            >
              <h3
                id="settings-heading"
                tabindex="-1"
                class="text-(--text-primary) focus:outline-none"
                i18n="@@vendor.im.section.settings"
              >
                Settings
              </h3>
              @if (o.claimed_at || o.retired_at) {
                <aec-vendor-owned-retire [row]="o" [statusLine]="titleHeading" />
              } @else {
                <p
                  class="mt-3 max-w-prose text-sm text-(--text-secondary)"
                  i18n="@@vendor.im.owned.settings.unclaimed"
                >
                  Once you claim this integration, you can retire it here if it is no longer
                  offered.
                </p>
              }
            </section>
          }
        </div>
      </div>
    } @else if (loading()) {
      <p class="mt-6 text-sm text-(--text-secondary)" i18n="@@vendor.im.loading">
        Loading the integration…
      </p>
    } @else if (failed()) {
      <div class="mt-6 flex flex-wrap items-center gap-3">
        <p class="text-sm text-(--text-primary)" i18n="@@vendor.im.failed">
          Could not load this integration.
        </p>
        <button
          aecButton
          variant="secondary"
          compact
          type="button"
          (click)="retry()"
          i18n="@@vendor.im.retry"
        >
          Try again
        </button>
      </div>
    } @else {
      <h2
        class="mt-6 text-(--text-primary)"
        data-testid="integration-not-found"
        i18n="@@vendor.im.notFound.heading"
      >
        Integration not found
      </h2>
      <p [class]="notFoundClass">
        <span i18n="@@vendor.im.notFound.body"
          >This integration is not one of {{ productPossessive() }} integrations. It may have been
          removed, or the link may be wrong.</span
        >
        {{ ' ' }}
        <a routerLink=".." [class]="inTextLink" i18n="@@vendor.im.notFound.link"
          >See {{ productPossessive() }} integrations</a
        >
      </p>
    }
  `,
})
export class VendorIntegrationDetailPage {
  private readonly store = inject(VendorPortalStore);
  private readonly state = inject(IntegrationDetailState);
  private readonly route = inject(ActivatedRoute);
  private readonly document = inject(DOCUMENT);
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly ctx = vendorProductContext();

  private readonly titleBlock = viewChild<ElementRef<HTMLElement>>('titleBlock');
  private readonly spySections = viewChildren<ElementRef<HTMLElement>>('spy');

  private readonly integrationId = toSignal(
    this.route.paramMap.pipe(map((p) => p.get('integrationId'))),
    { initialValue: this.route.snapshot.paramMap.get('integrationId') },
  );

  /** The entry the page is about, or `null`. */
  protected readonly integration = computed(() => {
    const id = this.integrationId();
    const product = this.ctx.product();
    if (!id || !product) return null;
    return (
      this.store.integrations().find((i) => i.id === id && i.context_product.id === product.id) ??
      null
    );
  });

  /**
   * AECI-2110 (§11e.6): the entry shaped for the Sync Service rights block, or `null`
   * when the API gave it no rights (not a Sync Service row, retired, or the caller's own).
   */
  protected readonly syncRightsTarget = computed<SyncRightsTarget | null>(() => {
    const i = this.integration();
    if (!i?.sync_service_rights || !i.powered_by) return null;
    return {
      id: i.id,
      sync_service_rights: i.sync_service_rights,
      connector: { name: i.powered_by.name },
      owner: i.owner ? { name: i.owner.name } : null,
      context_product: i.context_product,
      other_product: i.other_product,
    };
  });

  /** After a veto or report: the row's rights and listing changed. */
  protected reloadIntegrations(): void {
    void this.store.reload('integrations');
  }

  /**
   * AECI-2045: a row the caller owns that the endpoint list does not carry (`owned[]`,
   * §6.15), when `:integrationId` names none of the caller's endpoint entries. The two
   * lists are disjoint (`owned[]` skips a row the list carries), so an id resolves to
   * at most one of them. The same rows the product's tab lists (`ownedRowsForProduct`).
   */
  protected readonly ownedRow = computed(() => {
    if (this.integration()) return null;
    const id = this.integrationId();
    const product = this.ctx.product();
    if (!id || !product) return null;
    const mine = new Set((this.store.me()?.products ?? []).map((p) => p.id));
    return (
      ownedRowsForProduct(this.store.ownedIntegrations(), product.id, mine).find(
        (row) => row.id === id,
      ) ?? null
    );
  });

  /** The two products the title block shows, in either mode. */
  protected readonly shell = computed(() => {
    const i = this.integration();
    if (i) return { a: i.context_product, b: i.other_product };
    const o = this.ownedRow();
    return o ? { a: o.product_a, b: o.product_b } : null;
  });

  protected readonly loading = this.store.integrationsLoading;
  protected readonly failed = this.store.integrationsFailed;
  protected readonly productPossessive = computed(() => possessive(this.ctx.product()?.name ?? ''));

  /**
   * `{path}?{query}#id` for the native section anchors (AECI-1843). It keeps the query, so a
   * click on a URL with one is a same-document jump and not a page load, and it reads
   * `Location`, so the first render already has the real path (`router.url` reads `/` until
   * the first navigation ends). `/vendor` is never edge-cached, so the server keeps the query too.
   */
  protected readonly hrefFor = injectInPageHrefFor();

  protected readonly title = computed(() => {
    const sh = this.shell();
    if (!sh) return '';
    const a = sh.a.name;
    const b = sh.b.name;
    return $localize`:@@vendor.im.title:${a}:context: and ${b}:other:`;
  });

  private readonly statusKey = computed<IntegrationStatusKey>(() => {
    const i = this.integration();
    const o = this.ownedRow();
    if (!i) {
      return o
        ? ownedIntegrationStatus(
            o,
            this.pageContests(),
            new Date().toISOString(),
            this.ownedRights(),
          )
        : 'up_to_date';
    }
    return integrationStatus(i, {
      contests: this.pageContests(),
      canAuthor: this.state.canAuthor(),
      now: new Date().toISOString(),
    });
  });

  /** The page's own contest read, narrowed to this row as a guard. */
  private readonly pageContests = computed(() => {
    const i = this.integration();
    if (i) return contestsFor(this.state.contests(), i.id);
    // An owned row's page reads the store's vendor-wide contests, as its list does.
    const o = this.ownedRow();
    return o ? contestsFor(this.store.contests(), o.id) : { submitted: [], received: [] };
  });

  /**
   * AECI-2045: the owner's received data flow reports and the endpoint vendors' removals
   * on this pair, as the Change requests section's pair-rights block last read them.
   * Empty until that read lands, and on any row that is not a Sync Service pair.
   */
  protected readonly pairRights = signal<{
    readonly reports: readonly PairContest[];
    readonly vetoes: readonly SyncServicePairVeto[];
  }>({ reports: [], vetoes: [] });

  private readonly ownedRights = computed(() => {
    const o = this.ownedRow();
    return o ? ownedRowRights(o.id, this.pairRights()) : NO_OWNED_ROW_RIGHTS;
  });

  protected readonly statusText = computed(() => {
    const key = this.statusKey();
    return this.ownedRow() && isOwnedKey(key)
      ? ownedStatusLabel(key, this.pageContests(), this.ownedRights())
      : statusLabel(key, this.pageContests());
  });
  protected readonly tone = computed(() => statusTone(this.statusKey()));
  protected readonly statusHelp = computed(() => {
    const i = this.integration();
    if (i) return statusExplain(this.statusKey(), i);
    const o = this.ownedRow();
    const key = this.statusKey();
    return o && isOwnedKey(key) ? ownedStatusExplain(key, o.retired_by, this.ownedRights()) : '';
  });

  protected readonly needs = computed(() => {
    const i = this.integration();
    if (!i) {
      const o = this.ownedRow();
      if (!o) return { yours: [], waiting: [] };
      const notOurs = selfDisclaimStands(
        selfDisclaimOn(this.store.contests().submitted, o.id, o.anchor),
      );
      return ownedNeedsItems(
        o,
        this.pageContests(),
        new Date().toISOString(),
        notOurs,
        this.ownedRights(),
      );
    }
    return needsItems(i, {
      contests: this.pageContests(),
      canAuthor: this.state.canAuthor(),
      company: this.state.company(),
      now: new Date().toISOString(),
    });
  });

  protected readonly publicHref = computed(() => {
    const sh = this.shell();
    return sh ? `/products/${sh.a.slug}/integrations/${sh.b.slug}` : '/';
  });

  /** Built in TS: an interpolated `i18n-aria-label` emits no attribute here. It
   *  starts with the visible text (WCAG 2.5.3) and names the destination (§6.7). */
  protected readonly publicAria = computed(() => {
    const sh = this.shell();
    if (!sh) return null;
    const context = sh.a.name;
    const other = sh.b.name;
    return $localize`:@@vendor.attest.card.viewPublic.aria:View public page: the ${context}:CONTEXT: and ${other}:OTHER: integration (opens in a new tab)`;
  });

  protected readonly slimLabel = computed(
    () => $localize`:@@vendor.im.sticky.aria:Current integration: ${this.title()}:title:`,
  );

  private readonly allNavItems: readonly { id: SectionId; label: string }[] = [
    { id: 'overview', label: $localize`:@@vendor.im.section.overview:Overview` },
    { id: 'data-shared', label: $localize`:@@vendor.im.section.dataShared:Data that's shared` },
    { id: 'links', label: $localize`:@@vendor.im.section.links:Integration links` },
    {
      id: 'change-requests',
      label: $localize`:@@vendor.im.section.changeRequests:Change requests`,
    },
    { id: 'settings', label: $localize`:@@vendor.im.section.settings:Settings` },
  ];

  /** An owned row has no Integration links section: its listing and documentation
   *  links are two of the nine fields in its Overview (AECI-2045). */
  protected readonly navItems = computed(() =>
    this.ownedRow() ? this.allNavItems.filter((item) => item.id !== 'links') : this.allNavItems,
  );

  /** "From {A} to {B}", as the owned card's flows read it. */
  protected flowDirection(
    row: Parameters<typeof ownedDirectionText>[0],
    direction: Parameters<typeof ownedDirectionText>[1],
  ): string {
    return ownedDirectionText(row, direction);
  }

  /** The section under the sticky bar. SSR marks Overview. */
  protected readonly active = signal<SectionId>('overview');
  protected readonly showSlim = signal(false);

  private spyLocked = false;
  private unlockTimer: ReturnType<typeof setTimeout> | null = null;
  private recompute: (() => void) | null = null;
  private fragmentHandled = false;
  /** The pending `scrollend` and `hashchange` listeners, removed on release and on
   *  destroy so a page left mid-jump leaves nothing on the window. */
  private spyListeners: AbortController | null = null;
  private navListeners: AbortController | null = null;

  constructor() {
    this.state.bind(this.integration);
    this.state.setJumpHandler((target) => this.jump(target));
    this.destroyRef.onDestroy(() => {
      this.state.setJumpHandler(null);
      if (this.unlockTimer) clearTimeout(this.unlockTimer);
      this.spyListeners?.abort();
      this.navListeners?.abort();
    });

    afterNextRender(() => void this.store.ensure('integrations'));

    // The page's one extra read (§6.17.6), once the entry is known to be the
    // caller's: no request carries an id the list has not vouched for.
    effect(() => {
      const i = this.integration();
      if (!i || !this.isBrowser) return;
      untracked(() => void this.state.ensureContests(i.id));
    });

    // The slim bar shows once the title block has scrolled above the viewport.
    effect((onCleanup) => {
      const el = this.titleBlock()?.nativeElement;
      if (!el || !this.isBrowser || typeof IntersectionObserver === 'undefined') {
        this.showSlim.set(false);
        return;
      }
      const observer = new IntersectionObserver(([entry]) =>
        this.showSlim.set(!entry.isIntersecting && entry.boundingClientRect.top < 0),
      );
      observer.observe(el);
      onCleanup(() => observer.disconnect());
    });

    // Scroll-spy (§6.17.2). An observer whose root is a one-pixel line just below
    // the sticky bar fires whenever a section edge crosses it; the current section
    // is then read from positions. A second observer watches the last section,
    // because a short last section can never reach the line at the foot of the page.
    effect((onCleanup) => {
      const sections = this.spySections().map((r) => r.nativeElement);
      const win = this.document.defaultView;
      if (
        sections.length === 0 ||
        !win ||
        !this.isBrowser ||
        typeof IntersectionObserver === 'undefined'
      ) {
        return;
      }
      let line: IntersectionObserver | null = null;
      let lastFull = false;
      const recompute = () => {
        if (this.spyLocked) return;
        const atBottom =
          win.innerHeight + win.scrollY >= this.document.documentElement.scrollHeight - 4;
        this.active.set(sectionAtBar(sections, atBottom && lastFull));
      };
      const observeLine = () => {
        line?.disconnect();
        const below = Math.max(0, win.innerHeight - SPY_TOP_PX - 1);
        line = new IntersectionObserver(recompute, {
          rootMargin: `-${SPY_TOP_PX}px 0px -${below}px 0px`,
        });
        sections.forEach((el) => line?.observe(el));
      };
      const end = new IntersectionObserver(
        ([entry]) => {
          lastFull = entry.intersectionRatio >= 0.99;
          recompute();
        },
        { threshold: [0, 0.99] },
      );
      end.observe(sections[sections.length - 1]);
      observeLine();
      win.addEventListener('resize', observeLine, { passive: true });
      this.recompute = recompute;
      onCleanup(() => {
        line?.disconnect();
        end.disconnect();
        win.removeEventListener('resize', observeLine);
        this.recompute = null;
      });
    });

    // Land a `#section` or `#item` deep link once the sections exist (see the
    // header). Once per page.
    effect(() => {
      const sections = this.spySections();
      if (sections.length === 0 || this.fragmentHandled || !this.isBrowser) return;
      this.fragmentHandled = true;
      const hash = this.document.defaultView?.location.hash.replace(/^#/, '') ?? '';
      if (!hash) return;
      untracked(() =>
        afterNextRender(
          () => {
            const el = this.document.getElementById(safeDecode(hash));
            if (!el) return;
            if (isSectionId(hash)) this.active.set(hash);
            this.lockSpy();
            el.scrollIntoView?.({ block: 'start', behavior: 'instant' });
          },
          { injector: this.injector },
        ),
      );
    });
  }

  /**
   * A nav item was chosen. The anchor's native behaviour does the scroll (and
   * `ScrollMarginViewportScroller` skips the router's follow-up); this only holds the
   * spy on the chosen item until the scroll ends and moves focus to the section's heading.
   */
  protected onNav(id: SectionId): void {
    this.active.set(id);
    this.lockSpy();
    const heading = this.document.getElementById(`${id}-heading`);
    const focus = () => heading?.focus({ preventScroll: true });
    focus();
    // The anchor's own fragment navigation (and the router's follow-up) can move
    // focus back to the document after this handler, so focus again once it has
    // landed. Never a scroll: the anchor already did that.
    this.navListeners?.abort();
    const listeners = new AbortController();
    this.navListeners = listeners;
    this.document.defaultView?.addEventListener(
      'hashchange',
      () => {
        listeners.abort();
        setTimeout(focus);
      },
      { once: true, signal: listeners.signal },
    );
    setTimeout(focus, 50);
  }

  protected jumpToItem(item: NeedItem): void {
    this.state.jumpTo(item.target, item.inRequests);
  }

  /** Scroll to one element and focus it. Instant, so reduced motion is respected. */
  private jump(target: string): void {
    this.lockSpy();
    afterNextRender(
      () => {
        const el = this.document.getElementById(target);
        if (!el) return;
        const section = el.closest<HTMLElement>('[data-section]')?.dataset['section'];
        if (section && isSectionId(section)) this.active.set(section);
        el.scrollIntoView?.({ block: 'start', behavior: 'instant' });
        const focusable = el.matches('[tabindex], button, a, input, select, textarea')
          ? el
          : el.querySelector<HTMLElement>('[tabindex="-1"]');
        (focusable ?? el).focus({ preventScroll: true });
      },
      { injector: this.injector },
    );
  }

  private lockSpy(): void {
    this.spyLocked = true;
    if (this.unlockTimer) clearTimeout(this.unlockTimer);
    this.spyListeners?.abort();
    const listeners = new AbortController();
    this.spyListeners = listeners;
    const release = () => {
      this.spyLocked = false;
      if (this.unlockTimer) clearTimeout(this.unlockTimer);
      this.unlockTimer = null;
      listeners.abort();
      this.recompute?.();
    };
    this.document.defaultView?.addEventListener('scrollend', release, {
      once: true,
      signal: listeners.signal,
    });
    this.unlockTimer = setTimeout(release, 1200);
  }

  protected retry(): void {
    void this.store.reload('integrations');
  }

  protected readonly backLinkClass =
    'inline-flex min-h-11 items-center gap-1 rounded-mark text-t-14 font-semibold text-(--accent-primary) underline-offset-4 hover:underline focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--accent-primary)';
  /** DESIGN.md's standalone link, as part 1 draws "View public page". */
  protected readonly publicLinkClass = STANDALONE_LINK_CLASS;
  /** The slim bar's row: the page wrap, so its content lines up with the page below. */
  protected readonly slimWrapClass = `${BAND_WRAP_CLASS} flex h-14 items-center gap-3`;
  /** "Things that need you": one list divided by hairlines (mock-up 13's "What needs you"). */
  protected readonly needListClass =
    'mt-2 list-none divide-y divide-(--border-default) border-b border-(--border-default) p-0';
  protected readonly needLinkClass =
    'cursor-pointer rounded-mark text-start text-t-14 font-semibold text-(--accent-primary) underline underline-offset-2 hover:text-(--accent-primary-hover) focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--accent-primary)';
  /**
   * The section nav: the portal tab row's language on its side. Secondary ink at rest;
   * the current section is Forest at 600 with a 2px Forest edge, where the tab row
   * (`VENDOR_NAV_ITEM_CLASS`, `VENDOR_NAV_ITEM_ACTIVE_CLASS`) draws a 2px underline.
   * The edge sits over the rail's hairline. 44px targets.
   */
  protected readonly navLinkClass =
    '-ms-px flex min-h-11 items-center border-s-2 border-transparent px-4 text-t-14 text-(--text-secondary) no-underline transition-colors duration-base ease-standard hover:text-(--text-primary) focus-visible:outline-3 focus-visible:-outline-offset-3 focus-visible:outline-(--accent-primary) aria-[current=location]:border-(--accent-primary) aria-[current=location]:font-semibold aria-[current=location]:text-(--accent-primary)';
  protected readonly notFoundClass =
    'mt-4 max-w-prose rounded-panel bg-(--surface-sunken) p-4 text-t-14 leading-relaxed text-(--text-primary)';
  protected readonly inTextLink = IN_TEXT_LINK;
}

/** The last section whose top has reached the bar, else the first. At the foot
 *  of the page, the last one when it is fully in view. */
function sectionAtBar(sections: readonly HTMLElement[], lastInFullView: boolean): SectionId {
  const keyOf = (el: HTMLElement): SectionId => {
    const key = el.dataset['section'] ?? 'overview';
    return isSectionId(key) ? key : 'overview';
  };
  if (lastInFullView) return keyOf(sections[sections.length - 1]);
  let current = sections[0];
  for (const el of sections) {
    if (el.getBoundingClientRect().top <= SPY_TOP_PX + 1) current = el;
  }
  return keyOf(current);
}

const OWNED_KEYS: ReadonlySet<IntegrationStatusKey> = new Set<OwnedStatusKey>([
  'retired',
  'needs_answer',
  'needs_decision',
  'ready_to_claim',
  'waiting',
  'up_to_date',
]);

function isOwnedKey(key: IntegrationStatusKey): key is OwnedStatusKey {
  return OWNED_KEYS.has(key);
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
