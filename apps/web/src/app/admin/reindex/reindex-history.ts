import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import {
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';

import {
  RECRAWL_SUBMISSION_CHANNELS,
  RECRAWL_SUBMISSION_OUTCOMES,
  type ListReindexSubmissionsQuery,
  type ReindexSubmissionCause,
  type ReindexSubmissionEntity,
  type ReindexSubmissionRow,
} from '@aeci/shared';

import { AdminPaginator } from '../admin-paginator';
import { describeAuditAction } from '../audit/audit-action-labels';
import { AecSelect, type AecSelectOption } from '../../shared/aec-select/aec-select';
import { AdminReindexApi } from './admin-reindex.api';

/** Rows per page, as on `/admin/email`. */
const PER_PAGE = 25;

/** Why a read failed, for the copy. `invalid` is a 400: retrying cannot help. */
type LoadError = 'session' | 'invalid' | 'other';

/** The vendor filter: its id for the request, its name for the chip. */
interface VendorFilter {
  readonly id: string;
  readonly name: string;
}

/**
 * The "Submission history" section of `/admin/reindex` (AECI-1188,
 * `docs/ADMIN_PANEL_SPEC.md` §5.11): every URL we sent to IndexNow, or asked
 * Google to re-crawl by hand, newest first, with the edits that caused it.
 *
 * Read-only. The log is append-only evidence (ADR 0022), so nothing here writes.
 * The copy says "submitted" and "requested", never "indexed": no search engine
 * tells us that.
 *
 * Follows `EmailActivity` (`/admin/email`): filters are component state, a
 * refilter resets the page, the table stays mounted and goes `aria-busy` while it
 * refetches, and empty and no-match are different sentences.
 *
 * ── THE VENDOR FILTER IS SET FROM A ROW ──────────────────────────────────────
 * There is no vendor picker. The admin vendor list is paginated and searched,
 * and a select loaded from one page of it would silently omit vendors. Each
 * vendor cause instead carries an "Only this vendor" button. The active filter
 * shows as a chip with its own remove button, and Clear filters drops it too.
 *
 * ── NO AUDIT LINK ────────────────────────────────────────────────────────────
 * There is no audit-by-id page. A vendor cause links to `/admin/vendors/:id`,
 * whose audit trail lists the causing entry, and shows the action label here.
 */
@Component({
  selector: 'aec-reindex-history',
  imports: [AdminPaginator, AecSelect, DatePipe, RouterLink],
  templateUrl: './reindex-history.html',
})
export class ReindexHistory {
  private readonly api = inject(AdminReindexApi);
  private readonly injector = inject(Injector);
  private readonly heading = viewChild.required<ElementRef<HTMLElement>>('heading');
  private readonly vendorRemove = viewChild<ElementRef<HTMLButtonElement>>('vendorRemove');

  protected readonly perPage = PER_PAGE;

  protected readonly rows = signal<readonly ReindexSubmissionRow[]>([]);
  protected readonly total = signal(0);
  protected readonly page = signal(1);
  /** True until the first response, success or failure. */
  protected readonly firstLoad = signal(true);
  protected readonly busy = signal(false);
  protected readonly error = signal<LoadError | null>(null);

  /** A result count after a refilter or page change, for the page's ONE polite
   *  live region, which `ReindexList` owns. Not emitted for the first load. */
  readonly announce = output<string>();

  /** `null` is "any", the `AecSelect` convention. */
  protected readonly vendor = signal<VendorFilter | null>(null);
  protected readonly channel = signal<string | null>(null);
  protected readonly outcome = signal<string | null>(null);
  protected readonly from = signal('');
  protected readonly to = signal('');

  /** Bumped by every load. A stale response is dropped. */
  private seq = 0;

  protected readonly anyFilter = computed(
    () =>
      this.vendor() !== null ||
      this.channel() !== null ||
      this.outcome() !== null ||
      this.from() !== '' ||
      this.to() !== '',
  );

  /** Nothing has been submitted yet, and no filter narrows it. */
  protected readonly isEmpty = computed(
    () => !this.firstLoad() && !this.anyFilter() && this.total() === 0,
  );
  /** A filter matched nothing. */
  protected readonly noMatches = computed(
    () => !this.firstLoad() && this.anyFilter() && this.total() === 0,
  );

  protected readonly channelOptions: readonly AecSelectOption[] = [
    { value: null, label: $localize`:@@admin.reindex.history.filter.channel.any:Any channel` },
    ...RECRAWL_SUBMISSION_CHANNELS.map((c) => ({ value: c, label: channelLabel(c) })),
  ];

  protected readonly outcomeOptions: readonly AecSelectOption[] = [
    { value: null, label: $localize`:@@admin.reindex.history.filter.outcome.any:Any outcome` },
    ...RECRAWL_SUBMISSION_OUTCOMES.map((o) => ({ value: o, label: outcomeLabel(o) })),
  ];

  constructor() {
    afterNextRender(() => {
      void this.load();
    });
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  protected onChannel(value: string | null): void {
    this.channel.set(value);
    this.refilter();
  }

  protected onOutcome(value: string | null): void {
    this.outcome.set(value);
    this.refilter();
  }

  protected onFrom(event: Event): void {
    this.from.set((event.target as HTMLInputElement).value);
    this.refilter();
  }

  protected onTo(event: Event): void {
    this.to.set((event.target as HTMLInputElement).value);
    this.refilter();
  }

  /** "Only this vendor" on a cause row. The button the operator pressed is gone
   *  after the refilter, so focus moves to the chip's Remove button. */
  protected filterToVendor(vendor: ReindexSubmissionEntity): void {
    if (this.vendor()?.id === vendor.id) return;
    this.vendor.set({ id: vendor.id, name: this.vendorName(vendor) });
    this.refilter();
    this.focusAfterRender(() => this.vendorRemove()?.nativeElement);
  }

  /** The chip's Remove. The chip is gone after, so focus goes to the heading. */
  protected clearVendor(): void {
    this.vendor.set(null);
    this.refilter();
    this.focusAfterRender(() => this.heading().nativeElement);
  }

  /** Clear filters hides itself, so focus goes to the heading. */
  protected clearFilters(): void {
    this.vendor.set(null);
    this.channel.set(null);
    this.outcome.set(null);
    this.from.set('');
    this.to.set('');
    this.refilter();
    this.focusAfterRender(() => this.heading().nativeElement);
  }

  protected goToPage(page: number): void {
    this.page.set(page);
    void this.load();
  }

  protected retry(): void {
    void this.load();
  }

  private refilter(): void {
    this.page.set(1);
    void this.load();
  }

  /** Move focus once the control that had it has been removed from the DOM. */
  private focusAfterRender(target: () => HTMLElement | undefined): void {
    afterNextRender(() => target()?.focus(), { injector: this.injector });
  }

  // ── Load ───────────────────────────────────────────────────────────────────

  private async load(): Promise<void> {
    const seq = ++this.seq;
    this.busy.set(true);
    this.error.set(null);
    // A typed `from` after `to` gets past the pickers' min/max. The server
    // refuses it, so refuse it here without a request.
    if (this.from() && this.to() && this.from() > this.to()) {
      this.error.set('invalid');
      this.rows.set([]);
      this.total.set(0);
      this.busy.set(false);
      this.firstLoad.set(false);
      return;
    }
    const query: Partial<ListReindexSubmissionsQuery> = {
      page: this.page(),
      perPage: this.perPage,
      vendorId: this.vendor()?.id,
      channel: (this.channel() ?? undefined) as ListReindexSubmissionsQuery['channel'],
      outcome: (this.outcome() ?? undefined) as ListReindexSubmissionsQuery['outcome'],
      from: this.from() || undefined,
      to: this.to() || undefined,
    };
    try {
      const res = await this.api.submissions(query);
      if (seq !== this.seq) return;
      this.rows.set(res.data);
      this.total.set(res.total);
      if (!this.firstLoad()) {
        this.announce.emit(
          $localize`:@@admin.reindex.history.announce.loaded:Matching submissions: ${res.total}:COUNT:.`,
        );
      }
    } catch (err) {
      if (seq !== this.seq) return;
      this.error.set(errorKind(err));
      this.rows.set([]);
      this.total.set(0);
    } finally {
      if (seq === this.seq) {
        this.busy.set(false);
        this.firstLoad.set(false);
      }
    }
  }

  // ── View helpers ───────────────────────────────────────────────────────────

  protected readonly channelLabel = channelLabel;
  protected readonly outcomeLabel = outcomeLabel;

  /** Badge styling per outcome. The word carries the meaning; colour only draws
   *  the eye to the two that did not go through. */
  protected outcomeClass(outcome: string): string {
    switch (outcome) {
      case 'accepted':
        return 'bg-(--accent-primary-soft) text-(--accent-primary)';
      case 'requested':
        return 'bg-(--accent-warm) text-(--text-primary)';
      case 'refused':
        return 'bg-(--surface-sunken) font-bold text-(--accent-secondary-deep)';
      case 'failed':
        return 'bg-(--surface-sunken) font-bold text-(--status-error)';
      default:
        return 'bg-(--surface-sunken) text-(--text-primary)';
    }
  }

  protected sourceLabel(cause: ReindexSubmissionCause): string {
    switch (cause.source) {
      case 'vendor':
        return $localize`:@@admin.reindex.history.source.vendor:Vendor edit`;
      case 'admin':
        return $localize`:@@admin.reindex.history.source.admin:Admin edit`;
      case 'promote':
        return $localize`:@@admin.reindex.history.source.promote:Promote`;
      default:
        return cause.source;
    }
  }

  protected actionLabel(action: string): string {
    return describeAuditAction(action);
  }

  /** A deleted vendor keeps its id in the log but has no name. */
  protected vendorName(vendor: ReindexSubmissionEntity): string {
    return vendor.name ?? $localize`:@@admin.reindex.history.vendor.deleted:Deleted vendor`;
  }

  protected productName(product: ReindexSubmissionEntity): string {
    return product.name ?? $localize`:@@admin.reindex.history.product.deleted:Deleted product`;
  }

  protected vendorPath(vendor: ReindexSubmissionEntity): string {
    return `/admin/vendors/${encodeURIComponent(vendor.id)}`;
  }

  /** Stable `@for` key for a cause. Two causes may share every field but the
   *  queue time, so the index is part of it. */
  protected causeKey(cause: ReindexSubmissionCause, i: number): string {
    return `${cause.audit_log_id ?? cause.promote_job_id ?? ''}:${cause.queued_at}:${i}`;
  }
}

/** The channel, in words. */
function channelLabel(channel: string): string {
  switch (channel) {
    case 'indexnow':
      return $localize`:@@admin.reindex.history.channel.indexnow:IndexNow (Bing, Yandex)`;
    case 'gsc_manual':
      return $localize`:@@admin.reindex.history.channel.gscManual:Search Console, by hand`;
    default:
      return channel;
  }
}

/** The outcome, in words. None of them means the page was indexed. */
function outcomeLabel(outcome: string): string {
  switch (outcome) {
    case 'accepted':
      return $localize`:@@admin.reindex.history.outcome.accepted:Accepted`;
    case 'refused':
      return $localize`:@@admin.reindex.history.outcome.refused:Refused`;
    case 'failed':
      return $localize`:@@admin.reindex.history.outcome.failed:Failed`;
    case 'requested':
      return $localize`:@@admin.reindex.history.outcome.requested:Requested`;
    default:
      return outcome;
  }
}

function errorKind(err: unknown): LoadError {
  if (!(err instanceof HttpErrorResponse)) return 'other';
  if (err.status === 401 || err.status === 403) return 'session';
  if (err.status === 400) return 'invalid';
  return 'other';
}
