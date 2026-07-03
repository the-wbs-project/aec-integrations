/**
 * Contact page (`/contact`, AECI-238 / Phase 7.3). Stage 1 contact path is a
 * `mailto:` link (the acceptance criteria explicitly permits it; no contact form
 * and no `/api/contact` endpoint — vendor/listing issues already flow through the
 * per-entity claim/correction forms). A short editorial intro, the email as the
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
 */
import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';

import { canonicalUrl } from '../core/canonical';
import { MetaService } from '../core/meta.service';

@Component({
  selector: 'app-contact',
  imports: [RouterLink],
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

  /** Stage 1 contact address (matches the landing page). Shared by the visible
   *  label and the `mailto:` href so they can never drift. */
  protected readonly email = 'founders@thewbsproject.com';
  protected readonly mailtoHref = `mailto:${this.email}`;

  constructor() {
    this.meta.setStaticPageMeta({
      title: $localize`:@@meta.contactTitle:Contact · AEC Integrations`,
      description: $localize`:@@meta.contactDescription:Get in touch with AEC Integrations. Questions, feedback, corrections, or press.`,
      canonical: canonicalUrl('/contact'),
    });
  }
}
