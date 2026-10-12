/**
 * The Plans page's calls to action (`/docs/vendors/plans`, marketing review
 * 2026-10-12). Four placements of one ask, "Talk to us about Managed":
 *
 *  - `top`        a button row under the intro (`<!-- docs:plans-actions -->`),
 *                 with "Claim your listing free" beside it.
 *  - `card`       the Managed card's button (`docs-plans-comparison.ts`).
 *  - `rail`       a small sticky card under the "On this page" dashes, from
 *                 90rem, where the rail column is wide enough to hold it.
 *  - `mobile_bar` a slim bar fixed to the bottom of the screen below `lg`. It
 *                 shows only once the top row has scrolled away, and hides while
 *                 a full call to action is on screen.
 *  - `bottom`     a full-width Forest panel in "Getting Managed"
 *                 (`<!-- docs:plans-cta -->`).
 *
 * The rail and the bar are placed by the page's `cta: managed` frontmatter
 * (`docs-page.ts`), not by a widget line, because they live outside the body.
 *
 * **The wording stays "Talk to us about Managed".** There is no checkout, so a
 * button that says "Get" or "Start" would promise what the click does not do.
 * Every Managed button goes to `/contact?topic=managed`, which pre-fills the
 * email's subject and prompts (`contact/contact.ts`). Every click fires
 * `plan_cta_clicked` with its placement (`docs/ANALYTICS.md` §4).
 *
 * The reply line repeats the contact page's own promise ("most messages within
 * a couple of business days"). Change both together, or neither.
 *
 * Static and visitor-neutral in the SSR HTML: the bar renders hidden and is
 * shown only by the browser, so the edge-cached HTML is the same for everyone.
 * Chrome only, so every string is `$localize`d. Light only.
 */
import {
  Component,
  DestroyRef,
  DOCUMENT,
  LOCALE_ID,
  afterNextRender,
  inject,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';

import { MANAGED_LIST_PRICE_CENTS } from '@aeci/shared/entitlements';

import { Analytics, type PlanCtaPlacement } from '../analytics/analytics';
import { formatPlanPrice, planLabel } from '../vendor/vendor-plan';

/** The contact page, asked about Managed. */
export const MANAGED_CONTACT_PATH = '/contact';
export const MANAGED_CONTACT_QUERY = { topic: 'managed' } as const;

/** Where "Claim your listing" points. */
export const CLAIM_PATH = '/docs/vendors/claiming-your-listing';

/**
 * Marks a full call to action, so the phone bar can hide while one is on
 * screen. The two hosts spell it out literally, because `host` keys must be.
 */
export const PLANS_CTA_ATTR = 'data-plans-cta';

/** `$25 a month per product`, from the list price. */
function managedPriceLine(locale: string): string {
  const amount = formatPlanPrice(MANAGED_LIST_PRICE_CENTS, locale);
  return $localize`:@@app.docs.plans.cta.priceLine:${amount}:AMOUNT: a month per product`;
}

/** Records a click. Shared so every placement reports the same shape. */
abstract class PlanCta {
  private readonly analytics = inject(Analytics);
  protected readonly contactPath = MANAGED_CONTACT_PATH;
  protected readonly contactQuery = MANAGED_CONTACT_QUERY;
  protected readonly claimPath = CLAIM_PATH;

  protected track(plan: 'free' | 'managed', placement: PlanCtaPlacement): void {
    this.analytics.planCtaClicked({ plan, placement });
  }
}

/** The button row under the intro (`placement: top`). */
@Component({
  selector: 'app-docs-plans-actions',
  imports: [RouterLink],
  host: { class: 'block', 'data-plans-cta': 'top' },
  template: `
    <div class="flex flex-col gap-3 sm:flex-row sm:items-center">
      <a
        [routerLink]="contactPath"
        [queryParams]="contactQuery"
        (click)="track('managed', 'top')"
        class="inline-flex items-center justify-center rounded-(--radius-md) bg-(--accent-primary) px-5 py-3 text-base font-semibold text-(--surface-base) no-underline hover:bg-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
        i18n="@@app.docs.plans.cta.managed"
        >Talk to us about Managed</a
      >
      <a
        [routerLink]="claimPath"
        (click)="track('free', 'top')"
        class="inline-flex items-center justify-center rounded-(--radius-md) border border-(--border-default) bg-(--surface-base) px-5 py-3 text-base font-medium text-(--text-primary) no-underline hover:bg-(--surface-muted) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
        i18n="@@app.docs.plans.cta.claimFree"
        >Claim your listing free</a
      >
    </div>
  `,
})
export class DocsPlansActionsComponent extends PlanCta {}

/** The full-width Forest panel in "Getting Managed" (`placement: bottom`). */
@Component({
  selector: 'app-docs-plans-cta-panel',
  imports: [RouterLink],
  host: { class: 'block', 'data-plans-cta': 'bottom' },
  template: `
    <section
      class="rounded-(--radius-lg) bg-(--accent-primary) px-6 py-7 text-(--surface-base) sm:px-8"
      aria-labelledby="plans-cta-heading"
    >
      <h3 id="plans-cta-heading" class="aec-plan-cta-heading" i18n="@@app.docs.plans.cta.heading">
        Tell the full story of your product
      </h3>
      <p class="mt-2 max-w-[34rem] leading-relaxed">
        <span i18n="@@app.docs.plans.cta.terms"
          >{{ price }}, billed by invoice or purchase order.</span
        >
        {{ ' ' }}
        <span i18n="@@app.docs.plans.cta.safety"
          >If a plan ends, nothing you entered is removed.</span
        >
      </p>
      <a
        [routerLink]="contactPath"
        [queryParams]="contactQuery"
        (click)="track('managed', 'bottom')"
        class="mt-5 inline-flex w-full items-center justify-center rounded-(--radius-md) bg-(--surface-base) px-6 py-3.5 text-base font-semibold text-(--accent-primary) no-underline hover:bg-(--accent-warm) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--surface-base) sm:w-auto"
        i18n="@@app.docs.plans.cta.managed"
        >Talk to us about Managed</a
      >
      <ol class="mt-5 space-y-1.5 text-sm">
        <li class="flex gap-2">
          <span class="font-semibold" aria-hidden="true">1.</span>
          <span i18n="@@app.docs.plans.cta.step1">We agree the price and the term with you.</span>
        </li>
        <li class="flex gap-2">
          <span class="font-semibold" aria-hidden="true">2.</span>
          <span i18n="@@app.docs.plans.cta.step2"
            >We switch Managed on, and everyone with a seat sees it in the portal.</span
          >
        </li>
      </ol>
    </section>
  `,
})
export class DocsPlansCtaPanelComponent extends PlanCta {
  protected readonly price = managedPriceLine(inject(LOCALE_ID));
}

/** The small sticky card under the rail's dashes (`placement: rail`). */
@Component({
  selector: 'app-docs-plans-rail',
  imports: [RouterLink],
  host: { class: 'block' },
  template: `
    <aside class="aec-plan-card p-4" aria-labelledby="plans-rail-heading">
      <p id="plans-rail-heading" class="text-sm font-semibold text-(--text-primary)">
        {{ managedName }}
      </p>
      <p class="mt-1 text-xs leading-snug text-(--text-secondary)">{{ price }}</p>
      <a
        [routerLink]="contactPath"
        [queryParams]="contactQuery"
        (click)="track('managed', 'rail')"
        class="mt-3 flex items-center justify-center rounded-(--radius-md) bg-(--accent-primary) px-3 py-2 text-sm font-semibold text-(--surface-base) no-underline hover:bg-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
        i18n="@@app.docs.plans.cta.short"
        >Talk to us</a
      >
    </aside>
  `,
})
export class DocsPlansRailComponent extends PlanCta {
  protected readonly managedName = planLabel('managed');
  protected readonly price = managedPriceLine(inject(LOCALE_ID));
}

/**
 * The slim bar fixed to the bottom of a phone screen (`placement: mobile_bar`).
 * Hidden in the SSR HTML. In the browser it shows once the top row has
 * scrolled above the screen and no full call to action is on screen. While it
 * shows, the page reserves its height (`scroll-padding-bottom`), so a focused
 * link is never hidden under it (WCAG 2.2, 2.4.11).
 */
@Component({
  selector: 'app-docs-plans-mobile-bar',
  imports: [RouterLink],
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
          <a
            [routerLink]="contactPath"
            [queryParams]="contactQuery"
            (click)="track('managed', 'mobile_bar')"
            class="shrink-0 rounded-(--radius-md) bg-(--accent-primary) px-4 py-2.5 text-sm font-semibold text-(--surface-base) no-underline hover:bg-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
            i18n="@@app.docs.plans.cta.short"
            >Talk to us</a
          >
        </div>
      </div>
    }
  `,
})
export class DocsPlansMobileBarComponent extends PlanCta {
  private readonly document = inject(DOCUMENT);
  protected readonly managedName = planLabel('managed');
  protected readonly price = managedPriceLine(inject(LOCALE_ID));
  protected readonly visible = signal(false);

  /** Room the bar takes, reserved while it shows. */
  private static readonly RESERVE = '5rem';

  private readonly destroyRef = inject(DestroyRef);

  constructor() {
    super();
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
        const show = (phone?.matches ?? true) && topPassed && onScreen.size === 0;
        this.visible.set(show);
        // Reserve the bar's height: focus never lands under it, and the end of
        // the page can still scroll clear of it.
        root.style.scrollPaddingBottom = show ? DocsPlansMobileBarComponent.RESERVE : '';
        this.document.body.style.paddingBottom = show ? DocsPlansMobileBarComponent.RESERVE : '';
      };
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
        observer.disconnect();
        phone?.removeEventListener('change', apply);
        root.style.scrollPaddingBottom = '';
        this.document.body.style.paddingBottom = '';
      });
    });
  }
}
