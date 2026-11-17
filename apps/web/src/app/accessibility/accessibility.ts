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
 * Layout mirrors `/methodology` (the anchor reference for this surface): the
 * hero on `aec-bone-band`, the body a white band on the 1328px page wrap, the
 * prose at the shared `.aec-prose` style and a 42rem measure (AECI-1804). Light
 * theme only.
 */
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

import { canonicalUrl } from '../core/canonical';
import { MetaService } from '../core/meta.service';
import { BAND_WRAP_CLASS } from '../shared/band-wrap';
import { BoneBand } from '../shared/bone-band/bone-band';
import { ACCESSIBILITY_DOC, type AccessibilityDoc } from './accessibility-content';

@Component({
  selector: 'app-accessibility',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BoneBand],
  template: `
    <div class="bg-(--surface-base) text-(--text-primary)">
      <!-- Hero: the page's one Bone band, as on /methodology and /legal/*
           (AECI-1804), with the h1 at the Headline role (the global h1 size). -->
      <aec-bone-band>
        <div class="max-w-[42rem]">
          <!-- No eyebrow: it would only repeat the h1 (impeccable kicker-above-heading). -->
          <h1 class="text-(--text-primary)">
            {{ doc.frontmatter.title }}
          </h1>
          <!-- Authored pre-formatted in the frontmatter and rendered verbatim. -->
          <p class="mt-4 text-t-14 text-(--text-secondary)" i18n="@@app.accessibility.lastUpdated">
            Last updated {{ doc.frontmatter.lastUpdated }}
          </p>
        </div>
      </aec-bone-band>

      <!-- Rendered Markdown (sanitized by Angular). Styled globally via .aec-prose.
           White band on the page wrap; the article keeps the rem prose measure. -->
      <div class="py-16 md:py-24">
        <div [class]="wrap">
          <article class="aec-prose max-w-[42rem]" [innerHTML]="doc.html"></article>
        </div>
      </div>
    </div>
  `,
})
export class AccessibilityPage {
  private readonly meta = inject(MetaService);

  protected readonly doc: AccessibilityDoc = ACCESSIBILITY_DOC;

  /** The 1328px page wrap the header, footer and bands share. */
  protected readonly wrap = BAND_WRAP_CLASS;

  constructor() {
    this.meta.setStaticPageMeta({
      title: $localize`:@@meta.accessibilityTitle:Accessibility statement · AEC Integrations`,
      description: $localize`:@@meta.accessibilityDescription:How AEC Integrations approaches accessibility: the standard we aim for, how we test each release, and how to report a barrier.`,
      canonical: canonicalUrl('/accessibility'),
    });
  }
}
