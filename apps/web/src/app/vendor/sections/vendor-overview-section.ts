import { NgTemplateOutlet, formatDate } from '@angular/common';
import {
  Component,
  LOCALE_ID,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { RouterLink } from '@angular/router';

import { AecButton } from '../../shared/button/button';
import { AecCard } from '../../shared/card/card';
import { Chip, type ChipTone } from '../../shared/chip/chip';
import { AecIcon } from '../../shared/icon/icon';
import type { AecIconName } from '../../shared/icon/icon-registry';
import { VendorGlanceBand } from '../components/vendor-glance-band';
import { VendorChecklist } from '../components/vendor-checklist';
import { VendorDocsLink } from '../components/vendor-docs-link';
import { VendorListingHiddenBanner } from '../components/vendor-listing-hidden-banner';
import { vendorChecklistRows } from '../checklist-rows';
import {
  buildNeedsItems,
  conflictsByProduct,
  linkCommands,
  linkFragment,
  linkQueryParams,
  openCorrections,
  type NeedsItem,
  type ProductClaimCount,
  type ProductGapField,
  type ProfileGapField,
} from '../overview/vendor-overview-model';
import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorApi } from '../vendor-api';
import { isCatalogueProduct, vendorCan, vendorIsCatalogueSeat } from '../vendor-capabilities';
import { VendorPortalStore } from '../vendor-portal-store';

/** The presentational half of a {@link NeedsItem}: what the row says. */
interface NeedsRow {
  readonly key: string;
  readonly commands: readonly string[];
  readonly queryParams: Readonly<Record<string, string>> | null;
  /** The section an integration page link lands on (AECI-1149). */
  readonly fragment: string | null;
  readonly icon: 'alert' | 'clock' | 'pencil' | 'users';
  readonly tone: 'conflict' | 'attention' | 'quiet';
  readonly pill: string;
  readonly title: string;
  readonly body: string;
}

/**
 * `…/overview` — the portal's landing page (AECI-983,
 * `docs/STAGE_2_VENDOR_PORTAL_SPEC.md` §6.10).
 *
 * Three blocks. From 1024px they sit in two columns (AECI-1810, mock-up 13): the
 * list on the start side, the figures and the checklist on the end side. Below
 * 1024px they stack in this order:
 *  1. **The glance band.** Views (a placeholder until AECI-941), In conflict, and
 *     Suggestions about your listing.
 *  2. **Getting started** (AECI-1218, §6.18). The vendor checklist
 *     (`GET /api/vendor/checklist`), full width. Plans live per product
 *     (decision 2), so there is no vendor-level plan card: the plan panel is on
 *     each product's overview. A plan that ended is the shell's banner, above the tabs.
 *  3. **What needs you.** One prioritised list, each row a link to where the work
 *     is done. "Needs you now" is conflicts and open corrections. "Worth doing" is
 *     waiting positions, incomplete products, the company profile and unaccepted
 *     seat invites, each gated on the capability that lets the vendor act.
 *
 * Every rule is in `vendor-overview-model.ts`; this component turns it into copy.
 *
 * Data comes from {@link VendorPortalStore}. `me` is seeded by the parent route,
 * and `integrations` and `seats` are ensured after first render, so SSR paints
 * the plan panel and the corrections without waiting on either. Every value is a
 * `computed` over the store, which is what lets the AECI-631 entitlement flip and
 * the AECI-516 revalidation land here without a reload. Seats have no freshness
 * cursor, so invites load on entry only, the same as the Seats tab.
 *
 * No live region of its own: the one retry announces through the shell channel.
 * No `markDirty`: nothing here is a form.
 */
@Component({
  selector: 'aec-vendor-overview-section',
  imports: [
    NgTemplateOutlet,
    RouterLink,
    AecButton,
    AecCard,
    AecIcon,
    Chip,
    VendorGlanceBand,
    VendorChecklist,
    VendorDocsLink,
    VendorListingHiddenBanner,
  ],
  template: `
    @if (me(); as m) {
      <div class="space-y-8">
        <!-- AECI-1238 (section 11d.6): AECi hid the company. First, because it changes what every
             other block on this page means for the public site. -->
        @if (m.vendor.hidden; as hidden) {
          <aec-vendor-listing-hidden-banner
            [hidden]="hidden"
            headingId="vendor-overview-listing-hidden-h"
          />
        }
        <!--
          AECI-1810 (mock-up 13, ruled 2026-11-24): two columns from 1024px, "What
          needs you" on the start side and the figures and checklist in a 400px
          column (432px from 1280px) on the end side. The side column comes FIRST in
          the DOM, so below 1024px the order stays figures, checklist, then the list.
        -->
        <div
          class="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,25rem)] lg:items-start xl:grid-cols-[minmax(0,1fr)_minmax(0,27rem)] xl:gap-12"
        >
          <div class="grid min-w-0 gap-6 lg:col-start-2 lg:row-start-1">
            <aec-vendor-glance-band
              [conflictTotal]="conflicts().total"
              [conflictProducts]="conflicts().byProduct"
              [conflictsLoading]="integrationsLoading()"
              [conflictsFailed]="integrationsFailed()"
              [openCorrections]="corrections().items.length"
              [newestCorrectionAt]="corrections().newestCreatedAt"
              (retry)="retryIntegrations()"
            />

            <!--
              AECI-1218 (STAGE_2_VENDOR_PORTAL_SPEC.md section 6.18). The vendor
              checklist. Plans live per product, so there is no vendor plan card.
            -->
            <div>
              @if (checklist(); as c) {
                <aec-vendor-checklist
                  [heading]="checklistHeading"
                  headingId="vendor-overview-checklist-h"
                  [lede]="checklistLede"
                  [rows]="checklistRows()"
                  [done]="c.done"
                  [total]="c.total"
                />
              } @else if (checklistFailed()) {
                <div aecCard class="p-6">
                  <p
                    class="text-sm text-(--text-primary)"
                    role="alert"
                    i18n="@@vendor.checklist.failed"
                  >
                    The checklist could not be loaded.
                  </p>
                  <button
                    aecButton
                    variant="secondary"
                    type="button"
                    class="mt-4"
                    (click)="retryChecklist()"
                    i18n="@@vendor.checklist.retry"
                  >
                    Try again
                  </button>
                </div>
              } @else {
                <div aecCard class="p-6" aria-busy="true">
                  <p class="text-sm text-(--text-secondary)" i18n="@@vendor.checklist.loading">
                    Loading the checklist…
                  </p>
                </div>
              }
            </div>

            @if (catalogueSeat() && catalogueProducts().length > 0) {
              <!--
                AECI-1083: where the catalogue seat's work is. Navigation, not a call
                to action, so a plain link per connector product. Outside the paused
                box because the seat keeps the Free edits, so it is not paused.
              -->
              <div>
                @for (p of catalogueProducts(); track p.slug) {
                  <p class="text-sm">
                    <a
                      [routerLink]="['..', 'products', p.slug, 'catalogue']"
                      class="rounded-mark font-semibold text-(--accent-primary) underline underline-offset-2 hover:text-(--accent-primary-hover) focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--accent-primary)"
                      data-catalogue-link
                      >{{ catalogueLinkLabel(p.name) }}</a
                    >
                  </p>
                }
              </div>
            }
          </div>

          <section
            class="min-w-0 lg:col-start-1 lg:row-start-1"
            aria-labelledby="vendor-overview-needs-h"
          >
            <h2 id="vendor-overview-needs-h" i18n="@@vendor.overview.needs.heading">
              What needs you
            </h2>
            <div class="mt-1 flex flex-wrap items-baseline gap-x-4 gap-y-1">
              <p class="text-sm leading-relaxed text-(--text-secondary)">
                {{ lede() }}
              </p>
              <p><aec-vendor-docs-link page="your-dashboard" /></p>
            </div>

            @if (needs().paused) {
              <div aecCard class="mt-4 p-6">
                @if (catalogueSeat()) {
                  <!--
                  AECI-1082. The catalogue seat never had this access and is never
                  sold it (STAGE_2_SPEC.md section 8.9), so nothing here is paused
                  and nothing comes "back on". Same box, a different statement.
                -->
                  <p
                    class="text-sm font-semibold text-(--text-primary)"
                    i18n="@@vendor.overview.catalogue.title"
                  >
                    This seat maintains your connector catalog.
                  </p>
                  <p
                    class="mt-1 max-w-prose text-sm leading-relaxed text-(--text-secondary)"
                    i18n="@@vendor.overview.catalogue.body"
                  >
                    Everything on record is here to read, and seat invites can still be managed.
                  </p>
                } @else {
                  <p
                    class="text-sm font-semibold text-(--text-primary)"
                    i18n="@@vendor.overview.paused.title"
                  >
                    Editing is paused.
                  </p>
                  <p
                    class="mt-1 max-w-prose text-sm leading-relaxed text-(--text-secondary)"
                    i18n="@@vendor.overview.paused.body"
                  >
                    Everything on record is here to read, and seat invites can still be managed. Ask
                    AEC Integrations if this looks wrong.
                  </p>
                }
              </div>
            } @else if (outstanding() === 0 && integrationsReady()) {
              <div aecCard class="mt-4 p-6">
                <p class="flex items-start gap-2 text-sm font-semibold text-(--text-primary)">
                  <span class="flex h-5 shrink-0 items-center text-(--accent-primary)">
                    <aec-icon name="check-circle" decorative [size]="4" />
                  </span>
                  <span i18n="@@vendor.overview.clear.title">Nothing needs you right now.</span>
                </p>
                <p
                  class="mt-1 max-w-prose text-sm leading-relaxed text-(--text-secondary)"
                  i18n="@@vendor.overview.clear.body"
                >
                  Your products and company profile are filled in, every data flow on record has
                  your position, and no suggestions are open. New items appear here as they come in.
                </p>
              </div>
            }

            <!--
            AECI-1810 (ruled 2026-11-24): the rows share ONE card, divided by
            hairlines, under their overline groups. A hairline also parts the groups.
          -->
            @if (nowRows().length > 0 || worthRows().length > 0) {
              <div aecCard class="mt-4 overflow-hidden" data-testid="needs-card">
                @if (nowRows().length > 0) {
                  <div [class]="groupClass">
                    <h3 [class]="groupHeadingClass" i18n="@@vendor.overview.band.now">
                      Needs you now
                    </h3>
                    <ul [class]="rowListClass">
                      @for (row of nowRows(); track row.key) {
                        <li>
                          <ng-container
                            [ngTemplateOutlet]="rowTpl"
                            [ngTemplateOutletContext]="{ $implicit: row }"
                          />
                        </li>
                      }
                    </ul>
                  </div>
                }

                @if (worthRows().length > 0) {
                  <div [class]="groupClass">
                    <h3 [class]="groupHeadingClass" i18n="@@vendor.overview.band.worth">
                      Worth doing
                    </h3>
                    <ul [class]="rowListClass">
                      @for (row of worthRows(); track row.key) {
                        <li>
                          <ng-container
                            [ngTemplateOutlet]="rowTpl"
                            [ngTemplateOutletContext]="{ $implicit: row }"
                          />
                        </li>
                      }
                    </ul>
                  </div>
                }
              </div>
            }
          </section>
        </div>
      </div>
    }

    <ng-template #rowTpl let-row>
      <a
        [routerLink]="row.commands"
        [queryParams]="row.queryParams"
        [fragment]="row.fragment ?? undefined"
        class="group/row flex min-h-16 items-start gap-4 px-4 py-3 text-(--text-primary) no-underline transition-colors hover:bg-(--surface-sunken) focus-visible:outline-3 focus-visible:-outline-offset-3 focus-visible:outline-(--accent-primary) sm:px-6"
        [attr.data-item]="row.key"
      >
        <span
          [class]="
            'flex h-5 shrink-0 items-center ' +
            (row.tone === 'conflict' ? 'text-(--status-error)' : 'text-(--text-secondary)')
          "
        >
          <aec-icon [name]="rowIcon(row.icon)" decorative [size]="4" />
        </span>
        <!--
          AECI-1116. Below sm the chip drops under the text instead of taking a
          column beside it. At 375px a long chip ("Reply by the due date") left
          the title and body about two words a line.
        -->
        <span
          class="flex min-w-0 flex-1 flex-col items-start gap-2 sm:flex-row sm:items-center sm:gap-4"
        >
          <span class="min-w-0 flex-1">
            <span
              class="block text-sm font-semibold text-(--text-primary) group-hover/row:text-(--accent-primary)"
              >{{ row.title }}</span
            >
            <span class="block text-t-13 text-(--text-secondary)">{{ row.body }}</span>
          </span>
          <aec-chip density="dense" [tone]="chipTone(row.tone)" [icon]="chipIcon(row.tone)">{{
            row.pill
          }}</aec-chip>
        </span>
        <span class="flex shrink-0 self-center text-(--text-tertiary)">
          <aec-icon name="chevron-right" decorative [size]="4" [mirrorRtl]="true" />
        </span>
      </a>
    </ng-template>
  `,
  styles: [':host { display: block; }'],
})
export class VendorOverviewSection {
  private readonly store = inject(VendorPortalStore);
  private readonly announcer = inject(VendorPortalAnnouncer);
  private readonly locale = inject(LOCALE_ID);
  private readonly api = inject(VendorApi);

  protected readonly me = this.store.me;

  /**
   * Unanswered reviews per product (AECI-1179, §11c.16): one `GET /api/vendor/reviews`
   * per owned product, filtered to `reply_status=none` with `perPage=1`, so each
   * costs one row and answers with `total`. Every claimed plan can reply since
   * AECI-1590, so no product is filtered out. That is one read per owned product
   * per `reviews` cursor tick, and the display is still capped by
   * `PRODUCT_ROW_CAP`. Empty until the reads land, and a failed read drops its
   * product rather than claiming a count.
   */
  private readonly reviewsToAnswer = signal<readonly ProductClaimCount[]>([]);
  private reviewsTicket = 0;
  private readonly rendered = signal(false);

  protected readonly integrationsLoading = computed(
    () => this.store.integrationsStatus() === 'idle' || this.store.integrationsLoading(),
  );
  protected readonly integrationsFailed = this.store.integrationsFailed;
  /** The all-clear and the conflict and waiting rows all wait on this. Before it,
   *  "nothing outstanding" would be a claim about data flows we do not hold. */
  protected readonly integrationsReady = computed(
    () => !this.integrationsLoading() && !this.integrationsFailed(),
  );

  private readonly canEditProfile = vendorCan(this.store, 'profile.edit');
  // The product gaps are the four `listing_tier` fields, so the Free capability
  // that edits them decides whether the rows are worth showing (AECI-1214).
  private readonly canEditProducts = vendorCan(this.store, 'product.listing.edit');
  private readonly canAttest = vendorCan(this.store, 'attestation.author');
  /** The §8.9 connector seat (AECI-1082): the paused row speaks to it differently. */
  protected readonly catalogueSeat = vendorIsCatalogueSeat(this.store);
  /** AECI-2044: only the products with a catalogue to maintain, never a Sync Service. */
  protected readonly catalogueProducts = computed(
    () => this.store.me()?.products.filter(isCatalogueProduct) ?? [],
  );
  protected catalogueLinkLabel(name: string): string {
    return $localize`:@@vendor.plan.catalogue.link:Open the ${name}:PRODUCT: catalog`;
  }

  protected readonly conflicts = computed(() => conflictsByProduct(this.store.integrations()));
  protected readonly corrections = computed(() => openCorrections(this.me()?.requests ?? []));

  protected readonly needs = computed(() => {
    const me = this.me();
    if (!me) return { now: [], worthDoing: [], paused: false };
    return buildNeedsItems({
      me,
      integrations: this.store.integrations(),
      ownedIntegrations: this.store.ownedIntegrations(),
      integrationsReady: this.integrationsReady(),
      seatInviteCount: this.store.seatInvites().length,
      contestsToDecide: this.store.contests().received.filter((c) => c.status === 'open').length,
      protestsToReply: this.store
        .contests()
        .received.filter(
          (c) =>
            c.protest?.status === 'open' &&
            c.protest.reply === null &&
            Date.parse(c.protest.reply_due_at) > Date.now(),
        ).length,
      counterpartAddedUnanswered: this.store.counterpartAddedUnanswered(),
      reviewsToAnswer: this.reviewsToAnswer(),
      canManageSeats: this.store.canManageSeats(),
      // The same capability the Integrations tab gates on (AECI-623).
      canAttest: this.canAttest(),
      canEditProducts: this.canEditProducts(),
      canEditProfile: this.canEditProfile(),
    });
  });

  protected readonly nowRows = computed(() => this.needs().now.map((i) => this.row(i)));
  protected readonly worthRows = computed(() => this.needs().worthDoing.map((i) => this.row(i)));
  protected readonly outstanding = computed(
    () => this.needs().now.length + this.needs().worthDoing.length,
  );

  protected readonly checklist = this.store.checklist;
  protected readonly checklistFailed = this.store.checklistFailed;
  protected readonly checklistRows = computed(() => {
    const c = this.checklist();
    return c ? vendorChecklistRows(c) : [];
  });
  protected readonly checklistHeading = $localize`:@@vendor.checklist.vendor.heading:Getting started`;
  protected readonly checklistLede = $localize`:@@vendor.checklist.vendor.lede:Your company, then each product. Each step finishes when you take the action.`;

  protected readonly lede = computed(() => {
    const n = this.outstanding();
    if (n === 0 && this.integrationsFailed()) {
      return $localize`:@@vendor.overview.needs.lede.failed:Your data flows could not be loaded, so this list may be incomplete.`;
    }
    if (n === 0 && this.integrationsLoading()) {
      return $localize`:@@vendor.overview.needs.lede.loading:Checking your data flows.`;
    }
    if (n === 0) return $localize`:@@vendor.overview.needs.lede.none:Nothing is outstanding.`;
    return n === 1
      ? $localize`:@@vendor.overview.needs.lede.one:One thing is outstanding.`
      : $localize`:@@vendor.overview.needs.lede.many:${n}:COUNT: things are outstanding.`;
  });

  constructor() {
    afterNextRender(() => {
      void this.store.ensure('integrations');
      void this.store.ensure('seats');
      void this.store.ensure('contests');
      void this.store.ensureChecklist();
      this.rendered.set(true);
    });

    // AECI-1179: the unanswered-review counts, on first render, on a catalog or plan
    // change, and on every `reviews` cursor tick.
    effect(() => {
      if (!this.rendered()) return;
      this.store.reviewsRevision();
      const products = this.me()?.products ?? [];
      untracked(() => void this.loadReviewCounts(products));
    });
  }

  protected retryChecklist(): void {
    void this.store.reloadChecklist().then(() => {
      if (!this.store.checklistFailed()) {
        this.announcer.announce(
          $localize`:@@vendor.checklist.reloaded:The checklist is up to date.`,
        );
      }
    });
  }

  private async loadReviewCounts(
    products: readonly { id: string; slug: string; name: string }[],
  ): Promise<void> {
    const ticket = ++this.reviewsTicket;
    const results = await Promise.all(
      products.map(async (p) => {
        try {
          const res = await this.api.listReviews({
            page: 1,
            perPage: 1,
            productId: p.id,
            replyStatus: 'none',
          });
          return { product: { id: p.id, slug: p.slug, name: p.name }, count: res.total };
        } catch {
          return null;
        }
      }),
    );
    if (ticket !== this.reviewsTicket) return;
    this.reviewsToAnswer.set(results.filter((r): r is ProductClaimCount => r !== null));
  }

  protected retryIntegrations(): void {
    void this.store.reload('integrations').then(() => {
      this.announcer.announce(
        this.store.integrationsFailed()
          ? $localize`:@@vendor.overview.live.reloadFailed:Your data flows could not be loaded.`
          : $localize`:@@vendor.overview.live.reloaded:Your data flows are up to date.`,
      );
    });
  }

  /**
   * The row's chip on the shared ladder (AECI-1810). The same three steps as the old
   * pills: the one red for a conflict, a strong edge for work with a clock on it, and
   * the quiet sunken chip for the rest.
   */
  protected chipTone(tone: NeedsRow['tone']): ChipTone {
    switch (tone) {
      case 'conflict':
        return 'error';
      case 'attention':
        return 'strong';
      default:
        return 'sunken';
    }
  }

  /**
   * Work with a clock on it carries the "!" mark, as on the Integrations list
   * (AECI-1811, `STATUS_CHIP_ICON.attention`), so the two strong-edged chips read
   * the same on both pages. The conflict row already has its warning icon. The
   * chip draws the mark decorative, so the chip's words carry the state.
   */
  protected chipIcon(tone: NeedsRow['tone']): AecIconName | null {
    return tone === 'attention' ? 'exclamation' : null;
  }

  protected rowIcon(icon: NeedsRow['icon']): AecIconName {
    switch (icon) {
      case 'alert':
        return 'warning';
      case 'clock':
        return 'clock';
      case 'pencil':
        return 'pencil';
      case 'users':
        return 'users';
    }
  }

  /** A group in the one card. The second group stands under a hairline. */
  protected readonly groupClass = '[&+&]:border-t [&+&]:border-(--border-default)';
  protected readonly groupHeadingClass =
    'aec-overline px-4 pt-4 pb-2 text-(--text-secondary) sm:px-6';
  protected readonly rowListClass = 'm-0 list-none divide-y divide-(--border-default) p-0';

  private row(item: NeedsItem): NeedsRow {
    const commands = linkCommands(item.link);
    const queryParams = linkQueryParams(item.link);
    const fragment = linkFragment(item.link);
    switch (item.type) {
      case 'conflict': {
        const name = item.product.name;
        return {
          key: item.key,
          commands,
          queryParams,
          fragment,
          icon: 'alert',
          tone: 'conflict',
          pill: $localize`:@@vendor.overview.item.conflict.pill:In conflict`,
          title:
            item.count === 1
              ? $localize`:@@vendor.overview.item.conflict.title.one:${name}:PRODUCT: has a data flow in conflict`
              : $localize`:@@vendor.overview.item.conflict.title.many:${name}:PRODUCT: has ${item.count}:COUNT: data flows in conflict`,
          body: $localize`:@@vendor.overview.item.conflict.body:Another source describes the same flow differently. Both positions show on the public pair page until one changes.`,
        };
      }
      case 'correction': {
        const date = formatDate(item.request.created_at, 'MMMM d, y', this.locale, 'UTC');
        const target = item.targetName;
        return {
          key: item.key,
          commands,
          queryParams,
          fragment,
          icon: 'clock',
          tone: 'attention',
          pill:
            item.request.status === 'open'
              ? $localize`:@@vendor.overview.item.correction.pill.open:Open`
              : $localize`:@@vendor.overview.item.correction.pill.inReview:In review`,
          title:
            target === null
              ? $localize`:@@vendor.overview.item.correction.title.generic:A correction was suggested to your listing`
              : $localize`:@@vendor.overview.item.correction.title:A correction was suggested to ${target}:TARGET:`,
          body: $localize`:@@vendor.overview.item.correction.body:Filed ${date}:DATE:. AEC Integrations reviews it and records the outcome in Messages.`,
        };
      }
      case 'protests':
        return {
          key: item.key,
          commands,
          queryParams,
          fragment,
          icon: 'clock',
          tone: 'attention',
          pill: $localize`:@@vendor.overview.item.protests.pill:Reply by the due date`,
          title:
            item.count === 1
              ? $localize`:@@vendor.overview.item.protests.title.one:A vendor asked AEC Integrations to review one of your change request decisions`
              : $localize`:@@vendor.overview.item.protests.title.many:${item.count}:COUNT: appeals on your change request decisions are open`,
          body: $localize`:@@vendor.overview.item.protests.body:You can reply once to each, in Messages. AEC Integrations says which side it agrees with. Its view is advice, and nothing about it is public.`,
        };
      case 'contests':
        return {
          key: item.key,
          commands,
          queryParams,
          fragment,
          icon: 'clock',
          tone: 'attention',
          pill: $localize`:@@vendor.overview.item.contests.pill:To decide`,
          title:
            item.count === 1
              ? $localize`:@@vendor.overview.item.contests.title.one:A vendor requested a change on an integration you built`
              : $localize`:@@vendor.overview.item.contests.title.many:${item.count}:COUNT: change requests are waiting for your decision`,
          body: $localize`:@@vendor.overview.item.contests.body:Accept or decline them in Messages. An accepted request changes the public integration page.`,
        };
      case 'addedRows':
        return {
          key: item.key,
          commands,
          queryParams,
          fragment,
          icon: 'clock',
          tone: 'attention',
          pill: $localize`:@@vendor.overview.item.addedRows.pill:To answer`,
          title:
            item.count === 1
              ? $localize`:@@vendor.overview.item.addedRows.title.one:1 row another company added needs your answer`
              : $localize`:@@vendor.overview.item.addedRows.title.many:${item.count}:COUNT: rows another company added need your answer`,
          body: $localize`:@@vendor.overview.item.addedRows.body:Until you answer, the public page shows each one as confirmed by the company that added it.`,
        };
      case 'waiting': {
        const name = item.product.name;
        return {
          key: item.key,
          commands,
          queryParams,
          fragment,
          icon: 'clock',
          tone: 'attention',
          pill: $localize`:@@vendor.overview.item.waiting.pill:${item.count}:COUNT: waiting`,
          title: $localize`:@@vendor.overview.item.waiting.title:Confirm what ${name}:PRODUCT: moves`,
          body:
            item.count === 1
              ? $localize`:@@vendor.overview.item.waiting.body.one:One data flow on this product has no position from you yet.`
              : $localize`:@@vendor.overview.item.waiting.body.many:${item.count}:COUNT: data flows on this product have no position from you yet.`,
        };
      }
      case 'waitingMore':
        return {
          key: item.key,
          commands,
          queryParams,
          fragment,
          icon: 'clock',
          tone: 'quiet',
          pill: $localize`:@@vendor.overview.item.more.pill:More`,
          title:
            item.products === 1
              ? $localize`:@@vendor.overview.item.waitingMore.title.one:And 1 more product with data flows waiting`
              : $localize`:@@vendor.overview.item.waitingMore.title.many:And ${item.products}:COUNT: more products with data flows waiting`,
          body: $localize`:@@vendor.overview.item.more.body:Open Products to see them all.`,
        };
      case 'reviews': {
        const name = item.product.name;
        return {
          key: item.key,
          commands,
          queryParams,
          fragment,
          icon: 'pencil',
          tone: 'quiet',
          pill:
            item.count === 1
              ? $localize`:@@vendor.overview.item.reviews.pill.one:1 review`
              : $localize`:@@vendor.overview.item.reviews.pill.many:${item.count}:COUNT: reviews`,
          title:
            item.count === 1
              ? $localize`:@@vendor.overview.item.reviews.title.one:A review of ${name}:PRODUCT: has no reply from you`
              : $localize`:@@vendor.overview.item.reviews.title.many:${item.count}:COUNT: reviews of ${name}:PRODUCT: have no reply from you`,
          body: $localize`:@@vendor.overview.item.reviews.body:You can answer each review once, in public. AEC Integrations checks every reply before it shows.`,
        };
      }
      case 'reviewsMore':
        return {
          key: item.key,
          commands,
          queryParams,
          fragment,
          icon: 'pencil',
          tone: 'quiet',
          pill: $localize`:@@vendor.overview.item.more.pill:More`,
          title:
            item.products === 1
              ? $localize`:@@vendor.overview.item.reviewsMore.title.one:And 1 more product with reviews to answer`
              : $localize`:@@vendor.overview.item.reviewsMore.title.many:And ${item.products}:COUNT: more products with reviews to answer`,
          body: $localize`:@@vendor.overview.item.more.body:Open Products to see them all.`,
        };
      case 'productGaps': {
        const name = item.product.name;
        const fields = this.fieldList(item.fields);
        return {
          key: item.key,
          commands,
          queryParams,
          fragment,
          icon: 'pencil',
          tone: 'quiet',
          pill: this.fieldCount(item.fields.length),
          title: $localize`:@@vendor.overview.item.product.title:${name}:PRODUCT: is missing ${fields}:FIELDS:`,
          body: $localize`:@@vendor.overview.item.product.body:Buyers compare listings side by side. An empty field reads as an unanswered question.`,
        };
      }
      case 'productGapsMore':
        return {
          key: item.key,
          commands,
          queryParams,
          fragment,
          icon: 'pencil',
          tone: 'quiet',
          pill: $localize`:@@vendor.overview.item.more.pill:More`,
          title:
            item.products === 1
              ? $localize`:@@vendor.overview.item.productMore.title.one:And 1 more product with missing fields`
              : $localize`:@@vendor.overview.item.productMore.title.many:And ${item.products}:COUNT: more products with missing fields`,
          body: $localize`:@@vendor.overview.item.more.body:Open Products to see them all.`,
        };
      case 'profileGaps': {
        const fields = this.fieldList(item.fields);
        return {
          key: item.key,
          commands,
          queryParams,
          fragment,
          icon: 'pencil',
          tone: 'quiet',
          pill: this.fieldCount(item.fields.length),
          title: $localize`:@@vendor.overview.item.profile.title:Your company profile is missing ${fields}:FIELDS:`,
          body: $localize`:@@vendor.overview.item.profile.body:This is the company record behind every one of your product listings.`,
        };
      }
      case 'seatInvites':
        return {
          key: item.key,
          commands,
          queryParams,
          fragment,
          icon: 'users',
          tone: 'quiet',
          pill: $localize`:@@vendor.overview.item.seats.pill:Not accepted`,
          title:
            item.count === 1
              ? $localize`:@@vendor.overview.item.seats.title.one:One seat invite is still unaccepted`
              : $localize`:@@vendor.overview.item.seats.title.many:${item.count}:COUNT: seat invites are still unaccepted`,
          body: $localize`:@@vendor.overview.item.seats.body:You can re-send or revoke invites from Seats.`,
        };
    }
  }

  private fieldCount(n: number): string {
    return n === 1
      ? $localize`:@@vendor.overview.item.fields.one:1 field`
      : $localize`:@@vendor.overview.item.fields.many:${n}:COUNT: fields`;
  }

  private fieldList(fields: readonly (ProductGapField | ProfileGapField)[]): string {
    const labels = fields.map((f) => FIELD_LABELS[f]());
    if (labels.length <= 1) return labels.join('');
    const head = labels.slice(0, -1).join(', ');
    const last = labels[labels.length - 1]!;
    return $localize`:@@vendor.overview.item.fields.list:${head}:HEAD: and ${last}:LAST:`;
  }
}

const FIELD_LABELS: Readonly<Record<ProductGapField | ProfileGapField, () => string>> = {
  description: () => $localize`:@@vendor.overview.field.description:a description`,
  website: () => $localize`:@@vendor.overview.field.website:a website`,
  logo: () => $localize`:@@vendor.overview.field.logo:a logo`,
  categories: () => $localize`:@@vendor.overview.field.categories:categories`,
  headquarters: () => $localize`:@@vendor.overview.field.headquarters:a headquarters location`,
};
