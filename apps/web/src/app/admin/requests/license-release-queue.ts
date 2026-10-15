import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { Component, LOCALE_ID, afterNextRender, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import type {
  AdminLicenseReleaseRequest,
  DecideLicenseReleaseRequest,
  LicenseReleaseRequestStatus,
} from '@aeci/shared';

import { AdminSummaryStore } from '../admin-summary.store';
import { formatTermDate } from '../entitlement/entitlement-term';
import { AdminRequestsApi } from './admin-requests-api';

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
  imports: [DatePipe, RouterLink],
  host: { class: 'mt-14 block' },
  templateUrl: './license-release-queue.html',
})
export class LicenseReleaseQueue {
  private readonly api = inject(AdminRequestsApi);
  private readonly summaryStore = inject(AdminSummaryStore);
  private readonly locale = inject(LOCALE_ID);

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

  protected readonly primaryClass =
    'inline-flex items-center justify-center rounded-(--radius-md) bg-(--accent-primary) px-5 py-2 text-sm font-bold text-(--surface-base) transition-colors hover:bg-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) disabled:cursor-not-allowed disabled:opacity-50';
  protected readonly secondaryClass =
    'inline-flex items-center justify-center rounded-(--radius-md) border border-(--border-strong) bg-(--surface-base) px-5 py-2 text-sm font-bold text-(--text-primary) transition-colors hover:bg-(--surface-sunken) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) disabled:cursor-not-allowed disabled:opacity-50';

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
            $localize`:@@admin.licenseReleases.error.licenseMoved:The license is no longer on this product. Decline the request instead.`,
          );
          break;
        default:
          this.formError.set(
            $localize`:@@admin.requests.action.failed:Something went wrong. Please try again.`,
          );
      }
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

  /** "Ends Jun 30, 2027" or "Monthly", in UTC like every term date on the console. */
  protected termLine(row: AdminLicenseReleaseRequest): string | null {
    const license = row.license;
    if (!license) return null;
    if (license.ends_at === null) {
      return $localize`:@@admin.licenseReleases.term.monthly:Monthly, renews until cancelled`;
    }
    const date = formatTermDate(license.ends_at, this.locale);
    return $localize`:@@admin.licenseReleases.term.ends:Term ends ${date}:DATE:`;
  }

  protected outcomeLine(row: AdminLicenseReleaseRequest): string {
    switch (row.status) {
      case 'approved':
        return $localize`:@@admin.licenseReleases.outcome.approved:Approved. The license went back to the vendor's pool.`;
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
    return $localize`:@@admin.licenseReleases.approve.summary:The license comes off ${name}:NAME: now and goes back to the vendor's pool. It stays live and its term dates do not change. ${name}:NAME: is on the Free plan until a license is assigned to it.`;
  }

  private doneMessage(kind: Decision, name: string): string {
    return kind === 'approve'
      ? $localize`:@@admin.licenseReleases.announce.approved:License freed from ${name}:NAME:. The vendor has been told.`
      : $localize`:@@admin.licenseReleases.announce.declined:Request for ${name}:NAME: declined. The vendor has been told.`;
  }

  private drop(id: string): void {
    this.rows.update((list) => list.filter((r) => r.id !== id));
    this.total.update((n) => Math.max(0, n - 1));
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
