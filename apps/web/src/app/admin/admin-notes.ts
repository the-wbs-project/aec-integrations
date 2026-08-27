import { Component, computed, input } from '@angular/core';

import type { AdminNote, AdminNoteCode } from '@aeci/shared';

/**
 * AECI-576 / Phase 8.3 P1.2 — the operator console's **honesty envelope**,
 * rendered. Every admin-panel response carries an `AdminNote[]` naming the biases
 * that apply to *that* window (`docs/ADMIN_PANEL_SPEC.md` §1.1 / §6).
 *
 * The `code` is the contract and the `params` are its data; `message` is a plain
 * English operator fallback for curl and logs and is deliberately **untranslated**
 * on the wire. So this component localizes from `code` + `params` and never renders
 * `message` — which is how "machine-readable notes rather than the UI hardcoding
 * prose" coexists with CLAUDE.md's unconditional i18n rule (§9.4).
 *
 * {@link NOTE_PROSE} is typed `Record<AdminNoteCode, …>`, so adding a code to the
 * shared enum is a **compile error here** rather than a note that silently
 * disappears from the UI. That is the whole point of the map being exhaustive.
 *
 * `warn` notes take the Bone/Clay treatment already used by the requests queue's
 * duplicate + domain-mismatch chips (the console inherits the queues' visual
 * language — §9.10, no new anchor site); `info` notes stay quiet. Severity is
 * carried by a "Note"/"Caveat" chip, never by colour alone.
 */
@Component({
  selector: 'aec-admin-notes',
  template: `
    @let items = rendered();
    @if (items.length > 0) {
      <!-- A plain <div>, not an <aside>: a complementary landmark nested inside
           <main> trips axe's landmark-complementary-is-top-level, and these
           caveats belong to the numbers below them, not beside them. The list
           carries the accessible name instead. -->
      <div class="rounded-(--radius-md) border border-(--border-default) bg-(--surface-raised) p-4">
        <ul
          role="list"
          class="space-y-2"
          i18n-aria-label="@@admin.notes.aria"
          aria-label="How to read these numbers"
        >
          @for (n of items; track n.key) {
            <li class="flex gap-2 text-xs leading-relaxed">
              <span
                class="mt-0.5 inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[0.6875rem]
                  font-bold"
                [class]="
                  n.warn
                    ? 'bg-(--accent-warm) text-(--accent-secondary-deep)'
                    : 'bg-(--surface-sunken) text-(--text-secondary)'
                "
              >
                @if (n.warn) {
                  <ng-container i18n="@@admin.notes.severity.warn">Caveat</ng-container>
                } @else {
                  <ng-container i18n="@@admin.notes.severity.info">Note</ng-container>
                }
              </span>
              <span class="text-(--text-secondary)">{{ n.text }}</span>
            </li>
          }
        </ul>
      </div>
    }
  `,
  styles: [':host { display: block; }'],
})
export class AdminNotes {
  readonly notes = input.required<readonly AdminNote[]>();

  protected readonly rendered = computed(() =>
    this.notes().map((n, i) => ({
      key: `${n.code}-${i}`,
      warn: n.severity === 'warn',
      text: NOTE_PROSE[n.code](n.params ?? {}),
    })),
  );
}

type NoteParams = Readonly<Record<string, string | number>>;

/** `params` values are `string | number` on the wire; a missing one renders an
 *  em-dash rather than "undefined" — a note is never worth breaking a page over. */
function str(params: NoteParams, key: string): string {
  const v = params[key];
  return v === undefined ? '–' : String(v);
}

function num(params: NoteParams, key: string): number {
  const v = params[key];
  return typeof v === 'number' ? v : Number(v ?? 0);
}

/**
 * Localized prose per note code. EXHAUSTIVE by type — see the class doc.
 * Wording tracks the API's own `message` fallbacks so the screen and a `curl`
 * of the same endpoint tell the operator the same story.
 */
const NOTE_PROSE: Record<AdminNoteCode, (params: NoteParams) => string> = {
  partial_day: (p) =>
    $localize`:@@admin.notes.partialDay:${str(p, 'day')}:DAY: is not a complete UTC day yet, so its figures are still filling and will not match the digest until 00:00 UTC.`,

  bot_classification_incomplete: (p) =>
    $localize`:@@admin.notes.botClassificationIncomplete:${num(p, 'rows')}:ROWS: page views in this window were captured before bot classification and are counted as human.`,

  referrer_source_incomplete: (p) =>
    $localize`:@@admin.notes.referrerSourceIncomplete:${num(p, 'rows')}:ROWS: human page views in this window have no traffic source. This is not backfillable: the header was never stored.`,

  referrer_source_is_unverified: () =>
    $localize`:@@admin.notes.referrerSourceIsUnverified:A traffic source is what the request claimed, not a verified fact. It comes from a header the visitor's browser sets, and anything can set it: a forged source is indistinguishable from a real one here.`,

  direct_is_mixed_bucket: () =>
    $localize`:@@admin.notes.directIsMixedBucket:Direct mixes true direct arrivals with in-app navigation: a same-origin referrer classifies as Direct.`,

  visitor_definition_approximate: () =>
    $localize`:@@admin.notes.visitorDefinitionApproximate:A visitor is a distinct browser-and-network pair within the window. It over-counts when a browser updates and under-counts behind a shared network.`,

  corroborated_is_a_referrer_floor: () =>
    $localize`:@@admin.notes.corroboratedIsAReferrerFloor:Corroborated arrivals are those carrying a named external search or social referrer. Read it as a floor, not a count of people: privacy tools strip the header, so real referrals land in Direct. It also rests on the same unverified claim as the Source column.`,

  operator_leak_is_an_inference: () =>
    $localize`:@@admin.notes.operatorLeakIsAnInference:Views excluded as operator self-traffic on a lapsed session are matched by browser-and-network pair against a verified operator session nearby in time. That is an inference about who the visitor was, not a verified session.`,

  catalog_series_is_additions_only: () =>
    $localize`:@@admin.notes.catalogSeriesIsAdditionsOnly:This series counts creation events from the audit log: additions per day, not a net total. Rows removed later still count on the day they were added.`,

  catalog_series_starts_at: (p) =>
    $localize`:@@admin.notes.catalogSeriesStartsAt:The audit log begins ${str(p, 'earliest_day')}:EARLIEST_DAY:. Days before that read zero for want of data, not for want of activity.`,

  internal_filter_unavailable: () =>
    $localize`:@@admin.notes.internalFilterUnavailable:Internal-traffic filtering is not available, so every figure here is unfiltered.`,

  internal_filter_applied: (p) =>
    $localize`:@@admin.notes.internalFilterApplied:Figures are reported both unfiltered and excluding these networks: ${str(p, 'asns')}:ASNS:. The unfiltered figure is always the primary one.`,

  requires_recompute: () =>
    $localize`:@@admin.notes.requiresRecompute:Algolia drift is left out of this view because it needs network calls, and the data-quality checks shown are the last stored scheduled run. Use Recompute to run both live.`,

  algolia_credentials_absent: () =>
    $localize`:@@admin.notes.algoliaCredentialsAbsent:Algolia credentials are not configured in this environment, so index drift could not be measured.`,

  // AECI-579 / P1.5 — catalog coverage. `warn` for the first and last (a reader
  // who misses them draws a wrong conclusion); `info` for the trade note.
  funnel_is_promoted_cohort_only: (p) =>
    $localize`:@@admin.notes.funnelIsPromotedCohortOnly:All ${num(p, 'promoted')}:PROMOTED: product(s) here are promoted, so this funnel has one populated stage by design. Promotion is the only way a product enters this database and retraction removes the row outright, so the earlier stages live in the review app, not here.`,

  trade_facet_sparse_by_design: (p) =>
    $localize`:@@admin.notes.tradeFacetSparseByDesign:Products carrying no trade (${num(p, 'untagged')}:UNTAGGED: of ${num(p, 'universe')}:UNIVERSE:) are not necessarily untagged work. Trades are applied only where a product has trade-specific value, so broad platforms correctly carry none. Read this as coverage, not as a backlog.`,

  api_docs_flag_inconsistent: (p) =>
    $localize`:@@admin.notes.apiDocsFlagInconsistent:Some products are marked as having API documentation but carry no link to it (${num(p, 'rows')}:ROWS:).`,

  // AECI-581 / P2.1 — the pre-snapshot segment of a series. `warn`: a reader who
  // misses this reads an approximation as a measurement.
  series_partly_reconstructed: (p) =>
    $localize`:@@admin.notes.seriesPartlyReconstructed:${num(p, 'reconstructed_days')}:DAYS: day(s) up to ${str(p, 'reconstructed_through')}:THROUGH: predate the daily snapshot and were reconstructed from the audit log afterwards. Read that segment as approximate, not measured.`,

  // AECI-580 / P1.6 — system status, reworded by AECI-583 once cron outcomes
  // became recorded. `warn`: a reader who misses this may read an unrecorded cron
  // as a healthy one.
  cron_liveness_unavailable: (p) =>
    $localize`:@@admin.notes.cronLivenessUnavailable:${num(p, 'unknown')}:UNKNOWN: of ${num(p, 'total')}:TOTAL: scheduled jobs have no recorded run yet: they haven't run since run recording shipped, or they were added since. Datadog remains the place to check whether a job stopped firing altogether.`,

  // AECI-583. `warn`: a stored observability record that cannot be parsed is a
  // defect in the recorder, not a caveat about the data.
  stored_result_unreadable: (p) =>
    $localize`:@@admin.notes.storedResultUnreadable:A stored result from the ${str(p, 'job')}:JOB: job couldn't be read, so it's left out rather than shown in part.`,

  // No longer emitted — AECI-583 persists the sweep in the 09:00 job's run record.
  // Kept because the map is total over `AdminNoteCode` and removing a code is a
  // breaking change; an older cached response still renders localized prose.
  orphan_sweep_not_persisted: () =>
    $localize`:@@admin.notes.orphanSweepNotPersisted:The Algolia orphan sweep runs inside the 09:00 UTC drift job and reports only to Datadog. Its result is not stored, so it cannot be shown here.`,

  // AECI-586 / P5.1 — audience. Both `info`: neither makes a number wrong.
  utm_attribution_incomplete: (p) =>
    $localize`:@@admin.notes.utmAttributionIncomplete:${num(p, 'missing')}:MISSING: of ${num(p, 'total')}:TOTAL: signups in this window arrived with no campaign parameters. They are real signups grouped under Unattributed, not missing records.`,

  audience_history_is_current_state: () =>
    $localize`:@@admin.notes.audienceHistoryIsCurrentState:Churn is computed from the opt-out timestamp on each subscriber, so it is exact rather than estimated. The one thing it cannot see is a return: resubscribing clears that timestamp, so anyone who opted out and came back reads as never having left.`,
};
