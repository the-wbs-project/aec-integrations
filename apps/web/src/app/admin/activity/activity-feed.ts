import { Component, afterNextRender, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import {
  ADMIN_PAGE_VIEW_NULL_FILTER,
  type AdminBreakdownRow,
  type AdminCount,
  type AdminInternalFilter,
  type AdminNote,
  type AdminPageViewRow,
  type AdminTrafficPopulation,
} from '@aeci/shared';

import { AdminNotes } from '../admin-notes';
import { AdminPaginator } from '../admin-paginator';
import { AdminSelect, type AdminSelectOption } from '../admin-select';
import { AdminPageViewsApi } from './admin-page-views-api';

/** Rows per page. Larger than the shared `perPage` default of 24 because this is
 *  a log to scan, not a queue to work through. The API caps it at 100. */
const PAGE_SIZE = 50;

/** Day spans offered as one-click windows. */
const PRESET_DAYS = [1, 7, 30] as const;

/** Debounce on the free-text path filter, matching `/search`'s URL-sync delay so
 *  typing feels the same across the app. */
const PATH_DEBOUNCE_MS = 350;

const DAY_MS = 86_400_000;

/** `YYYY-MM-DD` for a UTC instant. `created_at` is stored as an ISO string, so
 *  its first ten characters already ARE the UTC date — no parsing needed. */
function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

function addDays(day: string, delta: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + delta * DAY_MS).toISOString().slice(0, 10);
}

/** One day's worth of rows, for the feed's day separators. */
interface DayGroup {
  readonly day: string;
  readonly rows: readonly AdminPageViewRow[];
}

const EMPTY_COUNT: AdminCount = { total: 0, excluding_internal: null };
const NO_FILTER: AdminInternalFilter = { available: false, applied: false, asns: [] };

/**
 * AECI-577 / Phase 8.3 P1.3 — the Activity feed at `/admin/activity`
 * (`ADMIN_PANEL_SPEC.md` §5.2), rendered in the `AdminShell` layout's outlet.
 *
 * The consent-independent answer to "who actually visited today". PostHog only
 * ever sees traffic that clicked Accept on the consent banner, and a single-page
 * arrival from a search engine never does; `page_views` sees all of it. That is
 * the entire reason this screen exists, and it is why the honesty and privacy
 * rules below are load-bearing rather than decorative.
 *
 * Like the other admin queues, the gate + nav SSR via `adminSummaryResolver` (the
 * parent route), so this screen paints its shell during SSR and fetches
 * client-side in `afterNextRender` — the same-origin `GET /api/admin/page-views`
 * carries the session cookie, which the API Worker's `requireAdmin()` verifies.
 * It never reads cookies or session state directly.
 *
 * ─── Four things that are not obvious ────────────────────────────────────────
 *
 * **The filter bar waits for `ready()`.** The default window is derived from the
 * clock, and a clock-derived value baked into the SSR HTML is exactly the kind of
 * thing that diverges from what the browser computes. So the window is resolved
 * in `afterNextRender` and the controls render after it — which also means
 * `Date.now()` in {@link age} is never read server-side, the same reasoning the
 * requests queue relies on.
 *
 * **Both traffic figures are shown whenever they exist**, not only when the
 * internal-traffic toggle is on. §13 D10 constraint 2 is "show both numbers,
 * never substitute", and on a row feed the toggle removes rows — so if the
 * summary showed only the filtered count the operator would be reading a smaller
 * number with nothing to compare it against. The API computes both regardless;
 * this screen renders both regardless. When the var is unset the toggle is hidden
 * entirely rather than shown disabled.
 *
 * **`referrer_source: null` renders as *unknown*, never as *Direct*.** Every row
 * before August 2026 has it null because the header was never stored, and it is
 * not backfillable. Collapsing the two would invent attribution.
 *
 * **The visitor id is pseudonymous and stays that way.** The API sends eight
 * characters of a UA hash and an ASN; §9.7 forbids correlating beyond that, and
 * §13 D7 settled that no session identifier will ever exist to correlate with.
 * The §9.8 definition of "visitor" is rendered next to the number for that
 * reason.
 */
@Component({
  selector: 'aec-activity-feed',
  imports: [RouterLink, AdminNotes, AdminPaginator, AdminSelect],
  templateUrl: './activity-feed.html',
})
export class ActivityFeed {
  private readonly api = inject(AdminPageViewsApi);

  /** False until the browser has resolved the default window — see the class
   *  docblock. The filter bar renders off this. */
  protected readonly ready = signal(false);

  protected readonly from = signal('');
  protected readonly to = signal('');
  protected readonly traffic = signal<AdminTrafficPopulation>('human');
  protected readonly source = signal<string | null>(null);
  protected readonly country = signal<string | null>(null);
  protected readonly pathContains = signal('');
  protected readonly excludeInternal = signal(false);
  protected readonly page = signal(1);

  private readonly rows = signal<readonly AdminPageViewRow[]>([]);
  protected readonly total = signal(0);
  protected readonly windowTotal = signal<AdminCount>(EMPTY_COUNT);
  protected readonly windowVisitors = signal<AdminCount>(EMPTY_COUNT);
  protected readonly notes = signal<readonly AdminNote[]>([]);
  protected readonly internalFilter = signal<AdminInternalFilter>(NO_FILTER);

  protected readonly loading = signal(true);
  protected readonly loadFailed = signal(false);
  /** Polite announcements — paging and filtering replace the table silently. */
  protected readonly liveMessage = signal('');

  protected readonly perPage = PAGE_SIZE;
  protected readonly presets = PRESET_DAYS;

  protected readonly trafficOptions: ReadonlyArray<{ key: AdminTrafficPopulation; label: string }> =
    [
      { key: 'human', label: $localize`:@@admin.activity.filter.traffic.human:Humans` },
      { key: 'bot', label: $localize`:@@admin.activity.filter.traffic.bot:Bots` },
      { key: 'all', label: $localize`:@@admin.activity.filter.traffic.all:All` },
    ];

  private readonly anySource: AdminSelectOption = {
    value: null,
    label: $localize`:@@admin.activity.filter.source.any:Any source`,
  };
  private readonly anyCountry: AdminSelectOption = {
    value: null,
    label: $localize`:@@admin.activity.filter.country.any:Any country`,
  };

  protected readonly sourceOptions = signal<readonly AdminSelectOption[]>([this.anySource]);
  protected readonly countryOptions = signal<readonly AdminSelectOption[]>([this.anyCountry]);

  protected readonly sourceLabel = $localize`:@@admin.activity.filter.source.label:Source`;
  protected readonly countryLabel = $localize`:@@admin.activity.filter.country.label:Country`;

  /** Rows split into consecutive same-day runs. The server already orders newest
   *  first, so a linear pass is enough — no sorting, no grouping key lookup. */
  protected readonly dayGroups = computed<readonly DayGroup[]>(() => {
    const out: { day: string; rows: AdminPageViewRow[] }[] = [];
    for (const row of this.rows()) {
      const day = row.created_at.slice(0, 10);
      const last = out.at(-1);
      if (last && last.day === day) last.rows.push(row);
      else out.push({ day, rows: [row] });
    }
    return out;
  });

  protected readonly isEmpty = computed(() => this.rows().length === 0);

  /** Shown only when the operator can act on it: the var ships unset on every
   *  tier, and a permanently-disabled control is worse than no control. */
  protected readonly showInternalToggle = computed(() => this.internalFilter().available);

  private pathDebounce: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    afterNextRender(() => {
      const today = utcDay(new Date());
      this.to.set(today);
      this.from.set(addDays(today, -(PRESET_DAYS[1] - 1)));
      this.ready.set(true);
      void this.load();
      void this.loadFilterOptions();
    });
  }

  // ── Loading ────────────────────────────────────────────────────────────────

  private async load(): Promise<void> {
    this.loadFailed.set(false);
    this.loading.set(true);
    const path = this.pathContains().trim();
    try {
      const res = await this.api.listPageViews({
        from: this.from(),
        to: this.to(),
        traffic: this.traffic(),
        ...(this.source() ? { source: this.source() as string } : {}),
        ...(this.country() ? { country: this.country() as string } : {}),
        ...(path ? { path_contains: path } : {}),
        exclude_internal: this.excludeInternal(),
        page: this.page(),
        perPage: PAGE_SIZE,
      });
      this.rows.set(res.data);
      this.total.set(res.total);
      this.windowTotal.set(res.window_total);
      this.windowVisitors.set(res.window_visitors);
      this.notes.set(res.notes);
      this.internalFilter.set(res.internal_filter);
      this.liveMessage.set(
        $localize`:@@admin.activity.announce.loaded:${res.total}:TOTAL: visits match these filters.`,
      );
    } catch {
      this.loadFailed.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * Populate the source / country dropdowns from the traffic-breakdown endpoint.
   *
   * Best-effort: if it fails the feed still works, the two selects just offer
   * "any" only. Losing a filter's option list is not a reason to fail the screen.
   */
  private async loadFilterOptions(): Promise<void> {
    const [from, to] = [this.from(), this.to()];
    try {
      const [sources, countries] = await Promise.all([
        this.api.listFilterOptions('source', from, to),
        this.api.listFilterOptions('country', from, to),
      ]);
      this.sourceOptions.set([this.anySource, ...sources.data.map((r) => this.toOption(r))]);
      this.countryOptions.set([this.anyCountry, ...countries.data.map((r) => this.toOption(r))]);
    } catch {
      // Deliberately silent — see the docblock.
    }
  }

  /** A breakdown group as a select option. The API's `label` is an untranslated
   *  operator fallback, so a null key gets the UI's own localized string. */
  private toOption(row: AdminBreakdownRow): AdminSelectOption {
    return row.key === null
      ? {
          value: ADMIN_PAGE_VIEW_NULL_FILTER,
          label: $localize`:@@admin.activity.filter.unknownBucket:Unknown`,
        }
      : { value: row.key, label: row.key };
  }

  protected retry(): void {
    void this.load();
  }

  // ── Filters ────────────────────────────────────────────────────────────────

  /** Every filter change returns to page 1: staying on page 7 of a result set
   *  that just shrank to two pages shows an empty table for no visible reason. */
  private refilter(): void {
    this.page.set(1);
    void this.load();
  }

  protected setTraffic(traffic: AdminTrafficPopulation): void {
    if (this.traffic() === traffic) return;
    this.traffic.set(traffic);
    this.refilter();
  }

  protected setSource(value: string | null): void {
    this.source.set(value);
    this.refilter();
  }

  protected setCountry(value: string | null): void {
    this.country.set(value);
    this.refilter();
  }

  protected onPathInput(event: Event): void {
    this.pathContains.set((event.target as HTMLInputElement).value);
    clearTimeout(this.pathDebounce);
    this.pathDebounce = setTimeout(() => this.refilter(), PATH_DEBOUNCE_MS);
  }

  protected onFromInput(event: Event): void {
    this.from.set((event.target as HTMLInputElement).value);
    this.onWindowChange();
  }

  protected onToInput(event: Event): void {
    this.to.set((event.target as HTMLInputElement).value);
    this.onWindowChange();
  }

  /** Trailing window ending today (UTC), inclusive of both ends. */
  protected applyPreset(days: number): void {
    const today = utcDay(new Date());
    this.to.set(today);
    this.from.set(addDays(today, -(days - 1)));
    this.onWindowChange();
  }

  protected isPreset(days: number): boolean {
    const today = utcDay(new Date());
    return this.to() === today && this.from() === addDays(today, -(days - 1));
  }

  private onWindowChange(): void {
    if (!this.from() || !this.to() || this.from() > this.to()) return;
    this.refilter();
    // The available sources and countries are a property of the window.
    void this.loadFilterOptions();
  }

  protected toggleInternal(event: Event): void {
    this.excludeInternal.set((event.target as HTMLInputElement).checked);
    this.refilter();
  }

  protected goToPage(page: number): void {
    this.page.set(page);
    void this.load();
  }

  // ── Row rendering ──────────────────────────────────────────────────────────

  /**
   * The bot chip. `null` is not "human" — it is *never classified*, and those
   * rows are being counted as human, so the chip says so rather than leaving the
   * over-inclusion invisible at row level (§1.1).
   */
  protected botChip(row: AdminPageViewRow): string | null {
    if (row.is_bot === true) {
      return row.bot_name ?? $localize`:@@admin.activity.bot.other:Other bot`;
    }
    if (row.is_bot === null) {
      return $localize`:@@admin.activity.bot.unclassified:Unclassified`;
    }
    return null;
  }

  /** `365d59e9 · AS23700` — a truncated hash and a network, and nothing that
   *  could identify a person (§9.7). */
  protected visitorLabel(row: AdminPageViewRow): string {
    const parts: string[] = [];
    if (row.visitor_hash) parts.push(row.visitor_hash);
    if (row.cf_asn !== null) parts.push(`AS${row.cf_asn}`);
    return parts.join(' · ');
  }

  /** Country + Cloudflare colo — the colo IS the nearest city (§5.2). */
  protected locationLabel(row: AdminPageViewRow): string {
    return [row.cf_country, row.cf_colo].filter(Boolean).join(' · ');
  }

  protected routerLinkFor(row: AdminPageViewRow): string[] | null {
    if (!row.entity) return null;
    return row.entity_type === 'product'
      ? ['/products', row.entity.slug]
      : ['/vendors', row.entity.slug];
  }

  /** Relative age. Browser-only: the table is empty during SSR, so `Date.now()`
   *  is never read server-side and there is no hydration divergence. */
  protected age(createdAt: string): string {
    const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(createdAt)) / 60_000));
    if (minutes < 1) return $localize`:@@admin.activity.age.now:just now`;
    if (minutes < 60) return $localize`:@@admin.activity.age.minutes:${minutes}:COUNT: min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return $localize`:@@admin.activity.age.hours:${hours}:COUNT: h`;
    const days = Math.floor(hours / 24);
    return $localize`:@@admin.activity.age.days:${days}:COUNT: d`;
  }

  /** Exact UTC instant, for the `title` tooltip. Built in TS because an
   *  interpolated `i18n-title` emits no attribute at all. */
  protected exactUtc(createdAt: string): string {
    const iso = new Date(createdAt).toISOString();
    return $localize`:@@admin.activity.time.exactUtc:${iso.slice(0, 10)}:DATE: ${iso.slice(11, 19)}:TIME: UTC`;
  }

  /** Day-separator heading, e.g. `2026-08-10 (UTC)`. UTC is always labelled
   *  (§9.5) — the digest and every cron are UTC, and the operator is not. */
  protected dayLabel(day: string): string {
    return $localize`:@@admin.activity.dayLabel:${day}:DAY: (UTC)`;
  }

  // ── Summary strip ──────────────────────────────────────────────────────────

  /** "1,204 · 312 excluding internal" — never the filtered figure alone. */
  protected excludingInternalLabel(count: AdminCount): string | null {
    if (count.excluding_internal === null) return null;
    return $localize`:@@admin.activity.summary.excludingInternal:${count.excluding_internal}:COUNT: excluding internal traffic`;
  }

  protected readonly internalToggleLabel = computed(() => {
    const asns = this.internalFilter().asns;
    return asns.length === 0
      ? $localize`:@@admin.activity.filter.internal.plain:Filter out internal traffic`
      : $localize`:@@admin.activity.filter.internal.withAsns:Filter out internal traffic (AS${asns.join(', AS')}:ASNS:)`;
  });
}
