import { DatePipe, formatDate } from '@angular/common';
import {
  Component,
  ElementRef,
  Injector,
  LOCALE_ID,
  afterNextRender,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';

import {
  SEO_TREND_WEEKS_DEFAULT,
  type SeoTrendLanes,
  type SeoTrendResponse,
  type SeoTrendWeek,
} from '@aeci/shared';

import { AecButton } from '../../shared/button/button';
import { AdminNotes } from '../admin-notes';
import {
  CONSOLE_CAPTION_CLASS,
  CONSOLE_LABEL_CLASS,
  CONSOLE_PANEL_CLASS,
  CONSOLE_TABLE,
} from '../console/console-table';
import { formatPercent, formatThousands } from '../charts/format';
import { LineChart } from '../charts/line-chart';
import type { NullableChartSeries } from '../charts/chart-types';
import { AdminSeoApi } from './admin-seo.api';
import { SEO_ENGINE_LABELS } from './seo-labels';

/** One cell of the week table. `kind` decides the treatment, never colour alone. */
export interface TrendCell {
  kind: 'value' | 'notRecorded' | 'none' | 'noPages';
  text: string;
  /** A second line: "5 of 22", "4 of 15 so far". */
  sub?: string;
  /** What a screen reader says instead of `text`, when `text` is an
   *  abbreviation: "9.1 days" for "9.1 d". */
  spoken?: string;
  /** The sub line belongs to a cohort still inside its window. */
  open?: boolean;
  delta?: TrendDelta;
}

/** The change from the week before. Arrow and number are hidden from assistive
 *  technology. The words carry the direction, as `stat-tile.ts` does. */
export interface TrendDelta {
  glyph: string;
  amount: string;
  spoken: string;
}

export interface TrendRow {
  key: string;
  label: string;
  sub?: string;
  cells: TrendCell[];
}

type LaneKey = Exclude<keyof SeoTrendLanes, 'reindex_oldest_tier12_age_days'>;

/**
 * Panel 2 of `/admin/seo`, "Am I keeping up?" (AECI-822, `ADMIN_PANEL_SPEC.md`
 * §5.24.6).
 *
 * Week over week for the last complete ISO weeks. The API returns newest first.
 * The panel reverses it so time runs left to right in the charts and the table
 * alike (Chris, 2026-11-24).
 *
 * ── NEVER ZERO ──────────────────────────────────────────────────────────────
 * A lane week with no snapshot row is `null`, and it reads "Not recorded" in
 * the table and is a gap in the chart. It is never drawn or printed as 0. The
 * oldest re-index row has a third value, `'none'`: that day was sampled and held
 * no tier-1 or tier-2 row. A cohort that published nothing has no rate, and
 * reads "No pages".
 *
 * ── THE ONE SELF-REPORTED NUMBER ────────────────────────────────────────────
 * "Requests recorded" counts the operator's own "Requested indexing" answers in
 * the re-index Done dialog. It is labelled as self-reported, because it is not
 * a measurement (§5.24.1, §5.24.6).
 *
 * Fetches its own endpoint after render and fails on its own, with the
 * `/admin/system` error recipe, so a failed trend never blanks Panel 1.
 */
@Component({
  selector: 'aec-seo-trend-panel',
  imports: [AdminNotes, AecButton, DatePipe, LineChart],
  templateUrl: './seo-trend-panel.html',
  styles: [':host { display: block; }'],
})
export class SeoTrendPanel {
  private readonly api = inject(AdminSeoApi);
  private readonly locale = inject(LOCALE_ID);
  private readonly injector = inject(Injector);

  /** Prefix for every element id in the panel, so two instances on one page
   *  (the preview's state gallery) never share an id. */
  readonly idPrefix = input('admin-seo');

  /** The console recipe (AECI-2125, `console/console-table.ts`). */
  protected readonly t = CONSOLE_TABLE;
  protected readonly panelClass = CONSOLE_PANEL_CLASS;
  protected readonly captionClass = CONSOLE_CAPTION_CLASS;
  protected readonly labelClass = CONSOLE_LABEL_CLASS;
  /** Small print: notes and the read-at line, as on `/admin/traffic`. */
  protected readonly noteClass = 'text-t-13 text-(--text-secondary)';

  /*
   * The week table on the console table recipe. Its first column sticks while the
   * weeks scroll, so its cells carry the page fill, and every cell aligns to the
   * top because a row header has two lines. These are the recipe's cell parts
   * written out with `align-top`, because two vertical alignments in one class
   * list would be decided by stylesheet order.
   */
  protected readonly weekHead = `${CONSOLE_TABLE.head} sticky left-0 z-10 min-w-[11rem] bg-(--surface-base)`;
  protected readonly groupHead =
    'sticky left-0 bg-(--surface-base) px-3 pt-6 pb-2 text-start text-t-13 font-semibold leading-[1.4] tracking-[0.01em] text-(--text-secondary) border-b border-(--border-strong)';
  protected readonly rowHead =
    'sticky left-0 z-10 min-w-[11rem] px-3 py-2 text-start align-top font-normal border-b border-(--border-default)';
  protected readonly cell =
    'px-3 py-2 text-end align-top whitespace-nowrap tabular-nums lining-nums border-b border-(--border-default)';

  /** Text for the page's polite live region. */
  readonly announce = output<string>();

  private readonly heading = viewChild<ElementRef<HTMLElement>>('heading');

  protected readonly data = signal<SeoTrendResponse | null>(null);
  protected readonly loading = signal(true);
  protected readonly loadFailed = signal(false);

  /** Oldest first. */
  protected readonly weeks = computed<readonly SeoTrendWeek[]>(() =>
    [...(this.data()?.weeks ?? [])].reverse(),
  );

  /** "19 Oct". The Monday is a bare `YYYY-MM-DD`, which `formatDate` reads as
   *  LOCAL midnight, so a browser west or east of UTC would shift it a day. It is
   *  pinned to UTC midnight first. */
  protected readonly weekLabels = computed(() =>
    this.weeks().map((w) =>
      formatDate(`${w.week_start}T00:00:00.000Z`, 'd MMM', this.locale, 'UTC'),
    ),
  );

  /** The cohort window in days, from the data rather than a copy of the tunable. */
  protected readonly cohortDays = computed(() => this.weeks()[0]?.cohort.crawled_within_days ?? 7);

  /** The newest week's cohort is still inside its window. */
  protected readonly newestOpen = computed(() => this.weeks().at(-1)?.cohort.open ?? false);

  protected readonly rateSeries = computed<NullableChartSeries[]>(() => [
    {
      key: 'google',
      label: SEO_ENGINE_LABELS.google,
      slot: 1,
      values: this.weeks().map((w) => w.cohort.google.rate),
    },
    {
      key: 'bing',
      label: SEO_ENGINE_LABELS.bing,
      slot: 2,
      values: this.weeks().map((w) => w.cohort.bing.rate),
    },
  ]);

  protected readonly depthSeries = computed<NullableChartSeries[]>(() => [
    {
      key: 'google',
      label: SEO_ENGINE_LABELS.google,
      slot: 1,
      values: this.weeks().map((w) => w.lanes.uncrawled_google),
    },
    {
      key: 'bing',
      label: SEO_ENGINE_LABELS.bing,
      slot: 2,
      values: this.weeks().map((w) => w.lanes.uncrawled_bing),
    },
  ]);

  /** The week count the intro names. The panel asks for exactly this many. */
  protected readonly weekCount = SEO_TREND_WEEKS_DEFAULT;

  /** The first week with any stored lane, as "23 Nov", or null when none was
   *  stored. Derived from the data, so the note never names a stale date. */
  protected readonly firstRecordedLabel = computed(() => {
    const index = this.weeks().findIndex((w) => Object.values(w.lanes).some((v) => v !== null));
    return index < 0 ? null : (this.weekLabels()[index] ?? null);
  });

  /** Some lane week was not recorded, so the table explains what that means. */
  protected readonly hasUnrecorded = computed(() =>
    this.weeks().some((w) => Object.values(w.lanes).some((v) => v === null)),
  );

  protected readonly cohortRows = computed<TrendRow[]>(() => {
    const weeks = this.weeks();
    return [
      {
        key: 'published',
        label: $localize`:@@admin.seo.trend.row.published:Published`,
        sub: $localize`:@@admin.seo.trend.row.published.sub:Product and vendor pages, by publish week`,
        cells: weeks.map((w) => value(formatThousands(w.cohort.published))),
      },
      {
        key: 'google',
        label: $localize`:@@admin.seo.trend.row.crawledGoogle:Crawled by Google within ${this.cohortDays()}:DAYS: days`,
        cells: weeks.map((w) => rateCell(w, 'google')),
      },
      {
        key: 'bing',
        label: $localize`:@@admin.seo.trend.row.crawledBing:Crawled by Bing within ${this.cohortDays()}:DAYS: days`,
        cells: weeks.map((w) => rateCell(w, 'bing')),
      },
    ];
  });

  protected readonly workRows = computed<TrendRow[]>(() => {
    const weeks = this.weeks();
    return [
      {
        key: 'reindex',
        label: $localize`:@@admin.seo.trend.row.reindex:Re-index queue`,
        cells: laneCells(weeks, 'reindex_pending'),
      },
      {
        key: 'oldest',
        label: $localize`:@@admin.seo.trend.row.oldest:Oldest re-index row`,
        sub: $localize`:@@admin.seo.trend.row.oldest.sub:Priority 1 or 2, age on the last day of the week`,
        cells: weeks.map((w) => oldestCell(w.lanes.reindex_oldest_tier12_age_days)),
      },
      {
        key: 'uncrawledGoogle',
        label: $localize`:@@admin.seo.trend.row.uncrawledGoogle:Not crawled by Google`,
        cells: laneCells(weeks, 'uncrawled_google'),
      },
      {
        key: 'uncrawledBing',
        label: $localize`:@@admin.seo.trend.row.uncrawledBing:Not crawled by Bing`,
        cells: laneCells(weeks, 'uncrawled_bing'),
      },
      {
        key: 'pairs',
        label: $localize`:@@admin.seo.trend.row.pairs:Pair pages with no reviews`,
        sub: $localize`:@@admin.seo.trend.row.pairs.sub:A count to watch, not a work list. It falls when a reviewer writes a review.`,
        cells: laneCells(weeks, 'pairs_without_reviews'),
      },
    ];
  });

  /** The table's first two row groups. The self-reported row is its own group
   *  in the template, because it carries a label no measured row has. */
  protected readonly groups = computed(() => [
    {
      key: 'cohort',
      heading: $localize`:@@admin.seo.trend.group.cohort:New product and vendor pages`,
      rows: this.cohortRows(),
    },
    {
      key: 'work',
      heading: $localize`:@@admin.seo.trend.group.work:Work left at the end of the week`,
      rows: this.workRows(),
    },
  ]);

  protected readonly requestCells = computed<TrendCell[]>(() =>
    this.weeks().map((w) => value(formatThousands(w.requests_self_reported))),
  );

  constructor() {
    afterNextRender(() => {
      void this.load();
    });
  }

  private async load(): Promise<boolean> {
    this.loadFailed.set(false);
    this.loading.set(true);
    try {
      this.data.set(await this.api.trend(SEO_TREND_WEEKS_DEFAULT));
      return true;
    } catch {
      this.loadFailed.set(true);
      this.data.set(null);
      return false;
    } finally {
      this.loading.set(false);
    }
  }

  /** The Try again button unmounts while the read is in flight, so focus would
   *  drop to the page. Once it settles, focus goes to the panel heading and the
   *  live region says how it went, including a second failure. */
  protected async retry(): Promise<void> {
    const ok = await this.load();
    this.announce.emit(
      ok
        ? $localize`:@@admin.seo.trend.announce.loaded:Weekly trend loaded.`
        : $localize`:@@admin.seo.trend.announce.failed:The weekly trend still could not load.`,
    );
    afterNextRender(() => this.heading()?.nativeElement.focus(), { injector: this.injector });
  }
}

function value(text: string, delta?: TrendDelta): TrendCell {
  return delta ? { kind: 'value', text, delta } : { kind: 'value', text };
}

function notRecorded(): TrendCell {
  return {
    kind: 'notRecorded',
    text: $localize`:@@admin.seo.trend.notRecorded:Not recorded`,
  };
}

/** One engine's cohort rate. No pages published means no rate, never 0%. */
function rateCell(week: SeoTrendWeek, engine: 'google' | 'bing'): TrendCell {
  const { published, open } = week.cohort;
  const { crawled, rate } = week.cohort[engine];
  if (published === 0 || rate === null) {
    return { kind: 'noPages', text: $localize`:@@admin.seo.trend.noPages:No pages` };
  }
  const sub = open
    ? $localize`:@@admin.seo.trend.ofSoFar:${crawled}:CRAWLED: of ${published}:PUBLISHED: so far`
    : $localize`:@@admin.seo.trend.of:${crawled}:CRAWLED: of ${published}:PUBLISHED:`;
  return { kind: 'value', text: formatPercent(crawled, published), sub, open };
}

/** A stored lane count per week, with the change from the week before. The
 *  delta needs a recorded week on BOTH sides: a change across a "Not recorded"
 *  week would be a two-week change shown as one. */
function laneCells(weeks: readonly SeoTrendWeek[], key: LaneKey): TrendCell[] {
  return weeks.map((w, i) => {
    const current = w.lanes[key];
    if (current === null) return notRecorded();
    const previous = i > 0 ? weeks[i - 1]!.lanes[key] : null;
    return value(
      formatThousands(current),
      previous === null ? undefined : delta(current - previous),
    );
  });
}

function oldestCell(age: number | 'none' | null): TrendCell {
  if (age === null) return notRecorded();
  if (age === 'none') {
    return {
      kind: 'none',
      text: $localize`:@@admin.seo.trend.none:None`,
      sub: $localize`:@@admin.seo.trend.none.sub:no such row`,
    };
  }
  const days = age.toFixed(1);
  return {
    kind: 'value',
    text: $localize`:@@admin.seo.trend.days:${days}:DAYS: d`,
    spoken: $localize`:@@admin.seo.trend.days.spoken:${days}:DAYS: days`,
  };
}

function delta(diff: number): TrendDelta {
  const amount = formatThousands(Math.abs(diff));
  if (diff === 0) {
    return {
      glyph: '→',
      amount: '0',
      spoken: $localize`:@@admin.seo.trend.delta.flat:unchanged from the week before`,
    };
  }
  return diff > 0
    ? {
        glyph: '↑',
        amount,
        spoken: $localize`:@@admin.seo.trend.delta.up:up ${amount}:AMOUNT: from the week before`,
      }
    : {
        glyph: '↓',
        amount,
        spoken: $localize`:@@admin.seo.trend.delta.down:down ${amount}:AMOUNT: from the week before`,
      };
}
