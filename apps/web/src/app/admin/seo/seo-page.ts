import { Component, signal } from '@angular/core';

import { SeoQueuePanel } from './seo-queue-panel';
import { SeoTrendPanel } from './seo-trend-panel';

/**
 * `/admin/seo`, the search console (AECI-822, `docs/ADMIN_PANEL_SPEC.md` §5.24).
 *
 * Panel 1, "Do this now", is the work list. Panel 2, "Am I keeping up?", is the
 * week-over-week record. Panel 3 belongs to AECI-823 and is absent until then,
 * not stubbed: a placeholder panel reads as broken.
 *
 * The gate and the nav SSR through `adminSummaryResolver` on the parent
 * `/admin` route, like every sibling screen. Each panel fetches its own endpoint
 * in `afterNextRender` and fails on its own (the `/admin/system` pattern,
 * §5.24.4). The screen writes nothing.
 *
 * The page owns the one polite live region (§5.24.11). Panel 1 reports a lane
 * change, a page change and a copy through it.
 *
 * `aec-charts` scopes the series palette to this screen (`DESIGN.md` §"Data
 * visualization").
 */
@Component({
  selector: 'aec-seo-page',
  imports: [SeoQueuePanel, SeoTrendPanel],
  host: { class: 'aec-charts block' },
  template: `
    <section aria-labelledby="admin-seo-heading" class="space-y-12">
      <div>
        <h2
          id="admin-seo-heading"
          class="text-xl font-bold text-(--text-primary)"
          i18n="@@admin.seo.heading"
        >
          Search
        </h2>
        <p
          class="mt-1 max-w-[62ch] text-sm text-pretty text-(--text-secondary)"
          i18n="@@admin.seo.subheading"
        >
          SEO work that is undone, then whether the backlog is shrinking. All times UTC.
        </p>
      </div>

      <p class="sr-only" role="status" aria-live="polite">{{ liveMessage() }}</p>

      <aec-seo-queue-panel (announce)="liveMessage.set($event)" />
      <aec-seo-trend-panel />
    </section>
  `,
})
export class SeoPage {
  protected readonly liveMessage = signal('');
}
