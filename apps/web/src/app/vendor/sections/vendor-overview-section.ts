import { NgTemplateOutlet, formatDate } from '@angular/common';
import { Component, LOCALE_ID, afterNextRender, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';

import { EXPIRY_WARNING_DAYS } from '@aeci/shared/entitlements';

import { VendorGlanceBand } from '../components/vendor-glance-band';
import { VendorPlanPanel } from '../components/vendor-plan-panel';
import {
  buildNeedsItems,
  conflictsByProduct,
  linkCommands,
  linkQueryParams,
  openCorrections,
  type NeedsItem,
  type ProductGapField,
  type ProfileGapField,
} from '../overview/vendor-overview-model';
import { VendorPortalAnnouncer } from '../vendor-announcer';
import { vendorCan, vendorIsCatalogueSeat } from '../vendor-capabilities';
import { VendorPortalStore } from '../vendor-portal-store';

/** The presentational half of a {@link NeedsItem}: what the row says. */
interface NeedsRow {
  readonly key: string;
  readonly commands: readonly string[];
  readonly queryParams: Readonly<Record<string, string>> | null;
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
 * Three blocks, top to bottom:
 *  1. **Account access.** The plan panel, collapsed to one line when access is
 *     active and not expiring. Every other state is a conversation and keeps the
 *     full panel.
 *  2. **The glance band.** Views (a placeholder until AECI-941), In conflict, and
 *     Suggestions about your listing.
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
  imports: [NgTemplateOutlet, RouterLink, VendorGlanceBand, VendorPlanPanel],
  template: `
    @if (me(); as m) {
      <div class="space-y-8">
        <section aria-labelledby="vendor-overview-access-h">
          <h2
            id="vendor-overview-access-h"
            [class]="accessHeadingClass()"
            i18n="@@vendor.section.accountAccess"
          >
            Account access
          </h2>
          <div [class]="compactAccess() ? '' : 'mt-4'">
            <aec-vendor-plan-panel
              [entitlement]="m.entitlement"
              [products]="m.products"
              [compact]="true"
              [catalogueLinks]="true"
            />
          </div>
        </section>

        <aec-vendor-glance-band
          [conflictTotal]="conflicts().total"
          [conflictProducts]="conflicts().byProduct"
          [conflictsLoading]="integrationsLoading()"
          [conflictsFailed]="integrationsFailed()"
          [openCorrections]="corrections().items.length"
          [newestCorrectionAt]="corrections().newestCreatedAt"
          (retry)="retryIntegrations()"
        />

        <section aria-labelledby="vendor-overview-needs-h">
          <h2
            id="vendor-overview-needs-h"
            class="font-display text-xl font-semibold text-(--text-primary)"
            i18n="@@vendor.overview.needs.heading"
          >
            What needs you
          </h2>
          <p class="mt-2 max-w-prose text-sm leading-relaxed text-(--text-secondary)">
            {{ lede() }}
          </p>

          @if (needs().paused) {
            <div
              class="mt-4 rounded-(--radius-md) border border-(--border-default) bg-(--surface-sunken) px-4 py-4"
            >
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
                  Your profile and product details stay with the AECi team.
                </p>
                <p
                  class="mt-1 max-w-prose text-sm leading-relaxed text-(--text-secondary)"
                  i18n="@@vendor.overview.catalogue.body"
                >
                  This seat maintains your connector catalogue. Everything else on record is here to
                  read, and seat invites can still be managed.
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
                  Everything on record is here to read, and seat invites can still be managed. When
                  your access is back on, this list picks up where it left off.
                </p>
              }
            </div>
          } @else if (outstanding() === 0 && integrationsReady()) {
            <div
              class="mt-4 rounded-(--radius-md) border border-(--border-default) bg-(--surface-sunken) px-4 py-4"
            >
              <p class="flex items-start gap-2 text-sm font-semibold text-(--text-primary)">
                <svg
                  aria-hidden="true"
                  class="mt-0.5 h-4 w-4 shrink-0 text-(--accent-primary)"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M20 6 9 17l-5-5" />
                </svg>
                <span i18n="@@vendor.overview.clear.title">Nothing needs you right now.</span>
              </p>
              <p
                class="mt-1 max-w-prose text-sm leading-relaxed text-(--text-secondary)"
                i18n="@@vendor.overview.clear.body"
              >
                Your products and company profile are filled in, every data flow on record has your
                position, and no suggestions are open. New items appear here as they come in.
              </p>
            </div>
          }

          @if (nowRows().length > 0) {
            <div class="mt-6">
              <h3 class="aec-overline text-(--text-secondary)" i18n="@@vendor.overview.band.now">
                Needs you now
              </h3>
              <ul class="m-0 mt-3 list-none space-y-2 p-0">
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
            <div class="mt-6">
              <h3 class="aec-overline text-(--text-secondary)" i18n="@@vendor.overview.band.worth">
                Worth doing
              </h3>
              <ul class="m-0 mt-3 list-none space-y-2 p-0">
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
        </section>
      </div>
    }

    <ng-template #rowTpl let-row>
      <a
        [routerLink]="row.commands"
        [queryParams]="row.queryParams"
        class="flex items-start gap-3 rounded-(--radius-md) border border-(--border-default) bg-(--surface-raised) px-4 py-3 no-underline transition-colors hover:bg-(--surface-sunken) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
        [attr.data-item]="row.key"
      >
        <svg
          aria-hidden="true"
          [class]="
            'mt-0.5 h-4 w-4 shrink-0 ' +
            (row.tone === 'conflict' ? 'text-(--status-error)' : 'text-(--text-secondary)')
          "
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          @switch (row.icon) {
            @case ('alert') {
              <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
              <path d="M12 9v4" />
              <path d="M12 17h.01" />
            }
            @case ('clock') {
              <circle cx="12" cy="12" r="10" />
              <path d="M12 6v6l4 2" />
            }
            @case ('pencil') {
              <path
                d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"
              />
            }
            @case ('users') {
              <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            }
          }
        </svg>
        <!--
          AECI-1116. Below sm the pill drops under the text instead of taking a
          column beside it. At 375px a long pill ("Reply by the due date") left
          the title and body about two words a line.
        -->
        <span
          class="flex min-w-0 flex-1 flex-col items-start gap-2 sm:flex-row sm:items-center sm:gap-3"
        >
          <span class="min-w-0 flex-1">
            <span class="block text-sm font-semibold text-(--text-primary)">{{ row.title }}</span>
            <span class="mt-0.5 block text-xs leading-relaxed text-(--text-secondary)">{{
              row.body
            }}</span>
          </span>
          <span [class]="pillClass(row.tone)">{{ row.pill }}</span>
        </span>
        <svg
          aria-hidden="true"
          class="h-4 w-4 shrink-0 self-center text-(--text-secondary) rtl:-scale-x-100"
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
  styles: [':host { display: block; }'],
})
export class VendorOverviewSection {
  private readonly store = inject(VendorPortalStore);
  private readonly announcer = inject(VendorPortalAnnouncer);
  private readonly locale = inject(LOCALE_ID);

  protected readonly me = this.store.me;

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
  private readonly canEditProducts = vendorCan(this.store, 'product.edit');
  private readonly canAttest = vendorCan(this.store, 'attestation.author');
  /** The §8.9 connector seat (AECI-1082): the paused row speaks to it differently. */
  protected readonly catalogueSeat = vendorIsCatalogueSeat(this.store);

  protected readonly conflicts = computed(() => conflictsByProduct(this.store.integrations()));
  protected readonly corrections = computed(() => openCorrections(this.me()?.requests ?? []));

  protected readonly needs = computed(() => {
    const me = this.me();
    if (!me) return { now: [], worthDoing: [], paused: false };
    return buildNeedsItems({
      me,
      integrations: this.store.integrations(),
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

  /**
   * The plan panel's `isCompact` rule, restated so the heading can hide exactly
   * when the panel collapses (it stays in the outline either way). Same inputs:
   * active, a known tier, and more than `EXPIRY_WARNING_DAYS` left. The dashboard
   * spec pins the two together.
   */
  protected readonly compactAccess = computed(() => {
    const e = this.me()?.entitlement;
    if (!e || e.status !== 'active' || e.tier === 'unclaimed') return false;
    if (!e.period_end) return true;
    const end = new Date(e.period_end).getTime();
    if (Number.isNaN(end)) return true;
    return Math.ceil((end - Date.now()) / 86_400_000) > EXPIRY_WARNING_DAYS;
  });

  protected readonly accessHeadingClass = computed(() =>
    this.compactAccess() ? 'sr-only' : 'font-display text-xl font-semibold text-(--text-primary)',
  );

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
    });
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

  protected pillClass(tone: NeedsRow['tone']): string {
    const base =
      'inline-flex shrink-0 items-center rounded-(--radius-sm) border px-2 py-0.5 text-xs font-semibold tracking-[0.01em]';
    switch (tone) {
      case 'conflict':
        return `${base} aec-pill-conflict bg-(--surface-raised) text-(--status-error)`;
      case 'attention':
        return `${base} aec-pill-attention bg-(--surface-raised) text-(--text-primary)`;
      default:
        return `${base} bg-(--surface-sunken) text-(--text-secondary)`;
    }
  }

  private row(item: NeedsItem): NeedsRow {
    const commands = linkCommands(item.link);
    const queryParams = linkQueryParams(item.link);
    switch (item.type) {
      case 'conflict': {
        const name = item.product.name;
        return {
          key: item.key,
          commands,
          queryParams,
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
          icon: 'clock',
          tone: 'attention',
          pill: $localize`:@@vendor.overview.item.protests.pill:Reply by the due date`,
          title:
            item.count === 1
              ? $localize`:@@vendor.overview.item.protests.title.one:A vendor asked AEC Integrations to review one of your contest decisions`
              : $localize`:@@vendor.overview.item.protests.title.many:${item.count}:COUNT: review requests on your contest decisions are open`,
          body: $localize`:@@vendor.overview.item.protests.body:You can reply once to each, in Messages. AEC Integrations says which side it agrees with. Its view is advice, and nothing about it is public.`,
        };
      case 'contests':
        return {
          key: item.key,
          commands,
          queryParams,
          icon: 'clock',
          tone: 'attention',
          pill: $localize`:@@vendor.overview.item.contests.pill:To decide`,
          title:
            item.count === 1
              ? $localize`:@@vendor.overview.item.contests.title.one:A vendor contested a field on an integration you built`
              : $localize`:@@vendor.overview.item.contests.title.many:${item.count}:COUNT: field contests are waiting for your decision`,
          body: $localize`:@@vendor.overview.item.contests.body:Accept or decline them in Messages. An accepted contest changes the public integration page.`,
        };
      case 'waiting': {
        const name = item.product.name;
        return {
          key: item.key,
          commands,
          queryParams,
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
          icon: 'clock',
          tone: 'quiet',
          pill: $localize`:@@vendor.overview.item.more.pill:More`,
          title:
            item.products === 1
              ? $localize`:@@vendor.overview.item.waitingMore.title.one:And 1 more product with data flows waiting`
              : $localize`:@@vendor.overview.item.waitingMore.title.many:And ${item.products}:COUNT: more products with data flows waiting`,
          body: $localize`:@@vendor.overview.item.more.body:Open Products to see them all.`,
        };
      case 'productGaps': {
        const name = item.product.name;
        const fields = this.fieldList(item.fields);
        return {
          key: item.key,
          commands,
          queryParams,
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
