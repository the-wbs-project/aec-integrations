import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import {
  Component,
  ElementRef,
  Injector,
  LOCALE_ID,
  afterNextRender,
  computed,
  inject,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';

import type {
  AdminLicenseReleaseRequest,
  DecideLicenseReleaseRequest,
  LicenseReleaseRequestStatus,
} from '@aeci/shared';

import { AecButton } from '../../shared/button/button';
import { Chip } from '../../shared/chip/chip';
import { FIELD_HINT_CLASS, FIELD_INPUT_CLASS } from '../../shared/form-field/form-field-classes';
import { AecIcon } from '../../shared/icon/icon';
import { AdminSummaryStore } from '../admin-summary.store';
import { CONSOLE_FILTER } from '../console/console-filter';
import {
  CONSOLE_CAPTION_CLASS,
  CONSOLE_LABEL_CLASS,
  CONSOLE_TABLE,
} from '../console/console-table';
import { AdminDisclosureButton } from '../console/disclosure-button';
import { adminStatusTone, type AdminStatusKey } from '../console/status-tones';
import {
  QUEUE_BODY_CLASS,
  QUEUE_DETAIL_GRID_CLASS,
  QUEUE_FAILED_CLASS,
  QUEUE_FORM_CLASS,
} from '../reviews/queue-classes';
import { queueFocusAfterRemoval } from '../reviews/queue-focus';
import { formatTermDate } from '../../shared/term-date/format-term-date';
import { AdminRequestsApi } from './admin-requests-api';
import { isReplayedEvent } from '../../core/event-replay';
import { CONSOLE_NOTICE_CLASS } from '../console/console-detail';

/** One request covers the backlog. The API caps `perPage` at 100. */
const PAGE_SIZE = 100;

/** The decision form open on one row. */
type Decision = 'approve' | 'decline';

/** What the API's refusal means for the open form. */
type Refusal = 'decided' | 'license_moved' | 'failed';

/**
 * Early-unassign requests (AECI-1373, `docs/ADMIN_PANEL_SPEC.md` §5.17 and
 * `VENDOR_SIGNUP_PROCESS.md` decision 11): the fourth section of `/admin/requests`. An
 * owner seat asked AECi to take a license off its product before renewal.
 *
 * Each open row has two decisions, each behind one inline form on that row.
 * **Approve** confirms what it does: the license comes off the product now and goes
 * back to the vendor's pool, still live, with its term dates unchanged, and the product
 * is on Free until a license is assigned to it. **Decline** takes a required reason,
 * which the vendor is shown.
 *
 * `409 RELEASE_REQUEST_NOT_OPEN` (another admin decided it first) announces "Already
 * decided" and reloads the list without touching the badge: the winner already
 * decremented it. `409 LICENSE_NOT_ASSIGNED` keeps the approve form open and says the
 * license is no longer on that product, so the operator declines instead. The section
 * keeps its own polite region, like the sections above it.
 */
@Component({
  selector: 'aec-license-release-queue',
  imports: [AdminDisclosureButton, AecButton, AecIcon, Chip, DatePipe, RouterLink],
  host: { class: 'mt-14 block' },
  templateUrl: './license-release-queue.html',
})
export class LicenseReleaseQueue {
  private readonly api = inject(AdminRequestsApi);
  private readonly summaryStore = inject(AdminSummaryStore);
  private readonly locale = inject(LOCALE_ID);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  // AECI-2111: the console recipe and the queues' shared detail-row classes.
  protected readonly t = CONSOLE_TABLE;
  protected readonly f = CONSOLE_FILTER;
  protected readonly labelClass = CONSOLE_LABEL_CLASS;
  protected readonly captionClass = CONSOLE_CAPTION_CLASS;
  protected readonly inputClass = FIELD_INPUT_CLASS;
  protected readonly hintClass = FIELD_HINT_CLASS;
  protected readonly noticeClass = CONSOLE_NOTICE_CLASS;
  protected readonly detailGridClass = QUEUE_DETAIL_GRID_CLASS;
  protected readonly bodyClass = QUEUE_BODY_CLASS;
  protected readonly formClass = QUEUE_FORM_CLASS;
  protected readonly failedClass = QUEUE_FAILED_CLASS;
  /** Disclosure, product, vendor, subscription, submitted, status. */
  protected readonly columnCount = 6;

  /** The rows whose detail is open. */
  private readonly openIds = signal<ReadonlySet<string>>(new Set());

  protected readonly rows = signal<readonly AdminLicenseReleaseRequest[]>([]);
  protected readonly total = signal(0);
  protected readonly truncated = computed(() => this.total() > this.rows().length);
  /** Bumped per `load()`, so a response for an earlier filter never lands last. */
  private loadSeq = 0;
  protected readonly status = signal<LicenseReleaseRequestStatus>('open');
  protected readonly loading = signal(true);
  protected readonly loadFailed = signal(false);
  protected readonly liveMessage = signal('');

  /** The row whose decision form is open, and which decision. One at a time. */
  protected readonly openId = signal<string | null>(null);
  protected readonly decision = signal<Decision | null>(null);
  protected readonly reason = signal('');
  protected readonly pending = signal(false);
  protected readonly formError = signal<string | null>(null);

  protected readonly statusOptions: ReadonlyArray<{
    key: LicenseReleaseRequestStatus;
    label: string;
  }> = [
    { key: 'open', label: $localize`:@@admin.requests.filter.status.open:Open` },
    { key: 'approved', label: $localize`:@@admin.licenseReleases.filter.approved:Approved` },
    { key: 'declined', label: $localize`:@@admin.licenseReleases.filter.declined:Declined` },
  ];

  constructor() {
    afterNextRender(() => void this.load());
  }

  protected async load(): Promise<void> {
    const seq = ++this.loadSeq;
    this.loading.set(true);
    this.loadFailed.set(false);
    try {
      const res = await this.api.listLicenseReleaseRequests({
        status: this.status(),
        page: 1,
        perPage: PAGE_SIZE,
      });
      if (seq !== this.loadSeq) return;
      this.rows.set(res.data);
      this.total.set(res.total);
    } catch {
      if (seq === this.loadSeq) this.loadFailed.set(true);
    } finally {
      if (seq === this.loadSeq) this.loading.set(false);
    }
  }

  protected setStatus(status: LicenseReleaseRequestStatus): void {
    if (this.status() === status) return;
    this.status.set(status);
    this.cancel();
    void this.load();
  }

  protected start(row: AdminLicenseReleaseRequest, kind: Decision): void {
    this.openId.set(row.id);
    this.decision.set(kind);
    this.reason.set('');
    this.formError.set(null);
    // The openers leave the DOM with the form open: focus the reason field, or the
    // sentence that says what Approve does, so it is heard before the confirm.
    this.focusAfterRender(
      kind === 'decline' ? `license-release-reason-${row.id}` : `license-release-summary-${row.id}`,
    );
  }

  /** Cancel or Escape: close the form and return focus to the decision that opened it. */
  protected dismiss(row: AdminLicenseReleaseRequest): void {
    if (this.pending()) return;
    const kind = this.decision();
    this.cancel();
    if (kind) this.focusAfterRender(`license-release-${row.id}-${kind}`);
  }

  protected cancel(): void {
    this.openId.set(null);
    this.decision.set(null);
    this.reason.set('');
    this.formError.set(null);
  }

  protected onReason(event: Event): void {
    this.reason.set((event.target as HTMLTextAreaElement).value);
    this.formError.set(null);
  }

  protected async submit(event: Event, row: AdminLicenseReleaseRequest): Promise<void> {
    if (isReplayedEvent(event)) return;
    event.preventDefault();
    const kind = this.decision();
    if (!kind || this.pending()) return;
    this.formError.set(null);

    let body: DecideLicenseReleaseRequest;
    if (kind === 'decline') {
      const reason = this.reason().trim();
      if (reason === '') {
        this.formError.set(
          $localize`:@@admin.licenseReleases.error.reason:Enter a reason. The vendor sees it.`,
        );
        return;
      }
      body = { action: 'decline', reason };
    } else {
      body = { action: 'approve' };
    }

    this.pending.set(true);
    try {
      await this.api.decideLicenseReleaseRequest(row.id, body);
      this.drop(row.id);
      this.summaryStore.decrement('requests');
      this.liveMessage.set(this.doneMessage(kind, this.productName(row)));
      this.cancel();
    } catch (err) {
      switch (refusalOf(err)) {
        case 'decided':
          // Another admin got there first. The badge is theirs to have decremented.
          this.cancel();
          this.liveMessage.set(
            $localize`:@@admin.licenseReleases.announce.alreadyDecided:Already decided. The list has been reloaded.`,
          );
          void this.load();
          break;
        case 'license_moved':
          this.formError.set(
            $localize`:@@admin.licenseReleases.error.licenseMoved:The subscription is no longer on this product. Decline the request instead.`,
          );
          break;
        default:
          this.formError.set(
            $localize`:@@admin.requests.action.failed:Something went wrong. Please try again.`,
          );
      }
      // A refused decision moves focus to its message. (A form refused before the
      // request, for a missing reason, keeps focus where it was.)
      if (this.formError()) this.focusAfterRender(`license-release-error-${row.id}`);
    } finally {
      this.pending.set(false);
    }
  }

  /** The product the request is about, for headings and announcements. */
  protected productName(row: AdminLicenseReleaseRequest): string {
    return (
      row.product?.name ??
      $localize`:@@admin.licenseReleases.productGone:A product no longer on record`
    );
  }

  /** The license is no longer live on the product the owner asked about. */
  protected licenseMoved(row: AdminLicenseReleaseRequest): boolean {
    const license = row.license;
    return (
      row.status === 'open' &&
      (!license || license.ended_at !== null || license.assigned_product_id !== row.product_id)
    );
  }

  /**
   * "Term ends Jun 30, 2027", in UTC like every term date on the console. With no end,
   * only a Stripe license renews monthly. Any other source reads "No end date".
   */
  protected termLine(row: AdminLicenseReleaseRequest): string | null {
    const license = row.license;
    if (!license) return null;
    if (license.ends_at === null) {
      return license.source === 'stripe'
        ? $localize`:@@admin.licenseReleases.term.monthly:Monthly, renews until cancelled`
        : $localize`:@@admin.licenseReleases.term.noEnd:No end date`;
    }
    const date = formatTermDate(license.ends_at, this.locale);
    return $localize`:@@admin.licenseReleases.term.ends:Term ends ${date}:DATE:`;
  }

  protected outcomeLine(row: AdminLicenseReleaseRequest): string {
    switch (row.status) {
      case 'approved':
        return $localize`:@@admin.licenseReleases.outcome.approved:Approved. The subscription went back to the vendor's pool.`;
      case 'declined': {
        const reason = row.decision_note ?? '';
        return $localize`:@@admin.licenseReleases.outcome.declined:Declined. Reason: ${reason}:REASON:`;
      }
      default:
        return '';
    }
  }

  protected formLabel(kind: Decision, row: AdminLicenseReleaseRequest): string {
    const name = this.productName(row);
    return kind === 'approve'
      ? $localize`:@@admin.licenseReleases.form.approve:Approve the early unassign of ${name}:NAME:`
      : $localize`:@@admin.licenseReleases.form.decline:Decline the early unassign of ${name}:NAME:`;
  }

  protected approveSummary(row: AdminLicenseReleaseRequest): string {
    const name = this.productName(row);
    return $localize`:@@admin.licenseReleases.approve.summary:The subscription comes off ${name}:NAME: now and goes back to the vendor's pool. It stays live and its term dates do not change. ${name}:NAME: is on the Free plan until a subscription is put on it.`;
  }

  private doneMessage(kind: Decision, name: string): string {
    return kind === 'approve'
      ? $localize`:@@admin.licenseReleases.announce.approved:Subscription freed from ${name}:NAME:. The vendor has been told.`
      : $localize`:@@admin.licenseReleases.announce.declined:Request for ${name}:NAME: declined. The vendor has been told.`;
  }

  /** The chip tone for a request status. Exhaustive: a new status fails to compile. */
  protected statusTone(status: LicenseReleaseRequestStatus) {
    let key: AdminStatusKey;
    switch (status) {
      case 'open':
        key = 'open';
        break;
      case 'approved':
        key = 'approved';
        break;
      case 'declined':
        key = 'declined';
        break;
    }
    return adminStatusTone(key);
  }

  /** The status in words: the filter's own labels. */
  protected statusLabel(status: LicenseReleaseRequestStatus): string {
    return this.statusOptions.find((o) => o.key === status)?.label ?? status;
  }

  protected isOpen(id: string): boolean {
    return this.openIds().has(id);
  }

  protected toggleRow(id: string): void {
    this.openIds.update((ids) => {
      const next = new Set(ids);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** The row's name, true open or closed: `aria-expanded` carries the state. */
  protected rowLabel(row: AdminLicenseReleaseRequest): string {
    const product = this.productName(row);
    const vendor = row.vendor?.name ?? $localize`:@@admin.productRequests.gone:No longer on record`;
    return $localize`:@@admin.licenseReleases.row.label:Early-unassign request for ${product}:product: from ${vendor}:vendor:`;
  }

  /** Drop a decided row, then move focus by the queues' one rule (AECI-2102). */
  private drop(id: string): void {
    const index = this.rows().findIndex((r) => r.id === id);
    this.rows.update((list) => list.filter((r) => r.id !== id));
    this.total.update((n) => Math.max(0, n - 1));
    this.openIds.update((ids) => {
      if (!ids.has(id)) return ids;
      const next = new Set(ids);
      next.delete(id);
      return next;
    });
    const target = queueFocusAfterRemoval(index, 1, 1, this.rows());
    if (target.kind === 'none') return;
    this.focusAfterRender(
      target.kind === 'heading' ? 'admin-license-releases-heading' : undefined,
      target.kind === 'row'
        ? `[aria-controls="license-release-${target.row.id}-detail"]`
        : undefined,
    );
  }

  /** Focus an element of this section once the next render lands. */
  private focusAfterRender(elementId: string | undefined, selector?: string): void {
    const query = selector ?? `[id="${elementId}"]`;
    afterNextRender(
      { write: () => this.host.nativeElement.querySelector<HTMLElement>(query)?.focus() },
      { injector: this.injector },
    );
  }
}

/** Map a failed decision to what the form does next. */
function refusalOf(err: unknown): Refusal {
  if (!(err instanceof HttpErrorResponse)) return 'failed';
  const code = (err.error as { error?: { code?: unknown } } | null)?.error?.code;
  if (err.status === 409 && code === 'RELEASE_REQUEST_NOT_OPEN') return 'decided';
  if (err.status === 409 && code === 'LICENSE_NOT_ASSIGNED') return 'license_moved';
  if (err.status === 404) return 'decided';
  return 'failed';
}
