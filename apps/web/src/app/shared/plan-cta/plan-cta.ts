/**
 * The plan calls to action, shared by the vendor guide's Plans page
 * (`/docs/vendors/plans`) and the public vendor program page (`/vendor-program`),
 * `VENDOR_PROGRAM_PAGE_SPEC.md` §4 and §15. Moved here from `docs/docs-plans-cta.ts`
 * (AECI-1285). The placements:
 *
 *  - `top`        the hero button (`PlanCtaActionsComponent`): under the docs intro, in
 *                 the vendor program hero.
 *  - `card`       the plan cards' buttons (`plan-cards.ts`).
 *  - `rail`       a small sticky card (`PlanCtaRailComponent`), on the docs Plans page
 *                 only.
 *  - `mobile_bar` a slim bar fixed to the bottom of the screen below `lg`
 *                 (`PlanCtaMobileBarComponent`). It shows only once the top pair has
 *                 scrolled away, and hides while a full call to action is on screen.
 *  - `bottom`     a full-width Forest panel (`PlanCtaPanelComponent`).
 *
 * **One claim workflow (AECI-1293, §15.1).** Every main control opens the claim
 * dialog (`shared/claim-dialog/`), and every one reads "Claim your listing": the hero,
 * both plan cards, the rail, the phone bar and the panel. E8.2 (2026-10-19) retired
 * "Start with Managed": claim is the one action. Each page mounts exactly one
 * `aec-claim-dialog-host`. Each control is a link to `CLAIM_DIALOG_FALLBACK_HREF` (the
 * search page), so a click without JS or into a new tab still lands where a visitor
 * can find the listing and its claim form. Claim is the only plan action. Never "Get
 * Managed", "Buy" or "Start now": public pages still lead with the claim, and paying
 * appears only on the portal's Billing tab ("Pay by card", AECI-1396).
 *
 * **Questions? Contact us** (`PlanContactLinkComponent`, E8.1, 2026-10-19). A plain
 * link to `/contact`, with no topic and no form. It replaced the plan inquiry dialog
 * ("Talk to us"), which was removed with its route and emails. It sits beside the
 * claim button in the closing panel, and the vendor program page also puts one under
 * its FAQ. It is not on the hero.
 *
 * **Every component takes a `page`** (`docs_plans` | `vendor_program`), sent on
 * `plan_cta_clicked` and carried into the claim dialog (`docs/ANALYTICS.md` §4).
 *
 * **Signed-in hooks (spec §5, AECI-1286).** `portal` turns every dialog control into
 * "Go to your portal" (`/vendor`) and drops the panel's two claim steps. `hideManaged`
 * drops the rail card, the phone bar and the panel's contact link, for a Managed
 * company. Both default to the signed-out page, so the SSR HTML stays visitor-neutral,
 * and both are set only after hydration.
 *
 * Static and visitor-neutral in the SSR HTML: the bar renders hidden and is shown only
 * by the browser, so the edge-cached HTML is the same for everyone. Every string is
 * `$localize`d or `i18n`. Light only.
 */
import {
  Component,
  DestroyRef,
  DOCUMENT,
  Directive,
  LOCALE_ID,
  afterNextRender,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { RouterLink } from '@angular/router';

import { MANAGED_ANNUAL_PRICE_CENTS, MANAGED_LIST_PRICE_CENTS } from '@aeci/shared/entitlements';

import { Analytics, type PlanCtaPage, type PlanCtaPlacement } from '../../analytics/analytics';
import { formatPlanPrice, planLabel } from '../../vendor/vendor-plan';
import { ClaimDialogTrigger } from '../claim-dialog/claim-dialog-trigger';
import { CLAIM_DIALOG_FALLBACK_HREF } from '../claim-dialog/claim-dialog.service';

/** Where "Go to your portal" points, for a signed-in vendor (spec §5). */
export const PORTAL_PATH = '/vendor';

/**
 * Marks a full call to action, so the phone bar can hide while one is on
 * screen. The two hosts spell it out literally, because `host` keys must be.
 */
export const PLANS_CTA_ATTR = 'data-plans-cta';

/** `$25 USD a month per product`, from the list price. */
export function managedPriceLine(locale: string): string {
  const amount = formatPlanPrice(MANAGED_LIST_PRICE_CENTS, locale);
  return $localize`:@@app.docs.plans.cta.priceLine:${amount}:AMOUNT: USD a month per product`;
}

/**
 * `$25 USD a month or $250 USD a year per product.`, the closing panel's terms (spec
 * §4.1), from the two price constants. USD stays on each amount: vendors outside the
 * US read these pages. No payment method (E8.2, 2026-10-19).
 */
export function managedTermsLine(locale: string): string {
  const monthly = formatPlanPrice(MANAGED_LIST_PRICE_CENTS, locale);
  const annual = formatPlanPrice(MANAGED_ANNUAL_PRICE_CENTS, locale);
  return $localize`:@@planCta.terms:${monthly}:MONTHLY: USD a month or ${annual}:ANNUAL: USD a year per product.`;
}

/**
 * The term, beside the price in What Managed adds on `/vendor-program` (E8.2
 * 2026-10-19): monthly is month to month with no commitment, and the first charge
 * carries a 14-day full refund. The closing panel says it shorter in its own string
 * since 2026-10-24 (spec §4.1).
 */
export function managedTermLine(): string {
  return $localize`:@@planCta.term:Monthly has no commitment: cancel any time. We refund in full if you ask within 14 days of the first charge.`;
}

/**
 * Annual renewal, under the price on `/vendor-program` (spec §3 item 4, E8.2
 * 2026-10-19). The docs Plans page says it in Markdown, and
 * `vendor-program-copy.component.spec.ts` pins the two together sentence by sentence.
 */
export function managedRenewalLine(): string {
  return $localize`:@@planCta.renewal:An annual license renews each year unless you opt out before the renewal date. At least 30 days before that date, we send you the renewal price and date in writing. A new price never applies mid-term.`;
}

/**
 * The vendor program FAQ's "What does Managed cost?" answer (E8.2, 2026-10-19): both
 * prices from the two constants, monthly with no commitment, annual renewal and the
 * 14-day refund. AECI-1396 (2026-10-28) added the payment method: by card through
 * Stripe, from the Billing tab.
 */
export function managedCostAnswer(locale: string): string {
  const monthly = formatPlanPrice(MANAGED_LIST_PRICE_CENTS, locale);
  const annual = formatPlanPrice(MANAGED_ANNUAL_PRICE_CENTS, locale);
  return $localize`:@@vendorProgram.faq.billing.a:Managed costs ${monthly}:MONTHLY: USD a month or ${annual}:ANNUAL: USD a year per product. Monthly has no commitment: cancel any time. An annual license renews each year unless you opt out before the renewal date. We refund in full if you ask within 14 days of the first charge. You pay by card through Stripe, from the Billing tab.`;
}

/**
 * Records a click. Shared so every placement reports the same shape. `page` is
 * required: every mount says which page it is on.
 */
@Directive()
abstract class PlanCta {
  private readonly analytics = inject(Analytics);
  /** Every claim dialog control's no-JS and new-tab destination (§15.1). */
  protected readonly claimHref = CLAIM_DIALOG_FALLBACK_HREF;
  /** "Go to your portal" carries no click handler: a portal click is not a plan click. */
  protected readonly portalPath = PORTAL_PATH;

  /** Which page this sits on, for `plan_cta_clicked` and the claim dialog. */
  readonly page = input.required<PlanCtaPage>();
  /** A signed-in vendor seat: every dialog control becomes "Go to your portal" (§5). */
  readonly portal = input(false);

  /**
   * `free` is a click on a Free-side control (hero, Free card, panel), `managed` one on a
   * Managed-side control (Managed card, rail, phone bar). All read "Claim your listing".
   */
  protected track(plan: 'free' | 'managed', placement: PlanCtaPlacement): void {
    this.analytics.planCtaClicked({ plan, placement, page: this.page() });
  }
}

/**
 * "Questions? Contact us": a plain link to the contact page, with no topic (E8.1).
 * `inverse` on the Forest panel.
 */
@Component({
  selector: 'aec-plan-contact-link',
  imports: [RouterLink],
  host: { class: 'block' },
  template: `
    <p
      [class]="
        tone() === 'inverse' ? 'text-sm text-(--surface-base)' : 'text-sm text-(--text-secondary)'
      "
    >
      <span i18n="@@planCta.contact.lead">Questions?</span>
      {{ ' ' }}
      <a
        routerLink="/contact"
        [class]="
          tone() === 'inverse'
            ? 'font-semibold text-(--surface-base) underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--surface-base)'
            : 'font-semibold text-(--accent-primary) underline underline-offset-4 hover:text-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)'
        "
        i18n="@@planCta.contact.link"
        >Contact us</a
      >
    </p>
  `,
})
export class PlanContactLinkComponent {
  /** `inverse` on the Forest panel. */
  readonly tone = input<'default' | 'inverse'>('default');
}

/** The hero button: under the docs intro, in the vendor program hero (`placement: top`). */
@Component({
  selector: 'aec-plan-cta-actions',
  imports: [RouterLink, ClaimDialogTrigger],
  host: { class: 'block', 'data-plans-cta': 'top' },
  template: `
    <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:gap-6">
      @if (portal()) {
        <a
          [routerLink]="portalPath"
          class="inline-flex items-center justify-center rounded-(--radius-md) bg-(--accent-primary) px-5 py-3 text-base font-semibold text-(--surface-base) no-underline hover:bg-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
          i18n="@@planCta.portal"
          >Go to your portal</a
        >
      } @else {
        <a
          [href]="claimHref"
          aecClaimDialogTrigger="top"
          [aecClaimDialogPage]="page()"
          (click)="track('free', 'top')"
          class="inline-flex items-center justify-center rounded-(--radius-md) bg-(--accent-primary) px-5 py-3 text-base font-semibold text-(--surface-base) no-underline hover:bg-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
          i18n="@@planCta.claim"
          >Claim your listing</a
        >
      }
    </div>
  `,
})
export class PlanCtaActionsComponent extends PlanCta {}

/**
 * The full-width Forest panel that closes a page (`placement: bottom`). On the
 * docs page it sits in "Getting Managed" under an `h2`, so its heading is an
 * `h3`. A page that gives it its own section passes `headingLevel` 2.
 */
@Component({
  selector: 'aec-plan-cta-panel',
  imports: [RouterLink, ClaimDialogTrigger, PlanContactLinkComponent],
  host: { class: 'block', 'data-plans-cta': 'bottom' },
  template: `
    <section
      class="rounded-(--radius-lg) bg-(--accent-primary) px-6 py-7 text-(--surface-base) sm:px-8"
      [class.lg:grid]="split()"
      [class.lg:grid-cols-12]="split()"
      [class.lg:items-center]="split()"
      [class.lg:gap-x-12]="split()"
      [class.lg:px-10]="split()"
      [class.lg:py-10]="split()"
      aria-labelledby="plans-cta-heading"
    >
      <div [class.lg:col-span-6]="split()" [class.xl:col-span-7]="split()">
        @if (headingLevel() === 2) {
          <h2
            id="plans-cta-heading"
            class="aec-plan-cta-heading"
            i18n="@@app.docs.plans.cta.heading"
          >
            Tell the full story of your product
          </h2>
        } @else {
          <h3
            id="plans-cta-heading"
            class="aec-plan-cta-heading"
            i18n="@@app.docs.plans.cta.heading"
          >
            Tell the full story of your product
          </h3>
        }
        <p class="mt-2 max-w-[34rem] leading-relaxed">
          <span>{{ terms }}</span>
          {{ ' ' }}
          <span i18n="@@app.docs.plans.cta.term"
            >Monthly, cancel any time. Full refund within 14 days.</span
          >
          {{ ' ' }}
          <span i18n="@@app.docs.plans.cta.safety"
            >If a plan ends, nothing you entered is removed.</span
          >
        </p>
      </div>
      <div [class.lg:col-span-6]="split()" [class.xl:col-span-5]="split()">
        <div
          class="mt-5 flex flex-col gap-4 sm:flex-row sm:items-center sm:gap-6"
          [class.lg:mt-0]="split()"
          [class.lg:flex-col]="split()"
          [class.lg:items-start]="split()"
          [class.xl:flex-row]="split()"
          [class.xl:items-center]="split()"
        >
          @if (portal()) {
            <a [routerLink]="portalPath" [class]="panelButtonClass" i18n="@@planCta.portal"
              >Go to your portal</a
            >
          } @else {
            <a
              [href]="claimHref"
              aecClaimDialogTrigger="bottom"
              [aecClaimDialogPage]="page()"
              (click)="track('free', 'bottom')"
              [class]="panelButtonClass"
              i18n="@@planCta.claim"
              >Claim your listing</a
            >
          }
          @if (!hideManaged()) {
            <aec-plan-contact-link tone="inverse" />
          }
        </div>
        @if (!portal() && !hideManaged()) {
          <ol class="mt-5 space-y-1.5 text-sm">
            <li class="flex gap-2">
              <span class="font-semibold" aria-hidden="true">1.</span>
              <span i18n="@@planCta.step.find">Find your listing and send your claim.</span>
            </li>
            <li class="flex gap-2">
              <span class="font-semibold" aria-hidden="true">2.</span>
              <span i18n="@@planCta.step.review">We review it and email you the result.</span>
            </li>
          </ol>
        }
      </div>
    </section>
  `,
})
export class PlanCtaPanelComponent extends PlanCta {
  protected readonly terms = managedTermsLine(inject(LOCALE_ID));
  protected readonly panelButtonClass =
    'inline-flex w-full items-center justify-center rounded-(--radius-md) bg-(--surface-base) px-6 py-3.5 text-base font-semibold text-(--accent-primary) no-underline hover:bg-(--accent-warm) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--surface-base) sm:w-auto';
  /** `h3` under a page section (the docs page), `h2` as its own section. */
  readonly headingLevel = input<2 | 3>(3);
  /**
   * A Managed company: drop the contact link (spec §5). The two next steps describe the
   * claim dialog, so they show only while the button opens it, never beside "Go to your
   * portal" (ruled 2026-10-12, spec §4.1).
   */
  readonly hideManaged = input(false);
  /**
   * From `lg`, the heading and terms on the left and the actions on the right (six
   * and six with the actions stacked, then seven and five in a row from `xl`), so a full-width panel has no blank right half. The vendor
   * program page sets it. The docs panel sits in the article column and does not.
   */
  readonly split = input(false);
}

/** The small sticky card beside the article (`placement: rail`). */
@Component({
  selector: 'aec-plan-cta-rail',
  imports: [RouterLink, ClaimDialogTrigger],
  host: { class: 'block' },
  template: `
    @if (!hideManaged()) {
      <aside class="aec-plan-card p-4" aria-labelledby="plans-rail-heading">
        <p id="plans-rail-heading" class="text-sm font-semibold text-(--text-primary)">
          {{ managedName }}
        </p>
        <p class="mt-1 text-xs leading-snug text-(--text-secondary)">{{ price }}</p>
        @if (portal()) {
          <a [routerLink]="portalPath" [class]="railButtonClass" i18n="@@planCta.portal"
            >Go to your portal</a
          >
        } @else {
          <a
            [href]="claimHref"
            aecClaimDialogTrigger="rail"
            [aecClaimDialogPage]="page()"
            (click)="track('managed', 'rail')"
            [class]="railButtonClass"
            i18n="@@planCta.claim"
            >Claim your listing</a
          >
        }
      </aside>
    }
  `,
})
export class PlanCtaRailComponent extends PlanCta {
  protected readonly managedName = planLabel('managed');
  protected readonly price = managedPriceLine(inject(LOCALE_ID));
  protected readonly railButtonClass =
    'mt-3 flex items-center justify-center rounded-(--radius-md) bg-(--accent-primary) px-3 py-2 text-center text-sm font-semibold text-(--surface-base) no-underline hover:bg-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';
  /** A Managed company: render nothing (spec §5). */
  readonly hideManaged = input(false);
}

/**
 * The slim bar fixed to the bottom of a phone screen (`placement: mobile_bar`).
 * Hidden in the SSR HTML. In the browser it shows once the top pair has
 * scrolled above the screen and no full call to action is on screen. While it
 * shows, the page reserves its height (`scroll-padding-bottom`), so a focused
 * link is never hidden under it (WCAG 2.2, 2.4.11). `hideManaged` keeps it
 * hidden, and its height unreserved, for a Managed company (spec §5).
 */
@Component({
  selector: 'aec-plan-cta-mobile-bar',
  imports: [RouterLink, ClaimDialogTrigger],
  host: { class: 'lg:hidden' },
  template: `
    @if (visible()) {
      <div
        class="fixed inset-x-0 bottom-0 z-40 border-t border-(--border-default) bg-(--surface-base) px-4 py-3"
        role="region"
        i18n-aria-label="@@app.docs.plans.cta.barLabel"
        aria-label="Managed plan"
      >
        <div class="mx-auto flex max-w-[42rem] items-center gap-3">
          <p class="min-w-0 flex-1 text-sm leading-snug text-(--text-primary)">
            <span class="font-semibold">{{ managedName }}</span>
            <span class="text-(--text-secondary)"> · {{ price }}</span>
          </p>
          @if (portal()) {
            <a [routerLink]="portalPath" [class]="barButtonClass" i18n="@@planCta.portal"
              >Go to your portal</a
            >
          } @else {
            <a
              [href]="claimHref"
              aecClaimDialogTrigger="mobile_bar"
              [aecClaimDialogPage]="page()"
              (click)="track('managed', 'mobile_bar')"
              [class]="barButtonClass"
              i18n="@@planCta.claim"
              >Claim your listing</a
            >
          }
        </div>
      </div>
    }
  `,
})
export class PlanCtaMobileBarComponent extends PlanCta {
  private readonly document = inject(DOCUMENT);
  protected readonly managedName = planLabel('managed');
  protected readonly price = managedPriceLine(inject(LOCALE_ID));
  protected readonly visible = signal(false);
  protected readonly barButtonClass =
    'shrink-0 rounded-(--radius-md) bg-(--accent-primary) px-4 py-2.5 text-sm font-semibold text-(--surface-base) no-underline hover:bg-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';
  /** A Managed company: never show, never reserve height (spec §5). */
  readonly hideManaged = input(false);

  /** Room the bar takes, reserved while it shows. */
  private static readonly RESERVE = '5rem';

  private readonly destroyRef = inject(DestroyRef);
  /** Re-runs the show rule. Set once the observer is wired, browser only. */
  private reapply: (() => void) | null = null;

  constructor() {
    super();
    // `hideManaged` can flip after hydration (spec §5), so re-run the rule on a flip.
    effect(() => {
      this.hideManaged();
      untracked(() => this.reapply?.());
    });
    // `afterNextRender` runs in the browser only, so SSR never shows the bar.
    afterNextRender(() => {
      const root = this.document.documentElement;
      const targets = [...this.document.querySelectorAll(`[${PLANS_CTA_ATTR}]`)];
      if (targets.length === 0 || typeof IntersectionObserver === 'undefined') return;
      // The host is `lg:hidden`, so from `lg` the bar never shows and must not
      // reserve its height either. Tailwind's `lg` is 64rem.
      const phone = this.document.defaultView?.matchMedia('(max-width: 63.99rem)');
      const onScreen = new Set<Element>();
      let topPassed = false;
      const apply = (): void => {
        const show =
          !this.hideManaged() && (phone?.matches ?? true) && topPassed && onScreen.size === 0;
        this.visible.set(show);
        // Reserve the bar's height: focus never lands under it, and the end of
        // the page can still scroll clear of it.
        root.style.scrollPaddingBottom = show ? PlanCtaMobileBarComponent.RESERVE : '';
        this.document.body.style.paddingBottom = show ? PlanCtaMobileBarComponent.RESERVE : '';
      };
      this.reapply = apply;
      const observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) onScreen.add(entry.target);
          else onScreen.delete(entry.target);
          if (entry.target.getAttribute(PLANS_CTA_ATTR) === 'top') {
            topPassed = !entry.isIntersecting && entry.boundingClientRect.bottom < 0;
          }
        }
        apply();
      });
      phone?.addEventListener('change', apply);
      for (const target of targets) observer.observe(target);
      this.destroyRef.onDestroy(() => {
        this.reapply = null;
        observer.disconnect();
        phone?.removeEventListener('change', apply);
        root.style.scrollPaddingBottom = '';
        this.document.body.style.paddingBottom = '';
      });
    });
  }
}
