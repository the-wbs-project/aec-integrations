/**
 * The Plans page's pricing layout (`/docs/vendors/plans`): the Free and Managed
 * cards (`shared/plan-cta/plan-cards.ts`, shared with `/vendor-program` since
 * AECI-1285), the sort rule, then a side-by-side comparison table. Placed in the
 * page by the `<!-- docs:plans-comparison -->` line in `content/docs/vendors/plans.md`
 * (`docs-markdown.ts`, "Widgets"). The Markdown keeps the full prose, so search
 * and the "On this page" rail still read it. This is the at-a-glance view.
 *
 * Anchor site: **Mintlify**'s billing page, Mobbin screen
 * `c74405c6-a307-4e35-b8eb-21a1129ce5f3`. Flat bordered plan cards, the paid
 * one marked by a heavier border rather than a shadow or a gradient, then a
 * check-mark table grouped by area. AECi keeps its own tokens and type.
 *
 * **Every capability cell comes from `TIER_CAPABILITIES`.** A row that one or
 * more capabilities gate names them, and the cell reads the registry, so the
 * table cannot promise what the API will refuse. Rows with no capability (seat
 * rights, search-engine notice) state their values here and follow
 * `STAGE_2_PAID_TIERS_SPEC.md` §13. Connector-delivered integrations are not a
 * plan benefit and have no row (Chris, 2026-10-13).
 *
 * **Copy is benefit-first (marketing review, 2026-10-12).** Labels say what a
 * vendor gets, not what the portal calls the control. Portal how-tos
 * ("Looks right", checklist counts) live on `vendors/checklists`, and work not
 * yet shipped appears nowhere: not as a table row and not as a teaser in the
 * Markdown (Chris, 2026-10-13). Managed copy must never suggest it changes where a listing ranks or
 * appears (decision 10, §3.2): the note under the cards states the sort rule
 * instead.
 *
 * The price row prints the monthly and the annual list price (`MANAGED_LIST_PRICE_CENTS`
 * and `MANAGED_ANNUAL_PRICE_CENTS`, §13.13, E8.2), formatted by the same helper as the
 * portal's plan panel.
 *
 * The rows and the sort note live in `plans-comparison-groups.ts` and the card words
 * in `shared/plan-cta/plan-card-copy.ts` (AECI-1619), pure modules the Plans snapshot
 * (`plans-snapshot.ts`) prints from. A change to any of them is a new Plans version.
 *
 * Static: no fetch and no visitor state, so the SSR HTML and the hydrated HTML
 * match and the page stays edge-cacheable. Chrome only, so every string is
 * `$localize`d. Light only. Styled by the unlayered `.aec-plan-*` classes in
 * `styles.css`, because a border-color utility loses to the unlayered `*` rule
 * and this renders outside `.aec-prose`.
 */
import { Component, LOCALE_ID, inject } from '@angular/core';

import type { PlanCtaPage } from '../analytics/analytics';
import { PlanCardsComponent } from '../shared/plan-cta/plan-cards';
import { planLabel } from '../vendor/vendor-plan';
import { planComparisonGroups, planSortRuleNote } from './plans-comparison-groups';
import { AecIcon } from '../shared/icon/icon';

export {
  type PlanCell,
  type PlanRow,
  type PlanRowGroup,
  planComparisonGroups,
} from './plans-comparison-groups';

@Component({
  selector: 'app-docs-plans-comparison',
  imports: [AecIcon, PlanCardsComponent],
  host: { class: 'block' },
  template: `
    <aec-plan-cards [page]="page" />

    <p class="aec-plan-note mt-4 px-4 py-3 text-sm text-(--text-primary)">{{ sortRule }}</p>

    <div class="mt-8 overflow-x-auto">
      <table class="aec-plan-table w-full text-sm">
        <caption class="sr-only" i18n="@@app.docs.plans.table.caption">
          What each plan includes
        </caption>
        <thead>
          <tr>
            <th scope="col" class="aec-plan-table-feature">
              <span class="sr-only" i18n="@@app.docs.plans.table.feature">Feature</span>
            </th>
            <th scope="col" class="aec-plan-table-plan">{{ freeName }}</th>
            <th scope="col" class="aec-plan-table-plan">{{ managedName }}</th>
          </tr>
        </thead>
        @for (group of groups; track group.label) {
          <tbody>
            <tr>
              <th scope="colgroup" colspan="3" class="aec-plan-table-group">
                {{ group.label }}
              </th>
            </tr>
            @for (row of group.rows; track row.label) {
              <tr>
                <th scope="row" class="aec-plan-table-feature">{{ row.label }}</th>
                @for (cell of [row.free, row.managed]; track $index) {
                  <td class="aec-plan-table-plan">
                    @if (cell === true) {
                      <span class="flex justify-center text-(--accent-primary)">
                        <aec-icon name="check" decorative [size]="4" />
                      </span>
                      <span class="sr-only" i18n="@@app.docs.plans.table.included">Included</span>
                    } @else if (cell === false) {
                      <span class="flex justify-center text-(--text-tertiary)">
                        <aec-icon name="minus" decorative [size]="4" />
                      </span>
                      <span class="sr-only" i18n="@@app.docs.plans.table.notIncluded"
                        >Not included</span
                      >
                    } @else {
                      <span>{{ cell }}</span>
                    }
                  </td>
                }
              </tr>
            }
          </tbody>
        }
      </table>
    </div>
  `,
})
export class DocsPlansComparisonComponent {
  private readonly locale = inject(LOCALE_ID);
  /** This component lives on the vendor guide's Plans page only. */
  protected readonly page: PlanCtaPage = 'docs_plans';

  protected readonly freeName = planLabel('free');
  protected readonly managedName = planLabel('managed');
  protected readonly groups = planComparisonGroups(this.locale);
  protected readonly sortRule = planSortRuleNote();
}
