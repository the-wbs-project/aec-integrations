import { Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { map } from 'rxjs';

import type { TaxonomyResponse } from '@aeci/shared';

import { TOP_N, topByCount } from '../core/taxonomy/taxonomy-rank';

import { BrowseGrid } from './browse-grid';

/**
 * Home page. AECI-184 (Phase 4.9) builds the below-the-fold "Browse by" grids:
 * three count-chip subsections (category / audience / project phase) reading the
 * **live** aggregate taxonomy (`GET /api/taxonomy`, resolved SSR-side by
 * `homeBrowseResolver`), NOT `stats_cache`. Each facet is ranked by
 * `product_count` (`topByCount`) and capped — categories/audiences at `TOP_N`,
 * phases (a small facet) shown in full — with a "View all" link to the facet
 * index.
 *
 * The hero, three stats cards, recently-added and trending modules are sibling
 * Phase-4 issues (4.7 / 4.8 / 4.10); the 4.11 assembly issue (AECI-186) composes
 * the full page (and the visible hero `<h1>`, meta and JSON-LD). Until then the
 * page carries an sr-only `<h1>` so the heading order is valid and axe-clean.
 */
@Component({
  selector: 'app-home',
  imports: [BrowseGrid],
  template: `
    <div class="bg-(--surface-base) text-(--text-primary)">
      <div class="mx-auto w-full max-w-7xl px-6 py-8 md:px-8 md:py-12">
        <h1 class="sr-only" i18n="@@home.h1">AEC Integrations</h1>

        <div class="flex flex-col gap-10 md:gap-12">
          <app-browse-grid kind="category" [terms]="topCategories()" />
          <app-browse-grid kind="audience" [terms]="topAudiences()" />
          <app-browse-grid kind="phase" [terms]="allPhases()" />
        </div>
      </div>
    </div>
  `,
})
export class Home {
  private readonly route = inject(ActivatedRoute);

  private readonly browse = toSignal<TaxonomyResponse | null, TaxonomyResponse | null>(
    this.route.data.pipe(map((d) => (d['browse'] ?? null) as TaxonomyResponse | null)),
    { initialValue: (this.route.snapshot.data['browse'] ?? null) as TaxonomyResponse | null },
  );

  protected readonly topCategories = computed(() => topByCount(this.browse()?.categories, TOP_N));
  protected readonly topAudiences = computed(() => topByCount(this.browse()?.audiences, TOP_N));
  /** Phases is a small facet (~6–8 terms) — show every term, ranked. */
  protected readonly allPhases = computed(() => topByCount(this.browse()?.phases, Infinity));
}
