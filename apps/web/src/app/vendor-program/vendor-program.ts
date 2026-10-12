/**
 * The public vendor landing page (`/vendor-program`). Governed by
 * `docs/VENDOR_PROGRAM_PAGE_SPEC.md`: §2 owns this file's route, caching and meta
 * (AECI-1283), §3 the sections and §8 the copy (AECI-1284), §4 the calls to action
 * (AECI-1285), §5 the signed-in variants (AECI-1286), §6 Find your product
 * (AECI-1287, `vendor-program-find.ts`).
 *
 * **Sections, in the §3 order.** One `h1` in the hero, then one `h2` per section:
 * what changes when you claim, Find your product, what a free claim gets you, what
 * Managed adds, the plan cards, how listings are sorted, coming soon, the FAQ, and
 * the closing panel.
 *
 * **This page carries its own benefit copy (ruling 2026-10-12).** The vendor
 * guide's Plans page (`src/content/docs/vendors/plans.md`) stays the feature
 * reference. Here each Free and Managed line says what you can do, then what your
 * company gains, then what the buyer or the person using the integration gains. The
 * facts stay aligned with the docs, not the sentences. Two things stay shared: the
 * plan cards (`aec-plan-cards`, never a copy) and the sort rule, one i18n id on both
 * pages (`@@app.docs.plans.sortRule`). `vendor-program-copy.component.spec.ts` pins
 * only those, plus the Plans page fragments this page links to.
 *
 * **What changes when you claim** draws both labels with the listing's own
 * `aec-maintenance-marker`, so the page can never show wording a listing does not.
 *
 * **Doc links open in a new tab (ruling 2026-10-12).** Every link to `/docs/*`, and
 * "View the listing" in Find your product, carries `target="_blank" rel="noopener"`
 * and `aec-new-tab-icon` (the drawn cue plus the sr-only "(opens in a new tab)").
 * A `routerLink` with a `target` builds the same absolute `/docs/...` href and lets
 * the browser open it, so `<base href>` does not touch it. Conversion links stay in
 * the tab: every claim link, the Managed inquiry, "Ask us to add it" and "Go to your
 * portal".
 *
 * **Calls to action (§4.1).** The hero pair (`top`), the plan cards (`card`), Find
 * your product (`search_result`), the phone bar (`mobile_bar`) and the closing panel
 * (`bottom`). No rail on this page: it would reserve an empty column beside every
 * section (2026-10-12). The docs Plans page keeps its rail.
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
 *  - a Managed company: also no phone bar, no Managed button in the panel.
 *
 * **Full width at desktop (§11).** Every section uses the whole `max-w-7xl`
 * container from `lg`: a 12-column split (heading left, content right), a 3-column
 * Free grid, three Managed jobs in 2-column lists, the plan cards side by side, a
 * split Bone panel and a split closing panel. No narrow column with a blank right half.
 * Paragraphs keep a readable measure inside their column. Phones stay one column.
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
  LOCALE_ID,
  PLATFORM_ID,
  afterNextRender,
  computed,
  inject,
  signal,
} from '@angular/core';
import { NgTemplateOutlet, isPlatformBrowser } from '@angular/common';
import { RouterLink } from '@angular/router';

import { canonicalUrl } from '../core/canonical';
import { VENDOR_PROGRAM_OG_IMAGE } from '../core/meta.helpers';
import { MetaService } from '../core/meta.service';
import { MaintenanceMarker } from '../shared/maintenance-marker/maintenance-marker';
import { NewTabIcon } from '../shared/new-tab-icon/new-tab-icon';
import { PlanCardsComponent } from '../shared/plan-cta/plan-cards';
import {
  PlanCtaActionsComponent,
  PlanCtaMobileBarComponent,
  PlanCtaPanelComponent,
  managedTermsLine,
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
    MaintenanceMarker,
    NewTabIcon,
    PlanCardsComponent,
    PlanCtaActionsComponent,
    PlanCtaMobileBarComponent,
    PlanCtaPanelComponent,
    PlanInquiryHost,
    VendorProgramFind,
  ],
  template: `
    <div class="bg-(--surface-base) text-(--text-primary)">
      <!-- 1. Hero. Both calls to action, on the first screen at 375px. From lg the
           copy takes the left seven columns and how claiming works the right five. -->
      <section class="border-b border-(--border-default) bg-(--accent-warm)">
        <div
          class="mx-auto max-w-7xl px-6 py-12 md:px-8 md:py-20 lg:grid lg:grid-cols-12 lg:items-center lg:gap-x-12"
        >
          <div class="lg:col-span-7">
            <h1
              class="font-display text-3xl font-normal text-balance leading-[1.1] tracking-[-0.01em] text-(--text-primary) sm:text-4xl md:text-5xl"
              i18n="@@app.vendorProgram.headline"
            >
              Your products may already be listed here. Make sure buyers read your version.
            </h1>
            <p
              class="mt-4 max-w-[52ch] text-base leading-relaxed text-(--text-secondary) md:mt-5 md:text-lg"
              i18n="@@app.vendorProgram.lede"
            >
              AEC Integrations lists AEC software and its integrations from public sources. Claiming
              your listing is free. Keep it current, and it reads "Vendor maintained" with the date
              you last updated it.
            </p>
            <aec-plan-cta-actions
              class="mt-6 md:mt-8"
              page="vendor_program"
              [claimPath]="claimPath"
              [claimFragment]="claimFragment"
              [portal]="portal()"
            />
          </div>
          <div
            class="hidden rounded-(--radius-lg) border border-(--border-default) bg-(--surface-base) p-6 lg:col-span-5 lg:block xl:p-8"
            data-testid="vp-how"
          >
            <p
              id="vp-how-heading"
              class="font-semibold text-(--text-primary)"
              i18n="@@vendorProgram.how.heading"
            >
              How claiming works
            </p>
            <ol class="mt-5 space-y-5" aria-labelledby="vp-how-heading">
              <li class="flex gap-4">
                <span [class]="stepNumber" aria-hidden="true">1</span>
                <div>
                  <p class="font-semibold" i18n="@@vendorProgram.how.find.title">
                    Find your product
                  </p>
                  <p
                    class="mt-0.5 leading-relaxed text-(--text-secondary)"
                    i18n="@@vendorProgram.how.find.body"
                  >
                    Search for your product or your company on this page.
                  </p>
                </div>
              </li>
              <li class="flex gap-4">
                <span [class]="stepNumber" aria-hidden="true">2</span>
                <div>
                  <p class="font-semibold" i18n="@@vendorProgram.how.claim.title">
                    Claim the listing
                  </p>
                  <p
                    class="mt-0.5 leading-relaxed text-(--text-secondary)"
                    i18n="@@vendorProgram.how.claim.body"
                  >
                    A claim costs nothing and needs no account.
                  </p>
                </div>
              </li>
              <li class="flex gap-4">
                <span [class]="stepNumber" aria-hidden="true">3</span>
                <div>
                  <p class="font-semibold" i18n="@@vendorProgram.how.review.title">We review it</p>
                  <p
                    class="mt-0.5 leading-relaxed text-(--text-secondary)"
                    i18n="@@vendorProgram.how.review.body"
                  >
                    A person at AEC Integrations reads every claim and emails you the result.
                  </p>
                </div>
              </li>
            </ol>
          </div>
        </div>
      </section>

      <div class="mx-auto max-w-7xl px-6 py-14 md:px-8 md:py-20">
        <div class="flex min-w-0 flex-col gap-16 md:gap-20">
          <!-- 2. What changes when you claim: the two labels a listing really shows,
               drawn by the listing's own maintenance marker so they cannot drift. -->
          <section id="vp-what-changes" aria-labelledby="vp-what-changes-heading" [class]="split">
            <div class="lg:col-span-5">
              <h2 id="vp-what-changes-heading" i18n="@@vendorProgram.whatChanges.heading">
                What changes when you claim
              </h2>
              <p
                class="mt-3 max-w-[56ch] leading-relaxed text-(--text-secondary)"
                i18n="@@vendorProgram.whatChanges.lede"
              >
                Buyers compare your integrations on your listing, whether or not you wrote it. Every
                listing says who keeps it up to date. Here is the label buyers see today, and the
                one they see once you take it over.
              </p>
            </div>
            <ul class="grid gap-4 sm:grid-cols-2 lg:col-span-7" role="list">
              <li
                class="rounded-(--radius-lg) border border-(--border-default) p-5"
                data-testid="vp-before"
              >
                <p
                  class="aec-overline text-(--text-secondary)"
                  i18n="@@vendorProgram.whatChanges.before.label"
                >
                  Before you claim
                </p>
                <aec-maintenance-marker class="mt-3 block" maintainedBy="aeci" />
                <p
                  class="mt-3 leading-relaxed text-(--text-secondary)"
                  i18n="@@vendorProgram.whatChanges.before.body"
                >
                  We wrote it from public sources. Buyers cannot tell whether your company has seen
                  it.
                </p>
              </li>
              <li
                class="rounded-(--radius-lg) border border-(--border-default) p-5"
                data-testid="vp-after"
              >
                <p
                  class="aec-overline text-(--text-secondary)"
                  i18n="@@vendorProgram.whatChanges.after.label"
                >
                  Once you claim and update it
                </p>
                <aec-maintenance-marker
                  class="mt-3 block"
                  maintainedBy="vendor"
                  [reviewedAt]="exampleUpdatedAt"
                />
                <p
                  class="mt-3 leading-relaxed text-(--text-secondary)"
                  i18n="@@vendorProgram.whatChanges.after.body"
                >
                  Save a change, or confirm a page is right, and the label moves to your company
                  with the date. Buyers can see you stand behind it, and when you last checked.
                </p>
              </li>
            </ul>
          </section>

          <!-- 3. Find your product (spec section 6). Every claim link lands here. -->
          <section id="find-your-product" aria-labelledby="vp-find-heading" class="scroll-mt-24">
            <aec-vendor-program-find />
          </section>

          <!-- 4. What a free claim gets you. This page's own benefit copy (spec section 3,
               2026-10-12): each line says what you can do, what your company gains, and what
               the buyer or the person using the integration gains. -->
          <section id="vp-free" aria-labelledby="vp-free-heading">
            <h2 id="vp-free-heading" i18n="@@vendorProgram.free.heading">
              What a free claim gets you
            </h2>
            <p
              class="mt-3 max-w-[56ch] leading-relaxed text-(--text-secondary)"
              i18n="@@vendorProgram.free.lede"
            >
              Everything here is on the free plan. Invite colleagues to share the work: each person
              gets
              <a
                routerLink="/docs/vendors/your-seat"
                target="_blank"
                rel="noopener"
                [class]="inTextLink"
                >their own seat<aec-new-tab-icon /></a
              >.
            </p>
            <ul class="mt-6 grid gap-x-10 lg:grid-cols-3 lg:gap-x-8" role="list">
              <li class="border-t border-(--border-default) py-4">
                <p class="font-semibold" i18n="@@vendorProgram.free.details.title">
                  Your listing, in your words
                </p>
                <p
                  class="mt-1 leading-relaxed text-(--text-secondary)"
                  i18n="@@vendorProgram.free.details.body"
                >
                  Keep your company and product details current: the description, website, logo and
                  categories. You decide what buyers read about you. They see a current page marked
                  "Vendor maintained", with the date you last updated it.
                  <a
                    routerLink="/docs/vendors/checklists"
                    target="_blank"
                    rel="noopener"
                    [class]="inTextLink"
                    >Your checklists<aec-new-tab-icon
                  /></a>
                  show what to fill in first.
                </p>
              </li>
              <li class="border-t border-(--border-default) py-4">
                <p class="font-semibold" i18n="@@vendorProgram.free.integrations.title">
                  Your integrations, owned by you
                </p>
                <p
                  class="mt-1 leading-relaxed text-(--text-secondary)"
                  i18n="@@vendorProgram.free.integrations.body"
                >
                  Claim the integrations your company builds, and add your setup guide to any
                  integration with your product. Buyers see who maintains each one. The person
                  setting it up on a project gets your guide from the integration page, not a
                  support ticket. If a partner's listing gets a detail of yours wrong, you can
                  contest it.
                </p>
              </li>
              <li class="border-t border-(--border-default) py-4">
                <p class="font-semibold" i18n="@@vendorProgram.free.complete.title">
                  A complete listing, at no cost
                </p>
                <p
                  class="mt-1 leading-relaxed text-(--text-secondary)"
                  i18n="@@vendorProgram.free.complete.body"
                >
                  When two listings match a search about equally well, the more complete one comes
                  first. Every detail that counts toward completeness can be filled in on the free
                  plan. That rule is the same for every listing, whatever its plan.
                </p>
              </li>
            </ul>
          </section>

          <!-- 5. What Managed adds: this page's own benefit copy in three jobs. Each bold
                 lead-in links to the docs page that explains it, in a new tab. -->
          <section
            id="vp-managed"
            aria-labelledby="vp-managed-heading"
            class="grid gap-6 lg:grid-cols-12 lg:gap-x-12"
          >
            <div class="lg:col-span-4">
              <h2 id="vp-managed-heading" i18n="@@vendorProgram.managed.heading">
                What Managed adds
              </h2>
              <p class="mt-3 max-w-[56ch] leading-relaxed text-(--text-secondary)">
                {{ terms }}
              </p>
            </div>
            <div class="flex flex-col gap-8 lg:col-span-8">
              <div>
                <h3 [class]="groupHeading" i18n="@@vendorProgram.managed.explain.heading">
                  Explain what your product does on a project
                </h3>
                <ul [class]="managedList" role="list">
                  <li [class]="managedItem">
                    <ng-container i18n="@@vendorProgram.managed.usefulness">
                      <a
                        [routerLink]="plansPath"
                        fragment="what-managed-adds"
                        target="_blank"
                        rel="noopener"
                        [class]="inTextLinkStrong"
                        >How teams use it.<aec-new-tab-icon
                      /></a>
                      Describe, in your own words, the work your product does on a real project.
                      Buyers judge fit by the job it does, not a feature list. The people who will
                      use it can picture it on their own project.
                    </ng-container>
                  </li>
                  <li [class]="managedItem">
                    <ng-container i18n="@@vendorProgram.managed.taxonomy">
                      <a
                        routerLink="/docs/getting-started/taxonomy"
                        target="_blank"
                        rel="noopener"
                        [class]="inTextLinkStrong"
                        >Trades, audiences and phases.<aec-new-tab-icon
                      /></a>
                      Set who each product is for and when in a project it is used, rather than
                      leave it to our reading of public sources. Buyers browsing a trade, audience
                      or phase page, or filtering a search by one, find the products tagged with it.
                      An MEP contractor filtering by trade sees the tools built for that trade.
                    </ng-container>
                  </li>
                </ul>
              </div>
              <div>
                <h3 [class]="groupHeading" i18n="@@vendorProgram.managed.backUp.heading">
                  Back up your integrations
                </h3>
                <ul [class]="managedList" role="list">
                  <li [class]="managedItem">
                    <ng-container i18n="@@vendorProgram.managed.integrationDetail">
                      <a
                        [routerLink]="plansPath"
                        fragment="what-managed-adds"
                        target="_blank"
                        rel="noopener"
                        [class]="inTextLinkStrong"
                        >More detailed information about integrations (additional URLs, data flow,
                        etc.).<aec-new-tab-icon
                      /></a>
                      Link evaluators straight to your integrations page and API docs, and say which
                      data moves in each of your integrations. Your answer counts the same as your
                      partner's. Buyers know what syncs before a project depends on it. See
                      <a
                        routerLink="/docs/vendors/attesting-an-integration"
                        target="_blank"
                        rel="noopener"
                        [class]="inTextLink"
                        >Attesting an integration<aec-new-tab-icon /></a
                      >.
                    </ng-container>
                  </li>
                  <li [class]="managedItem">
                    <ng-container i18n="@@vendorProgram.managed.connector">
                      <a
                        routerLink="/docs/vendors/owning-an-integration"
                        target="_blank"
                        rel="noopener"
                        [class]="inTextLinkStrong"
                        >Connector integrations.<aec-new-tab-icon
                      /></a>
                      Claim, edit, retire and restore the integrations you deliver through a
                      connector, not only the ones you built directly. Those listings stay as
                      current as your direct ones, so a team using one on a project reads up-to-date
                      details.
                    </ng-container>
                  </li>
                </ul>
              </div>
              <div>
                <h3 [class]="groupHeading" i18n="@@vendorProgram.managed.answer.heading">
                  Answer buyers in public
                </h3>
                <ul [class]="managedList" role="list">
                  <li [class]="managedItem">
                    <ng-container i18n="@@vendorProgram.managed.replies">
                      <a
                        routerLink="/docs/vendors/replying-to-reviews"
                        target="_blank"
                        rel="noopener"
                        [class]="inTextLinkStrong"
                        >Review replies.<aec-new-tab-icon
                      /></a>
                      Reply to reviews of your products, so buyers see your side and how you handle
                      a problem. Someone weighing a critical review reads your answer beside it. We
                      check each reply before it goes live.
                    </ng-container>
                  </li>
                </ul>
              </div>
            </div>
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
                target="_blank"
                rel="noopener"
                class="inline-flex items-center gap-1.5 rounded-(--radius-sm) underline decoration-(--border-strong) underline-offset-4 hover:text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
              >
                <span i18n="@@vendorProgram.plans.compare">Compare every feature side by side</span>
                <aec-new-tab-icon />
              </a>
            </p>
          </section>

          <!-- 7. How listings are sorted: the reason buyers trust the order. -->
          <section
            id="vp-sorting"
            aria-labelledby="vp-sorting-heading"
            class="grid gap-x-12 rounded-(--radius-lg) bg-(--accent-warm) px-6 py-8 sm:px-8 lg:grid-cols-12 lg:px-10 lg:py-10"
          >
            <div class="lg:col-span-6">
              <h2 id="vp-sorting-heading" i18n="@@vendorProgram.sorting.heading">
                How listings are sorted
              </h2>
              <p class="mt-4 max-w-[52ch] text-lg leading-relaxed" i18n="@@app.docs.plans.sortRule">
                Every listing is sorted the same way: how well it matches the search, then how
                complete it is. Your plan is not part of that.
              </p>
            </div>
            <div class="lg:col-span-6 lg:pt-1">
              <p
                class="mt-3 max-w-[56ch] leading-relaxed text-(--text-secondary) lg:mt-0"
                i18n="@@vendorProgram.sorting.trust"
              >
                That is why buyers trust the order they see. Your plan also never decides whether a
                review is published or removed, whether a listing exists, or how an agreement label
                is worked out.
              </p>
              <p class="mt-5">
                <a
                  routerLink="/docs/trust/how-ranking-works"
                  target="_blank"
                  rel="noopener"
                  [class]="inTextLinkStrong"
                >
                  <span i18n="@@vendorProgram.sorting.link">How ranking works</span>
                  <aec-new-tab-icon />
                </a>
              </p>
            </div>
          </section>

          <!-- 8. Coming soon: the one labelled exception to "only what ships". -->
          <section id="vp-coming-soon" aria-labelledby="vp-coming-soon-heading" [class]="split">
            <div class="flex flex-wrap items-baseline gap-x-4 gap-y-2 lg:col-span-5">
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
              class="max-w-[56ch] leading-relaxed text-(--text-secondary) lg:col-span-7 lg:max-w-none"
              i18n="@@vendorProgram.comingSoon.body"
            >
              Performance reporting is coming to Managed, so you can see whether your listing is
              working for you. It will show how many people view your product and integration pages,
              how many click through to your website and docs, and how often search engines and AI
              assistants visit. A monthly report you can download will let you share that with your
              team. It reports attention only, and never changes where you rank or appear. It is not
              available yet.
            </p>
          </section>

          <!-- 9. FAQ, a native details list (no JS, indexable answers). -->
          <section id="vp-faq" aria-labelledby="vp-faq-heading" [class]="split">
            <h2 id="vp-faq-heading" class="lg:col-span-5" i18n="@@vendorProgram.faq.heading">
              Questions vendors ask
            </h2>
            <div
              class="max-w-[56ch] border-b border-(--border-default) lg:col-span-7 lg:max-w-none"
            >
              <details class="group border-t border-(--border-default)">
                <summary [class]="summaryClass">
                  <span i18n="@@vendorProgram.faq.who.q">Who can claim a listing?</span>
                  <ng-container [ngTemplateOutlet]="chevron" />
                </summary>
                <p [class]="answerClass" i18n="@@vendorProgram.faq.who.a">
                  Anyone who works at the company that makes the product. You do not need an
                  account, and a claim costs nothing. A claim on a product is a claim on the company
                  that makes it, and the seat covers the whole company account. See
                  <a
                    routerLink="/docs/vendors/claiming-your-listing"
                    target="_blank"
                    rel="noopener"
                    [class]="inTextLink"
                    >Claiming your vendor listing<aec-new-tab-icon /></a
                  >.
                </p>
              </details>
              <details class="group border-t border-(--border-default)">
                <summary [class]="summaryClass">
                  <span i18n="@@vendorProgram.faq.approval.q">How long does approval take?</span>
                  <ng-container [ngTemplateOutlet]="chevron" />
                </summary>
                <p [class]="answerClass" i18n="@@vendorProgram.faq.approval.a">
                  Generally within 48 hours. A person at AEC Integrations reads every claim. Nothing
                  is granted automatically. We review each claim and email the result to the address
                  you gave.
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
                  product your company makes. Plans are per product, so each product can be on the
                  free plan or on Managed.
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
                  Yes. We bill paid plans by invoice or purchase order. Free plans require neither.
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
                  Your company moves to the free plan. Your seats, sign-in and portal stay. Nothing
                  you entered is removed, and your listings stay published. What Managed adds
                  becomes read-only. See
                  <a
                    [routerLink]="plansPath"
                    fragment="when-a-managed-plan-ends"
                    target="_blank"
                    rel="noopener"
                    [class]="inTextLink"
                    >when a Managed plan ends<aec-new-tab-icon /></a
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
                  <a
                    routerLink="/docs/trust/how-ranking-works"
                    target="_blank"
                    rel="noopener"
                    [class]="inTextLink"
                    >How ranking works<aec-new-tab-icon /></a
                  >.
                </p>
              </details>
            </div>
          </section>

          <!-- 10. The closing panel, its own section (h2). -->
          <aec-plan-cta-panel
            page="vendor_program"
            [headingLevel]="2"
            [split]="true"
            [showClaim]="true"
            [claimPath]="claimPath"
            [claimFragment]="claimFragment"
            [portal]="portal()"
            [hideManaged]="hideManaged()"
          />
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
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  protected readonly claimPath = VENDOR_PROGRAM_PATH;
  protected readonly claimFragment = FIND_YOUR_PRODUCT;
  protected readonly plansPath = PLANS_PATH;

  /**
   * An in-text link (DESIGN.md, the Link Treatment Rule). Every one on this page goes
   * to the docs in a new tab, so it carries `aec-new-tab-icon`: the `[&_svg]` rules
   * keep that icon inline in the running sentence instead of on its own line.
   */
  protected readonly inTextLink =
    'text-(--accent-primary) underline underline-offset-2 hover:text-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) [&_svg]:ms-1 [&_svg]:inline [&_svg]:align-[-0.125em]';
  /** The same, as the bold lead of a list line. */
  protected readonly inTextLinkStrong = `${this.inTextLink} font-semibold`;
  /** A Managed job: the small heading over its lines. */
  protected readonly groupHeading = 'text-base font-semibold text-(--text-primary)';
  protected readonly managedList = 'mt-2 grid gap-x-8 md:grid-cols-2';
  protected readonly managedItem = 'border-t border-(--border-default) py-4 leading-relaxed';
  /** `$25 a month per product, or $250 a year, billed by invoice or purchase order.` */
  protected readonly terms = managedTermsLine(inject(LOCALE_ID));
  /**
   * The date on the "after" label in What changes when you claim: today, in UTC, so
   * the example reads as "if you updated it today". The marker formats it in UTC, so
   * the server and the browser print the same day. It is not visitor state.
   */
  protected readonly exampleUpdatedAt = new Date().toISOString();
  protected readonly summaryClass =
    'flex cursor-pointer list-none items-center justify-between gap-4 py-4 font-semibold text-(--text-primary) hover:text-(--accent-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) [&::-webkit-details-marker]:hidden';
  protected readonly answerClass = 'max-w-[60ch] pb-5 leading-relaxed text-(--text-secondary)';
  /**
   * A section split from `lg`: the heading in the left five columns, the content in
   * the right seven, so no section leaves the right half of the page blank.
   */
  protected readonly split = 'grid gap-4 lg:grid-cols-12 lg:gap-x-12';
  /** The numbered disc of a step in the hero's "How claiming works". */
  protected readonly stepNumber =
    'flex size-7 shrink-0 items-center justify-center rounded-full bg-(--accent-primary) text-sm font-semibold text-(--surface-base)';

  /** True after the first browser render. Never true on the server. */
  private readonly hydrated = signal(false);

  /** A signed-in vendor seat (spec §5): claim links become "Go to your portal". */
  protected readonly portal = computed(
    () => this.hydrated() && this.planStatus.vendorSlug() !== null,
  );
  /** A Managed company (spec §5): no phone bar, no Managed button in the panel. */
  protected readonly hideManaged = computed(
    () => this.hydrated() && this.planStatus.managed() === true,
  );

  constructor() {
    this.meta.setStaticPageMeta({
      title: $localize`:@@meta.vendorProgramTitle:List your AEC software for free · AEC Integrations`,
      description: $localize`:@@meta.vendorProgramDescription:Claim your free listing in the AEC software directory. Keep your products and construction software integrations accurate where AEC teams compare them.`,
      canonical: canonicalUrl('/vendor-program'),
      ogImage: VENDOR_PROGRAM_OG_IMAGE,
      ogImageAlt: $localize`:@@meta.vendorProgramOgImageAlt:AEC Integrations for software vendors: your products may already be listed here. Make sure buyers read your version. Claiming your listing is free.`,
    });

    // Browser only: the signed-in variants never touch the SSR HTML.
    afterNextRender(() => {
      if (this.isBrowser) this.hydrated.set(true);
    });
  }
}
