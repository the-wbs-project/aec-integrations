import { ChangeDetectionStrategy, Component, computed, signal } from '@angular/core';

import { SearchProductCard } from '../../search/search-product-card';
import { FIXTURE_PRODUCTS, REPRESENTATIVE_QUERIES } from './search-relevance.fixtures';
import {
  DEFAULT_BLEND_WEIGHTS,
  rankProducts,
  STRATEGIES,
  strategyMeta,
  type BlendWeights,
  type ScoredHit,
  type StrategyId,
} from './ranking-strategies';

interface DiffRow extends ScoredHit {
  /** Rank of this product under the Baseline strategy (same query). */
  readonly baselineRank: number | null;
  /** baselineRank − rank: positive = moved up vs Baseline. */
  readonly delta: number | null;
}

/**
 * Dev-only "search relevance lab" for the §7 tuning loop (AECI-286).
 *
 * Top zone = a premium results surface (the real `SearchProductCard`) so you can
 * *feel* how a candidate `customRanking` reorders results; bottom zone = a signal
 * / rank-delta panel that explains *why*. Ranks the curated AEC fixtures with the
 * pure strategies in `ranking-strategies.ts` — no Algolia, no secrets, runs in any
 * workspace. It models Algolia's ranking client-side; it is not Algolia itself
 * (see the on-page caveat + the module header).
 *
 * Route: `/preview/search-relevance`, production-blocked by `isPreviewPath`
 * (`server-runtime.ts`). Not linked from product navigation. Preview copy is
 * intentionally not i18n-wrapped (matches the other preview harnesses).
 */
@Component({
  selector: 'app-search-relevance-preview',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SearchProductCard],
  host: { class: 'block' },
  template: `
    <main class="mx-auto max-w-7xl space-y-8 px-6 py-12">
      <header class="space-y-2">
        <h1 class="font-display text-3xl font-semibold tracking-tight text-(--text-primary)">
          Search relevance lab (AECI-286)
        </h1>
        <p class="max-w-3xl text-sm leading-relaxed text-(--text-secondary)">
          Compare the candidate <code>customRanking</code> levers from
          <code>SEARCH_RANKING.md</code> §7 before there is real query data. Pick a query, switch
          strategy, and watch the order change. The signal panel below shows the rank delta vs
          Baseline.
        </p>
      </header>

      <!-- Query -->
      <section class="space-y-3" aria-labelledby="srl-query">
        <h2
          id="srl-query"
          class="text-xs font-medium tracking-wide text-(--text-tertiary) uppercase"
        >
          Query
        </h2>
        <input
          type="search"
          [value]="query()"
          (input)="onQuery($event)"
          placeholder="Type a query…"
          aria-label="Search query"
          class="w-full max-w-md rounded-(--radius-md) border border-(--border-default) bg-(--surface-raised) px-3 py-2 text-sm text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
        />
        <ul class="flex flex-wrap gap-2">
          @for (preset of presets; track preset.value) {
            <li>
              <button
                type="button"
                (click)="query.set(preset.value)"
                [attr.aria-pressed]="query() === preset.value"
                [class]="chipClass(query() === preset.value)"
              >
                {{ preset.label }}
              </button>
            </li>
          }
        </ul>
      </section>

      <!-- Strategy -->
      <section class="space-y-3" aria-labelledby="srl-strategy">
        <h2
          id="srl-strategy"
          class="text-xs font-medium tracking-wide text-(--text-tertiary) uppercase"
        >
          Ranking strategy
        </h2>
        <div class="flex flex-wrap gap-2">
          @for (strat of strategies; track strat.id) {
            <button
              type="button"
              (click)="strategy.set(strat.id)"
              [attr.aria-pressed]="strategy() === strat.id"
              [class]="chipClass(strategy() === strat.id)"
            >
              {{ strat.label }}
            </button>
          }
        </div>
        <p class="max-w-3xl text-sm leading-relaxed text-(--text-secondary)">
          {{ activeMeta().blurb }}
        </p>

        @if (activeMeta().id === 'blend') {
          <div
            class="flex flex-wrap items-end gap-6 rounded-(--radius-md) border border-(--border-default) bg-(--surface-muted) p-4"
          >
            @for (lever of weightLevers; track lever.key) {
              <label class="flex flex-col gap-1 text-sm text-(--text-secondary)">
                <span class="flex items-center justify-between gap-4">
                  <span>{{ lever.label }}</span>
                  <span class="tabular-nums text-(--text-primary)">{{
                    pct(weights()[lever.key])
                  }}</span>
                </span>
                <input
                  type="range"
                  min="0"
                  max="100"
                  step="5"
                  [value]="weights()[lever.key] * 100"
                  (input)="onWeight(lever.key, $event)"
                  class="w-44 accent-(--accent-primary)"
                />
              </label>
            }
            <button type="button" (click)="resetWeights()" [class]="chipClass(false)">Reset</button>
          </div>
        }
      </section>

      <!-- Premium results surface -->
      <section class="space-y-4" aria-labelledby="srl-results">
        <div class="flex items-baseline justify-between gap-4">
          <h2
            id="srl-results"
            class="font-display text-xl font-semibold tracking-tight text-(--text-primary)"
          >
            Results: {{ activeMeta().label }}
          </h2>
          <p role="status" class="text-sm tabular-nums text-(--text-tertiary)">
            {{ results().length }} {{ results().length === 1 ? 'result' : 'results' }}
          </p>
        </div>

        @if (strategy() !== 'baseline') {
          <p class="text-xs text-(--text-tertiary)">
            Badges show each result's movement vs Baseline (▲ up, ▼ down).
          </p>
        }

        @if (rows().length) {
          <ol class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            @for (hit of rows(); track hit.record.objectID) {
              <li class="relative">
                <span
                  class="pointer-events-none absolute -top-2 -left-2 z-10 flex h-7 min-w-7 items-center justify-center rounded-full border border-(--border-default) bg-(--surface-base) px-1.5 text-xs font-semibold tabular-nums text-(--text-secondary)"
                  aria-hidden="true"
                  >{{ hit.rank }}</span
                >
                @if (strategy() !== 'baseline' && hit.delta) {
                  <span
                    class="pointer-events-none absolute -top-2 -right-2 z-10 flex h-7 items-center justify-center rounded-full border border-(--border-default) bg-(--surface-base) px-2 text-xs font-semibold tabular-nums"
                    [style.color]="deltaColor(hit.delta)"
                    [attr.aria-label]="deltaAria(hit.delta)"
                    >{{ deltaLabel(hit.delta) }}</span
                  >
                }
                <aec-search-product-card [record]="hit.record" />
              </li>
            }
          </ol>
        } @else {
          <p
            class="rounded-(--radius-md) border border-(--border-default) bg-(--surface-muted) p-6 text-sm text-(--text-secondary)"
          >
            No matches for “{{ query() }}”. Try a broader query or “Browse (no query)”.
          </p>
        }
      </section>

      <!-- Signal / diff panel -->
      <section class="space-y-4" aria-labelledby="srl-signals">
        <h2
          id="srl-signals"
          class="font-display text-xl font-semibold tracking-tight text-(--text-primary)"
        >
          Ranking signals &amp; rank delta vs Baseline
        </h2>
        <div class="overflow-x-auto rounded-(--radius-lg) border border-(--border-default)">
          <table class="w-full min-w-[44rem] border-collapse text-sm">
            <caption class="sr-only">
              Per-result ranking signals and rank change versus the Baseline strategy
            </caption>
            <thead>
              <tr class="border-b border-(--border-default) text-start text-(--text-tertiary)">
                <th scope="col" class="px-3 py-2 font-medium">#</th>
                <th scope="col" class="px-3 py-2 text-end font-medium">Δ</th>
                <th scope="col" class="px-3 py-2 font-medium">Product</th>
                <th scope="col" class="px-3 py-2 font-medium">Vendor</th>
                <th scope="col" class="px-3 py-2 text-end font-medium">Text</th>
                <th scope="col" class="px-3 py-2 text-end font-medium">Integr.</th>
                <th scope="col" class="px-3 py-2 text-end font-medium">Reviews</th>
                <th scope="col" class="px-3 py-2 text-end font-medium">Rating</th>
                <th scope="col" class="px-3 py-2 text-end font-medium">Score</th>
              </tr>
            </thead>
            <tbody>
              @for (row of rows(); track row.record.objectID) {
                <tr class="border-b border-(--border-default) last:border-0">
                  <td class="px-3 py-2 tabular-nums text-(--text-secondary)">{{ row.rank }}</td>
                  <td class="px-3 py-2 text-end">
                    <span [class]="deltaClass(row.delta)">{{ deltaLabel(row.delta) }}</span>
                  </td>
                  <th scope="row" class="px-3 py-2 font-medium text-(--text-primary)">
                    {{ row.record.name }}
                  </th>
                  <td class="px-3 py-2 text-(--text-secondary)">
                    {{ row.record.vendor_name ?? '-' }}
                  </td>
                  <td class="px-3 py-2 text-end tabular-nums text-(--text-secondary)">
                    {{ row.textScore.toFixed(2) }}
                  </td>
                  <td class="px-3 py-2 text-end tabular-nums text-(--text-secondary)">
                    {{ row.record.integration_count }}
                  </td>
                  <td class="px-3 py-2 text-end tabular-nums text-(--text-secondary)">
                    {{ row.record.review_count }}
                  </td>
                  <td class="px-3 py-2 text-end tabular-nums text-(--text-secondary)">
                    {{ rating(row.record.rating_overall_avg) }}
                  </td>
                  <td class="px-3 py-2 text-end tabular-nums text-(--text-secondary)">
                    {{ scoreLabel(row.score) }}
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>

        <p class="max-w-3xl text-xs leading-relaxed text-(--text-tertiary)">
          Caveat: this models Algolia's ranking client-side over fixtures; it is not Algolia. The
          Text score is a deterministic token-overlap proxy weighted by field in the same order as
          the real <code>searchableAttributes</code> (name › vendor › taxonomy › description). The
          lexicographic strategies (Baseline, Ratings-forward) mirror Algolia, where signals only
          break textual ties; the weighted strategies (Coverage-weighted, Balanced blend) are a
          best-match composite where signals can override text. The final tie-break is name A-Z,
          standing in for Algolia's arbitrary index order so the lab is reproducible.
        </p>
      </section>
    </main>
  `,
})
export class SearchRelevancePreview {
  protected readonly strategies = STRATEGIES;
  protected readonly presets = REPRESENTATIVE_QUERIES;
  protected readonly weightLevers = [
    { key: 'text', label: 'Text' },
    { key: 'coverage', label: 'Coverage' },
    { key: 'ratings', label: 'Ratings' },
  ] as const satisfies readonly { key: keyof BlendWeights; label: string }[];

  // Default to a query where the strategies diverge hard (different #1 under
  // Baseline / Ratings-forward / Coverage-weighted) so the effect is obvious.
  protected readonly query = signal('scheduling');
  protected readonly strategy = signal<StrategyId>('baseline');
  protected readonly weights = signal<BlendWeights>(DEFAULT_BLEND_WEIGHTS);

  protected readonly activeMeta = computed(() => strategyMeta(this.strategy()));

  protected readonly results = computed(() =>
    rankProducts(this.query(), FIXTURE_PRODUCTS, this.strategy(), this.weights()),
  );

  private readonly baselineRankById = computed(() => {
    const ranks = new Map<string, number>();
    for (const hit of rankProducts(this.query(), FIXTURE_PRODUCTS, 'baseline')) {
      ranks.set(hit.record.objectID, hit.rank);
    }
    return ranks;
  });

  protected readonly rows = computed<DiffRow[]>(() => {
    const baselineRanks = this.baselineRankById();
    return this.results().map((hit) => {
      const baselineRank = baselineRanks.get(hit.record.objectID) ?? null;
      return { ...hit, baselineRank, delta: baselineRank == null ? null : baselineRank - hit.rank };
    });
  });

  protected onQuery(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }

  protected onWeight(key: keyof BlendWeights, event: Event): void {
    const value = (event.target as HTMLInputElement).valueAsNumber / 100;
    this.weights.update((current) => ({ ...current, [key]: value }));
  }

  protected resetWeights(): void {
    this.weights.set(DEFAULT_BLEND_WEIGHTS);
  }

  protected pct(value: number): string {
    return `${Math.round(value * 100)}%`;
  }

  protected rating(value: number | null): string {
    return value == null ? '-' : value.toFixed(1);
  }

  /** Composite score for weighted strategies; '-' for lexicographic ones (no single scalar). */
  protected scoreLabel(score: number): string {
    return this.activeMeta().kind === 'weighted' ? score.toFixed(3) : '-';
  }

  protected deltaLabel(delta: number | null): string {
    if (delta == null || delta === 0) return '-';
    return delta > 0 ? `▲${delta}` : `▼${-delta}`;
  }

  protected deltaClass(delta: number | null): string {
    const base = 'font-medium tabular-nums';
    if (delta == null || delta === 0) return `${base} text-(--text-tertiary)`;
    return delta > 0 ? `${base} text-(--accent-primary)` : `${base} text-(--accent-secondary-deep)`;
  }

  /** Token color for the on-card movement badge (up = forest, down = clay deep). */
  protected deltaColor(delta: number | null): string {
    if (delta == null || delta === 0) return 'var(--text-tertiary)';
    return delta > 0 ? 'var(--accent-primary)' : 'var(--accent-secondary-deep)';
  }

  protected deltaAria(delta: number | null): string {
    if (delta == null || delta === 0) return 'unchanged from Baseline';
    return delta > 0 ? `up ${delta} from Baseline` : `down ${-delta} from Baseline`;
  }

  protected chipClass(active: boolean): string {
    const base =
      'rounded-(--radius-md) border px-3 py-1.5 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';
    return active
      ? `${base} border-(--accent-primary) bg-(--accent-primary-soft) text-(--text-primary)`
      : `${base} border-(--border-default) bg-(--surface-raised) text-(--text-secondary) hover:border-(--border-strong)`;
  }
}
