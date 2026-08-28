import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { Component, afterNextRender, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import type {
  AdminClaim,
  ListVendorClaimsQuery,
  ModerateClaimInput,
  VendorEntitlementResponse,
} from '@aeci/shared';

import { AdminClaimsApi } from './admin-claims-api';

/** One request covers a launch-scale claim backlog. The API caps `perPage` at 100;
 *  we load the max and surface a note if the server reports more. */
const QUEUE_PAGE_SIZE = 100;

type StatusFilter = 'open' | 'resolved' | 'rejected';
type FormMode = 'approve' | 'reject';

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
 * AECI-532 (`STAGE_2_PAID_TIERS_SPEC.md` §5) added an ENTITLEMENT column plus an
 * inline set/renew/clear control here, because `/admin/claims` was then the only
 * surface that could reach a vendor at all. **AECI-652 §5.6 moved the control
 * out** to `/admin/vendors/:id` — the surface that can reach EVERY vendor,
 * including one that never filed a claim, which is what concierge onboarding
 * needs. What is left here is a readout plus a "Manage entitlement" link.
 *
 * The move is not tidying. The control carries three sentences whose drift is a
 * foreseeable incident rather than a typo — clearing is not a seat revoke and not
 * a ban (§5.2); search is nightly in BOTH directions so the badge lags by up to a
 * day (§5.3 / R2); and the §5.4 lockout with its re-activate → edit → clear
 * escape hatch — and two surfaces meant two copies of them. They now live in
 * exactly one file, `admin/entitlement/entitlement-control.html`.
 *
 * The readout still points at `entitlement_vendor` — the row's RESOLVED target
 * vendor, because a product claim's entitlement belongs to that product's primary
 * vendor — and it stays visible on RESOLVED and REJECTED rows too, since renewing
 * or clearing a vendor granted months ago is the ordinary case.
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

  // ── Entitlement readout (AECI-532 §5; the CONTROL moved out in AECI-652 §5.6) ──
  //
  // What stayed here is the readout the queue renders and the link out to
  // `/admin/vendors/:id`. The set/renew/clear form, its API call and its error
  // mapping all live in `EntitlementControl` now — one copy of the §5.2/§5.3/§5.4
  // copy invariants, on the surface that can reach every vendor rather than only
  // the ones that filed a claim.

  /** The entitlement state, as a short badge label. Unlike the shared control's
   *  own label, this one has an "Unavailable" branch: on a claim card the target
   *  vendor can genuinely be absent (a product with no `product_vendors` row), and
   *  there is then nothing to link to. */
  protected entitlementLabel(r: AdminClaim): string {
    if (!r.entitlement_vendor) {
      return $localize`:@@admin.claims.ent.unavailable:Unavailable`;
    }
    switch (r.entitlement?.status) {
      case 'active':
        return $localize`:@@admin.claims.ent.status.active2:Verified: entitlement active`;
      case 'pending':
        return $localize`:@@admin.claims.ent.status.pending2:Arrangement pending`;
      case 'expired':
        return $localize`:@@admin.claims.ent.status.expired2:Term expired`;
      case 'revoked':
        return $localize`:@@admin.claims.ent.status.revoked2:Entitlement cleared`;
      default:
        return $localize`:@@admin.claims.ent.status.none2:No entitlement on record`;
    }
  }

  /** The term readout. `null` `period_end` is PERPETUAL (what the §2.4 backfill
   *  wrote), never "unknown" — so it must not render as a blank. */
  protected entitlementTerm(e: VendorEntitlementResponse): string {
    return e.period_end
      ? $localize`:@@admin.claims.ent.termEnds2:Term ends ${e.period_end}:DATE:`
      : $localize`:@@admin.claims.ent.termPerpetual2:No end date on record`;
  }
}
