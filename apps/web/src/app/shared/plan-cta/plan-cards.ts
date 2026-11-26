/**
 * The Free and Managed plan cards (`placement: card`), shared by the vendor
 * guide's Plans page (inside `docs/docs-plans-comparison.ts`) and the vendor
 * program page (`VENDOR_PROGRAM_PAGE_SPEC.md` §3 item 6: reuse, do not copy).
 * Extracted from `DocsPlansComparisonComponent` in AECI-1285. The two buttons share one
 * size and line (2026-10-26).
 *
 * Anchor site: **Mintlify**'s billing page, Mobbin screen
 * `c74405c6-a307-4e35-b8eb-21a1129ce5f3`. The paid card is marked by a heavier
 * border, never a gradient, and by its own name and price.
 *
 * Frame (ruling A7, 2026-11-16): both cards are the shared card (`aecCard`): 24px
 * radius, `shadow-card`, a transparent 1px edge. The Managed card keeps a 2px
 * Forest border (the unlayered `.aec-plan-card-featured` rule, after `.aec-card`
 * in `styles.css`) and drops 1px of padding to offset it, so both buttons are the
 * same width. The border is not its only mark: its "Managed" name and price say
 * which plan it is. Words, prices, buttons, links and order are unchanged.
 *
 * From `sm` each card is a six-row subgrid of the outer grid (name, summary,
 * price, button, label, list), so the two buttons sit on one line even though
 * the Managed price row is taller than the Free one.
 *
 * The price is the default list price (`MANAGED_LIST_PRICE_CENTS`,
 * `STAGE_2_PAID_TIERS_SPEC.md` §13.13), formatted by the same helper as the
 * portal's plan panel. Managed copy must never suggest it changes where a
 * listing ranks or appears (`STAGE_2_PAID_TIERS_SPEC.md` §3.2).
 *
 * Inputs, as on the other plan calls to action (`plan-cta.ts`): `page` and the
 * signed-in `portal` swap. Both buttons open the claim dialog (AECI-1293, spec
 * §15.1), and both read "Claim your listing" (E8.2, 2026-10-19, retired "Start with
 * Managed"). The Managed card's inquiry link and reply line were removed on 2026-10-19 (E8.1): claim is the only
 * plan action. A vendor seat sees "Go to your portal" on both.
 *
 * Static: no fetch and no visitor state, so the SSR HTML and the hydrated HTML
 * match and the page stays edge-cacheable. Every string is `$localize`d or
 * `i18n`. Light only. The name, price and featured border are the unlayered
 * `.aec-plan-*` classes in `styles.css`, written while a border-color utility lost
 * to the then-unlayered `*` rule (fixed in AECI-2088).
 */
import { Component, LOCALE_ID, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';

import { AecButton } from '../button/button';
import { AecCard } from '../card/card';
import { Analytics, type PlanCtaPage } from '../../analytics/analytics';
import { ClaimDialogTrigger } from '../claim-dialog/claim-dialog-trigger';
import { CLAIM_DIALOG_FALLBACK_HREF } from '../claim-dialog/claim-dialog.service';
import { planCardsCopy } from './plan-card-copy';
import { PORTAL_PATH } from './plan-cta';
import { AecIcon } from '../icon/icon';

@Component({
  selector: 'aec-plan-cards',
  imports: [AecButton, AecCard, AecIcon, RouterLink, ClaimDialogTrigger],
  host: { class: 'block' },
  template: `
    <div class="grid gap-4 sm:grid-cols-2 sm:gap-y-0">
      <section
        aecCard
        data-plan-card="free"
        class="flex flex-col p-6 sm:row-span-6 sm:grid sm:grid-rows-subgrid sm:gap-y-0"
        aria-labelledby="plan-card-free"
      >
        <h3 id="plan-card-free" class="aec-plan-card-name text-(--text-primary)">
          {{ copy.free.name }}
        </h3>
        <p class="mt-1 text-sm text-(--text-secondary)">{{ copy.free.summary }}</p>
        <p class="mt-4 flex items-baseline gap-2 sm:self-end">
          <span class="text-sm text-(--text-secondary)">{{ copy.free.unit }}</span>
        </p>
        @if (portal()) {
          <a
            [routerLink]="portalPath"
            aecButton
            variant="secondary"
            class="mt-4"
            i18n="@@planCta.portal"
            >Go to your portal</a
          >
        } @else {
          <a
            [href]="claimHref"
            aecClaimDialogTrigger="card"
            [aecClaimDialogPage]="page()"
            (click)="track('free')"
            aecButton
            variant="secondary"
            class="mt-4"
            i18n="@@planCta.claim"
            >Claim your listing</a
          >
        }
        <p class="mt-6 text-xs font-semibold text-(--text-secondary)">{{ copy.free.includes }}</p>
        <ul class="mt-2 space-y-2 text-sm text-(--text-primary)">
          @for (item of copy.free.highlights; track item) {
            <li class="flex gap-2">
              <span class="flex h-5 shrink-0 items-center text-(--accent-primary)">
                <aec-icon name="check" decorative [size]="4" />
              </span>
              <span>{{ item }}</span>
            </li>
          }
        </ul>
      </section>

      <section
        aecCard
        data-plan-card="managed"
        class="aec-plan-card-featured flex flex-col p-[23px] sm:row-span-6 sm:grid sm:grid-rows-subgrid sm:gap-y-0"
        aria-labelledby="plan-card-managed"
      >
        <h3 id="plan-card-managed" class="aec-plan-card-name text-(--text-primary)">
          {{ copy.managed.name }}
        </h3>
        <p class="mt-1 text-sm text-(--text-secondary)">{{ copy.managed.summary }}</p>
        <p class="mt-4 flex items-baseline gap-2">
          <span class="aec-plan-price text-(--text-primary)">{{ copy.managed.price }}</span>
          <span class="text-sm text-(--text-secondary)">{{ copy.managed.unit }}</span>
        </p>
        @if (portal()) {
          <a [routerLink]="portalPath" aecButton class="mt-4" i18n="@@planCta.portal"
            >Go to your portal</a
          >
        } @else {
          <a
            [href]="claimHref"
            aecClaimDialogTrigger="card"
            [aecClaimDialogPage]="page()"
            (click)="track('managed')"
            aecButton
            class="mt-4"
            i18n="@@planCta.claim"
            >Claim your listing</a
          >
        }
        <p class="mt-6 text-xs font-semibold text-(--text-secondary)">
          {{ copy.managed.includes }}
        </p>
        <ul class="mt-2 space-y-2 text-sm text-(--text-primary)">
          @for (item of copy.managed.highlights; track item) {
            <li class="flex gap-2">
              <span class="flex h-5 shrink-0 items-center text-(--accent-primary)">
                <aec-icon name="check" decorative [size]="4" />
              </span>
              <span>{{ item }}</span>
            </li>
          }
        </ul>
      </section>
    </div>
  `,
})
export class PlanCardsComponent {
  private readonly locale = inject(LOCALE_ID);
  private readonly analytics = inject(Analytics);
  protected readonly claimHref = CLAIM_DIALOG_FALLBACK_HREF;
  protected readonly portalPath = PORTAL_PATH;
  /** Which page the cards sit on, for `plan_cta_clicked` and the claim dialog. */
  readonly page = input.required<PlanCtaPage>();
  /** A signed-in vendor: the claim link becomes "Go to your portal" (spec §5). */
  readonly portal = input(false);

  /** Every word on both cards (`plan-card-copy.ts`), shared with the Plans snapshot. */
  protected readonly copy = planCardsCopy(this.locale);

  protected track(plan: 'free' | 'managed'): void {
    this.analytics.planCtaClicked({ plan, placement: 'card', page: this.page() });
  }
}
