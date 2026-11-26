import { DatePipe } from '@angular/common';
import { Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';

import type { AdminStatusStrip, VersionResponse } from '@aeci/shared';

import { CONSOLE_LABEL_CLASS } from '../console/console-table';

/**
 * AECI-576 / Phase 8.3 P1.2 — the §5.1 status strip: the six signals that answer
 * "is anything broken right now?" without opening an email or a dashboard.
 *
 * `algolia_drift` is `null` on the default response because it costs network
 * calls — the API returns a `requires_recompute` note instead, and the parent's
 * **Recompute** button re-requests with `?recompute=1` to fill it (§13 D8: still a
 * pure read, still a `GET`). It renders an explicit **"Not measured"** rather than
 * a zero: a zero would claim a clean bill of health nobody checked for.
 *
 * `data_quality` used to behave the same way. Since AECI-583 the 04:00 cron
 * persists its result set (`job_runs`, §7.2), so the default view replays the last
 * stored run and the recompute is the refresh — which is why the tile carries an
 * "as of" line. Without it, stored figures would read as live ones. The same
 * helper feeds `/admin/system`, so the two screens cannot disagree about a check
 * on either path.
 *
 * The deploy item compares the API Worker's SHA with the SSR Worker's own
 * `/_version`. That comparison is the entire reason two version endpoints exist
 * (AECI-92) — `/api/version` is proxied, so a stale SSR bundle in front of a
 * current API is invisible from it alone.
 *
 * The parent owns the surrounding `h3`; this component renders a `<dl>` so it adds
 * no headings of its own and cannot disturb heading order.
 */
@Component({
  selector: 'aec-status-strip',
  imports: [DatePipe, RouterLink],
  template: `
    @let s = status();
    <!-- AECI-1813, mock-up 14: one grid inside the System status panel, a Label
         role term over each value. No box per item. -->
    <dl class="grid gap-x-6 gap-y-4 md:grid-cols-[repeat(auto-fill,minmax(14rem,1fr))]">
      <!-- Deploy identity: API vs SSR. -->
      <div class="min-w-0">
        <dt [class]="labelClass" i18n="@@admin.status.deploy.label">Deploy</dt>
        <dd class="mt-2 space-y-1 text-t-14">
          <p class="font-mono text-t-14 tabular-nums text-(--text-primary)">
            {{ shortSha(s.version.sha) }} · {{ s.version.environment }}
          </p>
          <p class="text-t-14 text-(--text-secondary)">
            @if (ssrVersion(); as ssr) {
              <ng-container i18n="@@admin.status.deploy.ssr"
                >SSR {{ shortSha(ssr.sha) }}</ng-container
              >
            } @else {
              <ng-container i18n="@@admin.status.deploy.ssrUnknown"
                >SSR build not reported</ng-container
              >
            }
          </p>
          @if (shaMismatch()) {
            <p
              class="text-t-14 font-semibold text-(--accent-secondary-deep)"
              i18n="@@admin.status.deploy.mismatch"
            >
              SSR and API are on different builds.
            </p>
          }
        </dd>
      </div>

      <!-- stats_cache freshness: the 07:00 home-stats cron's liveness signal. -->
      <div class="min-w-0">
        <dt [class]="labelClass" i18n="@@admin.status.stats.label">Home stats freshness</dt>
        <dd class="mt-2 space-y-1 text-t-14">
          <p class="text-(--text-primary)">{{ statsAgeText() }}</p>
          @if (s.stats_freshness.stale) {
            <p
              class="text-t-14 font-semibold text-(--accent-secondary-deep)"
              i18n="@@admin.status.stats.stale"
            >
              Older than the 48-hour threshold.
            </p>
          }
        </dd>
      </div>

      <!--
        Moderation depth: the three Operations queues an operator acts on today,
        one link each, on the same predicates the nav badges use (AECI-922).
        Corrections and claims are counted apart because they are two screens. An
        all-kinds "requests open" figure linked to the corrections-only
        /admin/requests would name a number that page cannot show.
      -->
      <div class="min-w-0">
        <dt [class]="labelClass" i18n="@@admin.status.moderation.label">Moderation queue</dt>
        <dd class="mt-2 grid justify-items-start gap-1 text-t-14">
          <a
            routerLink="/admin/reviews"
            class="rounded-mark tabular-nums text-(--text-primary) underline-offset-3 transition-colors
              duration-fast hover:text-(--accent-primary) hover:underline"
            i18n="@@admin.status.moderation.reviews"
            >{{ s.moderation.pending_reviews }} reviews pending</a
          >
          <a
            routerLink="/admin/requests"
            class="rounded-mark tabular-nums text-(--text-primary) underline-offset-3 transition-colors
              duration-fast hover:text-(--accent-primary) hover:underline"
            i18n="@@admin.status.moderation.corrections"
            >{{ s.moderation.open_requests }} corrections open</a
          >
          <a
            routerLink="/admin/claims"
            class="rounded-mark tabular-nums text-(--text-primary) underline-offset-3 transition-colors
              duration-fast hover:text-(--accent-primary) hover:underline"
            i18n="@@admin.status.moderation.claims"
            >{{ s.moderation.open_claims }} claims open</a
          >
        </dd>
      </div>

      <!--
        AECI-1944. The copyright restore clock: open counter-notices whose restore is
        overdue, whose window is open, or that were never forwarded. A statutory
        deadline with a counterparty, so it sits beside the moderation depths, under
        its own term rather than inside "Moderation queue". Live on every load, on the
        predicate the dmca_restore_due data-quality check reads. The link is the whole
        log, not "Open only": a row closed by mistake with no outcome still counts here,
        and the log lists the most urgent clock first whether or not a row is closed. No nav badge: the log is not a queue (§5.23).
      -->
      <div class="min-w-0">
        <dt [class]="labelClass" i18n="@@admin.status.copyright.label">Copyright restores</dt>
        <dd class="mt-2 grid justify-items-start gap-1 text-t-14">
          <!-- An older API build sends no copyright_restores while a deploy rolls, so
               the item says so rather than throwing and blanking the strip. -->
          @if (s.copyright_restores; as cr) {
            <p
              class="tabular-nums"
              [class]="
                cr.overdue > 0
                  ? 'font-semibold text-(--accent-secondary-deep)'
                  : 'text-(--text-primary)'
              "
              i18n="@@admin.status.copyright.overdue"
            >
              {{ cr.overdue }} overdue
            </p>
            <p
              class="tabular-nums text-(--text-primary)"
              i18n="@@admin.status.copyright.windowOpen"
            >
              {{ cr.window_open }} in the restore window
            </p>
            <p
              class="tabular-nums"
              [class]="
                cr.awaiting_forward > 0
                  ? 'font-semibold text-(--accent-secondary-deep)'
                  : 'text-(--text-primary)'
              "
              i18n="@@admin.status.copyright.awaitingForward"
            >
              {{ cr.awaiting_forward }} not yet forwarded
            </p>
            <a
              routerLink="/admin/dmca"
              class="rounded-mark text-(--text-primary) underline underline-offset-3 transition-colors
              duration-fast hover:text-(--accent-primary)"
              i18n="@@admin.status.copyright.link"
              >Open the copyright log</a
            >
          } @else {
            <p class="text-(--text-secondary)" i18n="@@admin.status.copyright.notReported">
              Not reported by this API build.
            </p>
          }
        </dd>
      </div>

      <!-- Data quality: the last stored 04:00 run by default, live on recompute. -->
      <div class="min-w-0">
        <dt [class]="labelClass" i18n="@@admin.status.dq.label">Data-quality checks</dt>
        <dd class="mt-2 space-y-1 text-t-14">
          @if (s.data_quality; as dq) {
            <p class="tabular-nums text-(--text-primary)">
              <ng-container i18n="@@admin.status.dq.failing"
                >{{ dq.failing }} of {{ dq.checks.length }} failing</ng-container
              >
            </p>
            @if (failingChecks().length > 0) {
              <ul role="list" class="space-y-1 text-(--accent-secondary-deep)">
                @for (c of failingChecks(); track c.id) {
                  <li>{{ c.label }} ({{ c.count }})</li>
                }
              </ul>
            }
            <!-- Without this the stored figures read as live ones. -->
            @if (dq.source === 'job_runs') {
              <p class="text-t-13 text-(--text-secondary)" i18n="@@admin.status.dq.asOfStored">
                Last scheduled run, {{ dq.computed_at | date: 'short' : 'UTC' }} UTC
              </p>
            } @else {
              <p class="text-t-13 text-(--text-secondary)" i18n="@@admin.status.dq.asOfLive">
                Run just now
              </p>
            }
          } @else {
            <p class="text-(--text-secondary)" i18n="@@admin.status.dq.noStoredResult">
              No stored run yet. Use Recompute.
            </p>
          }
        </dd>
      </div>

      <!-- Algolia index drift: null until recomputed. -->
      <div class="min-w-0">
        <dt [class]="labelClass" i18n="@@admin.status.algolia.label">Algolia index drift</dt>
        <dd class="mt-2 space-y-1 text-t-14">
          @if (s.algolia_drift; as drift) {
            <p class="tabular-nums text-(--text-primary)">
              <ng-container i18n="@@admin.status.algolia.drifted"
                >{{ drift.drifted }} of {{ drift.indexes.length }} indexes drifted</ng-container
              >
            </p>
            @for (ix of driftedIndexes(); track ix.index_name) {
              <p class="tabular-nums text-(--accent-secondary-deep)">
                {{ ix.entity }}: {{ ix.database }} in D1, {{ ix.algolia }} in Algolia
              </p>
            }
          } @else {
            <p class="text-(--text-secondary)" i18n="@@admin.status.notMeasured">
              Not measured. Use Recompute.
            </p>
          }
        </dd>
      </div>
    </dl>
  `,
  styles: [':host { display: block; }'],
})
export class StatusStrip {
  protected readonly labelClass = CONSOLE_LABEL_CLASS;

  readonly status = input.required<AdminStatusStrip>();
  /** The SSR Worker's own build, or null when `/_version` could not be read.
   *  Null degrades to "not reported" — it never blocks the strip. */
  readonly ssrVersion = input<VersionResponse | null>(null);

  protected readonly failingChecks = computed(
    () => this.status().data_quality?.checks.filter((c) => c.count > 0 || c.error) ?? [],
  );

  protected readonly driftedIndexes = computed(
    () => this.status().algolia_drift?.indexes.filter((i) => i.drift !== 0) ?? [],
  );

  /** Only a mismatch between two KNOWN shas is worth flagging. `'unknown'` is the
   *  placeholder a Worker reports when `COMMIT_SHA` was not injected (local dev,
   *  a deploy that forgot the `--var`), and flagging that as drift would cry wolf
   *  on every developer machine. */
  protected readonly shaMismatch = computed(() => {
    const api = this.status().version.sha;
    const ssr = this.ssrVersion()?.sha;
    if (!ssr || api === 'unknown' || ssr === 'unknown') return false;
    return api !== ssr;
  });

  protected readonly statsAgeText = computed(() => {
    const f = this.status().stats_freshness;
    if (f.computed_at === null || f.age_hours === null) {
      return $localize`:@@admin.status.stats.never:Never computed`;
    }
    const hours = Math.round(f.age_hours);
    return hours < 1
      ? $localize`:@@admin.status.stats.freshNow:Computed less than an hour ago`
      : $localize`:@@admin.status.stats.ageHours:Computed ${hours}:HOURS: hours ago`;
  });

  protected shortSha(sha: string): string {
    return sha === 'unknown' ? sha : sha.slice(0, 7);
  }
}
