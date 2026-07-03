import { Component } from '@angular/core';

/**
 * Browse layout shell — projected into by product, vendor, and integration
 * browse pages. Named slots only; no state. Filter-sidebar interactivity is
 * a Phase 3 concern (this skeleton only reserves the slot).
 *
 * Anchor: Stripe (inherited from AECi site chrome). See `DESIGN.md`
 * §"Named Rules" → "The Anchor-Site Rule".
 *
 * Spec: Phase 2 Spec §11.1 (`docs/STAGE_1_PHASE_2_SPEC.md:423`).
 *
 * Slots:
 *   - `header`  — page title / strapline / counts (required)
 *   - `filters` — Phase 3 filter sidebar (collapses above grid on `< md`)
 *   - `grid`    — card grid of results (required)
 *
 * Usage:
 * ```html
 * <aec-browse-layout>
 *   <header slot="header">…</header>
 *   <aside slot="filters">…</aside>
 *   <section slot="grid">…</section>
 * </aec-browse-layout>
 * ```
 */
@Component({
  selector: 'aec-browse-layout',
  template: `
    <div class="bg-(--surface-base) text-(--text-primary)">
      <div class="mx-auto w-full max-w-7xl px-6 pt-3 pb-8 md:px-8 md:pt-4 md:pb-12">
        <header class="mb-8 border-b border-(--border-default) pb-6 md:mb-12 md:pb-8">
          <ng-content select="[slot=header]" />
        </header>

        <div class="grid gap-8 md:grid-cols-[minmax(0,1fr)_minmax(0,3fr)] md:gap-12">
          <aside
            class="md:self-start"
            i18n-aria-label="@@app.layouts.browse.filters.aria"
            aria-label="Filters"
          >
            <ng-content select="[slot=filters]" />
          </aside>

          <section
            class="min-w-0"
            i18n-aria-label="@@app.layouts.browse.grid.aria"
            aria-label="Results"
          >
            <ng-content select="[slot=grid]" />
          </section>
        </div>
      </div>
    </div>
  `,
})
export class BrowseLayout {}
