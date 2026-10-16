import { HttpErrorResponse } from '@angular/common/http';
import {
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';

import { ADMIN_REASON_MAX, type UpdateLicenseBody } from '@aeci/shared';

import { AdminLicensesApi } from './admin-licenses-api';
import type { BillingLicenseRow } from './billing-licenses-table';
import { licenseErrorMessage, licenseMinEndDay, licenseRowActions } from './license-row-actions';

type Mode = 'extend' | 'revoke';

/** One license the run could not change, with the sentence the operator reads. */
export interface LicenseBulkFailure {
  readonly id: string;
  readonly label: string;
  readonly message: string;
}

/**
 * The bulk Set end date and Revoke on the admin Billing tab. Rendered above the
 * licenses table through `BillingLicensesTable`'s `bulkActions` seam once one or more
 * rows are checked.
 *
 * ── ONE PATCH PER LICENSE ───────────────────────────────────────────────────
 * No bulk endpoint: each selected license goes through `PATCH /api/admin/licenses/:id`
 * in turn, the same write `LicenseRowActions` sends. Every guard, audit row, purge and
 * `managed-ended` email stays per license, exactly as a row-by-row run would leave it.
 * Sequential, not parallel: the `write` rate-limit bucket is 30 per minute per admin,
 * so a 429 stops the run and leaves the rest selected for a second pass.
 *
 * ── WHICH LICENSES EACH ACTION TOUCHES ──────────────────────────────────────
 * The same rules as the row (`licenseRowActions`): Set end date skips a Stripe
 * license, Revoke takes any live one. The form says how many it skips and why.
 *
 * ── AFTER A RUN ─────────────────────────────────────────────────────────────
 * Every license that changed is unchecked through {@link succeeded}. A failure keeps
 * its license checked and the form open with one line per failure. Announcements
 * leave through {@link announce} for the page's live region; the host refetches on
 * {@link changed}. Light theme only.
 */
@Component({
  selector: 'aec-license-bulk-actions',
  templateUrl: './license-bulk-actions.html',
})
export class LicenseBulkActions {
  private readonly api = inject(AdminLicensesApi);
  private readonly injector = inject(Injector);

  /** The checked rows. Every one is live: the table offers no box on an ended row. */
  readonly rows = input.required<readonly BillingLicenseRow[]>();
  /** Prefix for the form controls' `id`/`for` pairs. */
  readonly idPrefix = input.required<string>();

  /** At least one license changed. The host refetches the billing and the audit trail. */
  readonly changed = output<void>();
  /** The ids that changed, so the host unchecks them. */
  readonly succeeded = output<readonly string[]>();
  /** Text for the host's polite live region. */
  readonly announce = output<string>();
  /** A run started (`true`) or settled (`false`). The table locks its checkboxes. */
  readonly pendingChange = output<boolean>();

  protected readonly reasonMax = ADMIN_REASON_MAX;

  protected readonly extendable = computed(() =>
    this.rows().filter((r) => licenseRowActions(r.license).extend),
  );
  protected readonly revocable = computed(() =>
    this.rows().filter((r) => licenseRowActions(r.license).revoke),
  );
  /** Checked Stripe licenses: Set end date skips them. */
  protected readonly extendSkipped = computed(() => this.rows().length - this.extendable().length);
  /** Revocable licenses on a product: each of those products drops to Free. */
  protected readonly revokeOnProduct = computed(
    () => this.revocable().filter((r) => r.license.assigned_product !== null).length,
  );

  /** The latest of the per-license floors, so one date clears every license. */
  protected readonly minEnd = computed(() =>
    this.extendable()
      .map((r) => licenseMinEndDay(r.license))
      .reduce((max, day) => (day > max ? day : max), ''),
  );

  protected readonly mode = signal<Mode | null>(null);
  protected readonly endsAt = signal('');
  protected readonly reason = signal('');
  protected readonly internalNote = signal('');
  protected readonly reasonError = signal(false);
  protected readonly pending = signal(false);
  protected readonly failures = signal<readonly LicenseBulkFailure[]>([]);
  /** Set when a 429 stopped the run: the count of licenses not attempted. */
  protected readonly stoppedCount = signal(0);

  /** `YYYY-MM-DD` strings compare correctly as text. */
  protected readonly endTooEarly = computed(
    () => this.endsAt() !== '' && this.endsAt() < this.minEnd(),
  );
  protected readonly canExtend = computed(
    () => this.extendable().length > 0 && this.endsAt() !== '' && !this.endTooEarly(),
  );

  private readonly reasonInput = viewChild<ElementRef<HTMLTextAreaElement>>('reasonInput');
  private readonly firstField = viewChild<ElementRef<HTMLElement>>('firstField');
  private readonly triggers = viewChild<ElementRef<HTMLElement>>('triggers');

  protected open(mode: Mode): void {
    this.failures.set([]);
    this.stoppedCount.set(0);
    this.reasonError.set(false);
    this.endsAt.set('');
    this.reason.set('');
    this.internalNote.set('');
    this.mode.set(mode);
    afterNextRender(() => this.firstField()?.nativeElement.focus(), { injector: this.injector });
  }

  protected close(): void {
    const mode = this.mode();
    this.mode.set(null);
    this.failures.set([]);
    this.stoppedCount.set(0);
    afterNextRender(
      () =>
        this.triggers()
          ?.nativeElement.querySelector<HTMLButtonElement>(`[data-mode="${mode}"]`)
          ?.focus(),
      { injector: this.injector },
    );
  }

  protected onEndInput(event: Event): void {
    this.endsAt.set((event.target as HTMLInputElement).value);
  }

  protected onReasonInput(event: Event): void {
    this.reason.set((event.target as HTMLTextAreaElement).value);
    if (this.reasonError() && this.reason().trim()) this.reasonError.set(false);
  }

  protected onNoteInput(event: Event): void {
    this.internalNote.set((event.target as HTMLTextAreaElement).value);
  }

  protected submitExtend(): Promise<void> {
    if (!this.canExtend()) return Promise.resolve();
    return this.run(this.extendable(), { action: 'extend', ends_at: this.endsAt() });
  }

  protected submitRevoke(): Promise<void> {
    const reason = this.reason().trim();
    if (!reason) {
      this.reasonError.set(true);
      this.reasonInput()?.nativeElement.focus();
      return Promise.resolve();
    }
    const note = this.internalNote().trim();
    return this.run(this.revocable(), {
      action: 'revoke',
      reason,
      ...(note ? { internalNote: note } : {}),
    });
  }

  /** One PATCH at a time, in table order. A 429 stops the run. */
  private async run(targets: readonly BillingLicenseRow[], body: UpdateLicenseBody): Promise<void> {
    if (this.pending() || targets.length === 0) return;
    this.pending.set(true);
    this.pendingChange.emit(true);
    this.failures.set([]);
    this.stoppedCount.set(0);
    const done: string[] = [];
    const failed: LicenseBulkFailure[] = [];
    let stopped = 0;
    try {
      for (const [i, row] of targets.entries()) {
        try {
          await this.api.updateLicense(row.license.id, body);
          done.push(row.license.id);
        } catch (err) {
          if (err instanceof HttpErrorResponse && err.status === 429) {
            stopped = targets.length - i;
            break;
          }
          failed.push({
            id: row.license.id,
            label: rowLabel(row),
            message: licenseErrorMessage(err),
          });
        }
      }
    } finally {
      this.pending.set(false);
      this.pendingChange.emit(false);
    }

    this.failures.set(failed);
    this.stoppedCount.set(stopped);
    if (done.length > 0) {
      this.succeeded.emit(done);
      this.changed.emit();
    }
    this.announce.emit(summary(body.action, done.length, failed.length, stopped));
    if (failed.length === 0 && stopped === 0) this.mode.set(null);
  }
}

function rowLabel(row: BillingLicenseRow): string {
  return (
    row.license.assigned_product?.name ??
    $localize`:@@admin.vendors.licenseBulk.unassignedLabel:Unassigned license (${row.sourceLabel}:SOURCE:)`
  );
}

/** One sentence for the live region: what changed, what failed, what was not tried. */
function summary(
  action: UpdateLicenseBody['action'],
  done: number,
  failed: number,
  stopped: number,
): string {
  const parts: string[] = [
    action === 'revoke'
      ? $localize`:@@admin.vendors.licenseBulk.announce.revoked:Revoked ${done}:COUNT: of the selected licenses.`
      : $localize`:@@admin.vendors.licenseBulk.announce.extended:Set the end date on ${done}:COUNT: of the selected licenses.`,
  ];
  if (failed > 0) {
    parts.push(
      $localize`:@@admin.vendors.licenseBulk.announce.failed:${failed}:COUNT: could not be changed. They are still selected.`,
    );
  }
  if (stopped > 0) {
    parts.push(
      $localize`:@@admin.vendors.licenseBulk.announce.stopped:Stopped by the rate limit with ${stopped}:COUNT: not tried. Wait a minute, then run it again.`,
    );
  }
  return parts.join(' ');
}
