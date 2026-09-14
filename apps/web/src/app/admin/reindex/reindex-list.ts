import { HttpErrorResponse } from '@angular/common/http';
import { PLATFORM_ID, Component, afterNextRender, computed, inject, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';

import type { ListReindexQueueQuery, ReindexQueueRow } from '@aeci/shared';

import { AdminPaginator } from '../admin-paginator';
import { AdminSummaryStore } from '../admin-summary.store';
import { AdminReindexApi } from './admin-reindex.api';

/** A worklist is walked top to bottom, so the page is big enough that the
 *  operator rarely pages at all, and small enough that the table stays scannable. */
const PAGE_SIZE = 25;

/** `null` is the unfiltered view — the default, and the one the fixed ordering
 *  already serves. */
type PriorityFilter = number | null;

/**
 * The closed part of an open vocabulary, exactly as `audit-action-labels.ts`
 * treats `audit_log.action`. Keys are the `reason` slugs written by the API
 * today; the values are what an operator reads.
 *
 * ── THE FALLBACK IS LOAD-BEARING ─────────────────────────────────────────────
 * `ReindexQueueRowSchema.reason` is a plain `z.string()` on purpose: nothing
 * prunes `gsc_recrawl_queue` on a schedule, so a row can outlive the code that
 * wrote its reason, and a new writer anywhere in the API must not blank a cell
 * on this screen. Never convert this map to a closed union.
 */
const REASON_LABELS: Readonly<Record<string, string>> = {
  'product.created': $localize`:@@admin.reindex.reason.productCreated:New product page`,
  'product.updated': $localize`:@@admin.reindex.reason.productUpdated:Product page changed`,
  'product.minor': $localize`:@@admin.reindex.reason.productMinor:Product page changed slightly`,
  'vendor.created': $localize`:@@admin.reindex.reason.vendorCreated:New vendor page`,
  'vendor.updated': $localize`:@@admin.reindex.reason.vendorUpdated:Vendor page changed`,
  'vendor.minor': $localize`:@@admin.reindex.reason.vendorMinor:Vendor page changed slightly`,
  'pair.created': $localize`:@@admin.reindex.reason.pairCreated:New integration page`,
  'pair.updated': $localize`:@@admin.reindex.reason.pairUpdated:Integration page changed`,
  'trade.published': $localize`:@@admin.reindex.reason.tradePublished:Trade page published`,
};

/** Turn an unmapped `entity.verb` slug into a readable phrase: `data_object.created`
 *  becomes "Data object created". Deliberately dumb, so it never guesses meaning. */
function humanizeReason(reason: string): string {
  const words = reason.replace(/[._]+/g, ' ').trim();
  if (!words) return reason;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * `/admin/reindex` — the manual Google re-index worklist (AECI-946 /
 * `docs/ADMIN_PANEL_SPEC.md` §5.11).
 *
 * Google publishes no API that accepts our content types, so the only way to ask
 * it to re-fetch a changed page is Search Console's URL Inspection, run by hand,
 * one URL at a time. This screen is the worklist for that chore and nothing more:
 * show the most important URL, copy it in one click, mark it done, repeat.
 *
 * Follows `/admin/requests` and `/admin/connectors`: the gate and the nav SSR via
 * `adminSummaryResolver` on the parent `/admin` route, so this screen paints its
 * shell during SSR and fetches client-side in `afterNextRender`, where the
 * same-origin request carries the session cookie for `requireAdmin()` to verify.
 * It never reads cookies or session state directly.
 *
 * ── DONE DELETES, WHICH IS WHY THE BADGE IS TRUSTWORTHY ──────────────────────
 * There is no "requested" flag: `DELETE /api/admin/reindex/:id` drops the row.
 * So an empty screen means "genuinely nothing pending" rather than "nothing I
 * have not already dismissed", and the nav count is the real backlog. A later
 * edit to the same page inserts a fresh row, so nothing is lost.
 */
@Component({
  selector: 'aec-reindex-list',
  imports: [AdminPaginator],
  templateUrl: './reindex-list.html',
})
export class ReindexList {
  private readonly api = inject(AdminReindexApi);
  private readonly summaryStore = inject(AdminSummaryStore);
  /** The copy action touches `navigator`, which does not exist during SSR. A
   *  click cannot fire server-side either, but the guard is cheap and explicit. */
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  protected readonly rows = signal<readonly ReindexQueueRow[]>([]);
  protected readonly total = signal(0);
  protected readonly page = signal(1);
  protected readonly perPage = PAGE_SIZE;

  protected readonly loading = signal(true);
  protected readonly loadFailed = signal(false);

  /** Id of the row whose Done is in flight. One action at a time, so a double
   *  click cannot delete two rows and decrement the badge twice. */
  protected readonly pendingActionId = signal<number | null>(null);
  /** Id of the row whose last action failed (inline, retryable, row kept). */
  protected readonly failedActionId = signal<number | null>(null);
  /** Id of the row last copied, for the button's own confirmation. */
  protected readonly copiedId = signal<number | null>(null);
  /** Polite live-region message: the row vanishes on success, so announce it. */
  protected readonly liveMessage = signal('');

  protected readonly priority = signal<PriorityFilter>(null);

  protected readonly priorityOptions: ReadonlyArray<{ key: PriorityFilter; label: string }> = [
    { key: null, label: $localize`:@@admin.reindex.filter.priority.all:All` },
    { key: 1, label: $localize`:@@admin.reindex.filter.priority.p1:1` },
    { key: 2, label: $localize`:@@admin.reindex.filter.priority.p2:2` },
    { key: 3, label: $localize`:@@admin.reindex.filter.priority.p3:3` },
    { key: 4, label: $localize`:@@admin.reindex.filter.priority.p4:4` },
  ];

  protected readonly isEmpty = computed(() => !this.loading() && this.rows().length === 0);

  constructor() {
    afterNextRender(() => {
      void this.load();
    });
  }

  private async load(): Promise<void> {
    this.loadFailed.set(false);
    this.loading.set(true);
    const selected = this.priority();
    const query: Partial<ListReindexQueueQuery> = {
      page: this.page(),
      perPage: this.perPage,
      ...(selected === null ? {} : { priority: selected }),
    };
    try {
      const res = await this.api.list(query);
      this.rows.set(res.data);
      this.total.set(res.total);
    } catch {
      this.loadFailed.set(true);
      this.rows.set([]);
      this.total.set(0);
    } finally {
      this.loading.set(false);
    }
  }

  protected retry(): void {
    void this.load();
  }

  protected setPriority(key: PriorityFilter): void {
    if (this.priority() === key) return;
    this.priority.set(key);
    this.page.set(1);
    void this.load();
  }

  protected goToPage(page: number): void {
    this.page.set(page);
    void this.load();
  }

  /** Relative age ("3 d", "5 h", "12 min"). Browser-only: the list is empty
   *  during SSR, so `Date.now()` is never read server-side. */
  protected age(queuedAt: string): string {
    const minutes = Math.max(0, Math.floor((Date.now() - new Date(queuedAt).getTime()) / 60_000));
    if (minutes < 60) return $localize`:@@admin.reindex.age.minutes:${minutes}:COUNT: min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return $localize`:@@admin.reindex.age.hours:${hours}:COUNT: h`;
    const days = Math.floor(hours / 24);
    return $localize`:@@admin.reindex.age.days:${days}:COUNT: d`;
  }

  /** Why this URL is queued, in English. Never throws, never returns empty. */
  protected reasonLabel(reason: string): string {
    return REASON_LABELS[reason] ?? humanizeReason(reason);
  }

  /**
   * Copy one URL for pasting into Search Console's URL Inspection bar. That paste
   * is the whole workflow, so it is one click and it is announced: the row does
   * not change, so a screen reader would otherwise get no confirmation at all.
   */
  protected async copyUrl(row: ReindexQueueRow): Promise<void> {
    if (!this.isBrowser || !navigator.clipboard) {
      this.liveMessage.set(
        $localize`:@@admin.reindex.announce.copyUnavailable:This browser will not let us copy. Select the URL and copy it by hand.`,
      );
      return;
    }
    try {
      await navigator.clipboard.writeText(row.url);
      this.copiedId.set(row.id);
      this.liveMessage.set($localize`:@@admin.reindex.announce.copied:Copied ${row.url}:URL:`);
    } catch {
      this.copiedId.set(null);
      this.liveMessage.set(
        $localize`:@@admin.reindex.announce.copyFailed:We could not copy that URL. Select it and copy it by hand.`,
      );
    }
  }

  /**
   * Mark one URL done: `DELETE`, drop the row, tick the nav badge down.
   *
   * A **404** means another operator cleared it first. Drop the row, but do NOT
   * decrement — their own action already did, and decrementing twice for one row
   * walks the badge below the real backlog with nothing to resync it until the
   * next full visit to `/admin`. Anything else keeps the row and offers a retry.
   */
  protected async markDone(row: ReindexQueueRow): Promise<void> {
    if (this.pendingActionId() !== null) return;
    this.failedActionId.set(null);
    this.pendingActionId.set(row.id);
    try {
      await this.api.clear(row.id);
      this.removeRow(row.id);
      this.summaryStore.decrement('reindex');
      this.liveMessage.set(
        $localize`:@@admin.reindex.announce.done:Marked done and removed from the queue.`,
      );
    } catch (err) {
      if (err instanceof HttpErrorResponse && err.status === 404) {
        this.removeRow(row.id);
        this.liveMessage.set(
          $localize`:@@admin.reindex.announce.alreadyCleared:Someone else already cleared that URL.`,
        );
      } else {
        this.failedActionId.set(row.id);
      }
    } finally {
      this.pendingActionId.set(null);
    }
  }

  private removeRow(id: number): void {
    this.rows.update((list) => list.filter((r) => r.id !== id));
    this.total.update((n) => Math.max(0, n - 1));
    if (this.copiedId() === id) this.copiedId.set(null);
  }
}
