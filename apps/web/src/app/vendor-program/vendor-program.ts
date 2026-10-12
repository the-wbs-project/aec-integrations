/**
 * The public vendor landing page (`/vendor-program`). Governed by
 * `docs/VENDOR_PROGRAM_PAGE_SPEC.md`: §2 owns this file's route, caching and meta
 * (AECI-1283), §3 the sections and §8 the copy (AECI-1284), §4 the calls to action
 * (AECI-1285), §5 the signed-in variants (AECI-1286), §6 Find your product
 * (AECI-1287, `vendor-program-find.ts`).
 *
 * **Sections, in the §3 order.** One `h1` in the hero, then one `h2` per section:
 * the problem, Find your product, what Free gives you, what Managed adds, the plan
 * cards, how listings are sorted, coming soon, the FAQ, and the closing panel.
 *
 * **One source for the docs wording.** The Free, Managed, sort-rule and Coming
 * soon copy comes from the vendor guide's Plans page
 * (`src/content/docs/vendors/plans.md`). That page is Markdown, not i18n'd, so the
 * sentences are copied here verbatim and `vendor-program-copy.component.spec.ts`
 * fails when either side drifts. The sort rule is the one string both pages already
 * share as an i18n id (`@@app.docs.plans.sortRule`). The plan cards are the shared
 * `aec-plan-cards`, never a copy.
 *
 * **Calls to action (§4.1).** The hero pair (`top`), the plan cards (`card`), Find
 * your product (`search_result`), the rail (`rail`, desktop, shown once the hero has
 * scrolled away), the phone bar (`mobile_bar`) and the closing panel (`bottom`).
 * Every claim link points at `#find-your-product` through `claimPath` +
 * `claimFragment`, never a bare `#id` (the `<base href>` trap). The plan cards carry
 * `data-plans-cta`, so the phone bar also hides while they are on screen. Exactly one
 * `aec-plan-inquiry-host`.
 *
 * **Static + edge-cached + SSR-safe.** No data fetch and no per-visitor state in the
 * HTML: `/vendor-program` carries `Cache-Tag: route:index` on the `/about` TTLs.
 * The signed-in variants (§5) read `VendorPlanStatus`, which is `null` throughout
 * SSR, and are applied only after the first browser render (`hydrated`), so the
 * server HTML is the signed-out page for every visitor:
 *
 *  - a vendor seat: every "Claim your listing free" becomes "Go to your portal";
 *  - a Managed company: also no rail, no phone bar, no Managed button in the panel.
 *
 * Copy rules (§8): sentence case, no em dashes, no statistics, "may already be
 * listed", and nothing that suggests a plan affects ranking, placement, review
 * publication or agreement labels. Light theme only. Every string is i18n'd.
 *
 * Mobbin anchor: **Mintlify**. The hero follows its marketing home (screen
 * `4cc8ee93-cf4e-4b9f-a905-8e11b2b9da9e`: a left-aligned serif headline, one line
 * of lede, a filled and an outlined button side by side). The plan cards already
 * follow its billing page (`c74405c6-a307-4e35-b8eb-21a1129ce5f3`).
 */
import {
  Component,
  DestroyRef,
  PLATFORM_ID,
  type ElementRef,
  afterNextRender,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { NgTemplateOutlet, isPlatformBrowser } from '@angular/common';
import { RouterLink } from '@angular/router';

import { canonicalUrl } from '../core/canonical';
import { VENDOR_PROGRAM_OG_IMAGE } from '../core/meta.helpers';
import { MetaService } from '../core/meta.service';
import { PlanCardsComponent } from '../shared/plan-cta/plan-cards';
import {
  PlanCtaActionsComponent,
  PlanCtaMobileBarComponent,
  PlanCtaPanelComponent,
  PlanCtaRailComponent,
} from '../shared/plan-cta/plan-cta';
import { PlanInquiryHost } from '../shared/plan-inquiry/plan-inquiry-host';
import { VendorPlanStatus } from '../vendor/vendor-plan-status';
import { VendorProgramFind } from './vendor-program-find';

/** Where every claim link on this page goes: its own Find your product section. */
export const VENDOR_PROGRAM_PATH = '/vendor-program';
export const FIND_YOUR_PRODUCT = 'find-your-product';

/** The Plans page, for the Managed lines with no page of their own. */
const PLANS_PATH = '/docs/vendors/plans';

@Component({
  selector: 'aec-vendor-program',
  imports: [
    NgTemplateOutlet,
    RouterLink,
    PlanCardsComponent,
    PlanCtaActionsComponent,
    PlanCtaMobileBarComponent,
    PlanCtaPanelComponent,
    PlanCtaRailComponent,
    PlanInquiryHost,
    VendorProgramFind,
  ],
  template: `
    <div class="bg-(--surface-base) text-(--text-primary)">
      <!-- 1. Hero. Both calls to action, on the first screen at 375px. -->
      <section #hero class="border-b border-(--border-default) bg-(--accent-warm)">
        <div class="mx-auto max-w-7xl px-6 py-12 md:px-8 md:py-20">
          <div class="max-w-[70ch]">
            <h1
              class="font-display text-4xl font-normal text-balance leading-[1.1] tracking-[-0.01em] text-(--text-primary) md:text-5xl"
              i18n="@@app.vendorProgram.headline"
            >
              Contractors compare your integrations here
            </h1>
            <p
              class="mt-4 max-w-[52ch] text-base leading-relaxed text-(--text-secondary) md:mt-5 md:text-lg"
              i18n="@@app.vendorProgram.lede"
            >
              A listing on AEC Integrations is free to claim. Claim yours to keep what buyers read
              about your products and integrations accurate.
            </p>
            <aec-plan-cta-actions
              class="mt-6 md:mt-8"
              page="vendor_program"
              [claimPath]="claimPath"
              [claimFragment]="claimFragment"
              [portal]="portal()"
            />
          </div>
        </div>
      </section>

      <div class="mx-auto max-w-7xl px-6 py-14 md:px-8 md:py-20">
        <div class="lg:grid lg:grid-cols-[minmax(0,1fr)_13rem] lg:gap-16">
          <div class="flex min-w-0 flex-col gap-16 md:gap-20">
            <!-- 2. The problem. -->
            <section id="vp-problem" aria-labelledby="vp-problem-heading" class="max-w-[52ch]">
              <h2 id="vp-problem-heading" i18n="@@vendorProgram.problem.heading">
                What buyers read about you
              </h2>
              <p class="mt-4 text-lg leading-relaxed" i18n="@@vendorProgram.problem.body">
                AEC Integrations compiles its listings from public sources, so your products may
                already be listed. Buyers compare your integrations on that listing, whether or not
                you wrote it. Claiming it lets you keep it accurate.
              </p>
            </section>

            <!-- 3. Find your product (spec section 6). Every claim link lands here. -->
            <section id="find-your-product" aria-labelledby="vp-find-heading" class="scroll-mt-24">
              <aec-vendor-program-find />
            </section>

            <!-- 4. What Free gives you: the Plans page's "What every plan includes". -->
            <section id="vp-free" aria-labelledby="vp-free-heading">
              <h2 id="vp-free-heading" i18n="@@vendorProgram.free.heading">What Free gives you</h2>
              <p
                class="mt-3 max-w-[56ch] leading-relaxed text-(--text-secondary)"
                i18n="@@vendorProgram.free.lede"
              >
                Free costs nothing. Anyone with a seat at your company can:
              </p>
              <ul class="mt-6 grid gap-x-10 md:grid-cols-2" role="list">
                <li class="border-t border-(--border-default) py-4">
                  <p class="font-semibold" i18n="@@vendorProgram.free.details.title">
                    Your company and products
                  </p>
                  <p
                    class="mt-1 leading-relaxed text-(--text-secondary)"
                    i18n="@@vendorProgram.free.details.body"
                  >
                    Keep your company details current: the description, website, headquarters, logo
                    and contact links. Keep each product's description, website, logo and categories
                    current.
                  </p>
                </li>
                <li class="border-t border-(--border-default) py-4">
                  <p class="font-semibold" i18n="@@vendorProgram.free.integrations.title">
                    Your integrations
                  </p>
                  <p
                    class="mt-1 leading-relaxed text-(--text-secondary)"
                    i18n="@@vendorProgram.free.integrations.body"
                  >
                    Claim and maintain the integrations your company builds, add your own links, and
                    contest a detail on one you do not own.
                  </p>
                </li>
                <li class="border-t border-(--border-default) py-4">
                  <p class="font-semibold" i18n="@@vendorProgram.free.seats.title">
                    Your colleagues
                  </p>
                  <p
                    class="mt-1 leading-relaxed text-(--text-secondary)"
                    i18n="@@vendorProgram.free.seats.body"
                  >
                    Invite colleagues and manage seats. See
                    <a routerLink="/docs/vendors/your-seat" [class]="inTextLink">Your seat</a>.
                  </p>
                </li>
                <li class="border-t border-(--border-default) py-4">
                  <p class="font-semibold" i18n="@@vendorProgram.free.checklists.title">
                    Your checklists
                  </p>
                  <p
                    class="mt-1 leading-relaxed text-(--text-secondary)"
                    i18n="@@vendorProgram.free.checklists.body"
                  >
                    Work through the company and product checklists. See
                    <a routerLink="/docs/vendors/checklists" [class]="inTextLink">Your checklists</a
                    >.
                  </p>
                </li>
              </ul>
            </section>

            <!-- 5. What Managed adds: the Plans page's list, one line each, each
                 linked to the page that explains it. -->
            <section id="vp-managed" aria-labelledby="vp-managed-heading">
              <h2 id="vp-managed-heading" i18n="@@vendorProgram.managed.heading">
                What Managed adds
              </h2>
              <p
                class="mt-3 max-w-[56ch] leading-relaxed text-(--text-secondary)"
                i18n="@@vendorProgram.managed.lede"
              >
                Managed lets you tell the full story: how teams use each product, which trades and
                phases it serves, and which data flows you confirm.
              </p>
              <ul class="mt-6 max-w-[56ch]" role="list">
                <li class="border-t border-(--border-default) py-4 leading-relaxed">
                  <ng-container i18n="@@vendorProgram.managed.usefulness">
                    <a
                      [routerLink]="plansPath"
                      fragment="what-managed-adds"
                      [class]="inTextLinkStrong"
                      >How teams use it.</a
                    >
                    Show buyers, in your own words, what your product does on a real project.
                  </ng-container>
                </li>
                <li class="border-t border-(--border-default) py-4 leading-relaxed">
                  <ng-container i18n="@@vendorProgram.managed.taxonomy">
                    <a routerLink="/docs/getting-started/taxonomy" [class]="inTextLinkStrong"
                      >Trades, audiences and phases.</a
                    >
                    Set the trades, audiences and project phases each product serves, so its listing
                    describes it accurately.
                  </ng-container>
                </li>
                <li class="border-t border-(--border-default) py-4 leading-relaxed">
                  <ng-container i18n="@@vendorProgram.managed.links">
                    <a
                      [routerLink]="plansPath"
                      fragment="what-managed-adds"
                      [class]="inTextLinkStrong"
                      >Integrations page and API docs links.</a
                    >
                    Send evaluators straight from your listing to your docs.
                  </ng-container>
                </li>
                <li class="border-t border-(--border-default) py-4 leading-relaxed">
                  <ng-container i18n="@@vendorProgram.managed.dataFlows">
                    <a
                      routerLink="/docs/vendors/attesting-an-integration"
                      [class]="inTextLinkStrong"
                      >Confirmed data flows.</a
                    >
                    Say which data moves in each of your integrations. Your answer counts toward the
                    integration's agreement label, the same as your partner's.
                  </ng-container>
                </li>
                <li class="border-t border-(--border-default) py-4 leading-relaxed">
                  <ng-container i18n="@@vendorProgram.managed.connector">
                    <a routerLink="/docs/vendors/owning-an-integration" [class]="inTextLinkStrong"
                      >Connector integrations.</a
                    >
                    Claim, edit, retire and restore the integrations you deliver through a
                    connector, not only the ones you built directly.
                  </ng-container>
                </li>
                <li class="border-t border-(--border-default) py-4 leading-relaxed">
                  <ng-container i18n="@@vendorProgram.managed.replies">
                    <a routerLink="/docs/vendors/replying-to-reviews" [class]="inTextLinkStrong"
                      >Review replies.</a
                    >
                    Answer reviews of your products in public, so buyers see your side. We check
                    each reply before it goes live.
                  </ng-container>
                </li>
                <li class="border-y border-(--border-default) py-4 leading-relaxed">
                  <ng-container i18n="@@vendorProgram.managed.indexNow">
                    <a
                      [routerLink]="plansPath"
                      fragment="what-managed-adds"
                      [class]="inTextLinkStrong"
                      >Search engine notice.</a
                    >
                    We tell search engines each time you update a public page. Telling a search
                    engine about a page does not decide whether it crawls, indexes or ranks that
                    page.
                  </ng-container>
                </li>
              </ul>
            </section>

            <!-- 6. The plan cards (shared with the Plans page). -->
            <section id="vp-plans" aria-labelledby="vp-plans-heading">
              <h2 id="vp-plans-heading" i18n="@@vendorProgram.plans.heading">Free and Managed</h2>
              <aec-plan-cards
                class="mt-6"
                data-plans-cta="card"
                page="vendor_program"
                claimLabel="free"
                [claimPath]="claimPath"
                [claimFragment]="claimFragment"
                [portal]="portal()"
              />
              <p class="mt-4 text-sm text-(--text-secondary)">
                <a
                  [routerLink]="plansPath"
                  fragment="compare-plans"
                  class="rounded-(--radius-sm) underline decoration-(--border-strong) underline-offset-4 hover:text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                  i18n="@@vendorProgram.plans.compare"
                  >Compare every feature side by side</a
                >
              </p>
            </section>

            <!-- 7. How listings are sorted: the reason buyers trust the order. -->
            <section
              id="vp-sorting"
              aria-labelledby="vp-sorting-heading"
              class="rounded-(--radius-lg) bg-(--accent-warm) px-6 py-8 sm:px-8"
            >
              <h2 id="vp-sorting-heading" i18n="@@vendorProgram.sorting.heading">
                How listings are sorted
              </h2>
              <p class="mt-4 max-w-[52ch] text-lg leading-relaxed" i18n="@@app.docs.plans.sortRule">
                Every listing is sorted the same way: how well it matches the search, then how
                complete it is. Your plan is not part of that.
              </p>
              <p
                class="mt-3 max-w-[56ch] leading-relaxed text-(--text-secondary)"
                i18n="@@vendorProgram.sorting.trust"
              >
                That is why buyers trust the order they see. Your plan also never decides whether a
                review is published or removed, whether a listing exists, or how an agreement label
                is worked out.
              </p>
              <p class="mt-5">
                <a
                  routerLink="/docs/trust/how-ranking-works"
                  [class]="inTextLinkStrong"
                  i18n="@@vendorProgram.sorting.link"
                  >How ranking works</a
                >
              </p>
            </section>

            <!-- 8. Coming soon: the one labelled exception to "only what ships". -->
            <section id="vp-coming-soon" aria-labelledby="vp-coming-soon-heading">
              <div class="flex flex-wrap items-baseline gap-x-4 gap-y-2">
                <h2 id="vp-coming-soon-heading" i18n="@@vendorProgram.comingSoon.heading">
                  Coming soon
                </h2>
                <span
                  class="rounded-full border border-(--border-strong) px-2.5 py-0.5 text-xs font-medium text-(--text-secondary)"
                  i18n="@@vendorProgram.comingSoon.badge"
                  >Not available yet</span
                >
              </div>
              <p
                class="mt-4 max-w-[56ch] leading-relaxed text-(--text-secondary)"
                i18n="@@vendorProgram.comingSoon.body"
              >
                Performance reporting is coming to Managed. It will show how many people view your
                product and integration pages, how many click through to your website and docs, how
                often search engines and AI assistants visit, and a monthly report you can download.
                It reports attention only, and never changes where you rank or appear. It is not
                available yet.
              </p>
            </section>

            <!-- 9. FAQ, a native details list (no JS, indexable answers). -->
            <section id="vp-faq" aria-labelledby="vp-faq-heading">
              <h2 id="vp-faq-heading" i18n="@@vendorProgram.faq.heading">Questions vendors ask</h2>
              <div class="mt-6 max-w-[56ch] border-b border-(--border-default)">
                <details class="group border-t border-(--border-default)">
                  <summary [class]="summaryClass">
                    <span i18n="@@vendorProgram.faq.who.q">Who can claim a listing?</span>
                    <ng-container [ngTemplateOutlet]="chevron" />
                  </summary>
                  <p [class]="answerClass" i18n="@@vendorProgram.faq.who.a">
                    Anyone who works at the company that makes the product. You do not need an
                    account, and a claim costs nothing. A claim on a product is a claim on the
                    company that makes it, and the seat covers the whole company account. See
                    <a routerLink="/docs/vendors/claiming-your-listing" [class]="inTextLink"
                      >Claiming your vendor listing</a
                    >.
                  </p>
                </details>
                <details class="group border-t border-(--border-default)">
                  <summary [class]="summaryClass">
                    <span i18n="@@vendorProgram.faq.approval.q">How long does approval take?</span>
                    <ng-container [ngTemplateOutlet]="chevron" />
                  </summary>
                  <p [class]="answerClass" i18n="@@vendorProgram.faq.approval.a">
                    A person at AEC Integrations reads every claim. Nothing is granted
                    automatically. We review each claim and email the result to the address you
                    gave.
                  </p>
                </details>
                <details class="group border-t border-(--border-default)">
                  <summary [class]="summaryClass">
                    <span i18n="@@vendorProgram.faq.products.q"
                      >We make several products. Do we claim each one?</span
                    >
                    <ng-container [ngTemplateOutlet]="chevron" />
                  </summary>
                  <p [class]="answerClass" i18n="@@vendorProgram.faq.products.a">
                    No. One claim gives you a seat on your company's account, and it covers every
                    product your company makes. Managed is priced per product, and today every
                    product your company makes is on the same plan as your company.
                  </p>
                </details>
                <details class="group border-t border-(--border-default)">
                  <summary [class]="summaryClass">
                    <span i18n="@@vendorProgram.faq.billing.q"
                      >Can we pay by invoice or purchase order?</span
                    >
                    <ng-container [ngTemplateOutlet]="chevron" />
                  </summary>
                  <p [class]="answerClass" i18n="@@vendorProgram.faq.billing.a">
                    Yes. We bill Managed by invoice or purchase order. There is no card payment and
                    no online checkout. Free has nothing to pay.
                  </p>
                </details>
                <details class="group border-t border-(--border-default)">
                  <summary [class]="summaryClass">
                    <span i18n="@@vendorProgram.faq.ends.q"
                      >What happens when a Managed plan ends?</span
                    >
                    <ng-container [ngTemplateOutlet]="chevron" />
                  </summary>
                  <p [class]="answerClass" i18n="@@vendorProgram.faq.ends.a">
                    Your company moves to Free. Your seats, sign-in and portal stay. Nothing you
                    entered is removed, and your listings stay published. What Managed adds becomes
                    read-only. See
                    <a
                      [routerLink]="plansPath"
                      fragment="when-a-managed-plan-ends"
                      [class]="inTextLink"
                      >when a Managed plan ends</a
                    >.
                  </p>
                </details>
                <details class="group border-t border-(--border-default)">
                  <summary [class]="summaryClass">
                    <span i18n="@@vendorProgram.faq.ranking.q"
                      >Does paying affect our reviews or where we rank?</span
                    >
                    <ng-container [ngTemplateOutlet]="chevron" />
                  </summary>
                  <p [class]="answerClass" i18n="@@vendorProgram.faq.ranking.a">
                    No. Every listing is sorted the same way on every plan. Your plan never decides
                    whether a review is published or removed, whether a listing exists, or how an
                    agreement label is worked out. See
                    <a routerLink="/docs/trust/how-ranking-works" [class]="inTextLink"
                      >How ranking works</a
                    >.
                  </p>
                </details>
              </div>
            </section>

            <!-- 10. The closing panel, its own section (h2). -->
            <aec-plan-cta-panel
              page="vendor_program"
              [headingLevel]="2"
              [showClaim]="true"
              [claimPath]="claimPath"
              [claimFragment]="claimFragment"
              [portal]="portal()"
              [hideManaged]="hideManaged()"
            />
          </div>

          <!-- The rail (desktop): a small Managed card, shown once the hero has
               scrolled away. Hidden in the SSR HTML. -->
          <div class="hidden lg:block">
            <div
              class="sticky top-24 transition-opacity duration-200 motion-reduce:transition-none"
              [class.invisible]="!railShown()"
              [class.opacity-0]="!railShown()"
              data-testid="vp-rail"
            >
              <aec-plan-cta-rail page="vendor_program" [hideManaged]="hideManaged()" />
            </div>
          </div>
        </div>
      </div>

      <aec-plan-cta-mobile-bar page="vendor_program" [hideManaged]="hideManaged()" />
      <!-- One inquiry dialog for every Managed button on the page (AECI-1279). -->
      <aec-plan-inquiry-host />
    </div>

    <ng-template #chevron>
      <svg
        class="size-5 shrink-0 text-(--text-secondary) transition-transform duration-200 group-open:rotate-180 motion-reduce:transition-none"
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
    </ng-template>
  `,
})
export class VendorProgramPage {
  private readonly meta = inject(MetaService);
  private readonly planStatus = inject(VendorPlanStatus);
  private readonly destroyRef = inject(DestroyRef);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  protected readonly claimPath = VENDOR_PROGRAM_PATH;
  protected readonly claimFragment = FIND_YOUR_PRODUCT;
  protected readonly plansPath = PLANS_PATH;

  /** An in-text link (DESIGN.md, the Link Treatment Rule). */
  protected readonly inTextLink =
    'text-(--accent-primary) underline underline-offset-2 hover:text-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';
  /** The same, as the bold lead of a list line. */
  protected readonly inTextLinkStrong = `${this.inTextLink} font-semibold`;
  protected readonly summaryClass =
    'flex cursor-pointer list-none items-center justify-between gap-4 py-4 font-semibold text-(--text-primary) hover:text-(--accent-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) [&::-webkit-details-marker]:hidden';
  protected readonly answerClass = 'pb-5 leading-relaxed text-(--text-secondary)';

  /** True after the first browser render. Never true on the server. */
  private readonly hydrated = signal(false);

  /** A signed-in vendor seat (spec §5): claim links become "Go to your portal". */
  protected readonly portal = computed(
    () => this.hydrated() && this.planStatus.vendorSlug() !== null,
  );
  /** A Managed company (spec §5): no rail, no phone bar, no Managed button in the panel. */
  protected readonly hideManaged = computed(
    () => this.hydrated() && this.planStatus.managed() === true,
  );

  /** The rail shows once the hero has scrolled above the screen (spec §4.1). */
  protected readonly railShown = signal(false);
  private readonly hero = viewChild.required<ElementRef<HTMLElement>>('hero');

  constructor() {
    this.meta.setStaticPageMeta({
      title: $localize`:@@meta.vendorProgramTitle:List your AEC software for free · AEC Integrations`,
      description: $localize`:@@meta.vendorProgramDescription:Claim your free listing in the AEC software directory. Keep your products and construction software integrations accurate where AEC teams compare them.`,
      canonical: canonicalUrl('/vendor-program'),
      ogImage: VENDOR_PROGRAM_OG_IMAGE,
      ogImageAlt: $localize`:@@meta.vendorProgramOgImageAlt:AEC Integrations for software vendors: contractors compare your integrations here. Your listing is free to claim.`,
    });

    // Browser only: the signed-in variants and the rail never touch the SSR HTML.
    afterNextRender(() => {
      if (!this.isBrowser) return;
      this.hydrated.set(true);
      if (typeof IntersectionObserver === 'undefined') return;
      const observer = new IntersectionObserver(([entry]) => {
        if (!entry) return;
        this.railShown.set(!entry.isIntersecting && entry.boundingClientRect.bottom < 0);
      });
      observer.observe(this.hero().nativeElement);
      this.destroyRef.onDestroy(() => observer.disconnect());
    });
  }
}
