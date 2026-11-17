/**
 * Contact page (`/contact`, AECI-238 / Phase 7.3). The general contact path is a
 * `mailto:` link (the acceptance criteria explicitly permits it; no general contact
 * form and no `/api/contact` endpoint — vendor/listing issues already flow through
 * the per-entity claim/correction forms). A short editorial intro, the email as the
 * primary contact path, and a pointer to the correction flow for listing fixes. The
 * plan pages' "Questions? Contact us" link lands here with no topic.
 *
 * **Non-cacheable, SSR, indexable.** `/contact` is "No cache" per §3.1 — it is not
 * in `ROUTE_CACHE_PATTERNS`, so the SSR Worker emits the fail-closed default
 * `private, no-store` (no `Cache-Tag`). It is still a canonical, indexable content
 * page, so `setStaticPageMeta` sets title + description + canonical + OG with no
 * `robots` tag. Meta is set from the constructor (like `Home`) so it ships in the
 * SSR head AND refreshes on an in-app navigation.
 *
 * Voice per `PRODUCT.md`: quiet, functional, sentence case, no exclamation marks.
 * Light theme only (Stage 1). All
 * strings authored with `i18n`/`$localize`; the email address itself is literal
 * (not translated) and shared between the visible label and the `mailto:` href.
 *
 * **Layout (AECI-1801, the `/about` recipe of AECI-1800).** The hero is on
 * `aec-bone-band`, the page's one Bone band, with the h1 at the Headline role (the
 * global h1 size). The body is a white band on the 1328px page wrap
 * (`BAND_WRAP_CLASS`). The add-product panel and the two route cards are the shared
 * `aecCard`, their headings the Section role on an inner span, and the address a
 * standalone link (DESIGN.md "The Link Treatment Rule"). Nothing here is a natural
 * feature card, so the page has no Forest card. The words and their order are
 * unchanged.
 *
 * **`?topic=add-product`** (`VENDOR_PROGRAM_PAGE_SPEC.md` §6; its in-app link,
 * Find your product, was removed on 2026-10-12, and the topic keeps working for
 * outside links). A vendor whose product is not in the
 * directory asks us to add it. The in-app path is a listing request (§15.4), on
 * `/vendor-program/list-your-product` or the claim dialog's typed-in step. This
 * topic is the fallback for outside links: the page shows a panel whose primary
 * button, "Request a listing", goes to that page (AECI-1474, §2.4). Its second
 * button is the same support `mailto:` with the subject and a prompt filled in:
 * product name, website, and the products it integrates with. The message reaches
 * the same mailbox as every other email.
 * Topic values live in `contact-topics.ts`. Any other topic value is ignored, including
 * `managed`, whose inline inquiry form was removed on 2026-10-19 (E8.1). `/contact` is
 * not cached, so reading the query in SSR is safe, and the canonical URL stays `/contact`.
 */
import { Component, inject } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';

import { canonicalUrl } from '../core/canonical';
import { MetaService } from '../core/meta.service';
import { ADD_PRODUCT_TOPIC } from './contact-topics';
import { BAND_WRAP_CLASS } from '../shared/band-wrap';
import { BoneBand } from '../shared/bone-band/bone-band';
import { AecButton } from '../shared/button/button';
import { AecCard } from '../shared/card/card';

@Component({
  selector: 'app-contact',
  imports: [AecButton, AecCard, BoneBand, RouterLink],
  template: `
    <div class="bg-(--surface-base) text-(--text-primary)">
      <!-- 1. Hero: the page's one Bone band, as on /about. -->
      <aec-bone-band>
        <div class="max-w-[70ch]">
          <p class="aec-overline text-(--text-secondary)" i18n="@@app.contact.eyebrow">Contact</p>
          <h1 class="mt-4 text-(--text-primary)" i18n="@@app.contact.headline">Get in touch</h1>
          <p
            class="mt-6 max-w-[36em] text-t-20 leading-normal text-(--text-secondary)"
            i18n="@@app.contact.lede"
          >
            Questions, feedback, corrections, or press: we read everything and reply to most
            messages within a couple of business days.
          </p>
        </div>
      </aec-bone-band>

      <!-- 2. White: the contact routes as shared cards on the page wrap. -->
      <div class="py-16 md:py-24">
        <div [class]="wrap">
          @if (addProduct) {
            <section aecCard class="mb-6 p-6 md:p-8" data-testid="contact-add-product">
              <h2 class="text-(--text-primary)">
                <span [class]="sectionTitle" i18n="@@app.contact.addProduct.heading"
                  >Ask us to add your product</span
                >
              </h2>
              <p
                class="mt-4 max-w-[70ch] text-t-16 leading-relaxed text-(--text-secondary)"
                i18n="@@app.contact.addProduct.body"
              >
                Send us a listing request, and a person on our team reviews it. Or email us the
                product name, its website, and the products it integrates with. The email opens with
                these questions filled in.
              </p>
              <!-- AECI-1474: the request form first, the email second. -->
              <div class="mt-6 flex flex-wrap gap-3">
                <a
                  aecButton
                  routerLink="/vendor-program/list-your-product"
                  data-testid="contact-add-product-request"
                  i18n="@@app.contact.addProduct.request"
                >
                  Request a listing
                </a>
                <a
                  aecButton
                  variant="secondary"
                  [href]="addProductHref"
                  data-testid="contact-add-product-email"
                  i18n="@@app.contact.addProduct.cta"
                >
                  Email us about your product
                </a>
              </div>
            </section>
          }
          <div class="grid gap-6 md:grid-cols-2">
            <section aecCard class="flex h-full flex-col p-6 md:p-8">
              <h2 class="text-(--text-primary)">
                <span [class]="sectionTitle" i18n="@@app.contact.email.heading">Email us</span>
              </h2>
              <p [class]="cardBody" i18n="@@app.contact.email.body">
                The fastest way to reach us is email. Tell us what you are working on and we will
                route your message to the right person.
              </p>
              <!-- A standalone link (DESIGN.md "The Link Treatment Rule"), as on /about.
                   The negative margin lines its text up with the paragraph above. -->
              <p class="-mx-3 mt-2 mb-6">
                <a [href]="mailtoHref" [class]="standaloneLink">{{ email }}</a>
              </p>
              <a
                aecButton
                [href]="mailtoHref"
                class="mt-auto self-start"
                i18n="@@app.contact.email.cta"
              >
                Email us
              </a>
            </section>

            <section aecCard class="flex h-full flex-col p-6 md:p-8">
              <h2 class="text-(--text-primary)">
                <span [class]="sectionTitle" i18n="@@app.contact.corrections.heading"
                  >Corrections to a listing</span
                >
              </h2>
              <p [class]="cardBody + ' mb-6'" i18n="@@app.contact.corrections.body">
                Spotted something inaccurate on a product or vendor page? Every listing has a way to
                claim it or suggest a correction. Open the relevant page from the directory, or
                email us directly and we will make sure it gets reviewed.
              </p>
              <a
                aecButton
                routerLink="/products"
                class="mt-auto self-start"
                i18n="@@app.contact.corrections.cta"
              >
                Browse listings
              </a>
            </section>
          </div>
        </div>
      </div>
    </div>
  `,
})
export class ContactPage {
  private readonly meta = inject(MetaService);

  /** The 1328px page wrap the header, footer and bands share. */
  protected readonly wrap = BAND_WRAP_CLASS;

  /** The Section role on an inner span, so the unlayered h2 rule cannot beat it. */
  protected readonly sectionTitle = 'block text-t-36 leading-[1.1] tracking-[-0.02em]';

  /** A card's body at the Body role. */
  protected readonly cardBody = 'mt-4 text-t-16 leading-relaxed text-(--text-secondary)';

  /** The standalone link recipe (DESIGN.md "The Link Treatment Rule"), as on `/about`. */
  protected readonly standaloneLink =
    'inline-block rounded-(--radius-md) px-3 py-2 text-t-14 font-semibold text-(--text-secondary) underline decoration-(--border-strong) underline-offset-4 hover:text-(--text-primary)';

  private readonly topic = inject(ActivatedRoute).snapshot.queryParamMap.get('topic');
  /** `?topic=add-product`: a product not in the directory (spec §6). */
  protected readonly addProduct = this.topic === ADD_PRODUCT_TOPIC;

  /** The public contact address. Shared by the visible label and the `mailto:`
   *  href so they can never drift. */
  protected readonly email = 'support@aecintegrations.com';
  protected readonly mailtoHref = `mailto:${this.email}`;
  /** The same address, with the subject and the prompt for a missing product filled in. */
  protected readonly addProductHref = `${this.mailtoHref}?subject=${encodeURIComponent(
    $localize`:@@app.contact.addProduct.subject:Please add my product to AEC Integrations`,
  )}&body=${encodeURIComponent(
    $localize`:@@app.contact.addProduct.prompt:Product name:\n\nWebsite:\n\nThe products it integrates with:\n`,
  )}`;

  constructor() {
    this.meta.setStaticPageMeta({
      title: $localize`:@@meta.contactTitle:Contact · AEC Integrations`,
      description: $localize`:@@meta.contactDescription:Get in touch with AEC Integrations. Questions, feedback, corrections, or press.`,
      canonical: canonicalUrl('/contact'),
    });
  }
}
