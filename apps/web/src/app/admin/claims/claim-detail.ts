import { DatePipe } from '@angular/common';
import { Component, LOCALE_ID, afterNextRender, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';

import type { AdminClaimDetail, ClaimDuplicateSibling } from '@aeci/shared';

import { AdminClaimsApi } from './admin-claims-api';
import { entitlementTermLabel } from '../entitlement/entitlement-term';
import { isStatus } from '../http-status';
import { productRolesLabel } from '../product-roles/product-roles-label';

/**
 * AECI-739 / `STAGE_2_VENDOR_PORTAL_SPEC.md` §5.2 — one vendor claim, at
 * `/admin/claims/:id`, rendered in the `AdminShell` layout's outlet.
 *
 * **Why this screen exists.** §5.2 tells an operator that a pure-connector
 * vendor's claim must be neither granted (an unconditional `verified` entitlement
 * plus the badge) nor rejected (a real decline email to exactly the party we want
 * a relationship with) — it is PARKED as `open` and routed to the partnership
 * track out of band. Until this route, the product had nowhere to record that:
 * step 6 sent the conversation to Linear comments "so nobody looks for an
 * in-product home that does not exist", and the console showed a lengthening
 * queue of open claims with no visible reason why any of them was parked.
 *
 * Five sections, all read together — which is why this is a FLAT child of
 * `/admin` with no per-route resolver, exactly like `/admin/vendors/:id` and
 * `/admin/users/:id`: a route per tab would buy nothing but resolvers. The gate is
 * the parent's `adminSummaryResolver`; this page paints its shell during SSR and
 * fetches in `afterNextRender`, so it never reads a cookie or a session directly.
 *
 * 1. **Claim** — submitter, target, status, body, source and Linear links.
 * 2. **Verification signals** — the same evidence the queue card carries,
 *    including the §5.2 payer test through the SHARED `productRolesLabel`, so the
 *    two screens cannot describe one vendor differently.
 * 3. **Operator note** — the write this issue adds. Free text, admin-only, never
 *    emailed, writable at every status.
 * 4. **Duplicate explanation** — §5.2 step 5's trap made legible.
 * 5. **In-review explainer** — shown only at that status.
 *
 * Two boundaries this screen deliberately does NOT cross. **It does not moderate**
 * — Grant and Reject stay on the queue, where the §5.2 pure-connector warning
 * lives beside the buttons that would do the damage; splitting them would mean two
 * copies of that warning. And **it does not manage the entitlement** — that moved
 * to `/admin/vendors/:id` (AECI-652 §5.6) precisely so the §5.2/§5.3/§5.4 copy
 * invariants live in one file; this page links there rather than re-rendering it.
 */
@Component({
  selector: 'aec-claim-detail',
  imports: [DatePipe, RouterLink],
  templateUrl: './claim-detail.html',
})
export class ClaimDetail {
  private readonly api = inject(AdminClaimsApi);
  private readonly route = inject(ActivatedRoute);
  private readonly locale = inject(LOCALE_ID);

  protected readonly claimId = signal(this.route.snapshot.paramMap.get('id') ?? '');
  protected readonly claim = signal<AdminClaimDetail | null>(null);

  protected readonly loading = signal(true);
  protected readonly loadFailed = signal(false);
  /** 404 (unknown id) and 422 (the id is a CORRECTION, which moderates through
   *  `/admin/requests`) are two different wrong turns and get two different
   *  messages — a shared "not found" would send an operator looking for a row
   *  that exists. */
  protected readonly notFound = signal(false);
  protected readonly notAClaim = signal(false);

  /** The textarea's working value — the note as edited, not as stored. */
  protected readonly noteDraft = signal('');
  protected readonly notePending = signal(false);
  protected readonly noteFailed = signal('');

  /** The page's ONE polite live region: a note save changes text already on
   *  screen, so without an announcement it is silent to a screen reader. */
  protected readonly liveMessage = signal('');

  constructor() {
    afterNextRender(() => {
      void this.load();
    });
  }

  private async load(): Promise<void> {
    const id = this.claimId();
    if (!id) {
      this.notFound.set(true);
      this.loading.set(false);
      return;
    }
    this.loadFailed.set(false);
    this.notFound.set(false);
    this.notAClaim.set(false);
    this.loading.set(true);
    try {
      const claim = await this.api.getClaim(id);
      this.claim.set(claim);
      this.noteDraft.set(claim.admin_notes ?? '');
    } catch (err) {
      // Structural, not `instanceof` — the admin bundle is lazily chunked, so an
      // error built in one chunk and caught in another can fail an identity check.
      if (isStatus(err, 404)) this.notFound.set(true);
      else if (isStatus(err, 422)) this.notAClaim.set(true);
      else this.loadFailed.set(true);
      this.claim.set(null);
    } finally {
      this.loading.set(false);
    }
  }

  protected retry(): void {
    void this.load();
  }

  // ── Operator note ──────────────────────────────────────────────────────────

  protected onNoteInput(event: Event): void {
    this.noteDraft.set((event.target as HTMLTextAreaElement).value);
  }

  /** True when the draft differs from what is stored — drives the Save button's
   *  disabled state. A no-op save is a legal 200 server-side, but offering it is
   *  just a way to make an operator wonder whether anything happened. */
  protected noteDirty(): boolean {
    const stored = this.claim()?.admin_notes ?? '';
    return this.noteDraft().trim() !== stored.trim();
  }

  protected revertNote(): void {
    this.noteDraft.set(this.claim()?.admin_notes ?? '');
    this.noteFailed.set('');
  }

  /**
   * Save (or clear) the note. No confirm step, deliberately: a note is text, it is
   * reversible, and every version is preserved in the audit trail — the
   * ask-then-confirm ceremony on `/admin/vendors/:id`'s revoke and
   * `/admin/users/:id`'s ban is there because those are not.
   *
   * Blank saves as `null` (cleared), so "empty the box and save" and "clear" are
   * one action. The response IS the committed state, so the page patches in place
   * rather than refetching.
   */
  protected async saveNote(): Promise<void> {
    const id = this.claimId();
    if (!id || this.notePending()) return;
    const next = this.noteDraft().trim() ? this.noteDraft().trim() : null;

    this.notePending.set(true);
    this.noteFailed.set('');
    try {
      const updated = await this.api.saveNotes(id, next);
      this.claim.set(updated);
      this.noteDraft.set(updated.admin_notes ?? '');
      this.liveMessage.set(
        next === null
          ? $localize`:@@admin.claims.detail.note.announce.cleared:Operator note cleared.`
          : $localize`:@@admin.claims.detail.note.announce.saved:Operator note saved.`,
      );
    } catch (err) {
      this.noteFailed.set(this.noteErrorMessage(err));
    } finally {
      this.notePending.set(false);
    }
  }

  /** 404 means the claim went away underneath us (nothing else on this endpoint
   *  can 404), so say that rather than "try again" — retrying cannot help. */
  private noteErrorMessage(err: unknown): string {
    if (isStatus(err, 404)) {
      return $localize`:@@admin.claims.detail.note.error.gone:This claim no longer exists. Your note was not saved.`;
    }
    return $localize`:@@admin.claims.detail.note.error.generic:We couldn't save the note. Your session may have expired.`;
  }

  // ── Labels ─────────────────────────────────────────────────────────────────

  protected statusLabel(status: AdminClaimDetail['status']): string {
    switch (status) {
      case 'open':
        return $localize`:@@admin.claims.detail.status.open:Open`;
      case 'in_review':
        return $localize`:@@admin.claims.detail.status.inReview:In review`;
      case 'resolved':
        return $localize`:@@admin.claims.detail.status.resolved:Approved`;
      case 'rejected':
        return $localize`:@@admin.claims.detail.status.rejected:Rejected`;
    }
  }

  protected domainMatchLabel(value: string): string {
    switch (value) {
      case 'match':
        return $localize`:@@admin.claims.detail.domain.match:Domain matches`;
      case 'no_match':
        return $localize`:@@admin.claims.detail.domain.noMatch:Domain mismatch`;
      case 'manual_review':
        return $localize`:@@admin.claims.detail.domain.manualReview:Manual review`;
      default:
        return $localize`:@@admin.claims.detail.domain.pending:Domain check pending`;
    }
  }

  protected authAccountLabel(value: boolean | null): string {
    if (value === true) {
      return $localize`:@@admin.claims.detail.auth.exists:Existing account: approve links it`;
    }
    if (value === false) {
      return $localize`:@@admin.claims.detail.auth.none:No account: approve provisions one`;
    }
    return $localize`:@@admin.claims.detail.auth.unknown:Account status unknown`;
  }

  /** The §5.2 payer test as one readable line — the SAME helper `/admin/claims`
   *  and `/admin/vendors/:id` use. */
  protected readonly roleBreakdownLabel = productRolesLabel;

  /** The term readout. A `null` `period_end` is PERPETUAL, never "unknown" —
   *  shared with `/admin/claims` and `<aec-entitlement-control>` so the three
   *  copies cannot drift (AECI-694). */
  protected entitlementTerm(periodEnd: string | null): string {
    return entitlementTermLabel(periodEnd, this.locale);
  }

  protected targetFallbackLabel(type: AdminClaimDetail['target_type']): string {
    return type === 'product'
      ? $localize`:@@admin.claims.detail.target.unknownProduct:Unknown product`
      : $localize`:@@admin.claims.detail.target.unknownVendor:Unknown vendor`;
  }

  protected targetRouterLink(claim: AdminClaimDetail): string[] | null {
    if (!claim.target) return null;
    return claim.target_type === 'product'
      ? ['/products', claim.target.slug]
      : ['/vendors', claim.target.slug];
  }

  protected seatDisplayName(name: string | null): string {
    return name?.trim() ? name : $localize`:@@admin.claims.detail.seat.unnamed:Unnamed seat`;
  }

  /** Which of the queue's two duplicate rules this sibling matched. */
  protected matchReasonLabel(reason: ClaimDuplicateSibling['match_reason']): string {
    return reason === 'target'
      ? $localize`:@@admin.claims.detail.duplicate.reason.target:Same claimed target`
      : $localize`:@@admin.claims.detail.duplicate.reason.submitter:Same submitter and target`;
  }
}
