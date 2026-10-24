/**
 * The public vendor landing page (`/vendor-program`). Governed by
 * `docs/VENDOR_PROGRAM_PAGE_SPEC.md`: §2 owns this file's route, caching and meta
 * (AECI-1283), §3 the sections and §8 the copy (AECI-1284), §4 the calls to action
 * (AECI-1285), §5 the signed-in variants (AECI-1286). §6's Find your product
 * section was removed on 2026-10-12: the claim dialog starts with Find it (§15).
 *
 * **Sections, in the §3 order.** One `h1` in the hero, then one `h2` per section:
 * what changes when you claim, what a free claim gets you, what Managed adds, the
 * plan cards, how listings are sorted, the FAQ, and the closing panel.
 *
 * **Free and Managed share one pattern (ruling 2026-10-12).** The same split and
 * the same item, `li[aec-vendor-program-benefit]` (`vendor-program-benefit.ts`): a plain
 * title, the body, then "Learn more" to the docs page when the line has one.
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
 * Its lede says buyers read our account of your public pages until you claim.
 *
 * **What Managed adds** opens with its own lede (who Managed is for), then the
 * price line in small text (copy pass 2026-10-12), then the monthly term with its
 * 14-day refund and the annual renewal (E8.2, 2026-10-19).
 *
 * **Doc links open in a new tab (ruling 2026-10-12).** Every link to `/docs/*` carries `target="_blank" rel="noopener"`
 * and `aec-new-tab-icon` (the drawn cue plus the sr-only "(opens in a new tab)").
 * A `routerLink` with a `target` builds the same absolute `/docs/...` href and lets
 * the browser open it, so `<base href>` does not touch it. Conversion links stay in
 * the tab: every claim link, the contact link and "Go to your portal".
 *
 * **Calls to action (§4.1, §15).** The hero button (`top`), the plan cards (`card`),
 * the phone bar (`mobile_bar`) and the closing panel (`bottom`). No rail on this page: it would reserve an empty column beside
 * every section (2026-10-12). The docs Plans page keeps its rail. Every one of them
 * opens the one claim dialog (AECI-1293), and every one reads "Claim your listing"
 * (E8.2 retired "Start with Managed", 2026-10-19). Without JS they link to `/search`
 * (`CLAIM_DIALOG_FALLBACK_HREF`), where the visitor finds the listing and its own
 * claim form. Claim is the only plan action. "Questions? Contact us" (`aec-plan-contact-link`, a plain link to
 * `/contact`) sits in the closing panel and under the FAQ, not on the hero (E8.1,
 * 2026-10-19). Under the FAQ it has a second line, "Not listed yet? Ask us to list
 * your product", a plain link to `/vendor-program/list-your-product` (AECI-1474). The plan cards carry `data-plans-cta`, so the phone bar also hides
 * while they are on screen. Exactly one `aec-claim-dialog-host`.
 *
 * **Static + edge-cached + SSR-safe.** No data fetch and no per-visitor state in the
 * HTML: `/vendor-program` carries `Cache-Tag: route:index` on the `/about` TTLs.
 * The signed-in variants (§5) read `VendorPlanStatus`, which is `null` throughout
 * SSR, and are applied only after the first browser render (`hydrated`), so the
 * server HTML is the signed-out page for every visitor:
 *
 *  - a vendor seat: every claim dialog control becomes "Go to your portal";
 *  - a Managed company: also no phone bar, no contact link or Managed steps in the panel.
 *
 * **Full width at desktop (§11).** Every section uses the whole `max-w-7xl`
 * container from `lg`: a 12-column split (heading left, content right), the Free
 * and Managed lines in a 2-column grid beside their heading, the plan cards side by side, a
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
  TransferState,
  afterNextRender,
  computed,
  inject,
  makeStateKey,
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
  PlanContactLinkComponent,
  PlanCtaActionsComponent,
  PlanCtaMobileBarComponent,
  PlanCtaPanelComponent,
  managedCostAnswer,
  managedRenewalLine,
  managedTermLine,
  managedTermsLine,
} from '../shared/plan-cta/plan-cta';
import { ClaimDialogHost } from '../shared/claim-dialog/claim-dialog-host';
import { VendorPlanStatus } from '../vendor/vendor-plan-status';
import { VendorProgramBenefit } from './vendor-program-benefit';

/** The Plans page, for the Managed lines with no page of their own. */
const PLANS_PATH = '/docs/vendors/plans';

/** The server's "today" for the example maintenance label (see `exampleUpdatedAt`). */
const EXAMPLE_UPDATED_AT_KEY = makeStateKey<string>('aeci.vendor-program.example-updated-at');
@Component({
  selector: 'aec-vendor-program',
  imports: [
    NgTemplateOutlet,
    RouterLink,
    MaintenanceMarker,
    NewTabIcon,
    PlanCardsComponent,
    PlanContactLinkComponent,
    PlanCtaActionsComponent,
    PlanCtaMobileBarComponent,
    PlanCtaPanelComponent,
    ClaimDialogHost,
    VendorProgramBenefit,
  ],
  template: `
    <div class="bg-(--surface-base) text-(--text-primary)">
      <!-- 1. Hero. The claim call to action, on the first screen at 375px. From lg the
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
              AEC teams compare software and its integrations here before they buy. Claim your
              listing, free, so what they read is current, complete and in your words.
            </p>
            <aec-plan-cta-actions class="mt-6 md:mt-8" page="vendor_program" [portal]="portal()" />
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
                    Start your claim, then search for your product or your company.
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
                    Claiming is free. We set up your account when we approve your claim.
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
                    A person reviews every claim and emails you the result.
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
                Buyers compare your integrations on your listing, whether or not you wrote it. Until
                you claim it, they are reading our account of your public pages. Every listing says
                who keeps it current.
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
                  We wrote it from what we could find. Buyers cannot tell whether anything is
                  missing or out of date.
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

          <!-- 3. What a free claim gets you, and 4. What Managed adds: one pattern
               (spec section 3, 2026-10-12). Heading and lede in the left four columns,
               the lines in a two-column grid on the right, each line the shared
               aec-vendor-program-benefit item. This page's own benefit copy: each line says
               what you can do, what your company gains, and what the buyer or the person
               using the integration gains. -->
          <section id="vp-free" aria-labelledby="vp-free-heading" [class]="benefitSection">
            <div [class]="benefitIntro">
              <h2 id="vp-free-heading" i18n="@@vendorProgram.free.heading">
                What a free claim gets you
              </h2>
              <p [class]="benefitLede" i18n="@@vendorProgram.free.lede">
                Everything here is on the free plan. Invite colleagues to share the work: each
                person gets
                <a
                  routerLink="/docs/vendors/your-seat"
                  target="_blank"
                  rel="noopener"
                  [class]="inTextLink"
                  >their own seat<aec-new-tab-icon /></a
                >.
              </p>
            </div>
            <ul [class]="benefitList" role="list">
              <li aec-vendor-program-benefit [benefitTitle]="freeTitles.details">
                <ng-container i18n="@@vendorProgram.free.details.body">
                  Buyers read a page your team wrote, marked "Vendor maintained" with the date you
                  last checked it. Keep the description, website, logo and categories current.
                  <a
                    routerLink="/docs/vendors/checklists"
                    target="_blank"
                    rel="noopener"
                    [class]="inTextLink"
                    >Your checklists<aec-new-tab-icon
                  /></a>
                  show what to fill in first.
                </ng-container>
              </li>
              <li aec-vendor-program-benefit [benefitTitle]="freeTitles.integrations">
                <ng-container i18n="@@vendorProgram.free.integrations.body">
                  The person setting up your integration on a project gets your guide from the
                  integration page, not a support ticket. Claim the integrations your company
                  builds, and add your setup guide to any integration with your product. Buyers see
                  who maintains each one. If a partner's listing describes your integration wrongly,
                  you can request a change.
                </ng-container>
              </li>
              <li aec-vendor-program-benefit [benefitTitle]="freeTitles.complete">
                <ng-container i18n="@@vendorProgram.free.complete.body">
                  A complete listing matches more searches and wins ties. When two listings match a
                  search about equally well, the more complete one comes first. Every field that
                  counts is free to fill in, and the rule is the same for every listing, whatever
                  its plan.
                </ng-container>
              </li>
            </ul>
          </section>

          <section id="vp-managed" aria-labelledby="vp-managed-heading" [class]="benefitSection">
            <div [class]="benefitIntro">
              <h2 id="vp-managed-heading" i18n="@@vendorProgram.managed.heading">
                What Managed adds
              </h2>
              <p [class]="benefitLede" i18n="@@vendorProgram.managed.lede">
                Managed is for products that need more than a corrected listing: your own account of
                what the product does on a project, who it is for, and how its integrations move
                data.
              </p>
              <p class="mt-3 text-sm text-(--text-secondary)">{{ terms }} {{ term }}</p>
              <p class="mt-2 text-sm text-(--text-secondary)">{{ renewal }}</p>
            </div>
            <ul [class]="benefitList" role="list">
              <li
                aec-vendor-program-benefit
                [benefitTitle]="managedTitles.usefulness"
                [link]="plansPath"
                fragment="what-managed-adds"
              >
                <ng-container i18n="@@vendorProgram.managed.usefulness.body">
                  Describe, in your own words, the work your product does on a real project. Buyers
                  judge fit by the job it does, not a feature list, and the people who will use it
                  can picture it on their own project.
                </ng-container>
              </li>
              <li
                aec-vendor-program-benefit
                [benefitTitle]="managedTitles.taxonomy"
                link="/docs/getting-started/taxonomy"
              >
                <ng-container i18n="@@vendorProgram.managed.taxonomy.body">
                  Set who each product is for and when in a project it is used, rather than leave it
                  to our reading of public sources. Buyers browsing a trade, audience or phase page,
                  or filtering a search by one, find the products tagged with it. An MEP contractor
                  filtering by trade sees the tools built for that trade.
                </ng-container>
              </li>
              <li
                aec-vendor-program-benefit
                [benefitTitle]="managedTitles.integrationDetail"
                [link]="plansPath"
                fragment="what-managed-adds"
              >
                <ng-container i18n="@@vendorProgram.managed.integrationDetail.body">
                  Link evaluators to your integrations page and API docs. Confirm which data each
                  integration moves, and your answer counts the same as your partner's. Buyers can
                  check what an integration syncs before they rely on it for a project. See
                  <a
                    routerLink="/docs/vendors/confirming-integration-data"
                    target="_blank"
                    rel="noopener"
                    [class]="inTextLink"
                    >Confirming integration data<aec-new-tab-icon /></a
                  >.
                </ng-container>
              </li>
              <li
                aec-vendor-program-benefit
                [benefitTitle]="managedTitles.replies"
                link="/docs/vendors/replying-to-reviews"
              >
                <ng-container i18n="@@vendorProgram.managed.replies.body">
                  Reply to reviews of your products, so buyers see your side and how you handle a
                  problem. Someone weighing a critical review reads your answer beside it. Every
                  reply is reviewed before it goes live, so buyers read it as part of the record,
                  not a comment thread.
                </ng-container>
              </li>
            </ul>
          </section>

          <!-- 5. The plan cards (shared with the Plans page). -->
          <section id="vp-plans" aria-labelledby="vp-plans-heading">
            <h2 id="vp-plans-heading" i18n="@@vendorProgram.plans.heading">Free and Managed</h2>
            <aec-plan-cards
              class="mt-6"
              data-plans-cta="card"
              page="vendor_program"
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

          <!-- 6. How listings are sorted: the reason buyers trust the order. -->
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
                That is why buyers trust what they find here, and why a claimed, complete listing is
                worth more than a paid one that is not. Paying changes what you can say. It never
                changes where you appear, whether a review is published, or how an agreement label
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

          <!-- 7. FAQ, a native details list (no JS, indexable answers). -->
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
                  Anyone who works at the company that makes the product. Claiming is free, and you
                  do not need an account to start: we set up yours when we approve the claim. A
                  claim on a product is a claim on the company that makes it, and the seat covers
                  the whole company account. See
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
                  <span i18n="@@vendorProgram.faq.approval.q"
                    >What happens after we send a claim?</span
                  >
                  <ng-container [ngTemplateOutlet]="chevron" />
                </summary>
                <p [class]="answerClass" i18n="@@vendorProgram.faq.approval.a">
                  A person reviews every claim and emails you the result.
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
                  product your company makes. Managed is licensed per product. An owner assigns a
                  license to each product you want on Managed.
                </p>
              </details>
              <details class="group border-t border-(--border-default)">
                <summary [class]="summaryClass">
                  <span i18n="@@vendorProgram.faq.billing.q">What does Managed cost?</span>
                  <ng-container [ngTemplateOutlet]="chevron" />
                </summary>
                <p [class]="answerClass">{{ costAnswer }}</p>
              </details>
              <details class="group border-t border-(--border-default)">
                <summary [class]="summaryClass">
                  <span i18n="@@vendorProgram.faq.cancel.q"
                    >Can we cancel a Managed plan early?</span
                  >
                  <ng-container [ngTemplateOutlet]="chevron" />
                </summary>
                <p [class]="answerClass" i18n="@@vendorProgram.faq.cancel.a">
                  Yes, on monthly. Monthly has no commitment: cancel any time, and your licenses run
                  to the end of the month you paid for. An annual license runs to its renewal date.
                  If you opt out of renewal, it ends on that date.
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
                  Each product whose license ends moves to Free. Your seats, sign-in and portal
                  stay. Nothing you entered is removed, and your listings stay published. What
                  Managed adds becomes read-only. See
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
            <div class="flex flex-col gap-2 lg:col-span-7 lg:col-start-6">
              <aec-plan-contact-link />
              <!-- AECI-1474: the listing request page, for a product not listed yet. Not
                   tracked, like the contact link. -->
              <p class="text-sm text-(--text-secondary)" data-testid="vp-faq-list-your-product">
                <span i18n="@@vendorProgram.faq.notListed.lead">Not listed yet?</span>
                {{ ' ' }}
                <a
                  routerLink="/vendor-program/list-your-product"
                  class="font-semibold text-(--accent-primary) underline underline-offset-4 hover:text-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                  i18n="@@vendorProgram.faq.notListed.link"
                  >Ask us to list your product</a
                >
              </p>
            </div>
          </section>

          <!-- 8. The closing panel, its own section (h2). -->
          <aec-plan-cta-panel
            page="vendor_program"
            [headingLevel]="2"
            [split]="true"
            [portal]="portal()"
            [hideManaged]="hideManaged()"
          />
        </div>
      </div>

      <aec-plan-cta-mobile-bar
        page="vendor_program"
        [portal]="portal()"
        [hideManaged]="hideManaged()"
      />
      <!-- One claim dialog for every claim control on the page (AECI-1293). -->
      <aec-claim-dialog-host />
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

  protected readonly plansPath = PLANS_PATH;

  /**
   * An in-text link (DESIGN.md, the Link Treatment Rule). Every one on this page goes
   * to the docs in a new tab, so it carries `aec-new-tab-icon`: the `[&_svg]` rules
   * keep that icon inline in the running sentence instead of on its own line.
   */
  protected readonly inTextLink =
    'text-(--accent-primary) underline underline-offset-2 hover:text-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) [&_svg]:ms-1 [&_svg]:inline [&_svg]:align-[-0.125em]';
  /** The same, bold: "How ranking works". */
  protected readonly inTextLinkStrong = `${this.inTextLink} font-semibold`;
  /**
   * What a free claim gets you and What Managed adds share one layout (2026-10-12):
   * from `lg` the heading and lede take the left four columns and the lines a
   * two-column grid in the right eight. Each line is `li[aec-vendor-program-benefit]`.
   */
  protected readonly benefitSection = 'grid gap-6 lg:grid-cols-12 lg:gap-x-12';
  protected readonly benefitIntro = 'lg:col-span-4';
  protected readonly benefitLede = 'mt-3 max-w-[56ch] leading-relaxed text-(--text-secondary)';
  protected readonly benefitList = 'grid gap-x-8 md:grid-cols-2 lg:col-span-8';
  protected readonly freeTitles = {
    details: $localize`:@@vendorProgram.free.details.title:Your listing, in your words`,
    integrations: $localize`:@@vendorProgram.free.integrations.title:Your integrations, owned by you`,
    complete: $localize`:@@vendorProgram.free.complete.title:A complete listing, at no cost`,
  };
  protected readonly managedTitles = {
    usefulness: $localize`:@@vendorProgram.managed.usefulness.title:How teams use it`,
    taxonomy: $localize`:@@vendorProgram.managed.taxonomy.title:Trades, audiences and phases`,
    integrationDetail: $localize`:@@vendorProgram.managed.integrationDetail.title:Integration detail buyers can check`,
    replies: $localize`:@@vendorProgram.managed.replies.title:Review replies`,
  };
  /** `$25 USD a month or $250 USD a year per product.` */
  protected readonly terms = managedTermsLine(inject(LOCALE_ID));
  /** Monthly with no commitment, and the 14-day refund, beside the price (E8.2). */
  protected readonly term = managedTermLine();
  /** Annual renewal and the 30-day written notice, under the price (E8.2). */
  protected readonly renewal = managedRenewalLine();
  /**
   * The FAQ's "What does Managed cost?" answer (E8.2, 2026-10-19): both prices from the
   * shared constants, monthly with no commitment, annual renewal and the 14-day refund.
   * No payment method: E9 adds the card line.
   */
  protected readonly costAnswer = managedCostAnswer(inject(LOCALE_ID));
  /**
   * The date on the "after" label in What changes when you claim: today, in UTC, so
   * the example reads as "if you updated it today". The marker formats it in UTC, so
   * the server and the browser print the same day. It is not visitor state.
   *
   * The page is edge-cached for 24 hours, so the browser takes the server's value
   * through `TransferState` instead of reading its own clock. Otherwise a copy cached
   * on an earlier UTC day would redraw the date after hydration. A client-side
   * navigation has no server value and reads the clock.
   */
  protected readonly exampleUpdatedAt = this.resolveExampleUpdatedAt();
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

  private resolveExampleUpdatedAt(): string {
    const state = inject(TransferState);
    const transferred = state.get(EXAMPLE_UPDATED_AT_KEY, null);
    if (transferred) return transferred;
    const now = new Date().toISOString();
    if (!this.isBrowser) state.set(EXAMPLE_UPDATED_AT_KEY, now);
    return now;
  }
}
