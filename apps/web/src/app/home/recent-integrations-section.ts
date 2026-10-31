import { Component, computed, input } from '@angular/core';

import type { IntegrationListItem } from '@aeci/shared';

import { IntegrationTile } from './integration-tile';

/** Tiles on the home rail; matches the producer's cap (AECI-1559). */
const RECENT_TILE_LIMIT = 6;

/**
 * AECI-185 (Phase 4.10) — the home "Recently added integrations" module: up to
 * six integrations (`recent_integrations` from `HomeStatsResponse`, deduped to
 * two per source product by the producer, AECI-1559) as a grid of
 * `IntegrationTile`s, three columns at `lg`. The section slices to six itself
 * because a cache row written before AECI-1559 still holds ten. Presentational only — fed by a signal input; the
 * 4.11 assembly issue (AECI-186) wires the resolver and stacks the modules.
 *
 * Pre-launch the cache is sparse, so the empty state is first-class (a bordered
 * note, per `docs/design/home-direction.md`), not a blank void. The `<h2>` renders
 * in both branches so the section stays navigable by heading either way.
 *
 * No `aria-labelledby` region landmark: the heading carries the a11y navigation,
 * and a static labelledby id would collide when the component is rendered more
 * than once (e.g. the preview harness shows populated + empty side by side) while
 * a generated id would risk an SSR hydration mismatch. Both themes via tokens; no
 * explicit OnPush (Angular v22 default, AECI-125).
 */
@Component({
  selector: 'aec-recent-integrations-section',
  imports: [IntegrationTile],
  template: `
    <section>
      <h2
        class="font-display text-2xl font-semibold tracking-tight text-(--text-primary)"
        i18n="@@home.recent.heading"
      >
        Recently added integrations
      </h2>

      @if (shown().length) {
        <ul role="list" class="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          @for (integration of shown(); track integration.id) {
            <li><aec-integration-tile [integration]="integration" /></li>
          }
        </ul>
      } @else {
        <p
          class="mt-4 rounded-(--radius-lg) border border-dashed border-(--border-default)
            bg-(--surface-sunken) p-6 text-center text-sm text-(--text-secondary)"
          i18n="@@home.recent.empty"
        >
          No integrations added yet. The first integrations land at launch.
        </p>
      }
    </section>
  `,
})
export class RecentIntegrationsSection {
  readonly integrations = input.required<readonly IntegrationListItem[]>();

  /** The tiles rendered: at most `RECENT_TILE_LIMIT`. */
  protected readonly shown = computed(() => this.integrations().slice(0, RECENT_TILE_LIMIT));
}
