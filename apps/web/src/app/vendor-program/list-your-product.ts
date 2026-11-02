/**
 * The listing request page (`/vendor-program/list-your-product`, AECI-1474,
 * `docs/VENDOR_PROGRAM_PAGE_SPEC.md` §2.5). One link outreach can send to a vendor
 * whose product is not in the directory yet: a short explainer and the listing
 * request form, inline.
 *
 * **Not a dialog (ruling 2026-10-24).** The page embeds the claim dialog's own step
 * component, `ClaimDialogFlow`, with `embedded` set, opened on the typed-in You step
 * (`start: 'typed'`). So it is the same form, the same `POST /api/requests/listing`,
 * the same receipt and the same events as the dialog's "Not listed? Type it in"
 * path. No BrnDialog and no `aec-claim-dialog-host`. Back from the first step goes
 * to the Find step, inline, so a vendor who is listed after all can claim from here.
 *
 * **Static + edge-cached + SSR-safe.** No data fetch. The form renders empty on the
 * server: the signed-in email prefill reads `SessionStatus`, which is empty in SSR
 * because visitor-state cookies are stripped first. The page carries
 * `Cache-Tag: route:index` on the `/vendor-program` TTLs, is indexable and is in
 * `sitemap.xml`.
 *
 * **Layout.** The standard canvas. From `lg` a 12-column grid: the explainer in
 * columns 1 to 5, sticky, and the form panel in 6 to 12. Under the explainer an `h2`
 * "What happens next" and a four-item ordered list, styled as `/vendor-program`'s
 * "How claiming works", so the left column is not blank beside the tall form. Below
 * `lg` they stack: explainer, list, then the form. The panel is the dialog's surface (`--surface-base`,
 * hairline, `rounded-lg`, no shadow) with an `h2`, so the flow's `h3` step headings
 * keep a correct outline. Mobbin anchor: the claim dialog's own (Mercor's "Complete
 * your profile" modal, screen `a39d82f4-c61a-44cb-be88-f81eec9320a8`), since this
 * is that form out of its dialog.
 *
 * Copy rules (§8): sentence case, no em dashes, every string i18n'd. Light only.
 */
import { Component, inject } from '@angular/core';

import { canonicalUrl } from '../core/canonical';
import { VENDOR_PROGRAM_OG_IMAGE } from '../core/meta.helpers';
import { MetaService } from '../core/meta.service';
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
  imports: [ClaimDialogFlow],
  template: `
    <div class="bg-(--surface-base) text-(--text-primary)">
      <div
        class="mx-auto w-full max-w-7xl px-6 py-8 md:px-8 md:py-12 lg:grid lg:grid-cols-12 lg:items-start lg:gap-x-12"
      >
        <div class="lg:sticky lg:top-8 lg:col-span-5" data-testid="list-your-product-intro">
          <h1
            class="font-display text-3xl font-normal text-balance leading-[1.1] tracking-[-0.01em] text-(--text-primary) sm:text-4xl md:text-5xl"
            i18n="@@listYourProduct.heading"
          >
            Ask us to list your product
          </h1>
          <p
            class="mt-4 max-w-[52ch] text-base leading-relaxed text-(--text-secondary) md:mt-5 md:text-lg"
            i18n="@@listYourProduct.lede"
          >
            Listing is free. Tell us the product and its website, and we take it from there.
          </p>

          <div class="mt-8 md:mt-10" data-testid="list-your-product-next">
            <h2
              id="list-your-product-next-heading"
              class="font-semibold text-(--text-primary)"
              i18n="@@listYourProduct.next.heading"
            >
              What happens next
            </h2>
            <ol class="mt-5 space-y-5" aria-labelledby="list-your-product-next-heading">
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
                      class="font-semibold text-(--accent-primary) underline underline-offset-2 hover:text-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
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
                    If it meets our conditions, we write it from the product's public pages and add
                    it to the directory.
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

        <section
          aria-labelledby="list-your-product-form-heading"
          class="mt-8 rounded-(--radius-lg) border border-(--border-default) bg-(--surface-base) lg:col-span-7 lg:mt-0"
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
  `,
})
export class ListYourProductPage {
  private readonly meta = inject(MetaService);

  protected readonly opening = LIST_YOUR_PRODUCT_OPENING;
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
