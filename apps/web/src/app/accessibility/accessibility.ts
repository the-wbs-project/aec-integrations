/**
 * Accessibility statement (`/accessibility`, AECI-1673; counsel Q40, ruling 22).
 *
 * Governed by `docs/STAGE_1_SPEC.md` §27.6. The page states an aim ("we aim to
 * conform to WCAG 2.1 AA"), the test process we actually run, one contact route,
 * and a reply window we can meet every time. It never claims compliance.
 *
 * **Static + edge-cache / SSR-safe**, exactly like `/methodology`: no data fetch,
 * no per-visitor state, body inlined at build time. `Cache-Tag: route:index` on
 * the 24h edge / 1h browser static-page TTL via `ROUTE_CACHE_PATTERNS` +
 * `cacheTagInputsForPath`; indexable and in `sitemap.xml`. Meta is set from the
 * constructor so it ships in the SSR head and refreshes on in-app navigation.
 *
 * **i18n split.** The Markdown body is content and is not extracted (the
 * `/legal/*` rule; `src/content/README.md`). The chrome is `i18n`/`$localize`.
 *
 * Layout mirrors `/methodology` (the anchor reference for this surface). Light
 * theme only.
 */
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

import { canonicalUrl } from '../core/canonical';
import { MetaService } from '../core/meta.service';
import { ACCESSIBILITY_DOC, type AccessibilityDoc } from './accessibility-content';

@Component({
  selector: 'app-accessibility',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="bg-(--surface-base) text-(--text-primary)">
      <section class="border-b border-(--border-default) bg-(--accent-warm)">
        <div class="mx-auto max-w-7xl px-6 py-16 md:px-8 md:py-20">
          <div class="max-w-[70ch]">
            <!-- No eyebrow: it would only repeat the h1 (impeccable kicker-above-heading). -->
            <h1
              class="font-display text-4xl font-normal leading-[1.1] tracking-[-0.01em] text-(--text-primary) md:text-5xl"
            >
              {{ doc.frontmatter.title }}
            </h1>
            <!-- Authored pre-formatted in the frontmatter and rendered verbatim. -->
            <p class="mt-4 text-sm text-(--text-secondary)" i18n="@@app.accessibility.lastUpdated">
              Last updated {{ doc.frontmatter.lastUpdated }}
            </p>
          </div>
        </div>
      </section>

      <!-- Rendered Markdown (sanitized by Angular). Styled globally via .aec-prose. -->
      <div class="mx-auto max-w-7xl px-6 py-12 md:px-8 md:py-16">
        <article class="aec-prose max-w-[70ch]" [innerHTML]="doc.html"></article>
      </div>
    </div>
  `,
})
export class AccessibilityPage {
  private readonly meta = inject(MetaService);

  protected readonly doc: AccessibilityDoc = ACCESSIBILITY_DOC;

  constructor() {
    this.meta.setStaticPageMeta({
      title: $localize`:@@meta.accessibilityTitle:Accessibility statement · AEC Integrations`,
      description: $localize`:@@meta.accessibilityDescription:How AEC Integrations approaches accessibility: the standard we aim for, how we test each release, and how to report a barrier.`,
      canonical: canonicalUrl('/accessibility'),
    });
  }
}
