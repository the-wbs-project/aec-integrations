import { Component, input } from '@angular/core';

import type { IntegrationListItem } from '@aeci/shared';

import { IntegrationTile } from './integration-tile';

/**
 * AECI-185 (Phase 4.10) — the home "Recently added integrations" module: the
 * last 10 integrations (`recent_integrations` from `HomeStatsResponse`) as a 2-up
 * grid of `IntegrationTile`s. Presentational only — fed by a signal input; the
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

      @if (integrations().length) {
        <ul role="list" class="mt-4 grid gap-4 sm:grid-cols-2">
          @for (integration of integrations(); track integration.id) {
            <li><aec-integration-tile [integration]="integration" /></li>
          }
        </ul>
      } @else {
        <p
          class="mt-4 rounded-(--radius-lg) border border-dashed border-(--border-default)
            bg-(--surface-sunken) p-6 text-center text-sm text-(--text-secondary)"
          i18n="@@home.recent.empty"
        >
          No integrations added yet. The first vendor-verified integrations land at launch.
        </p>
      }
    </section>
  `,
})
export class RecentIntegrationsSection {
  readonly integrations = input.required<readonly IntegrationListItem[]>();
}
