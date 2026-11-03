import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { Component, afterNextRender, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { foundViaLabel } from '../../shared/found-via/found-via-labels';
import { NewTabIcon } from '../../shared/new-tab-icon/new-tab-icon';

import {
  CLAIM_OWNER_REVIEW_DAYS,
  claimOwnerReviewDeadline,
  type AdminClaim,
  type ListVendorClaimsQuery,
  type ModerateClaimInput,
} from '@aeci/shared';

import { AdminClaimsApi } from './admin-claims-api';
import { ClaimAccountConflict, claimantSeatConflict } from './claim-account-conflict';
import { claimantAccountLabel } from './claimant-account-label';
import { DomainMatchSignal } from './domain-match-signal';
import { AdminSummaryStore } from '../admin-summary.store';
import { productRolesLabel } from '../product-roles/product-roles-label';
import { seatLabel } from '../seat-label';
import { ownedIntegrationsLabel } from '../product-roles/owned-integrations-label';

/** One request covers a launch-scale claim backlog. The API caps `perPage` at 100;
 *  we load the max and surface a note if the server reports more. */
const QUEUE_PAGE_SIZE = 100;

/** All four `vendor_requests` statuses since AECI-739. `in_review` was missing
 *  from the query enum until then, so a claim the Linear webhook had moved to a
 *  `started` state (`STATE_TYPE_TO_STATUS`) was invisible in every tab while still
 *  existing — and, now, still being addressable at `/admin/claims/:id`. */
type StatusFilter = 'open' | 'in_review' | 'resolved' | 'rejected';
type FormMode = 'approve' | 'reject';

/**
 * AECI-521 / `STAGE_2_VENDOR_PORTAL_SPEC.md` §5 — the admin claim-review queue,
 * rendered in the `AdminShell` layout's outlet at `/admin/claims`. A sibling of
 * `/admin/requests` (AECI-217): it clones that queue's SSR-shell + client-fetch
 * shape but is CLAIMS-only and assembles the reviewer-assist verification signals
 * a human weighs before activating vendor access — **no auto-grant**
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
 * Approve triggers the AECI-519 grant (`PATCH …/:id {action:'approve'}`). Since
 * AECI-1367 every approval lands on Free, so the form asks for nothing: AECI-1215's
 * plan radios and the Managed arrangement note are gone, and "Confirm grant" is
 * enabled at once. Reject runs the reject path. A successful action drops the row. **Approve returns 503
 * wherever `SUPABASE_SERVICE_ROLE_KEY` is absent — local dev, since
 * AECI-530 CI-pushes it on staging/demo/production** — surfaced as an inline
 * "grant unavailable" message (reject still works). A 409 is
 * an identity conflict (already an admin / claims another vendor).
 *
 * **AECI-922 gave this queue a nav badge** — `pending_claims`, open claims only —
 * so a successful approve or reject decrements `AdminSummaryStore` and the count
 * ticks down without a round-trip, exactly as the reviews queue has always done.
 * That number is one of the three the Operations category sums, which is why
 * `/admin/requests` is corrections-only now: counting claims in both places would
 * double them in the total.
 *
 * AECI-532 (`STAGE_2_PAID_TIERS_SPEC.md` §5) added an ENTITLEMENT column plus an
 * inline set/renew/clear control here. AECI-652 §5.6 moved the control to
 * `/admin/vendors/:id`, and AECI-1375 retired it and the entitlement readout:
 * licenses are the plan now. What is left is the target vendor's name and a
 * "Manage billing" link to its Billing tab.
 *
 * The link points at `entitlement_vendor`, the row's RESOLVED target vendor,
 * because a product claim's licenses belong to that product's primary vendor. It
 * stays visible on RESOLVED and REJECTED rows too, since managing the licenses
 * of a vendor granted months ago is the ordinary case.
 *
 * AECI-739 added three things to the queue. They were built for the PARKED
 * connector claim, which AECI-1367 retired: a pure-connector vendor is approved
 * like anyone else, and its row shows a neutral "Connector vendor: contact them
 * directly" flag instead of a parking banner. The three stay useful:
 *  - the **operator note** renders on the card. It lives on the detail page, but
 *    the queue is where the operator actually looks, so the note has to be
 *    legible without opening anything;
 *  - each card links to **`/admin/claims/:id`**, where the note is written and the
 *    duplicate chip is explained;
 *  - the status filter gained **In review**, which the API could not express at all
 *    until AECI-739 widened its enum — so no status is reachable by id but
 *    unfindable in the queue.
 */
@Component({
  selector: 'aec-claim-queue',
  imports: [ClaimAccountConflict, DatePipe, DomainMatchSignal, NewTabIcon, RouterLink],
  templateUrl: './claim-queue.html',
})
export class ClaimQueue {
  private readonly api = inject(AdminClaimsApi);
  private readonly summaryStore = inject(AdminSummaryStore);

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
  /** The reject form's free text: an INTERNAL decision note (recorded in the audit
   *  log, never emailed — the claimant email is neutral, §9). The approve form has
   *  no field since AECI-1367. */
  protected readonly formText = signal('');
  /** Id + message of the claim whose last action failed (inline alert). */
  protected readonly failedActionId = signal<string | null>(null);
  protected readonly failedActionMessage = signal('');
  /** Polite live-region message — the row vanishes on success, so announce it. */
  protected readonly liveMessage = signal('');

  protected readonly statusFilter = signal<StatusFilter>('open');

  protected readonly statusOptions: ReadonlyArray<{ key: StatusFilter; label: string }> = [
    { key: 'open', label: $localize`:@@admin.claims.filter.status.open:Open` },
    { key: 'in_review', label: $localize`:@@admin.claims.filter.status.inReview:In review` },
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

  /** AECI-1420: the claimant's address is a site admin or holds a seat on another
   *  vendor. The red box shows and Grant is disabled; Reject stays enabled. The
   *  server's `409 GRANT_CONFLICT` stays as the backstop for a stale page. */
  protected hasConflict(claim: AdminClaim): boolean {
    return claimantSeatConflict(claim) !== null;
  }

  /** The conflict box's id, which the disabled Grant names in `aria-describedby`. */
  protected conflictBoxId(claimId: string): string {
    return `claim-account-conflict-${claimId}`;
  }

  /** Only open / in-review rows can be moderated; terminal rows are read-only. */
  protected isActionable(status: AdminClaim['status']): boolean {
    return status === 'open' || status === 'in_review';
  }

  /** Relative age (e.g. "3 d", "5 h", "12 min"). Browser-only — the list is empty
   *  during SSR, so `Date.now()` is never read server-side. */
  /** When a routed claim comes back to AECi (AECI-1368): the shared 7-day rule. */
  protected ownerDeadline(routedToOwnersAt: string): string {
    return claimOwnerReviewDeadline(routedToOwnersAt);
  }

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

  /** The AECI-527 "Claimant account" reviewer signal, worded for the claim's
   *  status (AECI-1278). Shared with `/admin/claims/:id`. `null` (unknown) is
   *  common: absent Supabase creds or a failed lookup, never a decision gate. */
  protected readonly accountLabel = claimantAccountLabel;

  /** The §5.2 payer test as one readable line — shared with `/admin/vendors/:id`
   *  so the two screens cannot describe the same vendor differently. */
  protected readonly roleBreakdownLabel = productRolesLabel;

  /** The §5.2 step 1a owner signal (AECI-1041), through the label shared with
   *  `/admin/claims/:id` and `/admin/vendors/:id`. */
  protected readonly ownedLabel = ownedIntegrationsLabel;

  /** Display name, else email (AECI-1277) — the rule shared with the roster. */
  protected readonly seatLabel = seatLabel;
  /** AECI-1063: the "Found us via" channel label, shared with the form. */
  protected readonly foundViaLabel = foundViaLabel;

  /** The owners' review window, in days, for the "did not decide" line (AECI-1368).
   *  Read from the shared constant so the copy cannot drift from the fallback cron. */
  protected readonly reviewDays = CLAIM_OWNER_REVIEW_DAYS;

  /**
   * A pre-built LinkedIn people-search URL from the claimant's name (falling back
   * to their email). A LINK only — the reviewer opens it deliberately; no claimant
   * data is sent anywhere by rendering it (§8.3(4) working decision). Real
   * person-lookup/enrichment providers are a deferred DPA/GDPR decision (§11).
   *
   * Since AECI-847 this is the FALLBACK, shown only when the claimant supplied no
   * profile of their own (`submitter_linkedin_url`). A name search returns many
   * people and confirms nobody; the supplied profile names one. Rendering both
   * would invite the reviewer to treat the guess as corroboration of the claim.
   */
  protected linkedInSearchUrl(r: AdminClaim): string {
    const keywords = r.submitter_name?.trim() ? r.submitter_name.trim() : r.submitter_email;
    return `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(keywords)}`;
  }

  // ── Moderation actions ─────────────────────────────────────────────────────

  /** Open the inline approve confirmation for a row. */
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

  /** Every approval lands on Free (AECI-1367), so the body names no plan. */
  protected async confirmApprove(id: string): Promise<void> {
    await this.moderate(
      id,
      { action: 'approve' },
      $localize`:@@admin.claims.announce.approvedFree:Claim approved on the Free plan: vendor access was activated.`,
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
   *  `open` view), decrement the nav badge and announce. Error handling is
   *  claim-specific (see below) — note the 422 branch drops the row WITHOUT
   *  decrementing, since the admin who raced us already did. */
  private async moderate(
    id: string,
    input: ModerateClaimInput,
    announcement: string,
  ): Promise<void> {
    if (this.pendingActionId()) return;
    // Read the status BEFORE the row is dropped. `pending_claims` counts `open`
    // claims only, and the In review tab moderates rows that were never in it —
    // decrementing there would walk the badge below the real backlog with nothing
    // to resync it until the next full visit to /admin.
    const wasOpen = this.claims().find((c) => c.id === id)?.status === 'open';
    this.failedActionId.set(null);
    this.pendingActionId.set(id);
    try {
      await this.api.moderate(id, input);
      this.closeForm();
      this.removeRow(id);
      if (wasOpen) this.summaryStore.decrement('claims');
      this.liveMessage.set(announcement);
    } catch (err) {
      this.handleModerateError(id, err);
    } finally {
      this.pendingActionId.set(null);
    }
  }

  /**
   * A 422 means another admin moderated it first (or it's terminal) — drop the row.
   * So does a 409 `CLAIM_ALREADY_DECIDED` (AECI-1368: an owner or another decider won
   * the race between load and commit).
   * A 409 is an identity conflict (the claimant is already an admin, or claims a
   * different vendor); a 503 is the AECI-530 state (identity resolution isn't
   * configured — reject still works). Both keep the row + form so the reviewer can
   * react. Anything else is a generic retryable failure.
   */
  private handleModerateError(id: string, err: unknown): void {
    if (err instanceof HttpErrorResponse) {
      // A 409 CLAIM_ALREADY_DECIDED is the same outcome reached by a race: a company
      // owner, another admin or the fallback cron decided it between load and commit.
      if (err.status === 422 || errorCode(err) === 'CLAIM_ALREADY_DECIDED') {
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
}

/** The API error envelope's `error.code`, or null. */
function errorCode(err: HttpErrorResponse): string | null {
  return (err.error as { error?: { code?: string } } | null)?.error?.code ?? null;
}
