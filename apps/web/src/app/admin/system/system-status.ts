import { DatePipe, DecimalPipe } from '@angular/common';
import { Component, afterNextRender, computed, inject, signal } from '@angular/core';

import type {
  AdminCronRun,
  AdminDataQualityCheck,
  AdminNote,
  AdminNoteCode,
  AdminSystemResponse,
  VersionResponse,
} from '@aeci/shared';

import { AdminSystemApi } from './admin-system-api';

/** The sentinel both version endpoints return when `COMMIT_SHA` was never
 *  injected (`wrangler --var`). Comparing two sentinels is not a match, and
 *  comparing one against a real SHA is not a mismatch — it is unknown. */
const UNKNOWN_SHA = 'unknown';

/**
 * AECI-580 / Phase 8.3 P1.6 — the §5.6 System status screen, rendered in the
 * `AdminShell` layout's outlet at `/admin/system`. "Effectively the daily
 * procedure in `POST_LAUNCH_MONITORING.md` turned into one screen."
 *
 * Like `ReviewerBans`, the gate + nav SSR via the parent `adminSummaryResolver`;
 * this page paints its shell during SSR and fetches client-side in
 * `afterNextRender`.
 *
 * ─── Three things this screen must never do ──────────────────────────────────
 *
 * **1. Report a green state it cannot see.** Cron outcomes do not exist in D1
 * until `job_runs` lands (§7.2 / AECI-583), so a row whose `source` is `unknown`
 * renders as *Unknown* — never as a tick, never as a blank that reads as fine.
 * {@link cronState} is deliberately total: there is no fallthrough that could
 * produce "ok".
 *
 * **2. Render one version and call it "the version".** `/api/version` and
 * `/_version` exist as a pair so a stale SSR deploy is detectable (AECI-92). The
 * two are fetched in parallel and compared; a mismatch is a `role="alert"` band.
 * A `/_version` failure degrades to "unavailable" for that card only — the rest
 * of a diagnostic page must survive one broken probe.
 *
 * **3. Hardcode the API's prose.** Notes cross the wire as `code` + `params`;
 * `message` is an untranslated operator fallback for curl and logs (§6, §9.4).
 * The UI localizes from the code — {@link noteText} is that mapping, and an
 * unrecognized code degrades to the server's `message` rather than vanishing.
 *
 * The ten data-quality checks are opt-in (§13 **D8** / §6): the default load
 * omits them because check #9 HTTP-probes logo URLs and check #10 costs three
 * Algolia queries, and a dashboard should not do that on every visit. The button
 * re-requests with `?recompute=1`, which remains a pure read — it writes nothing
 * and sends nothing.
 */
@Component({
  selector: 'aec-system-status',
  imports: [DatePipe, DecimalPipe],
  templateUrl: './system-status.html',
})
export class SystemStatus {
  private readonly api = inject(AdminSystemApi);

  protected readonly system = signal<AdminSystemResponse | null>(null);
  /** The SSR Worker's own build metadata. Null when its probe failed — rendered
   *  as "unavailable", which is a different claim from a SHA mismatch. */
  protected readonly ssrVersion = signal<VersionResponse | null>(null);

  protected readonly loading = signal(true);
  protected readonly loadFailed = signal(false);
  /** In flight for `?recompute=1` only, so the button's state never borrows the
   *  first-load spinner (and vice versa). */
  protected readonly recomputing = signal(false);
  protected readonly recomputeFailed = signal(false);
  /** Polite live region — the checks appear well after the click. */
  protected readonly liveMessage = signal('');

  /**
   * True only when BOTH SHAs are known and differ. An unknown SHA (the
   * `wrangler --var` injection missing) is reported as unknown, not as a
   * mismatch — a false alarm on a diagnostic screen costs more than it saves.
   */
  protected readonly versionMismatch = computed(() => {
    const api = this.system()?.version.sha;
    const ssr = this.ssrVersion()?.sha;
    if (!api || !ssr) return false;
    if (api === UNKNOWN_SHA || ssr === UNKNOWN_SHA) return false;
    return api !== ssr;
  });

  protected readonly dataQuality = computed(() => this.system()?.data_quality ?? null);
  protected readonly crons = computed<readonly AdminCronRun[]>(() => this.system()?.crons ?? []);
  protected readonly notes = computed<readonly AdminNote[]>(() => this.system()?.notes ?? []);
  /** The last 09:00 drift job's orphan sweep (§7.2). Null means no run has
   *  recorded one — never "clean". */
  protected readonly orphanSweep = computed(() => this.system()?.algolia.orphan_sweep ?? null);

  constructor() {
    afterNextRender(() => {
      void this.load();
    });
  }

  private async load(recompute = false): Promise<void> {
    if (recompute) {
      this.recomputeFailed.set(false);
      this.recomputing.set(true);
    } else {
      this.loadFailed.set(false);
      this.loading.set(true);
    }

    // `allSettled`, not `all`: the SSR-version probe is one of two independent
    // reads, and losing it must cost only its own card.
    const [systemResult, ssrResult] = await Promise.allSettled([
      this.api.getSystem({ recompute }),
      this.api.getSsrVersion(),
    ]);

    if (systemResult.status === 'fulfilled') {
      this.system.set(systemResult.value);
      if (recompute) {
        const failing = systemResult.value.data_quality?.failing ?? 0;
        this.liveMessage.set(
          failing === 0
            ? $localize`:@@admin.system.announce.checksClean:Data-quality checks finished. All checks passing.`
            : $localize`:@@admin.system.announce.checksFailing:Data-quality checks finished. ${failing}:count: check(s) need attention.`,
        );
      }
    } else if (recompute) {
      this.recomputeFailed.set(true);
    } else {
      this.loadFailed.set(true);
    }

    this.ssrVersion.set(ssrResult.status === 'fulfilled' ? ssrResult.value : null);

    this.recomputing.set(false);
    this.loading.set(false);
  }

  protected retry(): void {
    void this.load();
  }

  /** Run the ten §23.1 checks + the drift count live (§13 D8 — a pure read). */
  protected runChecks(): void {
    if (this.recomputing()) return;
    this.liveMessage.set(
      $localize`:@@admin.system.announce.checksRunning:Running data-quality checks…`,
    );
    void this.load(true);
  }

  /**
   * A check's outcome, as one of four mutually exclusive states. `error` and
   * `skipped` are distinct from a finding: a check that threw tells you nothing,
   * and a check skipped for want of credentials is not a failure (§5.6).
   */
  protected checkState(check: AdminDataQualityCheck): 'error' | 'skipped' | 'findings' | 'passing' {
    if (check.error !== undefined) return 'error';
    if (check.skipped) return 'skipped';
    return check.count > 0 ? 'findings' : 'passing';
  }

  protected checkStateLabel(check: AdminDataQualityCheck): string {
    switch (this.checkState(check)) {
      case 'error':
        return $localize`:@@admin.system.dq.state.error:Errored`;
      case 'skipped':
        return $localize`:@@admin.system.dq.state.skipped:Skipped`;
      case 'findings':
        return $localize`:@@admin.system.dq.state.findings:Needs attention`;
      case 'passing':
        // The AC: a check that returns zero rows reads as PASSING, not as empty.
        return $localize`:@@admin.system.dq.state.passing:Passing`;
    }
  }

  /**
   * A cron row's liveness state, as one of four. `in_flight` is a `job_runs` row
   * with no `finished_at` — the run is mid-flight, or the isolate was reclaimed
   * and never completed it. The API guarantees such a row carries no outcome, so
   * this can never be reached with a green tick behind it.
   */
  protected cronState(run: AdminCronRun): 'unknown' | 'derived' | 'in_flight' | 'recorded' {
    if (run.source === 'unknown') return 'unknown';
    if (run.source === 'derived') return 'derived';
    return run.run_state === 'in_flight' ? 'in_flight' : 'recorded';
  }

  /** Exhaustive by design: adding a state to {@link cronState} must not compile
   *  until it has a label. */
  protected cronStateLabel(run: AdminCronRun): string {
    switch (this.cronState(run)) {
      case 'unknown':
        return $localize`:@@admin.system.cron.state.unknown:Unknown`;
      case 'derived':
        return $localize`:@@admin.system.cron.state.derived:Inferred`;
      case 'in_flight':
        return $localize`:@@admin.system.cron.state.inFlight:In flight`;
      case 'recorded':
        return $localize`:@@admin.system.cron.state.recorded:Recorded`;
    }
  }

  /**
   * The stored outcome, localized. Until AECI-583 `last_outcome` was null on every
   * row, so the template rendered the raw wire literal on a branch that could
   * never be reached; now that it can, the value needs translating like anything
   * else the operator reads.
   */
  protected cronOutcomeLabel(outcome: 'ok' | 'failed' | 'skipped'): string {
    switch (outcome) {
      case 'ok':
        return $localize`:@@admin.system.cron.outcome.ok:Succeeded`;
      case 'failed':
        return $localize`:@@admin.system.cron.outcome.failed:Failed`;
      case 'skipped':
        return $localize`:@@admin.system.cron.outcome.skipped:Skipped`;
    }
  }

  /** Localized prose for a note, keyed off `code` (§9.4). An unrecognized code
   *  falls back to the server's untranslated `message` so a newly-added code is
   *  never silently swallowed. */
  protected noteText(note: AdminNote): string {
    const p = note.params ?? {};
    switch (note.code as AdminNoteCode) {
      case 'requires_recompute':
        return $localize`:@@admin.system.note.requiresRecompute:Algolia drift isn't measured on load, and the data-quality checks below are the last stored scheduled run. Use "Run data-quality checks" above to run both live.`;
      case 'algolia_credentials_absent':
        return $localize`:@@admin.system.note.algoliaCredentialsAbsent:Algolia credentials are not configured on this environment, so index drift could not be measured.`;
      case 'cron_liveness_unavailable':
        return $localize`:@@admin.system.note.cronLivenessUnavailable:${p['unknown'] ?? ''}:unknown: of ${p['total'] ?? ''}:total: scheduled jobs have no recorded run yet: they haven't run since run recording shipped, or they were added since. Datadog remains the place to check whether a job stopped firing altogether.`;
      case 'stored_result_unreadable':
        return $localize`:@@admin.system.note.storedResultUnreadable:A stored result from the ${p['job'] ?? ''}:job: job couldn't be read, so it's left out rather than shown in part.`;
      // No longer emitted (the sweep is stored now), but kept so an older cached
      // response still renders localized prose rather than the raw API message.
      case 'orphan_sweep_not_persisted':
        return $localize`:@@admin.system.note.orphanSweepNotPersisted:The Algolia orphan sweep runs inside the 09:00 UTC drift job and reports only to Datadog. Its result is not stored, so it cannot be shown here.`;
      default:
        return note.message;
    }
  }

  /** Bytes → a short human string. Null renders as "Unknown" in the template —
   *  never approximated from the row counts. */
  protected formatBytes(bytes: number): string {
    const mb = bytes / 1_048_576;
    if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
    if (mb >= 1) return `${mb.toFixed(2)} MB`;
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  /** Total rows across every table — the one figure the per-table list does not
   *  give at a glance. */
  protected readonly totalRows = computed(() =>
    (this.system()?.database.tables ?? []).reduce((sum, t) => sum + t.rows, 0),
  );

  /**
   * Datadog + PostHog link-outs. The panel deliberately does not re-implement
   * APM, RUM, or funnels (§2) — it links to them. URLs are the ones recorded in
   * `docs/OBSERVABILITY.md`; keep the two in sync.
   */
  protected readonly externalLinks: readonly { label: string; url: string }[] = [
    {
      label: $localize`:@@admin.system.links.traffic:Datadog: Phase 2 Traffic`,
      url: 'https://us5.datadoghq.com/dashboard/b5b-edd-gva/aeci-phase-2--traffic',
    },
    {
      label: $localize`:@@admin.system.links.search:Datadog: Phase 3 Search`,
      url: 'https://us5.datadoghq.com/dashboard/fci-6sf-yvn/aeci-phase-3--search',
    },
    {
      label: $localize`:@@admin.system.links.homeStats:Datadog: Phase 4 Home and Stats`,
      url: 'https://us5.datadoghq.com/dashboard/3bi-9a9-6hz/aeci-phase-4--home--stats',
    },
    {
      label: $localize`:@@admin.system.links.requests:Datadog: Phase 6 Requests and Moderation`,
      url: 'https://us5.datadoghq.com/dashboard/k86-25g-8rx/aeci-phase-6--requests--moderation',
    },
    {
      label: $localize`:@@admin.system.links.monitors:Datadog: Monitors (cron liveness)`,
      url: 'https://us5.datadoghq.com/monitors/manage',
    },
    {
      label: $localize`:@@admin.system.links.rum:Datadog: RUM Core Web Vitals`,
      url: 'https://us5.datadoghq.com/rum/performance-monitoring',
    },
    {
      label: $localize`:@@admin.system.links.posthog:PostHog: product analytics`,
      url: 'https://us.posthog.com/',
    },
  ];
}
