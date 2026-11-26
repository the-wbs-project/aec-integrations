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

import type {
  AdminNote,
  SeoEngine,
  SeoFunnelBaseline,
  SeoFunnelEngine,
  SeoFunnelResponse,
  SeoFunnelStage,
  SeoFunnelStageName,
} from '@aeci/shared';

import { AecButton } from '../../shared/button/button';
import { AdminNotes } from '../admin-notes';
import {
  CONSOLE_CAPTION_CLASS,
  CONSOLE_LABEL_CLASS,
  CONSOLE_PANEL_CLASS,
  CONSOLE_TABLE,
} from '../console/console-table';
import { formatRate, formatThousands } from '../charts/format';
import { slotClass, type ChartSlot } from '../charts/chart-types';
import { AdminSeoApi } from './admin-seo.api';
import { SEO_ENGINE_LABELS } from './seo-labels';

/**
 * The stages each engine may draw, in order. A stage the API sends that is not
 * on its engine's list is dropped, never drawn.
 *
 * Google never has `indexed`: Google has no bulk index API, so its index signal
 * is `impressed`, labelled "Indexed (lower bound)". Bing never has `impressed`:
 * the ingest stores no Bing count of pages with an impression, because Bing does
 * not state the window that figure covers (§5.24.7, §5.24.10). Chris confirmed on
 * 2026-11-24 that the mock-up's Bing "Impressed" row is not built. So a future
 * API that sent one would still not render it here.
 */
const ENGINE_STAGES: Readonly<Record<SeoEngine, readonly SeoFunnelStageName[]>> = {
  google: ['catalog', 'crawled', 'impressed', 'clicked'],
  bing: ['catalog', 'crawled', 'indexed', 'clicked'],
};

/** Each engine's series slot, the same as Panel 2's charts (`DESIGN.md`). */
const ENGINE_SLOT: Readonly<Record<SeoEngine, ChartSlot>> = { google: 1, bing: 2 };

/** One stage drawn as a rate bar with its count beside it. */
export interface FunnelBarRow {
  key: SeoFunnelStageName;
  label: string;
  sub: string | null;
  /** "69.5%", "Base" for the catalog stage, or "No rate" when the base is 0. */
  rateText: string;
  /** The bar's width in percent, clamped to 0..100. Null draws no bar. */
  barPercent: number | null;
  countText: string;
}

/** The clicked stage. Click-through is a fraction of a percent, so it is text,
 *  not a bar: a bar that short draws nothing (the approved mock-up). */
export interface FunnelClickRow {
  ctrText: string;
  /** Google only. Bing's daily series has no position, so Bing never gets one. */
  positionText: string | null;
  totalsText: string;
}

export interface BaselineCell {
  text: string;
  notRecorded: boolean;
}

export interface BaselineRow {
  key: string;
  label: string;
  current: BaselineCell;
  reference: BaselineCell;
}

export interface BaselineView {
  monthLabel: string;
  explain: string;
  currentHeader: string;
  /** The current row's Pacific dates, or null when no day is recorded. */
  currentDates: string | null;
  /** "Days recorded: 9 of 28" when the current window is short, else null. */
  currentRecorded: string | null;
  referenceHeader: string;
  referenceDates: string;
  rows: BaselineRow[];
  currentAbsent: boolean;
  referenceRounded: boolean;
}

export interface FunnelEngineView {
  engine: SeoEngine;
  label: string;
  scope: string;
  searchWindow: string | null;
  caption: string;
  fillClass: string;
  rows: FunnelBarRow[];
  clicked: FunnelClickRow | null;
  notes: AdminNote[];
  baseline: BaselineView | null;
}

/**
 * Panel 3 of `/admin/seo`, "Is it working?" (AECI-823, `ADMIN_PANEL_SPEC.md`
 * §5.24.7).
 *
 * Each engine's funnel over the trailing 28 days, Google and Bing side by side.
 * The rate is drawn and the count sits beside it, because the catalog grows and
 * a rising count can hide a falling rate. The two engines are never summed or
 * compared in one figure: they are different indexes.
 *
 * ── RENDER WHAT THE API SENDS, NEVER INVENT ────────────────────────────────
 * A stage with no data is omitted by the API, and it is omitted here too, never
 * drawn as 0. {@link ENGINE_STAGES} also drops any stage an engine can never
 * have, so a Bing "Impressed" row or a Bing position cannot appear.
 *
 * ── EACH FUNNEL IS A REAL TABLE ─────────────────────────────────────────────
 * The rate and the count are text in the table's cells. The bar is
 * `aria-hidden` decoration beside the rate, the `horizontal-bar-chart.ts`
 * reasoning: a hidden copy of the numbers would be announced twice.
 *
 * Fetches its own endpoint after render and fails on its own, with the
 * `/admin/system` error recipe, so a failed funnel never blanks Panels 1 and 2.
 * After a retry settles, focus moves to the panel heading and the outcome goes
 * to the page's live region through {@link announce}, so a retry that fails
 * again is still heard.
 */
@Component({
  selector: 'aec-seo-funnel-panel',
  imports: [AdminNotes, AecButton, DatePipe],
  templateUrl: './seo-funnel-panel.html',
  styles: [':host { display: block; }'],
})
export class SeoFunnelPanel {
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
   * The funnel and baseline tables on the console table recipe. A stage header has
   * two lines, so every cell aligns to the top. These are the recipe's cell parts
   * written out with `align-top`, because two vertical alignments in one class
   * list would be decided by stylesheet order.
   */
  protected readonly stageHead =
    'w-[45%] px-3 py-2 text-start align-top font-normal border-b border-(--border-default)';
  protected readonly topCell = 'px-3 py-2 align-top border-b border-(--border-default)';
  protected readonly topNum =
    'px-3 py-2 text-end align-top tabular-nums lining-nums whitespace-nowrap border-b border-(--border-default)';

  /** Text for the page's polite live region. */
  readonly announce = output<string>();

  private readonly heading = viewChild<ElementRef<HTMLElement>>('heading');

  protected readonly data = signal<SeoFunnelResponse | null>(null);
  protected readonly loading = signal(true);
  protected readonly loadFailed = signal(false);

  /** The crawl window's length in UTC days, from the data. It is shorter than
   *  28 when the window is clamped to the first row with a real path. */
  protected readonly crawlDays = computed(() => this.data()?.crawl_window.days ?? null);

  /** "Nov 30, 2026", the last complete UTC day the crawl stages run to. */
  protected readonly dayLabel = computed(() => {
    const d = this.data();
    return d ? this.dateLabel(d.day) : '';
  });

  protected readonly engines = computed<FunnelEngineView[]>(() => {
    const d = this.data();
    if (!d) return [];
    return d.engines
      .filter((e) => e.engine in ENGINE_STAGES)
      .map((e) => this.engineView(e, d.notes, d.crawl_window.days));
  });

  /** Notes that name no engine render once, under both funnels. Engine notes
   *  render inside that engine's card, beside the figures they qualify. */
  protected readonly panelNotes = computed(() =>
    (this.data()?.notes ?? []).filter((n) => engineOf(n) === null),
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
      this.data.set(await this.api.funnel());
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
   *  drop to the page. Once it settles, focus goes to the heading and the live
   *  region says how it went, including a second failure. */
  protected async retry(): Promise<void> {
    const ok = await this.load();
    this.announce.emit(
      ok
        ? $localize`:@@admin.seo.funnel.announce.loaded:Search funnel loaded.`
        : $localize`:@@admin.seo.funnel.announce.failed:The search funnel still could not load.`,
    );
    afterNextRender(() => this.heading()?.nativeElement.focus(), { injector: this.injector });
  }

  /** A bare Pacific or UTC date, `YYYY-MM-DD`, as "Nov 26, 2026". Formatted at
   *  UTC midnight in UTC, so the server and every browser print the same day. */
  private dateLabel(day: string): string {
    return formatDate(`${day}T00:00:00.000Z`, 'mediumDate', this.locale, 'UTC');
  }

  private engineView(
    e: SeoFunnelEngine,
    notes: readonly AdminNote[],
    crawlDays: number,
  ): FunnelEngineView {
    const allowed = ENGINE_STAGES[e.engine];
    const stages = allowed
      .map((name) => e.stages.find((s) => s.stage === name))
      .filter((s): s is SeoFunnelStage => s !== undefined);
    const label = SEO_ENGINE_LABELS[e.engine];
    const w = e.search_window;
    const from = w ? this.dateLabel(w.from) : '';
    const to = w ? this.dateLabel(w.to) : '';
    const days = w?.days ?? 0;
    const recorded = w?.days_recorded ?? 0;

    let searchWindow: string | null = null;
    if (w) {
      searchWindow =
        recorded < days
          ? e.engine === 'google'
            ? $localize`:@@admin.seo.funnel.window.google.partial:Search Console figures cover the ${days}:DAYS: Pacific dates ${from}:FROM: to ${to}:TO:. Days recorded: ${recorded}:RECORDED: of ${days}:DAYS:.`
            : $localize`:@@admin.seo.funnel.window.bing.partial:Bing Webmaster Tools figures cover the ${days}:DAYS: Pacific dates ${from}:FROM: to ${to}:TO:. Days recorded: ${recorded}:RECORDED: of ${days}:DAYS:.`
          : e.engine === 'google'
            ? $localize`:@@admin.seo.funnel.window.google:Search Console figures cover the ${days}:DAYS: Pacific dates ${from}:FROM: to ${to}:TO:.`
            : $localize`:@@admin.seo.funnel.window.bing:Bing Webmaster Tools figures cover the ${days}:DAYS: Pacific dates ${from}:FROM: to ${to}:TO:.`;
    }

    const catalog = stages.find((s) => s.stage === 'catalog');
    const clickedStage = stages.find((s) => s.stage === 'clicked');
    const engineNotes = notes.filter((n) => engineOf(n) === e.engine);
    const day = this.dayLabel();

    return {
      engine: e.engine,
      label,
      scope:
        e.engine === 'google'
          ? $localize`:@@admin.seo.funnel.scope.google:Pages on www.aecintegrations.com. Crawled counts the ${crawlDays}:CRAWL_DAYS: UTC days ending ${day}:DAY:.`
          : $localize`:@@admin.seo.funnel.scope.bing:Pages on www.aecintegrations.com, the site as Bing registers it. Crawled counts the ${crawlDays}:CRAWL_DAYS: UTC days ending ${day}:DAY:.`,
      searchWindow,
      caption: $localize`:@@admin.seo.funnel.caption:${label}:ENGINE: funnel, www pages, ${crawlDays}:CRAWL_DAYS: days ending ${day}:DAY:`,
      fillClass: slotClass(ENGINE_SLOT[e.engine], 'swatch'),
      rows: stages
        .filter((s) => s.stage !== 'clicked')
        .map((s) => this.barRow(e.engine, s, catalog?.count ?? null)),
      clicked: clickedStage ? clickRow(e.engine, clickedStage) : null,
      notes: engineNotes,
      baseline: e.engine === 'google' && e.baseline ? this.baselineView(e.baseline) : null,
    };
  }

  private barRow(engine: SeoEngine, s: SeoFunnelStage, catalogCount: number | null): FunnelBarRow {
    const countText = formatThousands(s.count);
    if (s.stage === 'catalog') {
      return {
        key: s.stage,
        label: stageLabel(s.stage),
        sub: null,
        rateText: $localize`:@@admin.seo.funnel.base:Base`,
        barPercent: catalogCount && catalogCount > 0 ? 100 : null,
        countText,
      };
    }
    const rate = formatRate(s.rate);
    return {
      key: s.stage,
      label: stageLabel(s.stage),
      sub: this.stageSub(engine, s),
      rateText: rate ?? $localize`:@@admin.seo.funnel.noRate:No rate`,
      // Bing's index figure is its own count for the whole site and can pass
      // the catalog. The text says so. The bar stops at full.
      barPercent: s.rate === null ? null : Math.max(0, Math.min(100, s.rate * 100)),
      countText,
    };
  }

  private stageSub(engine: SeoEngine, s: SeoFunnelStage): string | null {
    switch (s.stage) {
      case 'crawled':
        // The one-line crawl-coverage caveat §5.24.4 puts beside this stage.
        return engine === 'google'
          ? $localize`:@@admin.seo.funnel.crawled.google.sub:Verified Googlebot visits our gateway recorded. A crawl that got an error or a redirect is not counted.`
          : $localize`:@@admin.seo.funnel.crawled.bing.sub:Verified Bingbot visits our gateway recorded. A crawl that got an error or a redirect is not counted.`;
      case 'impressed':
        return $localize`:@@admin.seo.funnel.impressed.sub:Pages with at least one search impression in the window. Google offers no indexed count we can read, so the real figure is higher.`;
      case 'indexed': {
        const asOf = s.as_of ? this.dateLabel(s.as_of) : null;
        return asOf
          ? $localize`:@@admin.seo.funnel.indexed.sub.asOf:Bing's own count, read on ${asOf}:AS_OF:. Bing does not say how it counts it, so it can pass the catalog.`
          : $localize`:@@admin.seo.funnel.indexed.sub:Bing's own count. Bing does not say how it counts it, so it can pass the catalog.`;
      }
      default:
        return null;
    }
  }

  private baselineView(b: SeoFunnelBaseline): BaselineView {
    const ref = b.reference;
    const cur = b.current;
    const months = ref.window_months;
    const curDays = cur?.window.days ?? 28;
    const curRecorded = cur?.window.days_recorded ?? curDays;
    const curShort = cur !== null && curRecorded < curDays;
    const refEnd = this.dateLabel(ref.window_end);
    const notRecorded: BaselineCell = {
      text: $localize`:@@admin.seo.funnel.baseline.notRecorded:Not recorded`,
      notRecorded: true,
    };
    const v = (text: string): BaselineCell => ({ text, notRecorded: false });
    const position = (p: number | null): BaselineCell =>
      p === null ? notRecorded : v(p.toFixed(1));

    return {
      monthLabel: formatDate(`${ref.taken_on}T00:00:00.000Z`, 'MMMM', this.locale, 'UTC'),
      explain: curShort
        ? $localize`:@@admin.seo.funnel.baseline.explain.short:The whole Search Console property, every host, which is how the baseline was taken. The baseline covers ${months}:MONTHS: months. This covers ${curDays}:DAYS: Pacific dates, and days recorded: ${curRecorded}:RECORDED: of ${curDays}:DAYS:. Read it as a reference point, not a like-for-like comparison.`
        : $localize`:@@admin.seo.funnel.baseline.explain:The whole Search Console property, every host, which is how the baseline was taken. The baseline covers ${months}:MONTHS: months and this covers ${curDays}:DAYS: days. Read it as a reference point, not a like-for-like comparison.`,
      currentHeader: $localize`:@@admin.seo.funnel.baseline.current:Last ${curDays}:DAYS: days`,
      currentDates: cur
        ? $localize`:@@admin.seo.funnel.baseline.currentDates:${this.dateLabel(cur.window.from)}:FROM: to ${this.dateLabel(cur.window.to)}:TO:`
        : null,
      currentRecorded: curShort
        ? $localize`:@@admin.seo.funnel.baseline.currentRecorded:Days recorded: ${curRecorded}:RECORDED: of ${curDays}:DAYS:`
        : null,
      referenceHeader: $localize`:@@admin.seo.funnel.baseline.reference:Baseline`,
      referenceDates: $localize`:@@admin.seo.funnel.baseline.referenceDates:${months}:MONTHS: months to ${refEnd}:END:`,
      currentAbsent: cur === null,
      referenceRounded: ref.impressions_rounded,
      rows: [
        {
          key: 'ctr',
          label: $localize`:@@admin.seo.funnel.baseline.ctr:Click-through`,
          current: cur ? v(formatCtr(cur.ctr)) : notRecorded,
          reference: v(formatCtr(ref.ctr)),
        },
        {
          key: 'position',
          label: $localize`:@@admin.seo.funnel.baseline.position:Average position`,
          current: cur ? position(cur.position_avg) : notRecorded,
          reference: position(ref.position_avg),
        },
        {
          key: 'clicks',
          label: $localize`:@@admin.seo.funnel.baseline.clicks:Clicks`,
          current: cur ? v(formatThousands(cur.clicks)) : notRecorded,
          reference: v(formatThousands(ref.clicks)),
        },
        {
          key: 'impressions',
          label: $localize`:@@admin.seo.funnel.baseline.impressions:Impressions`,
          current: cur ? v(formatThousands(cur.impressions)) : notRecorded,
          reference: v(
            ref.impressions_rounded
              ? $localize`:@@admin.seo.funnel.baseline.rounded:about ${formatThousands(ref.impressions)}:IMPRESSIONS:`
              : formatThousands(ref.impressions),
          ),
        },
      ],
    };
  }
}

function engineOf(n: AdminNote): SeoEngine | null {
  const e = n.params?.['engine'];
  return e === 'google' || e === 'bing' ? e : null;
}

function stageLabel(stage: SeoFunnelStageName): string {
  switch (stage) {
    case 'catalog':
      return $localize`:@@admin.seo.funnel.stage.catalog:In the catalog sitemap`;
    case 'crawled':
      return $localize`:@@admin.seo.funnel.stage.crawled:Crawled`;
    case 'impressed':
      return $localize`:@@admin.seo.funnel.stage.impressed:Indexed (lower bound)`;
    case 'indexed':
      return $localize`:@@admin.seo.funnel.stage.indexed:Indexed, as reported by Bing`;
    case 'clicked':
      return $localize`:@@admin.seo.funnel.stage.clicked:Clicked`;
  }
}

/** Click-through to two decimals: "0.34%". It is a fraction of a percent, so
 *  `formatRate`'s one decimal would print most real values as "0.3%". */
function formatCtr(rate: number | null): string {
  return rate === null
    ? $localize`:@@admin.seo.funnel.noImpressions:No impressions`
    : `${(rate * 100).toFixed(2)}%`;
}

function clickRow(engine: SeoEngine, s: SeoFunnelStage): FunnelClickRow {
  const clicks = formatThousands(s.count);
  const impressions = s.impressions === undefined ? null : formatThousands(s.impressions);
  const ctr = formatCtr(s.rate);
  let positionText: string | null = null;
  if (engine === 'google') {
    positionText =
      s.position_avg === null || s.position_avg === undefined
        ? $localize`:@@admin.seo.funnel.clicked.noPosition:no average position recorded`
        : $localize`:@@admin.seo.funnel.clicked.position:at average position ${s.position_avg.toFixed(1)}:POSITION:`;
  }
  return {
    ctrText:
      s.rate === null ? ctr : $localize`:@@admin.seo.funnel.clicked.ctr:${ctr}:CTR: click-through`,
    positionText,
    // A missing impressions figure is never printed as "from 0 impressions".
    totalsText:
      impressions === null
        ? $localize`:@@admin.seo.funnel.clicked.clicksOnly:${clicks}:CLICKS: clicks, impressions not recorded`
        : $localize`:@@admin.seo.funnel.clicked.totals:${clicks}:CLICKS: clicks from ${impressions}:IMPRESSIONS: impressions`,
  };
}
