/**
 * Contact page (`/contact`, AECI-238 / Phase 7.3). The general contact path is a
 * `mailto:` link (the acceptance criteria explicitly permits it; no general contact
 * form and no `/api/contact` endpoint — vendor/listing issues already flow through
 * the per-entity claim/correction forms). The one form here is the Managed plan
 * inquiry on `?topic=managed` (AECI-1279, below). A short editorial intro, the email as the
 * primary contact path, and a pointer to the correction flow for listing fixes.
 *
 * **Non-cacheable, SSR, indexable.** `/contact` is "No cache" per §3.1 — it is not
 * in `ROUTE_CACHE_PATTERNS`, so the SSR Worker emits the fail-closed default
 * `private, no-store` (no `Cache-Tag`). It is still a canonical, indexable content
 * page, so `setStaticPageMeta` sets title + description + canonical + OG with no
 * `robots` tag. Meta is set from the constructor (like `Home`) so it ships in the
 * SSR head AND refreshes on an in-app navigation.
 *
 * Voice per `PRODUCT.md`: quiet, functional, sentence case, no exclamation marks.
 * Layout per `DESIGN.md`: warm Bone (`accent-warm`) hero band, body capped at
 * 70ch, Source Serif headings, Atkinson body. Light theme only (Stage 1). All
 * strings authored with `i18n`/`$localize`; the email address itself is literal
 * (not translated) and shared between the visible label and the `mailto:` href.
 *
 * **`?topic=managed`** (the plan call-to-action buttons, `shared/plan-cta/`).
 * Those pages open the plan inquiry form in a dialog (AECI-1279). This page is
 * those buttons' link target, so a click without JS, or into a new tab, lands on the
 * same form, inline (`PlanInquiryForm`, `POST /api/plan-inquiries`). The page also
 * says what happens next. Any other topic value is ignored. `/contact` is not cached,
 * so reading the query in SSR is safe, and the canonical URL stays `/contact`. The
 * general "Email us" card is unchanged for every other question.
 *
 * **`?topic=add-product`** (`VENDOR_PROGRAM_PAGE_SPEC.md` §6; its in-app link,
 * Find your product, was removed on 2026-10-12, and the topic keeps working for
 * outside links). A vendor whose product is not in the
 * directory asks us to add it. The in-app path is the claim dialog's typed-in step
 * (a listing request, §15.4). This topic is the fallback for outside links: the
 * page shows a panel whose button is the same support `mailto:` with the subject
 * and a prompt filled in: product name, website, and the products it integrates
 * with. The message reaches the same mailbox as every other email.
 * Topic values live in `contact-topics.ts`.
 */
import { Component, inject } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';

import { canonicalUrl } from '../core/canonical';
import { MetaService } from '../core/meta.service';
import { PlanInquiryForm } from '../shared/plan-inquiry/plan-inquiry-form';
import { ADD_PRODUCT_TOPIC, MANAGED_TOPIC } from './contact-topics';

@Component({
  selector: 'app-contact',
  imports: [RouterLink, PlanInquiryForm],
  template: `
    <div class="bg-(--surface-base) text-(--text-primary)">
      <section class="border-b border-(--border-default) bg-(--accent-warm)">
        <div class="mx-auto max-w-7xl px-6 py-16 md:px-8 md:py-20">
          <div class="max-w-[70ch]">
            <p class="aec-overline text-(--accent-primary)" i18n="@@app.contact.eyebrow">Contact</p>
            <h1
              class="mt-3 font-display text-4xl font-normal leading-[1.1] tracking-[-0.01em] text-(--text-primary) md:text-5xl"
              i18n="@@app.contact.headline"
            >
              Get in touch
            </h1>
            <p
              class="mt-5 text-lg leading-relaxed text-(--text-secondary)"
              i18n="@@app.contact.lede"
            >
              Questions, feedback, corrections, or press: we read everything and reply to most
              messages within a couple of business days.
            </p>
          </div>
        </div>
      </section>

      <div class="mx-auto max-w-7xl px-6 py-12 md:px-8 md:py-16">
        @if (managed) {
          <section
            class="mb-6 max-w-5xl rounded-(--radius-lg) border border-(--border-default) bg-(--surface-raised) p-6 md:p-8"
            data-testid="contact-managed"
          >
            <h2
              class="font-display text-2xl font-normal leading-snug text-(--text-primary) md:text-3xl"
              i18n="@@app.contact.managed.heading"
            >
              Talk to us about Managed
            </h2>
            <p
              class="mt-4 max-w-[70ch] text-base leading-relaxed text-(--text-secondary)"
              i18n="@@app.contact.managed.formBody"
            >
              Tell us who you are and which products you want on Managed. We agree the price and the
              term with you, then switch Managed on for your company.
            </p>
            <div class="mt-6 max-w-xl">
              <aec-plan-inquiry-form idPrefix="contact-plan-inquiry" placement="contact" />
            </div>
          </section>
        }
        @if (addProduct) {
          <section
            class="mb-6 max-w-5xl rounded-(--radius-lg) border border-(--border-default) bg-(--surface-raised) p-6 md:p-8"
            data-testid="contact-add-product"
          >
            <h2
              class="font-display text-2xl font-normal leading-snug text-(--text-primary) md:text-3xl"
              i18n="@@app.contact.addProduct.heading"
            >
              Ask us to add your product
            </h2>
            <p
              class="mt-4 max-w-[70ch] text-base leading-relaxed text-(--text-secondary)"
              i18n="@@app.contact.addProduct.body"
            >
              Email us the product name, its website, and the products it integrates with. The email
              opens with these questions filled in.
            </p>
            <a
              [href]="addProductHref"
              class="mt-6 inline-flex items-center justify-center rounded-(--radius-md) bg-(--accent-primary) px-5 py-3 text-sm font-semibold text-(--surface-base) no-underline transition-colors hover:bg-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
              i18n="@@app.contact.addProduct.cta"
            >
              Email us about your product
            </a>
          </section>
        }
        <div class="grid max-w-5xl gap-6 md:grid-cols-2">
          <section
            class="flex h-full flex-col rounded-(--radius-lg) border border-(--border-default) bg-(--surface-raised) p-6 md:p-8"
          >
            <h2
              class="font-display text-2xl font-normal leading-snug text-(--text-primary) md:text-3xl"
              i18n="@@app.contact.email.heading"
            >
              Email us
            </h2>
            <p
              class="mt-4 text-base leading-relaxed text-(--text-secondary)"
              i18n="@@app.contact.email.body"
            >
              The fastest way to reach us is email. Tell us what you are working on and we will
              route your message to the right person.
            </p>
            <p class="mt-4 text-base">
              <a
                [href]="mailtoHref"
                class="font-medium text-(--accent-primary) hover:text-(--accent-primary-hover)"
              >
                {{ email }}
              </a>
            </p>
            <a
              [href]="mailtoHref"
              class="mt-auto inline-flex items-center justify-center self-start rounded-(--radius-md) bg-(--accent-primary) px-5 py-3 text-sm font-semibold text-(--surface-base) no-underline transition-colors hover:bg-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
              i18n="@@app.contact.email.cta"
            >
              Email us
            </a>
          </section>

          <section
            class="flex h-full flex-col rounded-(--radius-lg) border border-(--border-default) bg-(--surface-raised) p-6 md:p-8"
          >
            <h2
              class="font-display text-2xl font-normal leading-snug text-(--text-primary) md:text-3xl"
              i18n="@@app.contact.corrections.heading"
            >
              Corrections to a listing
            </h2>
            <p
              class="mt-4 text-base leading-relaxed text-(--text-secondary)"
              i18n="@@app.contact.corrections.body"
            >
              Spotted something inaccurate on a product or vendor page? Every listing has a way to
              claim it or suggest a correction. Open the relevant page from the directory, or email
              us directly and we will make sure it gets reviewed.
            </p>
            <a
              routerLink="/products"
              class="mt-auto inline-flex items-center justify-center self-start rounded-(--radius-md) bg-(--accent-primary) px-5 py-3 text-sm font-semibold text-(--surface-base) no-underline transition-colors hover:bg-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
              i18n="@@app.contact.corrections.cta"
            >
              Browse listings
            </a>
          </section>
        </div>
      </div>
    </div>
  `,
})
export class ContactPage {
  private readonly meta = inject(MetaService);

  private readonly topic = inject(ActivatedRoute).snapshot.queryParamMap.get('topic');
  /** `?topic=managed`: asked from the Plans page. */
  protected readonly managed = this.topic === MANAGED_TOPIC;
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
