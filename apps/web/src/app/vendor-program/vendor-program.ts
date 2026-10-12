/**
 * The public vendor landing page (`/vendor-program`, AECI-1283). Governed by
 * `docs/VENDOR_PROGRAM_PAGE_SPEC.md`: §2 owns this file's route, caching and meta,
 * §3 the sections in order.
 *
 * **A shell today.** AECI-1283 ships the route, the hero (`h1` + subhead, §3 item 1)
 * and the `#find-your-product` anchor the claim CTA scrolls to (§4, §6). The other
 * §3 sections land in AECI-1284 to 1287. Add each as its own `<section>` with one
 * `h2`, in the §3 order, inside the body column below the hero.
 *
 * **Static + edge-cached + SSR-safe.** No data fetch and no per-visitor state: the
 * HTML is visitor-neutral (`/vendor-program` carries `Cache-Tag: route:index` on the
 * `/about` TTLs via `ROUTE_CACHE_PATTERNS` + `cacheTagInputsForPath`). Every
 * signed-in variant (§5) is applied after hydration, never at SSR. Indexable, in the
 * sitemap, with its own 1200×630 share card (`VENDOR_PROGRAM_OG_IMAGE`). Meta is set
 * from the constructor, like `/about`, so it ships in the SSR head and refreshes on
 * an in-app navigation.
 *
 * Copy rules (§8): sentence case, no em dashes, no statistics, and nothing that
 * suggests a plan affects ranking. Light theme only. Every string is i18n'd.
 */
import { Component, inject } from '@angular/core';

import { canonicalUrl } from '../core/canonical';
import { VENDOR_PROGRAM_OG_IMAGE } from '../core/meta.helpers';
import { MetaService } from '../core/meta.service';

@Component({
  selector: 'aec-vendor-program',
  template: `
    <div class="bg-(--surface-base) text-(--text-primary)">
      <!-- §3 item 1, the hero. The calls to action (§4) join it in AECI-1285. -->
      <section class="border-b border-(--border-default) bg-(--accent-warm)">
        <div class="mx-auto max-w-7xl px-6 py-16 md:px-8 md:py-20">
          <div class="max-w-[70ch]">
            <p class="aec-overline text-(--accent-primary)" i18n="@@app.vendorProgram.eyebrow">
              For software vendors
            </p>
            <h1
              class="mt-3 font-display text-4xl font-normal leading-[1.1] tracking-[-0.01em] text-(--text-primary) md:text-5xl"
              i18n="@@app.vendorProgram.headline"
            >
              Contractors compare your integrations here
            </h1>
            <p
              class="mt-5 text-lg leading-relaxed text-(--text-secondary)"
              i18n="@@app.vendorProgram.lede"
            >
              A listing on AEC Integrations is free to claim. Claim yours to keep what buyers read
              about your products and integrations accurate.
            </p>
          </div>
        </div>
      </section>

      <div class="mx-auto max-w-7xl px-6 py-12 md:px-8 md:py-16">
        <div class="flex flex-col gap-12">
          <!-- §3 item 3, Find your product (§6, AECI-1287). The claim CTA scrolls
               here, so the anchor ships first. -->
          <section id="find-your-product" class="scroll-mt-20"></section>
        </div>
      </div>
    </div>
  `,
})
export class VendorProgramPage {
  private readonly meta = inject(MetaService);

  constructor() {
    this.meta.setStaticPageMeta({
      title: $localize`:@@meta.vendorProgramTitle:List your AEC software for free · AEC Integrations`,
      description: $localize`:@@meta.vendorProgramDescription:Claim your free listing in the AEC software directory. Keep your products and construction software integrations accurate where AEC teams compare them.`,
      canonical: canonicalUrl('/vendor-program'),
      ogImage: VENDOR_PROGRAM_OG_IMAGE,
      ogImageAlt: $localize`:@@meta.vendorProgramOgImageAlt:AEC Integrations for software vendors: contractors compare your integrations here. Your listing is free to claim.`,
    });
  }
}
