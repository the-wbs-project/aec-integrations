import { DatePipe, isPlatformBrowser } from '@angular/common';
import {
  Component,
  ElementRef,
  Injector,
  PLATFORM_ID,
  afterNextRender,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';

import {
  SEO_QUEUE_PAGE_SIZE,
  type AdminNote,
  type SeoEngine,
  type SeoQueueItem,
  type SeoQueueLane,
  type SeoQueueResponse,
} from '@aeci/shared';

import { AecButton } from '../../shared/button/button';
import { AdminNotes } from '../admin-notes';
import { AdminPaginator } from '../admin-paginator';
import { AdminDisclosureButton } from '../console/disclosure-button';
import {
  CONSOLE_CAPTION_CLASS,
  CONSOLE_LABEL_CLASS,
  CONSOLE_PANEL_CLASS,
  CONSOLE_TABLE,
} from '../console/console-table';
import { AdminSeoApi } from './admin-seo.api';
import { SEO_ENGINE_LABELS } from './seo-labels';

const DAY_MS = 86_400_000;

/**
 * The closed part of an open vocabulary. `SeoQueueItemSchema.page_type` is a
 * plain string, like `reindex.reason`, so a page type this build has never seen
 * is humanized rather than blanked. Never convert this map to a closed union.
 */
const PAGE_TYPE_LABELS: Readonly<Record<string, string>> = {
  product: $localize`:@@admin.seo.pageType.product:Product`,
  vendor: $localize`:@@admin.seo.pageType.vendor:Vendor`,
  pair: $localize`:@@admin.seo.pageType.pair:Integration pair`,
  category: $localize`:@@admin.seo.pageType.category:Category`,
  audience: $localize`:@@admin.seo.pageType.audience:Audience`,
  phase: $localize`:@@admin.seo.pageType.phase:Phase`,
  trade: $localize`:@@admin.seo.pageType.trade:Trade`,
};

function humanize(slug: string): string {
  const words = slug.replace(/[._-]+/g, ' ').trim();
  if (!words) return slug;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Panel 1 of `/admin/seo`, "Do this now" (AECI-822, `ADMIN_PANEL_SPEC.md` §5.24.5).
 *
 * Three lane cards in the API's order: the Google re-index queue (a count, the
 * oldest tier-1 or tier-2 age and a link to `/admin/reindex`, which it sits
 * beside and does not replace), then Google and Bing "not crawled". Selecting a
 * "not crawled" lane lists its URLs, 25 a page, oldest first, each with a copy
 * control. Pasting the URL into the engine's URL inspection tool is the whole
 * workflow, so the copy is one click and it is announced.
 *
 * It fetches its own endpoint after render and fails on its own, the
 * `/admin/system` pattern §5.24.4 names, so a failed queue never blanks Panel 2.
 * The error copy and Try again button are the `/admin/system` recipe.
 *
 * Every announcement goes up through {@link announce} to the page's one polite
 * live region (§5.24.11).
 */
@Component({
  selector: 'aec-seo-queue-panel',
  imports: [AdminDisclosureButton, AdminNotes, AdminPaginator, AecButton, DatePipe, RouterLink],
  templateUrl: './seo-queue-panel.html',
  styles: [':host { display: block; }'],
})
export class SeoQueuePanel {
  private readonly api = inject(AdminSeoApi);
  private readonly injector = inject(Injector);
  /** The copy action touches `navigator`, which does not exist during SSR. */
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

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
  /** The URL cell: a row header at body weight, so the URL reads as data. */
  protected readonly urlCellClass = `${CONSOLE_TABLE.cell} font-normal`;

  /** Text for the page's polite live region. */
  readonly announce = output<string>();

  protected readonly perPage = SEO_QUEUE_PAGE_SIZE;
  protected readonly data = signal<SeoQueueResponse | null>(null);
  /** The first load. The panel shows its loading line only then. */
  protected readonly loading = signal(true);
  /** The FIRST load failed, so there are no lanes to show: the whole panel is
   *  the error. */
  protected readonly loadFailed = signal(false);
  /** A lane switch or a page change failed. The lane cards stay, because they
   *  are still true, and only the list area shows the error and its retry. */
  protected readonly listFailed = signal(false);
  /** A lane switch is in flight. The list shows its own loading line. */
  protected readonly switching = signal(false);
  /** A page change is in flight. The rows stay and the paginator disables. */
  protected readonly paging = signal(false);

  protected readonly engine = signal<SeoEngine>('google');
  /** The selected lane's list is open. Pressing the pressed lane closes it. */
  protected readonly expanded = signal(true);
  protected readonly page = signal(1);
  /** The URL last copied, for its button's own "Copied" state. */
  protected readonly copiedUrl = signal<string | null>(null);

  private readonly listHeading = viewChild<ElementRef<HTMLElement>>('listHeading');
  private readonly heading = viewChild<ElementRef<HTMLElement>>('heading');

  protected readonly lanes = computed<readonly SeoQueueLane[]>(() => this.data()?.lanes ?? []);
  protected readonly items = computed<readonly SeoQueueItem[]>(() => this.data()?.items.data ?? []);
  protected readonly total = computed(() => this.data()?.items.total ?? 0);

  /** `PUBLIC_SITE_URL` is unset on this tier: the API returns no lanes. */
  protected readonly urlUnset = computed(() => {
    const d = this.data();
    return d !== null && d.lanes.length === 0;
  });

  /** The panel's own line says why there are no lanes, so the matching note is
   *  not said twice beneath it. Every other note renders as sent. */
  protected readonly notes = computed<readonly AdminNote[]>(() => {
    const notes = this.data()?.notes ?? [];
    return this.urlUnset() ? notes.filter((n) => n.code !== 'public_site_url_unset') : notes;
  });

  protected readonly allEmpty = computed(
    () => this.lanes().length > 0 && this.lanes().every((l) => l.count === 0),
  );

  /** The selected "not crawled" lane, from the latest lane summary. */
  protected readonly selectedLane = computed(
    () => this.lanes().find((l) => l.lane === 'uncrawled' && l.engine === this.engine()) ?? null,
  );

  /** The list shows only for an open lane with rows. An empty lane says so in
   *  its card. */
  protected readonly showList = computed(
    () => this.expanded() && (this.selectedLane()?.count ?? 0) > 0,
  );

  protected readonly engineLabel = computed(() => SEO_ENGINE_LABELS[this.engine()]);

  constructor() {
    afterNextRender(() => {
      void this.load();
    });
  }

  /** Bumped per request. Only the latest request may write state, so a slow
   *  Google answer that lands after a click on Bing never fills the Bing list. */
  private requestSeq = 0;

  private async load(): Promise<boolean> {
    const seq = ++this.requestSeq;
    this.loadFailed.set(false);
    this.listFailed.set(false);
    try {
      const res = await this.api.queue({
        lane: 'uncrawled',
        engine: this.engine(),
        page: this.page(),
        perPage: this.perPage,
      });
      if (seq !== this.requestSeq) return false;
      this.data.set(res);
      return true;
    } catch {
      if (seq !== this.requestSeq) return false;
      // Only a failed FIRST load blanks the panel. After that the lane cards
      // are still true, so a failed lane switch or page change keeps them and
      // fails in the list area alone.
      if (this.data() === null) this.loadFailed.set(true);
      else this.listFailed.set(true);
      return false;
    } finally {
      if (seq === this.requestSeq) {
        this.loading.set(false);
        this.switching.set(false);
        this.paging.set(false);
      }
    }
  }

  /** The Try again button unmounts while the read is in flight, so focus would
   *  drop to the page. Once it settles, focus goes to the panel heading and the
   *  live region says how it went, including a second failure. */
  protected async retry(): Promise<void> {
    this.loading.set(true);
    const ok = await this.load();
    this.announce.emit(
      ok
        ? $localize`:@@admin.seo.queue.announce.loaded:Search queue loaded.`
        : $localize`:@@admin.seo.queue.announce.failed:The search queue still could not load.`,
    );
    this.focusAfterRender(() => this.heading());
  }

  /** Retry a failed lane switch or page change, for the same lane and page.
   *  Focus goes to the list heading either way, and the outcome is announced. */
  protected async retryList(): Promise<void> {
    this.switching.set(true);
    const ok = await this.load();
    this.announce.emit(
      ok
        ? this.listAnnouncement()
        : $localize`:@@admin.seo.queue.announce.listFailed:These URLs still could not load.`,
    );
    this.focusAfterRender(() => this.listHeading());
  }

  private focusAfterRender(target: () => ElementRef<HTMLElement> | undefined): void {
    afterNextRender(() => target()?.nativeElement.focus(), { injector: this.injector });
  }

  /** A lane's toggle is pressed while its list is open. */
  protected isOpen(engine: SeoEngine): boolean {
    return this.engine() === engine && this.expanded();
  }

  /**
   * Press a "not crawled" lane. Another lane opens on page 1, oldest first.
   * The open lane closes, and pressing it again reopens it on the rows it
   * already has. Focus stays on the button either way, and the live region
   * says what changed.
   */
  protected async selectEngine(engine: SeoEngine): Promise<void> {
    if (this.engine() === engine) {
      const open = !this.expanded();
      this.expanded.set(open);
      this.announce.emit(
        open
          ? this.listAnnouncement()
          : $localize`:@@admin.seo.queue.announce.closed:URL list closed.`,
      );
      return;
    }
    this.expanded.set(true);
    this.engine.set(engine);
    this.page.set(1);
    this.copiedUrl.set(null);
    this.switching.set(true);
    if (await this.load()) this.announce.emit(this.listAnnouncement());
  }

  /** Change page. Focus moves to the list heading once the rows land, so the
   *  reader starts the new page at its first URL rather than at a paginator
   *  button that may now be disabled. */
  protected async goToPage(page: number): Promise<void> {
    this.page.set(page);
    this.copiedUrl.set(null);
    this.paging.set(true);
    if (await this.load()) {
      this.announce.emit(this.listAnnouncement());
      this.focusAfterRender(() => this.listHeading());
    }
  }

  private listAnnouncement(): string {
    const pages = Math.max(1, Math.ceil(this.total() / this.perPage));
    const engine = this.engineLabel();
    const page = this.page();
    return $localize`:@@admin.seo.queue.announce.list:Listing pages not crawled by ${engine}:ENGINE:, page ${page}:PAGE: of ${pages}:PAGES:.`;
  }

  /** The copy button's accessible name. It carries the URL, so each of the 25
   *  buttons says which page it copies. Bound from `$localize`, because an
   *  interpolated `i18n-aria-label` emits no attribute in this codebase. */
  protected copyLabel(url: string): string {
    return this.copiedUrl() === url
      ? $localize`:@@admin.seo.list.copiedAria:Copied ${url}:URL:`
      : $localize`:@@admin.seo.list.copyAria:Copy ${url}:URL:`;
  }

  /** Copy one URL for pasting into the engine's URL inspection tool. */
  protected async copyUrl(url: string): Promise<void> {
    if (!this.isBrowser || !navigator.clipboard) {
      this.announce.emit(
        $localize`:@@admin.seo.queue.announce.copyUnavailable:This browser will not let us copy. Select the URL and copy it by hand.`,
      );
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      this.copiedUrl.set(url);
      this.announce.emit($localize`:@@admin.seo.queue.announce.copied:Copied ${url}:URL:`);
    } catch {
      this.copiedUrl.set(null);
      this.announce.emit(
        $localize`:@@admin.seo.queue.announce.copyFailed:We could not copy that URL. Select it and copy it by hand.`,
      );
    }
  }

  protected engineName(engine: SeoEngine): string {
    return SEO_ENGINE_LABELS[engine];
  }

  protected pageTypeLabel(type: string): string {
    return PAGE_TYPE_LABELS[type] ?? humanize(type);
  }

  /** "144 d", the reindex screen's age format. Shown, not spoken. */
  protected waiting(days: number): string {
    return $localize`:@@admin.seo.queue.ageDays:${days}:COUNT: d`;
  }

  /** "144 days", what a screen reader says for {@link waiting}. */
  protected waitingSpoken(days: number): string {
    return days === 1
      ? $localize`:@@admin.seo.queue.ageDays.spokenOne:1 day`
      : $localize`:@@admin.seo.queue.ageDays.spoken:${days}:COUNT: days`;
  }

  /** Whole days between a fetch and the moment the API answered. Measured
   *  against `generated_at`, not the browser clock, so it matches the list. */
  protected daysAgo(instant: string): number {
    const generated = this.data()?.generated_at;
    const end = generated ? Date.parse(generated) : Date.parse(instant);
    return Math.max(0, Math.floor((end - Date.parse(instant)) / DAY_MS));
  }

  /** The oldest tier-1 or tier-2 row, rounded to whole days. */
  protected roundDays(days: number): number {
    return Math.round(days);
  }
}
