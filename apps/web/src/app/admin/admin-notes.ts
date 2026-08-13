import { ChangeDetectionStrategy, Component, input } from '@angular/core';

import type { AdminNote, AdminNoteCode } from '@aeci/shared';

/**
 * Renders the admin panel's honesty envelope (`ADMIN_PANEL_SPEC.md` §1.1) — the
 * `AdminNote[]` every `/api/admin/*` read carries, naming the biases that apply
 * to that particular response.
 *
 * **Why this is a shared component and not inline prose.** The API deliberately
 * ships `code` + `params` as the contract and leaves `message` untranslated
 * (`admin-panel.ts`: *"`message` is a plain-English operator fallback for curl /
 * logs and is deliberately NOT translated"*). CLAUDE.md's i18n rule is
 * unconditional, admin-only or not, so the localized string has to live on the
 * UI side — and every panel screen (AECI-576/577/578/579/580) renders the same
 * vocabulary. One mapping, one place: a note added to the API without a string
 * here fails loudly at the `never` in {@link AdminNotes.text}.
 *
 * `severity` drives the treatment: `warn` is a note whose absence would make a
 * reader draw the *wrong* conclusion (a one-stage funnel looks broken); `info` is
 * context. Neither is an error state — these describe the data, not a failure.
 */
@Component({
  selector: 'aec-admin-notes',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let items = notes();
    @if (items.length > 0) {
      <ul role="list" class="space-y-2">
        @for (n of items; track n.code + $index) {
          <li
            class="rounded-(--radius-md) border px-3 py-2 text-xs leading-relaxed"
            [class]="
              n.severity === 'warn'
                ? 'border-(--accent-secondary) bg-(--accent-warm) text-(--text-primary)'
                : 'border-(--border-default) bg-(--surface-sunken) text-(--text-secondary)'
            "
          >
            <span class="sr-only">{{ severityLabel(n.severity) }}: </span>{{ text(n) }}
          </li>
        }
      </ul>
    }
  `,
  styles: [':host { display: block; }'],
})
export class AdminNotes {
  readonly notes = input.required<readonly AdminNote[]>();

  /** Screen-reader prefix so the visual distinction between warn and info is not
   *  the only thing carrying it. */
  protected severityLabel(severity: AdminNote['severity']): string {
    return severity === 'warn'
      ? $localize`:@@admin.notes.severity.warn:Caveat`
      : $localize`:@@admin.notes.severity.info:Note`;
  }

  /**
   * `code` + `params` → localized prose. The exhaustive switch is the point: the
   * `never` in the default branch makes a new `AdminNoteCode` a compile error
   * here, which is how the API and the UI stay in step.
   */
  protected text(n: AdminNote): string {
    const p = n.params ?? {};
    const code: AdminNoteCode = n.code;
    switch (code) {
      case 'partial_day':
        return $localize`:@@admin.notes.partialDay:This window includes today (UTC), so its last bucket is still filling.`;

      case 'bot_classification_incomplete':
        return $localize`:@@admin.notes.botClassificationIncomplete:Page views recorded before bot classification existed (${p['rows']}:ROWS: here) are counted as human, so the human figure is an upper bound.`;

      case 'referrer_source_incomplete':
        return $localize`:@@admin.notes.referrerSourceIncomplete:Some human page views here have no traffic source (${p['rows']}:ROWS:). This cannot be backfilled: the referrer was never stored.`;

      case 'direct_is_mixed_bucket':
        return $localize`:@@admin.notes.directIsMixedBucket:“Direct” mixes true direct arrivals with in-app navigation, because a same-site referrer classifies as direct.`;

      case 'visitor_definition_approximate':
        return $localize`:@@admin.notes.visitorDefinitionApproximate:A visitor is a distinct browser-and-network pair within the window. This over-counts when a browser updates and under-counts when people share a network.`;

      case 'catalog_series_is_additions_only':
        // The AC's named case: the approximation banner on counts-over-time.
        return $localize`:@@admin.notes.catalogSeriesIsAdditionsOnly:This chart counts records ADDED each day, taken from the audit log. It is not a running total: records removed later still count on the day they were added, and some records predate the log entirely. Exact totals over time need the daily snapshot, which is not built yet.`;

      case 'catalog_series_starts_at':
        return $localize`:@@admin.notes.catalogSeriesStartsAt:The audit log begins on ${p['earliest_day']}:EARLIEST_DAY:. Days before that read zero for want of data, not for want of activity.`;

      case 'internal_filter_unavailable':
        return $localize`:@@admin.notes.internalFilterUnavailable:Internal-traffic filtering is not configured, so every figure here is unfiltered.`;

      case 'internal_filter_applied':
        return $localize`:@@admin.notes.internalFilterApplied:Figures are shown both unfiltered and excluding internal networks (${p['asns']}:ASNS:). The unfiltered figure is always the primary one.`;

      case 'requires_recompute':
        return $localize`:@@admin.notes.requiresRecompute:Some status checks were skipped because they are slow. Recompute to run them.`;

      case 'algolia_credentials_absent':
        return $localize`:@@admin.notes.algoliaCredentialsAbsent:Search-index drift could not be measured: the Algolia credentials are not configured in this environment.`;

      case 'funnel_is_promoted_cohort_only':
        return $localize`:@@admin.notes.funnelIsPromotedCohortOnly:All ${p['promoted']}:PROMOTED: product(s) here are promoted, so this funnel has one populated stage by design. Promotion is the only way a product enters this database and retraction removes the row outright, so the earlier stages live in the review app, not here.`;

      case 'trade_facet_sparse_by_design':
        return $localize`:@@admin.notes.tradeFacetSparseByDesign:Products carrying no trade (${p['untagged']}:UNTAGGED: of ${p['universe']}:UNIVERSE:) are not necessarily untagged work. Trades are applied only where a product has trade-specific value, so broad platforms correctly carry none. Read this as coverage, not as a backlog.`;

      case 'api_docs_flag_inconsistent':
        return $localize`:@@admin.notes.apiDocsFlagInconsistent:Some products are marked as having API documentation but carry no link to it (${p['rows']}:ROWS:).`;

      default: {
        // Exhaustiveness guard: a new AdminNoteCode fails to compile until it has
        // a string above, rather than silently rendering nothing.
        const exhaustive: never = code;
        return exhaustive;
      }
    }
  }
}
