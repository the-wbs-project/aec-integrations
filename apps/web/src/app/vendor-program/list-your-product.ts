/**
 * The listing request page (`/vendor-program/list-your-product`, AECI-1474,
 * `docs/VENDOR_PROGRAM_PAGE_SPEC.md` §2.5). One link outreach can send to a vendor
 * whose product is not in the directory yet: a short explainer and the listing
 * request form, inline.
 *
 * **Not a dialog (ruling 2026-10-24).** The page embeds the claim dialog's own step
 * component, `ClaimDialogFlow`, with `embedded` set, opened on the typed-in You step
 * (`start: 'typed'`). So it is the same form, the same `POST /api/requests/listing`,
 * the same receipt and the same events as the dialog's "Not listed? Ask us to add it"
 * path. No BrnDialog and no `aec-claim-dialog-host`. Back from the first step goes
 * to the Find step, inline, so a vendor who is listed after all can claim from here.
 *
 * **Static + edge-cached + SSR-safe.** No data fetch. The form renders empty on the
 * server: the signed-in email prefill reads `SessionStatus`, which is empty in SSR
 * because visitor-state cookies are stripped first. The page carries
 * `Cache-Tag: route:index` on the `/vendor-program` TTLs, is indexable and is in
 * `sitemap.xml`.
 *
 * **Layout (AECI-1802, reworked by the AECI-1720 layout pass).** A vendor comes
 * here to fill the form, so the form starts on the first screen. There is no Bone
 * band: one white band on the 1328px page wrap, split 5:7 from `lg` like the home
 * argument band. On the left the `h1` (the Headline role, the global h1 size)
 * and the lede. Under them, sticky once the heading has scrolled away, the `h2`
 * "What happens next" (the Section role on an inner span) over a four-item
 * ordered list styled as `/vendor-program`'s "How claiming works", so the left
 * column is not blank beside the tall form. On the right the
 * form on the shared form card (`aecCard phoneFlush`) with an `h2`, so the flow's
 * `h3` step headings keep a correct outline. Below `lg` they stack: the heading,
 * the list, then the form. Mobbin anchor: the claim dialog's own (Mercor's
 * "Complete your profile" modal, screen `a39d82f4-c61a-44cb-be88-f81eec9320a8`),
 * since this is that form out of its dialog.
 *
 * Copy rules (§8): sentence case, no em dashes, every string i18n'd. Light only.
 */
import { Component, inject } from '@angular/core';

import { canonicalUrl } from '../core/canonical';
import { VENDOR_PROGRAM_OG_IMAGE } from '../core/meta.helpers';
import { MetaService } from '../core/meta.service';
import { BAND_WRAP_CLASS } from '../shared/band-wrap';
import { AecCard } from '../shared/card/card';
import { ClaimDialogFlow } from '../shared/claim-dialog/claim-dialog-flow';
import type { ClaimDialogOpening } from '../shared/claim-dialog/claim-dialog.service';

/** How the page opens the flow: its own page and entry, on the typed-in step. */
export const LIST_YOUR_PRODUCT_OPENING: ClaimDialogOpening = {
  page: 'list_your_product',
  entry: 'list_page',
  start: 'typed',
};

@Component({
  selector: 'aec-list-your-product',
  imports: [AecCard, ClaimDialogFlow],
  template: `
    <div class="bg-(--surface-base) text-(--text-primary)">
      <!-- One white band on the page wrap, split 5:7 from lg: the heading, the lede
           and what happens next on the left, sticky; the form on the right. The form
           starts on the first screen, as it did before the redesign. -->
      <div class="pt-8 pb-16 md:pt-12 md:pb-24">
        <div
          [class]="
            wrap +
            ' grid gap-12 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-start lg:gap-16'
          "
        >
          <!-- The column stretches to the row, so the list can stick inside it once
               the heading has scrolled away. -->
          <div class="lg:self-stretch" data-testid="list-your-product-next">
            <div class="max-w-[52ch]" data-testid="list-your-product-intro">
              <h1 class="text-balance text-(--text-primary)" i18n="@@listYourProduct.heading">
                Ask us to list your product
              </h1>
              <p
                class="mt-6 text-t-20 leading-normal text-(--text-secondary)"
                i18n="@@listYourProduct.lede"
              >
                Listing is free. Tell us the product and its website, and we take it from there.
              </p>
            </div>
            <div class="mt-12 lg:sticky lg:top-8">
              <h2 id="list-your-product-next-heading" class="text-(--text-primary)">
                <span [class]="sectionTitle" i18n="@@listYourProduct.next.heading"
                  >What happens next</span
                >
              </h2>
              <ol class="mt-8 space-y-5" aria-labelledby="list-your-product-next-heading">
                <li class="flex gap-4">
                  <span [class]="stepNumber" aria-hidden="true">1</span>
                  <div>
                    <p class="font-semibold" i18n="@@listYourProduct.next.confirm.title">
                      Confirm your email.
                    </p>
                    <p
                      class="mt-0.5 leading-relaxed text-(--text-secondary)"
                      i18n="@@listYourProduct.next.confirm.body"
                    >
                      We email you a link. Your request is sent when you click it.
                    </p>
                  </div>
                </li>
                <li class="flex gap-4">
                  <span [class]="stepNumber" aria-hidden="true">2</span>
                  <div>
                    <p class="font-semibold" i18n="@@listYourProduct.next.review.title">
                      We review it.
                    </p>
                    <p
                      class="mt-0.5 leading-relaxed text-(--text-secondary)"
                      i18n="@@listYourProduct.next.review.body"
                    >
                      A person on our team confirms that you work for the company and checks the
                      product against our
                      <a
                        href="/docs/trust/listing-submissions"
                        target="_blank"
                        rel="noopener"
                        class="font-semibold text-(--accent-primary) underline underline-offset-2 hover:text-(--accent-primary-hover) focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--accent-primary)"
                        >listing conditions<span class="sr-only"> (opens in a new tab)</span></a
                      >.
                    </p>
                  </div>
                </li>
                <li class="flex gap-4">
                  <span [class]="stepNumber" aria-hidden="true">3</span>
                  <div>
                    <p class="font-semibold" i18n="@@listYourProduct.next.add.title">
                      We may add the listing.
                    </p>
                    <p
                      class="mt-0.5 leading-relaxed text-(--text-secondary)"
                      i18n="@@listYourProduct.next.add.body"
                    >
                      If it meets our conditions, we write it from the product's public pages and
                      add it to the directory.
                    </p>
                  </div>
                </li>
                <li class="flex gap-4">
                  <span [class]="stepNumber" aria-hidden="true">4</span>
                  <div>
                    <p class="font-semibold" i18n="@@listYourProduct.next.claim.title">
                      You claim it.
                    </p>
                    <p
                      class="mt-0.5 leading-relaxed text-(--text-secondary)"
                      i18n="@@listYourProduct.next.claim.body"
                    >
                      We email you so you can claim the listing and keep it current.
                    </p>
                  </div>
                </li>
              </ol>
            </div>
          </div>

          <!-- The form on the shared card. -->
          <section
            aecCard
            phoneFlush
            aria-labelledby="list-your-product-form-heading"
            data-testid="list-your-product-form"
          >
            <div class="px-6 pt-6 pb-3">
              <h2
                id="list-your-product-form-heading"
                class="font-display text-2xl font-normal leading-[1.15] tracking-[-0.01em] text-(--text-primary)"
                i18n="@@listYourProduct.form.heading"
              >
                Request a listing
              </h2>
            </div>
            <aec-claim-dialog-flow [opening]="opening" [embedded]="true" />
          </section>
        </div>
      </div>
    </div>
  `,
})
export class ListYourProductPage {
  private readonly meta = inject(MetaService);

  protected readonly opening = LIST_YOUR_PRODUCT_OPENING;
  /** The 1328px page wrap the header, footer and bands share. */
  protected readonly wrap = BAND_WRAP_CLASS;
  /** The Section role on an inner span, so the unlayered h2 rule cannot beat it. */
  protected readonly sectionTitle = 'block text-t-36 leading-[1.1] tracking-[-0.02em]';
  /** The numbered badge of `/vendor-program`'s "How claiming works" list. */
  protected readonly stepNumber =
    'flex size-7 shrink-0 items-center justify-center rounded-full bg-(--accent-primary) text-sm font-semibold text-(--surface-base)';

  constructor() {
    this.meta.setStaticPageMeta({
      title: $localize`:@@meta.listYourProductTitle:Ask us to list your product · AEC Integrations`,
      description: $localize`:@@meta.listYourProductDescription:List your software in the AEC software directory for free. Send a listing request, a person on our team reviews it, and we email you when your listing is ready to claim.`,
      canonical: canonicalUrl('/vendor-program/list-your-product'),
      ogImage: VENDOR_PROGRAM_OG_IMAGE,
      ogImageAlt: $localize`:@@meta.vendorProgramOgImageAlt:AEC Integrations for software vendors: your products may already be listed here. Make sure buyers read your version. Claiming your listing is free.`,
    });
  }
}
