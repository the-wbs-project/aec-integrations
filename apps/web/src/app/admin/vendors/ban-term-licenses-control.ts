import { HttpErrorResponse } from '@angular/common/http';
import { Component, computed, inject, input, output, signal } from '@angular/core';

import { ApiErrorCode, type AdminBillingLicense, type BanTermLicensesResponse } from '@aeci/shared';

import { AdminLicensesApi } from './admin-licenses-api';

/**
 * The API's rule for a ban-term `ends_at` (`createBanTermLicensesHandler`): the value
 * sent, parsed as an instant, must be after now. A `YYYY-MM-DD` value parses as UTC
 * midnight, so a typed date passes only when it is after today's UTC date, whatever
 * the operator's time zone. One rule in both places, so the form never accepts a date
 * the API answers 400.
 */
export function banTermEndIsValid(value: string, nowMs: number): boolean {
  if (value === '') return false;
  const ms = Date.parse(value);
  return !Number.isNaN(ms) && ms > nowMs;
}

/** What the form sends for a row's date: an untouched prefill sends the stored instant,
 *  not its UTC midnight, so a Stripe period end keeps its time of day. */
export function banTermEndToSend(storedEndsAt: string | null, date: string): string {
  return storedEndsAt && storedEndsAt.slice(0, 10) === date ? storedEndsAt : date;
}

/** One product the ban took off Managed, as the form offers it. */
export interface BanTermCandidate {
  productId: string;
  productName: string;
  /** The license the ban ended on this product. */
  endedLicenseId: string;
  /** That license's `ends_at`, the paid term end. `null`: unknown (a monthly row whose
   *  Stripe read failed at ban time), so the operator types it. */
  endsAt: string | null;
}

/** The form's state for one candidate. */
interface BanTermRowState {
  include: boolean;
  /** `YYYY-MM-DD`, what the date input holds. */
  date: string;
}

/**
 * Whether some other license on `productId` was created after `endedAt`: a ban-term
 * grant already restored the banned row, or a purchase or grant replaced it. The API's
 * rule (`createBanTermLicensesHandler`): such a row is spent, live or not, so a restored
 * license that lapsed or was revoked never brings the panel back.
 */
function replacedAfter(
  rows: readonly AdminBillingLicense[],
  bannedRow: AdminBillingLicense,
  productId: string,
): boolean {
  const endedMs = Date.parse(bannedRow.ended_at ?? '');
  if (Number.isNaN(endedMs)) return false;
  return rows.some(
    (l) =>
      l.id !== bannedRow.id &&
      l.assigned_product?.id === productId &&
      Date.parse(l.created_at) > endedMs,
  );
}

/**
 * The products a ban-term grant can restore: each product a license ended `banned` is
 * on, when no live license in the same list holds it and no license on that product
 * (any source, live or ended) was created after the banned row ended. One per product:
 * the list is ordered most recently ended first, so the first banned row wins.
 */
export function banTermCandidates(rows: readonly AdminBillingLicense[]): BanTermCandidate[] {
  const liveProducts = new Set(
    rows.filter((l) => l.live && l.assigned_product).map((l) => l.assigned_product!.id),
  );
  const seen = new Set<string>();
  const out: BanTermCandidate[] = [];
  for (const l of rows) {
    const product = l.assigned_product;
    if (l.live || l.end_reason !== 'banned' || !product) continue;
    if (liveProducts.has(product.id) || seen.has(product.id)) continue;
    if (replacedAfter(rows, l, product.id)) {
      seen.add(product.id);
      continue;
    }
    seen.add(product.id);
    out.push({
      productId: product.id,
      productName: product.name,
      endedLicenseId: l.id,
      endsAt: l.ends_at,
    });
  }
  return out;
}

/**
 * "Grant complimentary licenses for the ban term" on the Billing tab of
 * `/admin/vendors/:id` (AECI-1589; `POST /api/admin/vendors/:id/licenses/ban-term`).
 *
 * ── WHEN IT SHOWS ───────────────────────────────────────────────────────────
 * The ban of a vendor's last unbanned seat ends every license now (`end_reason =
 * 'banned'`), and the unban restores none. Once the vendor has an unbanned
 * `vendor_admin` seat again, this offers one row per product a banned license was on
 * and no live license now holds, unless a license on that product was created after the
 * ban ended it (it was restored or replaced; {@link banTermCandidates}). Otherwise it
 * renders nothing: the API would answer `409 VENDOR_STILL_BANNED`,
 * `LICENSE_PRODUCT_ALREADY_LICENSED`, or `400` on `items.{i}.ended_license_id`.
 *
 * ── ONE ROW PER PRODUCT ─────────────────────────────────────────────────────
 * Each row has an include checkbox and an end date prefilled from the banned row's
 * `ends_at` (the paid term end). A NULL `ends_at` means the term end was unknown at ban
 * time: the date is empty and required. A prefilled date the operator leaves alone is
 * sent as the stored timestamp, so a Stripe period end keeps its time of day. A date is
 * valid by the API's rule ({@link banTermEndIsValid}): after now, a typed date read as
 * UTC midnight, so "after today" means after today in UTC.
 *
 * ── IDEMPOTENT ON `grant_id` ────────────────────────────────────────────────
 * Minted when the form opens, as `GrantLicensesControl` does. A double click or a retry
 * after a lost response replays (`replayed: true`) instead of granting twice.
 *
 * ── HOST-OWNED CHROME ───────────────────────────────────────────────────────
 * No heading and no live region: `VendorDetail` owns both. Announcements leave through
 * {@link announce}; the host reloads Billing on {@link granted}, which hides the
 * control once every product is licensed again.
 */
@Component({
  selector: 'aec-ban-term-licenses-control',
  templateUrl: './ban-term-licenses-control.html',
})
export class BanTermLicensesControl {
  private readonly api = inject(AdminLicensesApi);

  readonly vendorId = input.required<string>();
  readonly vendorName = input.required<string>();
  /** Every license row the Billing read returned. */
  readonly licenses = input.required<readonly AdminBillingLicense[]>();
  /** The vendor holds an unbanned `vendor_admin` seat. `null`: the roster could not be
   *  read, so the control stays hidden. */
  readonly hasUnbannedSeat = input.required<boolean | null>();
  /** Prefix for the form controls' `id`/`for` pairs. */
  readonly idPrefix = input.required<string>();

  /** The committed grant. The host reloads Billing and the audit trail on it. */
  readonly granted = output<BanTermLicensesResponse>();
  /** Text for the host's polite live region. */
  readonly announce = output<string>();

  protected readonly candidates = computed(() => banTermCandidates(this.licenses()));
  protected readonly visible = computed(
    () => this.hasUnbannedSeat() === true && this.candidates().length > 0,
  );

  protected readonly formOpen = signal(false);
  private readonly grantId = signal('');
  protected readonly rows = signal<ReadonlyMap<string, BanTermRowState>>(new Map());
  protected readonly pending = signal(false);
  protected readonly failedMessage = signal('');
  /** Captured at open: the form compares dates against it, as the API compares with
   *  its request time. */
  private readonly openedAt = signal(Date.now());

  protected readonly includedCount = computed(
    () => [...this.rows().values()].filter((r) => r.include).length,
  );

  /** An included row whose date is empty or fails the API's rule (after now, UTC). */
  protected dateInvalid(productId: string): boolean {
    const row = this.rows().get(productId);
    if (!row || !row.include) return false;
    const stored = this.candidates().find((c) => c.productId === productId)?.endsAt ?? null;
    return !banTermEndIsValid(banTermEndToSend(stored, row.date), this.openedAt());
  }

  /** A typed date that fails: an empty required date only disables the submit. */
  protected showDateError(productId: string): boolean {
    return this.dateInvalid(productId) && this.rowFor(productId).date !== '';
  }

  /** The date input's description: the unknown-term hint and the error, when shown. */
  protected describedBy(c: BanTermCandidate): string | null {
    const ids = [
      ...(c.endsAt === null ? [`${this.idPrefix()}-ban-term-end-hint-${c.productId}`] : []),
      ...(this.showDateError(c.productId)
        ? [`${this.idPrefix()}-ban-term-end-error-${c.productId}`]
        : []),
    ];
    return ids.length > 0 ? ids.join(' ') : null;
  }

  protected readonly canSubmit = computed(
    () =>
      this.includedCount() > 0 && this.candidates().every((c) => !this.dateInvalid(c.productId)),
  );

  protected rowFor(productId: string): BanTermRowState {
    return this.rows().get(productId) ?? { include: false, date: '' };
  }

  protected openForm(): void {
    this.failedMessage.set('');
    this.grantId.set(crypto.randomUUID());
    this.openedAt.set(Date.now());
    this.rows.set(
      new Map(
        this.candidates().map((c) => [
          c.productId,
          { include: true, date: c.endsAt ? c.endsAt.slice(0, 10) : '' },
        ]),
      ),
    );
    this.formOpen.set(true);
  }

  protected closeForm(): void {
    this.formOpen.set(false);
    this.grantId.set('');
  }

  protected onIncludeChange(productId: string, event: Event): void {
    const include = (event.target as HTMLInputElement).checked;
    this.patchRow(productId, { include });
  }

  protected onDateInput(productId: string, event: Event): void {
    this.patchRow(productId, { date: (event.target as HTMLInputElement).value });
  }

  private patchRow(productId: string, patch: Partial<BanTermRowState>): void {
    this.rows.update((rows) => {
      const next = new Map(rows);
      next.set(productId, { ...this.rowFor(productId), ...patch });
      return next;
    });
  }

  protected async submit(): Promise<void> {
    if (!this.canSubmit() || this.pending()) return;
    const items = this.candidates()
      .filter((c) => this.rowFor(c.productId).include)
      .map((c) => {
        const date = this.rowFor(c.productId).date;
        return {
          ended_license_id: c.endedLicenseId,
          product_id: c.productId,
          ends_at: banTermEndToSend(c.endsAt, date),
        };
      });

    this.failedMessage.set('');
    this.pending.set(true);
    try {
      const result = await this.api.grantBanTermLicenses(this.vendorId(), {
        grant_id: this.grantId(),
        items,
      });
      this.granted.emit(result);
      this.closeForm();
      this.announce.emit(this.announcementFor(result));
    } catch (err) {
      this.failedMessage.set(messageForError(err));
    } finally {
      this.pending.set(false);
    }
  }

  private announcementFor(result: BanTermLicensesResponse): string {
    const count = result.licenses.length;
    const vendor = this.vendorName();
    if (result.replayed) {
      return $localize`:@@admin.vendors.billing.banTerm.announce.replayed:This grant was already recorded for ${vendor}:VENDOR:. Nothing changed.`;
    }
    return count === 1
      ? $localize`:@@admin.vendors.billing.banTerm.announce.grantedOne:1 complimentary subscription granted to ${vendor}:VENDOR: for the ban term. Its product is on Managed again.`
      : $localize`:@@admin.vendors.billing.banTerm.announce.granted:${count}:COUNT: complimentary subscriptions granted to ${vendor}:VENDOR: for the ban term. Their products are on Managed again.`;
  }
}

/** Each status and code the endpoint returns gets a sentence the operator can act on. */
function messageForError(err: unknown): string {
  if (err instanceof HttpErrorResponse) {
    const code = (err.error as { error?: { code?: string } } | null)?.error?.code;
    if (err.status === 400) {
      return $localize`:@@admin.vendors.billing.banTerm.error.invalid:Check the rows: each end date must be after today (UTC). Reload the page if the subscriptions changed. Nothing was granted.`;
    }
    if (err.status === 404) {
      return $localize`:@@admin.vendors.billing.banTerm.error.notFound:A product is no longer this vendor's, or the vendor has no billing account. Reload the page. Nothing was granted.`;
    }
    if (err.status === 409 && code === ApiErrorCode.VENDOR_STILL_BANNED) {
      return $localize`:@@admin.vendors.billing.banTerm.error.stillBanned:Every owner seat on this vendor is still banned. Reinstate a seat first. Nothing was granted.`;
    }
    if (err.status === 409 && code === ApiErrorCode.LICENSE_PRODUCT_ALREADY_LICENSED) {
      return $localize`:@@admin.vendors.billing.banTerm.error.licensed:A product already holds a live subscription. Reload the page and grant the rest. Nothing was granted.`;
    }
    if (err.status === 409) {
      return $localize`:@@admin.vendors.billing.banTerm.error.conflict:This grant clashes with one already recorded. Cancel, reopen the form and grant again. Nothing was written.`;
    }
    if (err.status === 403) {
      return $localize`:@@admin.vendors.billing.banTerm.error.forbidden:You do not have permission to grant subscriptions.`;
    }
    if (err.status === 429) {
      return $localize`:@@admin.vendors.billing.banTerm.error.rateLimited:Too many changes at once. Wait a minute, then try again.`;
    }
  }
  return $localize`:@@admin.vendors.billing.banTerm.error.failed:Something went wrong. Please try again.`;
}
