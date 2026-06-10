import { Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { map } from 'rxjs';

import type { TaxonomyResponse } from '@aeci/shared';

import { TOP_N, topByCount } from '../core/taxonomy/taxonomy-rank';

import { BrowseGrid } from './browse-grid';
import { HomeHero } from './home-hero';

/**
 * Home page (`/`). The page is assembled in phases (Stage 1 §4.1): 4.7 hero,
 * 4.8 stats cards, 4.9 "Browse by" grids (this), 4.10 recently-added / trending,
 * and 4.11 final assembly + meta / JSON-LD / Cache-Tag (AECI-186). It stacks the
 * shipped modules top-to-bottom; later phases append theirs below.
 *
 * AECI-184 (4.9) adds the below-the-fold "Browse by" grids: three count-chip
 * subsections (category / audience / project phase) reading the **live**
 * aggregate taxonomy (`GET /api/taxonomy`, resolved SSR-side by
 * `homeBrowseResolver`), NOT `stats_cache`. Each facet is ranked by
 * `product_count` (`topByCount`) and capped — categories/audiences at `TOP_N`,
 * phases (a small facet) shown in full — with a "View all" link to the facet
 * index. The hero owns the page `<h1>`; the grids render as `<h2>` sections
 * beneath it, so the heading order stays valid and axe-clean.
 */
@Component({
  selector: 'app-home',
  imports: [HomeHero, BrowseGrid],
  template: `
    <div class="bg-(--surface-base) text-(--text-primary)">
      <aec-home-hero />

      <div class="mx-auto w-full max-w-7xl px-6 py-8 md:px-8 md:py-12">
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
