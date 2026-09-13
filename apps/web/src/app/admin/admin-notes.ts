import { Component, computed, input } from '@angular/core';

import type { AdminNote, AdminNoteCode } from '@aeci/shared';

/**
 * AECI-576 / Phase 8.3 P1.2 — the operator console's **honesty envelope**,
 * rendered. Every admin-panel response carries an `AdminNote[]` naming the biases
 * that apply to *that* window (`docs/ADMIN_PANEL_SPEC.md` §1.1 / §6).
 *
 * The `code` is the contract and the `params` are its data; `message` is a plain
 * English operator fallback for curl and logs and is deliberately **untranslated**
 * on the wire. So this component localizes from `code` + `params`, and renders
 * `message` only for a code it has no prose for — which is how "machine-readable
 * notes rather than the UI hardcoding prose" coexists with CLAUDE.md's
 * unconditional i18n rule (§9.4).
 *
 * {@link NOTE_PROSE} is typed `Record<AdminNoteCode, …>`, so adding a code to the
 * shared enum is a **compile error here** rather than a note that silently
 * disappears from the UI. That is the whole point of the map being exhaustive.
 * It is a compile-time guarantee, so {@link NOTE_PROSE_LOOKUP} adds the runtime
 * half beside it: a `code` from an API newer than this build renders the wire
 * `message` rather than throwing.
 *
 * **This is the panel's only note renderer** — AECI-835 folded in `AdminNoteList`
 * (`notes/admin-note-list.ts`, a 15-of-32 `switch` on /admin/traffic and
 * /admin/audience) and `system-status.ts`'s five-case `noteText`. Both carried
 * their own `@@` ids and their own wording for codes this map already covered,
 * so the same caveat read differently depending on which screen you were on.
 * Add a string HERE, once. There is nowhere else to add it.
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
      text: NOTE_PROSE_LOOKUP[n.code]?.(n.params ?? {}) ?? n.message,
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

  // AECI-827. The same inference's other property: it is not final. Interpolates
  // the two day counts rather than naming a fixed window, because the lookback is
  // a documented launch tunable and a hardcoded "30" here would rot the first time
  // it moved.
  series_within_operator_lookback: (params) =>
    $localize`:@@admin.notes.seriesWithinOperatorLookback:${num(params, 'days')}:days: of the ${num(params, 'requested')}:requested: day(s) shown are not final. A view counts as operator self-traffic if it shares a browser-and-network pair with a verified operator session within ${num(params, 'lookback_days')}:lookbackDays: days, and such a session may not have happened yet. These figures can still fall. The daily snapshot re-checks and corrects them.`,

  // AECI-745. The API's `message` carries `SWARM_THRESHOLD_NOTE` verbatim, which
  // is English and interpolates the detector's own numeric thresholds — so it is
  // a FALLBACK, not the rendered string. Localizing the exact figures would mean
  // duplicating the constants here and letting them rot; naming the shape of the
  // rule and pointing at the day's own reading keeps the panel translatable
  // without asserting a threshold it does not own.
  automation_filter_applied: () =>
    $localize`:@@admin.notes.automationFilterApplied:The headline is human page views less those attributed to automated clients: one browser fingerprint appearing across many networks, one network serving a new fingerprint almost every request, or a request whose own headers do not look like a browser. It is an estimate, not a census.`,

  automation_filter_did_not_run: () =>
    $localize`:@@admin.notes.automationFilterDidNotRun:The automation filter did not run for this window, so the headline figure is unfiltered and is an upper bound only. It is not comparable with a day the filter ran on.`,

  // AECI-869. The loudest note this component renders, and the one place the
  // panel says a number had no input rather than that it has a caveat. Phrased
  // around the consequence: an operator does not need to know that a cache
  // gateway replaced `request.cf`, they need to know the exclusions did not run.
  arrival_telemetry_unavailable: (p) =>
    $localize`:@@admin.notes.arrivalTelemetryUnavailable:Network information was missing from most page loads on this day: ${num(p, 'arrivals_with_asn')}:WITH_NETWORK: of ${num(p, 'arrivals')}:ARRIVALS: carried one. Every check that works by network could not run, so nothing was excluded on those grounds and the headline is too high by an unknown amount. This day cannot be compared with a day that has network information.`,

  series_spans_degraded_days: (p) =>
    $localize`:@@admin.notes.seriesSpansDegradedDays:${num(p, 'degraded_days')}:DEGRADED: of the ${num(p, 'requested')}:REQUESTED: days behind the trend line and the 7-day change were missing network information, so their figures are too high by an unknown amount. Do not read a step across those days as a change in traffic.`,

  catalog_series_is_additions_only: () =>
    $localize`:@@admin.notes.catalogSeriesIsAdditionsOnly:This series counts creation events from the audit log: additions per day, not a net total. Rows removed later still count on the day they were added.`,

  catalog_series_starts_at: (p) =>
    $localize`:@@admin.notes.catalogSeriesStartsAt:The audit log begins ${str(p, 'earliest_day')}:EARLIEST_DAY:. Days before that read zero for want of data, not for want of activity.`,

  catalog_series_is_surviving_rows: () =>
    $localize`:@@admin.notes.catalogSeriesIsSurvivingRows:These are the records in the catalog now, counted against the period they were added in, so removals are netted off and the columns add up to the totals above. Nothing records when a record was removed, so a removal comes off the period it was added in: earlier figures can fall as records are removed later.`,

  catalog_claims_recreated_by_promote: () =>
    $localize`:@@admin.notes.catalogClaimsRecreatedByPromote:Every promote rewrites the claims on an integration, so a claim is dated by the last promote rather than by when it first appeared. Read Claims as a count of live claims, not as a history of when they arrived.`,

  // AECI-752. Both strings name the ASN axis and nothing else. The old pair said
  // "every figure here is unfiltered" and "the unfiltered figure is always the
  // primary one" — true of `ANALYTICS_INTERNAL_ASNS` alone, but read as a claim
  // about the whole screen, directly above a headline that AECI-745 filters for
  // automation and AECI-683 filters for operator self-traffic. Saying "including
  // / excluding these networks" instead of "unfiltered / filtered" is what stops
  // the sentence generalising; §13 D10 constraint 2 is kept, only re-scoped.
  //
  // `internal_filter_unavailable` covers THREE states, and this string has to be
  // true in all of them, so it says what was applied and never why. "…is not
  // configured" would be false in the second state, and three of this component's
  // callers can reach it:
  //
  //   1. `ANALYTICS_INTERNAL_ASNS` unset — the shipped default everywhere.
  //   2. Set, but the request did not ask. `/admin/overview` and `/admin/activity`
  //      cannot reach this: `admin-overview.ts` and `admin-page-views.ts` (via its
  //      `countFilter`) both hardcode `resolveInternalFilter(env, true)`. But
  //      `/admin/catalog` renders this component over
  //      `GET /api/admin/metrics/timeseries` notes (`catalog-coverage.ts`,
  //      `additions-table.ts`), and `admin-metrics.ts` passes the CALLER's
  //      `exclude_internal`, which neither catalog caller sends. `/admin/traffic`
  //      reaches it the same way through `admin-traffic.ts`, and is the surface
  //      where an operator can reach it with the var SET by leaving the toggle
  //      off — which is why "is not configured" would be a false sentence.
  //   3. The metric carries no ASN — `admin-metrics.ts` builds its own message for
  //      that one, but the code, and so this string, is the same.
  //
  // AECI-835 folded `AdminNoteList`'s separate string for this code into this
  // one. It was state-agnostic for the same reason, in its own words.
  internal_filter_unavailable: () =>
    $localize`:@@admin.notes.internalFilterUnavailable:No internal-network (ASN) filtering is applied here, so these figures include any company-network traffic. Automation and operator self-traffic exclusions are applied where noted.`,

  internal_filter_applied: (p) =>
    $localize`:@@admin.notes.internalFilterApplied:Figures are reported both including and excluding these networks: ${str(p, 'asns')}:ASNS:. The figure that includes them is always the primary one.`,

  // AECI-835. TWO screens receive this code, and the string has to be true on
  // both: `runExpensiveStatusItems` (`apps/api/src/lib/admin-status.ts`) is
  // called from `admin-system.ts` AND from `admin-overview.ts`, which merges its
  // notes into the envelope on every default (`recompute=false`) load. Their
  // controls are named differently — `/admin/system` renders "Run data-quality
  // checks", `/admin/overview` renders "Recompute" — and only `/admin/system`
  // renders the checks as a list, so the string names neither the button nor a
  // direction. It says WHAT is stale and WHERE to refresh it, and nothing else.
  // The pre-merge wordings each named a control the other screen lacks.
  requires_recompute: () =>
    $localize`:@@admin.notes.requiresRecompute:Algolia drift isn't measured on load, and the data-quality checks shown are the last stored scheduled run. Use the recompute control on this page to run both live.`,

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
    $localize`:@@admin.notes.cronLivenessUnavailable:${num(p, 'unknown')}:UNKNOWN: of ${num(p, 'total')}:TOTAL: scheduled jobs have no recorded run yet: they haven't run since run recording shipped, or they were added since. The scheduled liveness sweep is what detects a job that stopped firing altogether.`,

  // AECI-583. `warn`: a stored observability record that cannot be parsed is a
  // defect in the recorder, not a caveat about the data.
  stored_result_unreadable: (p) =>
    $localize`:@@admin.notes.storedResultUnreadable:A stored result from the ${str(p, 'job')}:JOB: job couldn't be read, so it's left out rather than shown in part.`,

  // No longer emitted — AECI-583 persists the sweep in the 09:00 job's run record.
  // Kept because the map is total over `AdminNoteCode` and removing a code is a
  // breaking change; an older cached response still renders localized prose.
  orphan_sweep_not_persisted: () =>
    $localize`:@@admin.notes.orphanSweepNotPersisted:The Algolia orphan sweep runs inside the 09:00 UTC drift job and reports only to PostHog. Its result is not stored, so it cannot be shown here.`,

  // AECI-586 / P5.1 — audience. Both `info`: neither makes a number wrong.
  utm_attribution_incomplete: (p) =>
    $localize`:@@admin.notes.utmAttributionIncomplete:${num(p, 'missing')}:MISSING: of ${num(p, 'total')}:TOTAL: signups in this window arrived with no campaign parameters. They are real signups grouped under Unattributed, not missing records.`,

  audience_history_is_current_state: () =>
    $localize`:@@admin.notes.audienceHistoryIsCurrentState:Churn is computed from the opt-out timestamp on each subscriber, so it is exact rather than estimated. The one thing it cannot see is a return: resubscribing clears that timestamp, so anyone who opted out and came back reads as never having left.`,

  // ── AECI-722 — the connector surface ──────────────────────────────────────
  // Each of these describes something the connector lane deliberately does not
  // model, so unlike the windowed notes above none of them retires on its own.
  connector_evidenced_pairs_empty: () =>
    $localize`:@@admin.notes.connectorEvidencedPairsEmpty:The delivered lane is empty because the powered integrations have not been migrated into it yet, not because this connector delivers nothing. Read it as "not measured", not as zero.`,
  reachable_never_counted: () =>
    $localize`:@@admin.notes.connectorReachableNeverCounted:Pair counts describe how many pair pages this connector publishes. They are never counted as integrations anywhere on the site: a connector being able to reach two products is not the same claim as an integration existing between them.`,
  publication_gate_inputs_only: () =>
    $localize`:@@admin.notes.connectorPublicationGateInputsOnly:These rows show what the publication rule looks at, not what it decides. Whether both sides are in our catalogue and whether a person made the mapping are shown here; whether the pair is already delivered, and whether it clears the thin-content bar, are decided elsewhere. A row appearing here is not a row we would publish.`,
  stub_actions_never_fetched: (p) =>
    $localize`:@@admin.notes.connectorStubActionsNeverFetched:${num(p, 'never_fetched')}:NEVER_FETCHED: of ${num(p, 'total')}:TOTAL: listings on this page have never had their action inventory fetched. That is not the same as having no actions: the inventory is fetched on demand, so most listings never carry one.`,
};

/**
 * The same map, seen as partial. AECI-835.
 *
 * This is an ASSIGNMENT, not a cast: `Record<K, V>` is assignable to
 * `Partial<Record<K, V>>`, so nothing is asserted and the declaration above is
 * NOT weakened. {@link NOTE_PROSE} stays total over `AdminNoteCode`, which is
 * the whole reason this component exists.
 *
 * What the alias buys is a lookup the compiler agrees may miss, which is the
 * runtime truth: the admin clients are `http.get<T>()`-typed and never Zod-parse
 * the response, so a `code` from an API newer than this build reaches
 * {@link AdminNotes.rendered} as a key the map does not have. The fallback lives
 * BESIDE the exhaustive map, never instead of it. Untranslated beats swallowed,
 * and a caveat that silently disappears is the exact failure §1.1 exists to
 * prevent.
 *
 * Do NOT "simplify" this by retyping `NOTE_PROSE` itself as `Partial`. That
 * deletes the compile error, and it fails silently: the fallback would swallow
 * the missing string into untranslated English and every test would stay green
 * except the exhaustive sweep in `admin-notes.component.spec.ts`.
 */
const NOTE_PROSE_LOOKUP: Partial<Record<AdminNoteCode, (params: NoteParams) => string>> =
  NOTE_PROSE;
