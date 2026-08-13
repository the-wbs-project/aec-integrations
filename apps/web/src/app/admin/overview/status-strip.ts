import { DatePipe } from '@angular/common';
import { Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';

import type { AdminStatusStrip, VersionResponse } from '@aeci/shared';

/**
 * AECI-576 / Phase 8.3 P1.2 — the §5.1 status strip: the five signals that answer
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
    <dl class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      <!-- Deploy identity: API vs SSR. -->
      <div class="rounded-(--radius-md) border border-(--border-default) bg-(--surface-raised) p-4">
        <dt class="text-xs font-bold text-(--text-secondary)" i18n="@@admin.status.deploy.label">
          Deploy
        </dt>
        <dd class="mt-1 space-y-1">
          <p class="font-mono text-sm tabular-nums text-(--text-primary)">
            {{ shortSha(s.version.sha) }} · {{ s.version.environment }}
          </p>
          <p class="text-xs text-(--text-secondary)">
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
              class="text-xs font-bold text-(--accent-secondary-deep)"
              i18n="@@admin.status.deploy.mismatch"
            >
              SSR and API are on different builds.
            </p>
          }
        </dd>
      </div>

      <!-- stats_cache freshness: the 07:00 home-stats cron's liveness signal. -->
      <div class="rounded-(--radius-md) border border-(--border-default) bg-(--surface-raised) p-4">
        <dt class="text-xs font-bold text-(--text-secondary)" i18n="@@admin.status.stats.label">
          Home stats freshness
        </dt>
        <dd class="mt-1 space-y-1">
          <p class="text-sm text-(--text-primary)">{{ statsAgeText() }}</p>
          @if (s.stats_freshness.stale) {
            <p
              class="text-xs font-bold text-(--accent-secondary-deep)"
              i18n="@@admin.status.stats.stale"
            >
              Older than the 48-hour threshold.
            </p>
          }
        </dd>
      </div>

      <!-- Moderation depth: the two queues an operator acts on today. -->
      <div class="rounded-(--radius-md) border border-(--border-default) bg-(--surface-raised) p-4">
        <dt
          class="text-xs font-bold text-(--text-secondary)"
          i18n="@@admin.status.moderation.label"
        >
          Moderation queue
        </dt>
        <dd class="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm">
          <a
            routerLink="/admin/reviews"
            class="tabular-nums text-(--text-primary) underline-offset-2 transition-colors
              hover:text-(--accent-primary) focus-visible:outline-2 focus-visible:outline-offset-2
              focus-visible:outline-(--accent-primary)"
            i18n="@@admin.status.moderation.reviews"
            >{{ s.moderation.pending_reviews }} reviews pending</a
          >
          <a
            routerLink="/admin/requests"
            class="tabular-nums text-(--text-primary) underline-offset-2 transition-colors
              hover:text-(--accent-primary) focus-visible:outline-2 focus-visible:outline-offset-2
              focus-visible:outline-(--accent-primary)"
            i18n="@@admin.status.moderation.requests"
            >{{ s.moderation.open_requests }} requests open</a
          >
        </dd>
      </div>

      <!-- Data quality: the last stored 04:00 run by default, live on recompute. -->
      <div class="rounded-(--radius-md) border border-(--border-default) bg-(--surface-raised) p-4">
        <dt class="text-xs font-bold text-(--text-secondary)" i18n="@@admin.status.dq.label">
          Data-quality checks
        </dt>
        <dd class="mt-1 space-y-1">
          @if (s.data_quality; as dq) {
            <p class="text-sm tabular-nums text-(--text-primary)">
              <ng-container i18n="@@admin.status.dq.failing"
                >{{ dq.failing }} of {{ dq.checks.length }} failing</ng-container
              >
            </p>
            @if (failingChecks().length > 0) {
              <ul role="list" class="space-y-0.5 text-xs text-(--accent-secondary-deep)">
                @for (c of failingChecks(); track c.id) {
                  <li>{{ c.label }} ({{ c.count }})</li>
                }
              </ul>
            }
            <!-- Without this the stored figures read as live ones. -->
            @if (dq.source === 'job_runs') {
              <p class="text-xs text-(--text-tertiary)" i18n="@@admin.status.dq.asOfStored">
                Last scheduled run, {{ dq.computed_at | date: 'short' : 'UTC' }} UTC
              </p>
            } @else {
              <p class="text-xs text-(--text-tertiary)" i18n="@@admin.status.dq.asOfLive">
                Run just now
              </p>
            }
          } @else {
            <p class="text-sm text-(--text-secondary)" i18n="@@admin.status.dq.noStoredResult">
              No stored run yet. Use Recompute.
            </p>
          }
        </dd>
      </div>

      <!-- Algolia index drift: null until recomputed. -->
      <div class="rounded-(--radius-md) border border-(--border-default) bg-(--surface-raised) p-4">
        <dt class="text-xs font-bold text-(--text-secondary)" i18n="@@admin.status.algolia.label">
          Algolia index drift
        </dt>
        <dd class="mt-1 space-y-1">
          @if (s.algolia_drift; as drift) {
            <p class="text-sm tabular-nums text-(--text-primary)">
              <ng-container i18n="@@admin.status.algolia.drifted"
                >{{ drift.drifted }} of {{ drift.indexes.length }} indexes drifted</ng-container
              >
            </p>
            @for (ix of driftedIndexes(); track ix.index_name) {
              <p class="text-xs tabular-nums text-(--accent-secondary-deep)">
                {{ ix.entity }}: {{ ix.database }} in D1, {{ ix.algolia }} in Algolia
              </p>
            }
          } @else {
            <p class="text-sm text-(--text-secondary)" i18n="@@admin.status.notMeasured">
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
