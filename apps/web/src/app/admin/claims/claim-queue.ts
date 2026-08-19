import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { Component, afterNextRender, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import type {
  AdminClaim,
  ListVendorClaimsQuery,
  ModerateClaimInput,
  SetVendorEntitlementInput,
  VendorEntitlementResponse,
} from '@aeci/shared';

import { AdminClaimsApi } from './admin-claims-api';

/** One request covers a launch-scale claim backlog. The API caps `perPage` at 100;
 *  we load the max and surface a note if the server reports more. */
const QUEUE_PAGE_SIZE = 100;

type StatusFilter = 'open' | 'resolved' | 'rejected';
type FormMode = 'approve' | 'reject';
/** The three verbs of `PATCH /api/admin/vendors/:id/entitlement` (§5.1). */
type EntitlementMode = SetVendorEntitlementInput['action'];

/**
 * AECI-521 / `STAGE_2_VENDOR_PORTAL_SPEC.md` §5 — the admin claim-review queue,
 * rendered in the `AdminShell` layout's outlet at `/admin/claims`. A sibling of
 * `/admin/requests` (AECI-217): it clones that queue's SSR-shell + client-fetch
 * shape but is CLAIMS-only and assembles the reviewer-assist verification signals
 * a human weighs before granting a verified vendor account — **no auto-grant**
 * (`STAGE_2_SPEC.md` §8.1(1)).
 *
 * The gate + nav SSR via `adminSummaryResolver` (the parent route); this queue
 * paints its shell during SSR and fetches the list client-side in `afterNextRender`
 * — the same-origin `GET /api/admin/claims` carries the session cookie, which the
 * API Worker's `requireAdmin()` verifies. It never reads cookies/session directly.
 *
 * Signals surfaced per claim: email-domain match, whether an auth account already
 * exists (approve LINKS vs PROVISIONS), the claimed vendor's existing seats
 * (second-seat vs first claim), prior/duplicate requests, and a client-built
 * LinkedIn/person search link (a link only — real enrichment providers are a
 * deferred DPA/GDPR decision, §8.3(4)). A signal that couldn't be computed
 * (`null`) renders "unavailable" and the review still proceeds.
 *
 * Approve triggers the AECI-519 grant (`PATCH …/:id {action:'approve'}`) and
 * captures a free-text arrangement note (the offline PO/invoice record, §8.1(5) —
 * recorded verbatim in the grant's audit metadata as `entitlement.notes`); reject
 * runs the reject path. A successful action drops the row. **Approve returns 503
 * wherever `SUPABASE_SERVICE_ROLE_KEY` is absent — local dev and PR previews, since
 * AECI-530 CI-pushes it on staging/demo/production** — surfaced as an inline
 * "grant unavailable" message (reject still works). A 409 is
 * an identity conflict (already an admin / claims another vendor). Following the
 * requests precedent there is no summary badge.
 *
 * AECI-532 (`STAGE_2_PAID_TIERS_SPEC.md` §5) adds the ENTITLEMENT column + its
 * inline set/renew/clear control, following the `/admin/reviewers` ban-control
 * precedent rather than opening a new admin section (a standalone `/admin/vendors`
 * entitlement browser is §11, out of scope). It acts on `entitlement_vendor` — the
 * row's RESOLVED target vendor, because a product claim's entitlement belongs to that
 * product's primary vendor — and it stays available on RESOLVED and REJECTED rows too,
 * since renewing or clearing a vendor granted months ago is the ordinary case.
 *
 * Three things the copy has to carry, because getting them wrong is a foreseeable
 * incident rather than a typo:
 *   1. Clearing an entitlement is NOT a seat revoke and NOT a ban (§5.2). Seats,
 *      logins and the dashboard all survive — read-only.
 *   2. Search is nightly in BOTH directions (§5.3 / R2), so the badge can lag the
 *      action by up to a day. Never promise instant search.
 *   3. The §5.4 lockout: a cleared-but-still-seated vendor can be edited by nobody
 *      (the portal 403s, and `POST /api/promote` refuses a claimed vendor). The
 *      escape hatch — re-activate, edit, clear again — is named on screen.
 */
@Component({
  selector: 'aec-claim-queue',
  imports: [DatePipe, RouterLink],
  templateUrl: './claim-queue.html',
})
export class ClaimQueue {
  private readonly api = inject(AdminClaimsApi);

  /** The loaded claims (server order: newest-first). */
  private readonly claims = signal<readonly AdminClaim[]>([]);
  /** Total matching the current filter reported by the server (may exceed loaded). */
  protected readonly total = signal(0);

  protected readonly loading = signal(true);
  protected readonly loadFailed = signal(false);

  /** Id of the claim whose action is in flight (disables its buttons). */
  protected readonly pendingActionId = signal<string | null>(null);
  /** The claim + mode whose action form is open (one at a time). */
  protected readonly formOpenId = signal<string | null>(null);
  protected readonly formMode = signal<FormMode | null>(null);
  /** The shared free-text field: approve → arrangement notes, reject → an INTERNAL
   *  decision note (recorded in the audit log, never emailed — the claimant email
   *  is neutral, §9). */
  protected readonly formText = signal('');
  /** Id + message of the claim whose last action failed (inline alert). */
  protected readonly failedActionId = signal<string | null>(null);
  protected readonly failedActionMessage = signal('');
  /** Polite live-region message — the row vanishes on success, so announce it. */
  protected readonly liveMessage = signal('');

  protected readonly statusFilter = signal<StatusFilter>('open');

  // ── Entitlement control (AECI-532 / §5) ────────────────────────────────────
  /** Claim id whose entitlement form is open, and which verb it will send. */
  protected readonly entFormOpenId = signal<string | null>(null);
  protected readonly entFormMode = signal<EntitlementMode | null>(null);
  /** Term end (`<input type="date">` → `YYYY-MM-DD`, which the wire schema accepts). */
  protected readonly entPeriodEnd = signal('');
  protected readonly entInvoiceRef = signal('');
  /** Notes on set/renew; the internal audit reason on clear. */
  protected readonly entNote = signal('');
  /** Vendor id whose entitlement action is in flight (disables its buttons). */
  protected readonly entPendingVendorId = signal<string | null>(null);
  protected readonly entFailedId = signal<string | null>(null);
  protected readonly entFailedMessage = signal('');

  protected readonly statusOptions: ReadonlyArray<{ key: StatusFilter; label: string }> = [
    { key: 'open', label: $localize`:@@admin.claims.filter.status.open:Open` },
    { key: 'resolved', label: $localize`:@@admin.claims.filter.status.resolved:Approved` },
    { key: 'rejected', label: $localize`:@@admin.claims.filter.status.rejected:Rejected` },
  ];

  protected readonly visibleClaims = computed(() => this.claims());
  protected readonly loadedCount = computed(() => this.claims().length);
  /** True when the server reports more rows than we loaded (note shown). */
  protected readonly truncated = computed(() => this.total() > this.claims().length);

  constructor() {
    afterNextRender(() => {
      void this.load();
    });
  }

  private async load(): Promise<void> {
    this.loadFailed.set(false);
    this.loading.set(true);
    const query: Partial<ListVendorClaimsQuery> = {
      status: this.statusFilter(),
      page: 1,
      perPage: QUEUE_PAGE_SIZE,
    };
    try {
      const res = await this.api.listClaims(query);
      this.claims.set(res.data);
      this.total.set(res.total);
    } catch {
      this.loadFailed.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  protected retry(): void {
    void this.load();
  }

  protected setStatus(status: StatusFilter): void {
    if (this.statusFilter() === status) return;
    this.statusFilter.set(status);
    this.closeForm();
    void this.load();
  }

  /** Only open / in-review rows can be moderated; terminal rows are read-only. */
  protected isActionable(status: AdminClaim['status']): boolean {
    return status === 'open' || status === 'in_review';
  }

  /** Relative age (e.g. "3 d", "5 h", "12 min"). Browser-only — the list is empty
   *  during SSR, so `Date.now()` is never read server-side. */
  protected age(createdAt: string): string {
    const minutes = Math.max(0, Math.floor((Date.now() - new Date(createdAt).getTime()) / 60_000));
    if (minutes < 60) return $localize`:@@admin.claims.age.minutes:${minutes}:COUNT: min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return $localize`:@@admin.claims.age.hours:${hours}:COUNT: h`;
    const days = Math.floor(hours / 24);
    return $localize`:@@admin.claims.age.days:${days}:COUNT: d`;
  }

  protected statusLabel(status: AdminClaim['status']): string {
    switch (status) {
      case 'open':
        return $localize`:@@admin.claims.status.open:Open`;
      case 'in_review':
        return $localize`:@@admin.claims.status.inReview:In review`;
      case 'resolved':
        return $localize`:@@admin.claims.status.resolved:Approved`;
      case 'rejected':
        return $localize`:@@admin.claims.status.rejected:Rejected`;
    }
  }

  /** Non-linked fallback label when the target row is missing (deleted/un-promoted). */
  protected targetFallbackLabel(type: AdminClaim['target_type']): string {
    return type === 'product'
      ? $localize`:@@admin.claims.target.unknownProduct:Unknown product`
      : $localize`:@@admin.claims.target.unknownVendor:Unknown vendor`;
  }

  /** Detail route base for a target — the discriminator picks products vs vendors. */
  protected targetRouterLink(r: AdminClaim): string[] | null {
    if (!r.target) return null;
    return r.target_type === 'product' ? ['/products', r.target.slug] : ['/vendors', r.target.slug];
  }

  protected domainMatchLabel(value: string): string {
    switch (value) {
      case 'match':
        return $localize`:@@admin.claims.domain.match:Domain matches`;
      case 'no_match':
        return $localize`:@@admin.claims.domain.noMatch:Domain mismatch`;
      case 'manual_review':
        return $localize`:@@admin.claims.domain.manualReview:Manual review`;
      default:
        return $localize`:@@admin.claims.domain.pending:Domain check pending`;
    }
  }

  /** What approving this claim will do to the claimant's auth account — the AECI-527
   *  reviewer signal. `null` (unknown) is common: absent Supabase creds or a failed
   *  lookup, never a decision gate. */
  protected authAccountLabel(value: boolean | null): string {
    if (value === true) {
      return $localize`:@@admin.claims.auth.exists:Existing account: approve links it`;
    }
    if (value === false) {
      return $localize`:@@admin.claims.auth.none:No account: approve provisions one`;
    }
    return $localize`:@@admin.claims.auth.unknown:Account status unknown`;
  }

  protected seatDisplayName(name: string | null): string {
    return name?.trim() ? name : $localize`:@@admin.claims.seat.unnamed:Unnamed seat`;
  }

  /**
   * A pre-built LinkedIn people-search URL from the claimant's name (falling back
   * to their email). A LINK only — the reviewer opens it deliberately; no claimant
   * data is sent anywhere by rendering it (§8.3(4) working decision). Real
   * person-lookup/enrichment providers are a deferred DPA/GDPR decision (§11).
   */
  protected linkedInSearchUrl(r: AdminClaim): string {
    const keywords = r.submitter_name?.trim() ? r.submitter_name.trim() : r.submitter_email;
    return `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(keywords)}`;
  }

  // ── Moderation actions ─────────────────────────────────────────────────────

  /** Open the inline approve form (arrangement-note capture) for a row. */
  protected openApprove(id: string): void {
    this.failedActionId.set(null);
    this.formText.set('');
    this.formMode.set('approve');
    this.formOpenId.set(id);
  }

  /** Open the inline reject form (optional internal note) for a row. */
  protected openReject(id: string): void {
    this.failedActionId.set(null);
    this.formText.set('');
    this.formMode.set('reject');
    this.formOpenId.set(id);
  }

  protected closeForm(): void {
    this.formOpenId.set(null);
    this.formMode.set(null);
    this.formText.set('');
  }

  protected onFormInput(event: Event): void {
    this.formText.set((event.target as HTMLTextAreaElement).value);
  }

  protected async confirmApprove(id: string): Promise<void> {
    const notes = this.formText().trim();
    await this.moderate(
      id,
      { action: 'approve', ...(notes ? { entitlement: { notes } } : {}) },
      $localize`:@@admin.claims.announce.approved:Claim approved: a verified vendor account was granted.`,
    );
  }

  protected async confirmReject(id: string): Promise<void> {
    const reason = this.formText().trim();
    await this.moderate(
      id,
      { action: 'reject', ...(reason ? { reason } : {}) },
      $localize`:@@admin.claims.announce.rejected:Claim rejected.`,
    );
  }

  /** Shared approve/reject path: PATCH, then drop the moderated row (it leaves the
   *  `open` view) and announce. Error handling is claim-specific (see below). */
  private async moderate(
    id: string,
    input: ModerateClaimInput,
    announcement: string,
  ): Promise<void> {
    if (this.pendingActionId()) return;
    this.failedActionId.set(null);
    this.pendingActionId.set(id);
    try {
      await this.api.moderate(id, input);
      this.closeForm();
      this.removeRow(id);
      this.liveMessage.set(announcement);
    } catch (err) {
      this.handleModerateError(id, err);
    } finally {
      this.pendingActionId.set(null);
    }
  }

  /**
   * A 422 means another admin moderated it first (or it's terminal) — drop the row.
   * A 409 is an identity conflict (the claimant is already an admin, or claims a
   * different vendor); a 503 is the AECI-530 state (identity resolution isn't
   * configured — reject still works). Both keep the row + form so the reviewer can
   * react. Anything else is a generic retryable failure.
   */
  private handleModerateError(id: string, err: unknown): void {
    if (err instanceof HttpErrorResponse) {
      if (err.status === 422) {
        this.removeRow(id);
        this.closeForm();
        this.liveMessage.set(
          $localize`:@@admin.claims.announce.alreadyModerated:That claim was already moderated.`,
        );
        return;
      }
      if (err.status === 409) {
        this.failedActionId.set(id);
        this.failedActionMessage.set(
          $localize`:@@admin.claims.action.conflict:Grant blocked: the claimant's account is a site admin or already claims a different vendor.`,
        );
        return;
      }
      if (err.status === 503) {
        this.failedActionId.set(id);
        this.failedActionMessage.set(
          $localize`:@@admin.claims.action.unavailable:Grant unavailable: the claimant identity service isn't configured. Reject still works.`,
        );
        return;
      }
    }
    this.failedActionId.set(id);
    this.failedActionMessage.set(
      $localize`:@@admin.claims.action.failed:Something went wrong. Please try again.`,
    );
  }

  private removeRow(id: string): void {
    this.claims.update((list) => list.filter((r) => r.id !== id));
    this.total.update((n) => Math.max(0, n - 1));
  }

  // ── Entitlement actions (AECI-532 / §5) ────────────────────────────────────

  /** Whether the vendor currently holds the paid entitlement. `active` is the ONLY
   *  status that grants capabilities and the only one that mirrors onto the badge
   *  (§2.2) — every other status, and no row at all, reads as "not entitled". */
  protected isEntitled(r: AdminClaim): boolean {
    return r.entitlement?.status === 'active';
  }

  /** The entitlement state, as a short badge label. */
  protected entitlementLabel(r: AdminClaim): string {
    if (!r.entitlement_vendor) {
      return $localize`:@@admin.claims.ent.unavailable:Unavailable`;
    }
    switch (r.entitlement?.status) {
      case 'active':
        return $localize`:@@admin.claims.ent.status.active:Verified: entitlement active`;
      case 'pending':
        return $localize`:@@admin.claims.ent.status.pending:Arrangement pending`;
      case 'expired':
        return $localize`:@@admin.claims.ent.status.expired:Term expired`;
      case 'revoked':
        return $localize`:@@admin.claims.ent.status.revoked:Entitlement cleared`;
      default:
        return $localize`:@@admin.claims.ent.status.none:No entitlement on record`;
    }
  }

  /** The term readout. `null` `period_end` is PERPETUAL (what the §2.4 backfill
   *  wrote), never "unknown" — so it must not render as a blank. */
  protected entitlementTerm(e: VendorEntitlementResponse): string {
    return e.period_end
      ? $localize`:@@admin.claims.ent.termEnds:Term ends ${e.period_end}:DATE:`
      : $localize`:@@admin.claims.ent.termPerpetual:No end date on record`;
  }

  protected openEntitlementForm(r: AdminClaim, mode: EntitlementMode): void {
    this.entFailedId.set(null);
    this.entFormMode.set(mode);
    this.entFormOpenId.set(r.id);
    // Renew pre-fills from the row so an admin extending a term edits one field and
    // does not silently blank the paperwork (the API patches, it does not replace).
    this.entPeriodEnd.set(mode === 'renew' ? (r.entitlement?.period_end ?? '') : '');
    this.entInvoiceRef.set(mode === 'renew' ? (r.entitlement?.invoice_ref ?? '') : '');
    this.entNote.set('');
  }

  protected closeEntitlementForm(): void {
    this.entFormOpenId.set(null);
    this.entFormMode.set(null);
    this.entPeriodEnd.set('');
    this.entInvoiceRef.set('');
    this.entNote.set('');
  }

  protected onEntPeriodEndInput(event: Event): void {
    this.entPeriodEnd.set((event.target as HTMLInputElement).value);
  }

  protected onEntInvoiceRefInput(event: Event): void {
    this.entInvoiceRef.set((event.target as HTMLInputElement).value);
  }

  protected onEntNoteInput(event: Event): void {
    this.entNote.set((event.target as HTMLTextAreaElement).value);
  }

  /**
   * Send the entitlement action and patch the affected rows in place.
   *
   * Rows are patched by VENDOR id, not by claim id: two claims on the same vendor are
   * common on this queue (that is what the duplicate signal is for), and updating only
   * the acted-on row would leave a sibling showing a stale badge state.
   */
  protected async submitEntitlement(r: AdminClaim): Promise<void> {
    const vendor = r.entitlement_vendor;
    const mode = this.entFormMode();
    if (!vendor || !mode || this.entPendingVendorId()) return;

    const note = this.entNote().trim();
    const periodEnd = this.entPeriodEnd().trim();
    const invoiceRef = this.entInvoiceRef().trim();
    const input: SetVendorEntitlementInput =
      mode === 'clear'
        ? { action: 'clear', ...(note ? { reason: note } : {}) }
        : {
            action: mode,
            ...(periodEnd ? { period_end: periodEnd } : {}),
            ...(invoiceRef ? { invoice_ref: invoiceRef } : {}),
            ...(note ? { notes: note } : {}),
          };

    this.entFailedId.set(null);
    this.entPendingVendorId.set(vendor.id);
    try {
      const entitlement = await this.api.setEntitlement(vendor.id, input);
      this.claims.update((list) =>
        list.map((row) =>
          row.entitlement_vendor?.id === vendor.id ? { ...row, entitlement } : row,
        ),
      );
      this.closeEntitlementForm();
      this.liveMessage.set(this.entitlementAnnouncement(mode, vendor.name));
    } catch (err) {
      this.handleEntitlementError(r.id, err);
    } finally {
      this.entPendingVendorId.set(null);
    }
  }

  /** Announced politely — the badge state changes in place, with no row removal to
   *  signal it. Deliberately says "within a day", never "now": the Algolia sync is
   *  nightly in BOTH directions (§5.3). */
  private entitlementAnnouncement(mode: EntitlementMode, vendorName: string): string {
    switch (mode) {
      case 'set':
        return $localize`:@@admin.claims.ent.announce.set:Entitlement granted for ${vendorName}:NAME:. Search results update within a day.`;
      case 'renew':
        return $localize`:@@admin.claims.ent.announce.renewed:Entitlement renewed for ${vendorName}:NAME:.`;
      case 'clear':
        return $localize`:@@admin.claims.ent.announce.cleared:Entitlement cleared for ${vendorName}:NAME:. Portal access continues, read-only. Search results update within a day.`;
    }
  }

  /** A 422 means the entitlement is already in the requested state (another admin got
   *  there first); a 403 is the guardrail. Both keep the row + form so the reviewer can
   *  react — nothing is dropped, because an entitlement row is not a queue item. */
  private handleEntitlementError(id: string, err: unknown): void {
    this.entFailedId.set(id);
    if (err instanceof HttpErrorResponse) {
      if (err.status === 422) {
        this.entFailedMessage.set(
          $localize`:@@admin.claims.ent.error.state:That entitlement is already in the state you asked for. Reload to see the current one.`,
        );
        return;
      }
      if (err.status === 403) {
        this.entFailedMessage.set(
          $localize`:@@admin.claims.ent.error.forbidden:That entitlement change isn't allowed. To remove a vendor's entitlement, clear it rather than downgrading the tier.`,
        );
        return;
      }
      if (err.status === 400) {
        this.entFailedMessage.set(
          $localize`:@@admin.claims.ent.error.term:Check the term dates: the end date must come after the start date.`,
        );
        return;
      }
    }
    this.entFailedMessage.set(
      $localize`:@@admin.claims.ent.error.failed:Something went wrong. Please try again.`,
    );
  }
}
