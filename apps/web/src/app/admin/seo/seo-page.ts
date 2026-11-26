import { Component, computed, signal } from '@angular/core';

import { SeoFunnelPanel } from './seo-funnel-panel';
import { SeoQueuePanel } from './seo-queue-panel';
import { SeoTrendPanel } from './seo-trend-panel';

/**
 * `/admin/seo`, the search console (AECI-822, `docs/ADMIN_PANEL_SPEC.md` §5.24).
 *
 * Panel 1, "Do this now", is the work list. Panel 2, "Am I keeping up?", is the
 * week-over-week record. Panel 3, "Is it working?", is each engine's search
 * funnel (AECI-823).
 *
 * The gate and the nav SSR through `adminSummaryResolver` on the parent
 * `/admin` route, like every sibling screen. Each panel fetches its own endpoint
 * in `afterNextRender` and fails on its own (the `/admin/system` pattern,
 * §5.24.4). The screen writes nothing.
 *
 * The page owns the one polite live region (§5.24.11). Panel 1 reports a lane
 * change, a page change and a copy through it. Every panel reports how a retry
 * settled through it.
 *
 * `aec-charts` scopes the series palette to this screen (`DESIGN.md` §"Data
 * visualization").
 */
@Component({
  selector: 'aec-seo-page',
  imports: [SeoQueuePanel, SeoTrendPanel, SeoFunnelPanel],
  host: { class: 'aec-charts block' },
  template: `
    <section aria-labelledby="admin-seo-heading" class="space-y-12">
      <div>
        <h2 id="admin-seo-heading" class="text-(--text-primary)" i18n="@@admin.seo.heading">
          Search
        </h2>
        <p
          class="mt-1 max-w-[62ch] text-sm text-pretty text-(--text-secondary)"
          i18n="@@admin.seo.subheading"
        >
          SEO work that is undone, then whether the backlog is shrinking, then whether crawling
          turns into impressions and clicks. All times UTC unless a figure says Pacific.
        </p>
      </div>

      <!-- Each message renders a NEW span, keyed by a counter, so the same text
           twice (copying one URL twice) is still a DOM change a screen reader
           announces. No timer and no clear-then-set, which zoneless would batch
           into nothing. -->
      <p class="sr-only" role="status" aria-live="polite">
        @for (m of liveMessages(); track m.id) {
          <span>{{ m.text }}</span>
        }
      </p>

      <aec-seo-queue-panel (announce)="announce($event)" />
      <aec-seo-trend-panel (announce)="announce($event)" />
      <aec-seo-funnel-panel (announce)="announce($event)" />
    </section>
  `,
})
export class SeoPage {
  private readonly live = signal<{ id: number; text: string }>({ id: 0, text: '' });
  /** The live region's content: one entry, replaced on every message. */
  protected readonly liveMessages = computed(() => {
    const m = this.live();
    return m.text ? [m] : [];
  });

  protected announce(text: string): void {
    this.live.update((m) => ({ id: m.id + 1, text }));
  }
}
