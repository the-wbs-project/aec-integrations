import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { Component, afterNextRender, computed, inject, input, signal } from '@angular/core';

import {
  claimOwnerReviewDeadline,
  type ManageableSeatInvite,
  type PendingSeatClaim,
  type VendorSeat,
} from '@aeci/shared';

import { AecButton } from '../../shared/button/button';
import { AecCard } from '../../shared/card/card';
import { Chip } from '../../shared/chip/chip';
import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorApi } from '../vendor-api';
import { VendorPortalStore } from '../vendor-portal-store';

/**
 * The seat roster for the vendor dashboard (AECI-522). Multi-seat is flat at
 * launch (`STAGE_2_VENDOR_PORTAL_SPEC.md` §6 / `STAGE_2_SPEC.md` §8.1(2)): data
 * capabilities are identical across seats, and the only owner/member split is
 * seat management itself (§11a.4).
 *
 * ── WHAT LIVES HERE, AND WHAT DOESN'T ───────────────────────────────────────
 * This renders the roster, the pending-invite list, and the three actions an
 * owner has over them: remove a seat, revoke an invite, and re-send one
 * (AECI-927). **Creating** an invite does not live here — it is
 * {@link VendorSeatInviteDialog}, triggered from the section heading, so the list
 * people come here to read isn't sitting under a permanent form. Both surfaces
 * gate on the same `canManageSeats` flag.
 *
 * Re-send belongs here and not in the dialog for the same reason: it acts on a
 * row that is already on screen, and the thing the owner needs in order to decide
 * — when it last went out — is the line right beside the button.
 *
 * The roster is a **separate** browser read (`GET /api/vendor/seats`) from the
 * dashboard payload because it needs the Supabase email lookup and the first
 * paint shouldn't wait on it. `email` degrades to `null` in local
 * environments (no service-role key), rendered as "email unavailable" — never an
 * error. A banned seat still appears (per-seat ban never touches the vendor's
 * verified state, §7) so co-admins can see why a colleague is locked out.
 *
 * ── STATE (AECI-628) ────────────────────────────────────────────────────────
 * The list, its load state and its retry all live in {@link VendorPortalStore}
 * now; this component only renders them. It used to hold them itself, which
 * meant the seats vanished and re-fetched every time the tab was switched away
 * and back (the `@switch` destroys the component), and meant a revalidation loop
 * had no way to reach them. `ensure()` is load-once, so re-entering the tab is
 * free and the poll (AECI-629) refreshes what is already on screen.
 *
 * Browser-only: `ensure()` is called from `afterNextRender`, so SSR paints the
 * loading state and no visitor data is ever baked into cached HTML.
 */
@Component({
  selector: 'aec-vendor-seat-roster',
  imports: [AecButton, AecCard, Chip, DatePipe],
  template: `
    @if (canManage()) {
      <p
        class="max-w-[30rem] text-sm leading-relaxed text-(--text-secondary)"
        i18n="@@vendor.seats.intro.owner"
      >
        Everyone with access to this vendor. You can invite anyone who helps maintain this listing,
        and remove access when someone leaves.
      </p>
    } @else {
      <p
        class="max-w-[30rem] text-sm leading-relaxed text-(--text-secondary)"
        i18n="@@vendor.seats.intro.member"
      >
        Everyone with access to this vendor. Ask an account owner (listed below) to add or remove a
        colleague.
      </p>
    }

    @if (canManage() && claims().length > 0) {
      <!-- AECI-1812: the claims that need an owner sit on the shared white card, rows
           divided by hairlines, like the Overview's "What needs you" list. -->
      <section aecCard [class]="'mt-6 p-6'" aria-labelledby="vendor-seats-claims-heading">
        <h3 id="vendor-seats-claims-heading" i18n="@@vendor.seats.claims.heading">Wants to join</h3>
        <p
          class="mt-2 max-w-[30rem] text-sm leading-relaxed text-(--text-secondary)"
          i18n="@@vendor.seats.claims.intro"
        >
          These people asked AEC Integrations to let them manage this company. Accept sends them a
          seat invite at the work email they gave. Their seat is not an owner seat. Decline tells
          them the claim was not approved. If no owner decides in time, AEC Integrations reviews it.
        </p>
        <ul class="mt-4 divide-y divide-(--border-default) border-t border-(--border-default)">
          @for (claim of claims(); track claim.id) {
            <li class="flex flex-wrap items-start justify-between gap-4 py-4 last:pb-0">
              <div class="min-w-0 space-y-1">
                <p class="text-sm font-semibold break-words text-(--text-primary)">
                  {{ claim.submitter_name || claim.submitter_email }}
                  @if (claim.submitter_title || claim.submitter_role; as title) {
                    <span class="font-normal text-(--text-secondary)">· {{ title }}</span>
                  }
                </p>
                <p class="text-sm break-words text-(--text-secondary)">
                  <span i18n="@@vendor.seats.claims.email">Work email:</span>
                  {{ claim.submitter_email }}
                </p>
                @if (claim.submitter_linkedin_url; as linkedin) {
                  <p class="text-sm">
                    <a
                      [href]="linkedin"
                      target="_blank"
                      rel="noopener nofollow"
                      class="rounded-mark text-(--accent-primary) underline underline-offset-2 focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--accent-primary)"
                      i18n="@@vendor.seats.claims.linkedin"
                      >LinkedIn profile</a
                    >
                  </p>
                }
                @if (claim.context_product_name; as product) {
                  <p class="text-t-13 text-(--text-secondary)">
                    <span i18n="@@vendor.seats.claims.cameFrom">Sent from the page for</span>
                    {{ product }}
                  </p>
                }
                @if (claim.comments) {
                  <p class="text-sm break-words whitespace-pre-line text-(--text-primary)">
                    {{ claim.comments }}
                  </p>
                }
                <p class="text-t-13 text-(--text-secondary)">
                  <ng-container i18n="@@vendor.seats.claims.asked">Asked</ng-container>
                  {{ claim.created_at | date: 'mediumDate' }}
                  <ng-container i18n="@@vendor.seats.claims.decideBy">· decide by</ng-container>
                  {{ decideBy(claim) | date: 'mediumDate' }}
                </p>
              </div>
              <div class="flex shrink-0 flex-wrap items-center gap-2">
                <button
                  aecButton
                  variant="secondary"
                  compact
                  type="button"
                  [disabled]="busyClaim() !== null"
                  (click)="acceptClaim(claim)"
                >
                  @if (isClaimBusy(claim, 'accept')) {
                    <span i18n="@@vendor.seats.claims.accepting">Accepting…</span>
                  } @else {
                    <span i18n="@@vendor.seats.claims.accept">Accept</span>
                  }
                  <span class="sr-only"
                    >&ngsp;{{ claim.submitter_name || claim.submitter_email }}</span
                  >
                </button>
                <button
                  aecButton
                  variant="secondary"
                  compact
                  type="button"
                  [disabled]="busyClaim() !== null"
                  (click)="declineClaim(claim)"
                >
                  @if (isClaimBusy(claim, 'decline')) {
                    <span i18n="@@vendor.seats.claims.declining">Declining…</span>
                  } @else {
                    <span i18n="@@vendor.seats.claims.decline">Decline</span>
                  }
                  <span class="sr-only"
                    >&ngsp;{{ claim.submitter_name || claim.submitter_email }}</span
                  >
                </button>
              </div>
            </li>
          }
        </ul>
      </section>
    }

    @if (loading()) {
      <p class="mt-6 text-sm text-(--text-secondary)" i18n="@@vendor.seats.loading">
        Loading seats…
      </p>
    } @else if (failed()) {
      <div class="mt-6 flex flex-wrap items-center gap-4">
        <p class="text-sm text-(--text-primary)" i18n="@@vendor.seats.error">
          Could not load the seat list.
        </p>
        <button
          aecButton
          variant="secondary"
          compact
          type="button"
          (click)="reload()"
          i18n="@@vendor.seats.retry"
        >
          Try again
        </button>
      </div>
    } @else if (seats().length === 0) {
      <p class="mt-6 text-sm text-(--text-secondary)" i18n="@@vendor.seats.empty">
        No seats to show.
      </p>
    } @else {
      <!-- The region is positioned, so the visually hidden names inside the row
           buttons (absolute boxes) stay inside it. Unpositioned, they escaped the
           scroller and pushed the whole page sideways at 390px (AECI-1812). -->
      <div
        class="relative mt-6 min-w-0 overflow-x-auto focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--accent-primary)"
        role="region"
        tabindex="0"
        aria-labelledby="vendor-seats-caption"
        data-seats-region
      >
        <table class="w-full min-w-[32rem] border-collapse text-start text-sm">
          <caption id="vendor-seats-caption" class="sr-only" i18n="@@vendor.seats.caption">
            Vendor seats
          </caption>
          <thead>
            <tr>
              <th scope="col" [class]="headClass" i18n="@@vendor.seats.col.name">Name</th>
              <th scope="col" [class]="headClass" i18n="@@vendor.seats.col.email">Email</th>
              <th scope="col" [class]="headClass" i18n="@@vendor.seats.col.status">Status</th>
              <th scope="col" [class]="headClass" i18n="@@vendor.seats.col.added">Added</th>
              @if (canManage()) {
                <th scope="col" [class]="headClass">
                  <span class="sr-only" i18n="@@vendor.seats.col.actions">Actions</span>
                </th>
              }
            </tr>
          </thead>
          <tbody>
            @for (seat of seats(); track seat.user_id) {
              <tr>
                <td [class]="cellClass + ' text-(--text-primary)'">
                  <span class="font-semibold">{{ seat.display_name || fallbackName }}</span>
                  @if (seat.is_self) {
                    <span class="ms-1 text-(--text-secondary)" i18n="@@vendor.seats.you"
                      >(you)</span
                    >
                  }
                  @if (seat.owner) {
                    <aec-chip
                      class="ms-2 align-middle"
                      density="dense"
                      i18n="@@vendor.seats.ownerLabel"
                      >Owner</aec-chip
                    >
                  }
                </td>
                <td [class]="cellClass + ' break-words text-(--text-secondary)'">
                  {{ seat.email || emailUnavailable }}
                </td>
                <td [class]="cellClass">
                  <aec-chip density="dense" [tone]="seat.banned ? 'strong' : 'forest'">
                    @if (seat.banned) {
                      <span i18n="@@vendor.seats.status.banned">Banned</span>
                    } @else {
                      <span i18n="@@vendor.seats.status.active">Active</span>
                    }
                  </aec-chip>
                </td>
                <td [class]="cellClass + ' whitespace-nowrap text-(--text-secondary)'">
                  {{ seat.created_at | date: 'mediumDate' }}
                </td>
                @if (canManage()) {
                  <td [class]="actCellClass">
                    @if (!seat.is_self) {
                      <button
                        aecButton
                        variant="secondary"
                        compact
                        type="button"
                        [disabled]="busySeat() === seat.user_id"
                        (click)="remove(seat)"
                      >
                        <span i18n="@@vendor.seats.remove">Remove</span>
                        <span class="sr-only"
                          >&ngsp;{{ seat.display_name || seat.email || fallbackName }}</span
                        >
                      </button>
                    }
                  </td>
                }
              </tr>
            }
          </tbody>
        </table>
      </div>
    }

    @if (invites().length > 0) {
      <section class="mt-8">
        <h3 i18n="@@vendor.seats.pending.heading">Pending invites</h3>
        <ul class="mt-4 divide-y divide-(--border-default) border-y border-(--border-default)">
          @for (invite of invites(); track invite.id) {
            <li class="flex flex-wrap items-center justify-between gap-4 py-4">
              <div class="min-w-0">
                <p class="text-sm font-semibold break-words text-(--text-primary)">
                  {{ invite.email }}
                </p>
                <p class="mt-1 text-t-13 text-(--text-secondary)">
                  <ng-container i18n="@@vendor.seats.pending.sent">Sent</ng-container>
                  {{ invite.last_sent_at || invite.created_at | date: 'mediumDate' }}
                  <ng-container i18n="@@vendor.seats.pending.expires">· expires</ng-container>
                  {{ invite.expires_at | date: 'mediumDate' }}
                  @if (invite.invited_by; as by) {
                    <ng-container i18n="@@vendor.seats.pending.by">· invited by</ng-container>
                    {{ by }}
                  }
                </p>
              </div>
              @if (canManage()) {
                <div class="flex shrink-0 flex-wrap items-center gap-2">
                  <!-- Disabled states carry their reason in the accessible name,
                       not just in the visual state: a cooldown clears itself in
                       minutes, a spent invite never does, and the two need
                       opposite next steps. -->
                  <button
                    aecButton
                    variant="secondary"
                    compact
                    type="button"
                    [disabled]="busyInvite() !== null || invite.resend_state !== 'ok'"
                    (click)="resend(invite)"
                    [attr.title]="resendHint(invite)"
                  >
                    @if (isBusy(invite, 'resend')) {
                      <span i18n="@@vendor.seats.pending.resending">Sending…</span>
                    } @else {
                      <span i18n="@@vendor.seats.pending.resend">Resend</span>
                    }
                    <span class="sr-only"
                      >&ngsp;{{ invite.email }}{{ resendHintSuffix(invite) }}</span
                    >
                  </button>
                  <button
                    aecButton
                    variant="secondary"
                    compact
                    type="button"
                    [disabled]="busyInvite()?.id === invite.id"
                    (click)="revoke(invite)"
                  >
                    <span i18n="@@vendor.seats.pending.revoke">Revoke</span>
                    <span class="sr-only">&ngsp;{{ invite.email }}</span>
                  </button>
                </div>
              }
            </li>
          }
        </ul>
      </section>
    }

    @if (actionError(); as message) {
      <p class="mt-4 text-sm font-semibold text-(--text-primary)" role="alert">{{ message }}</p>
    }
    @if (actionStatus(); as message) {
      <!-- Plain text. The same sentence goes to the portal's one live region
           (VendorPortalAnnouncer), so it is announced once (AECI-1812). -->
      <p class="mt-4 text-sm text-(--text-secondary)" data-seats-status>{{ message }}</p>
    }
  `,
  styles: [':host { display: block; }'],
})
export class VendorSeatRoster {
  private readonly store = inject(VendorPortalStore);
  private readonly announcer = inject(VendorPortalAnnouncer);

  /** The seat count from the dashboard payload — shown by the parent as a
   *  header; the detailed roster loads separately. Optional so the component is
   *  usable standalone. */
  readonly seatCount = input<number | null>(null);

  private readonly api = inject(VendorApi);

  protected readonly seats = this.store.seats;
  protected readonly invites = this.store.seatInvites;
  /** The SERVER's verdict on `profiles.seat_owner` for this caller — never
   *  re-derived from the roster. Hiding a control the API would 403 and showing
   *  one it would accept have to come from the same source. */
  protected readonly canManage = this.store.canManageSeats;
  /** Claims routed to this company's owners (AECI-1368). Owner seats only: the
   *  server sends a member `[]`, and the template also gates on `canManage`. */
  protected readonly claims = this.store.pendingSeatClaims;
  /** The claim decision in flight, if any. One at a time over the whole list. */
  protected readonly busyClaim = signal<{ id: string; action: 'accept' | 'decline' } | null>(null);
  protected readonly busySeat = signal<string | null>(null);
  /** The invite action in flight, if any — the id AND which action, not the id
   *  alone. Both actions are mutually exclusive over the whole list, so the id by
   *  itself cannot say what is happening to that row: a revoke would put the
   *  neighbouring Resend button into its "Sending…" state, including on a row
   *  whose `resend_state` makes a send impossible. */
  protected readonly busyInvite = signal<{ id: string; action: 'resend' | 'revoke' } | null>(null);
  protected readonly actionError = signal<string | null>(null);
  /** The success half of {@link actionError}: a plain line under the list, so a
   *  re-send that produces no visible list change still shows. The same sentence
   *  is announced through {@link VendorPortalAnnouncer} (AECI-1812), the portal's
   *  one live region. Kept separate from the error signal, which stays
   *  `role="alert"`. */
  protected readonly actionStatus = signal<string | null>(null);
  protected readonly loading = this.store.seatsLoading;
  protected readonly failed = this.store.seatsFailed;

  /** True once the fetch settled with at least one seat — lets the parent hide a
   *  redundant count while the table is visible. */
  readonly loaded = computed(() => !this.loading() && !this.failed());

  protected readonly fallbackName = $localize`:@@vendor.seats.name.fallback:Unnamed admin`;
  protected readonly emailUnavailable = $localize`:@@vendor.seats.email.unavailable:Email unavailable`;

  /** A header cell: the Label role, a hairline above and a strong rule below
   *  (the console table's header, without borrowing the admin recipe). */
  protected readonly headClass =
    'whitespace-nowrap border-t border-b border-t-(--border-default) border-b-(--border-strong) py-2 pe-4 text-start align-bottom text-t-13 font-semibold tracking-[0.01em] text-(--text-secondary) last:pe-0';
  /** A body cell, on a hairline. */
  protected readonly cellClass = 'border-b border-(--border-default) py-3 pe-4 align-middle';
  /** The last cell, holding the row's one 44px action. */
  protected readonly actCellClass =
    'border-b border-(--border-default) py-2 text-end align-middle whitespace-nowrap';

  constructor() {
    // Browser-only: the seat read (with its Supabase email lookup) runs after
    // hydration, so cached SSR HTML never carries visitor data.
    afterNextRender(() => void this.store.ensure('seats'));
  }

  /** The retry beside the failure state. `reload` rather than `ensure` because
   *  the store has already recorded an attempt. */
  protected reload(): void {
    void this.store.reload('seats');
  }

  /**
   * Remove a colleague's access. Pessimistic and re-read from the server rather
   * than spliced locally: this is a destructive, security-relevant action, and a
   * row that vanished optimistically and then came back would leave an owner
   * unsure whether the person still has access. `STAGE_2_REALTIME_SPEC.md` keeps
   * optimism for toggles only.
   *
   * No `confirm()` — a browser modal blocks the whole page and the action is
   * reversible by re-inviting. The button names the person in its accessible
   * label so it can't be hit blind.
   */
  protected async remove(seat: VendorSeat): Promise<void> {
    if (this.busySeat()) return;
    this.busySeat.set(seat.user_id);
    this.actionError.set(null);
    this.actionStatus.set(null);
    try {
      await this.api.removeSeat(seat.user_id);
      await this.store.reload('seats');
    } catch {
      this.actionError.set(
        $localize`:@@vendor.seats.remove.error:Could not remove that seat. Try again.`,
      );
    } finally {
      this.busySeat.set(null);
    }
  }

  /** Revoke a pending invite before it is redeemed. */
  protected async revoke(invite: ManageableSeatInvite): Promise<void> {
    if (this.busyInvite()) return;
    this.busyInvite.set({ id: invite.id, action: 'revoke' });
    this.actionError.set(null);
    this.actionStatus.set(null);
    try {
      await this.api.revokeInvite(invite.id);
      await this.store.reload('seats');
    } catch {
      this.actionError.set(
        $localize`:@@vendor.seats.revoke.error:Could not revoke that invite. Try again.`,
      );
    } finally {
      this.busyInvite.set(null);
    }
  }

  /**
   * Mail a pending invite again (AECI-927). Same link, refreshed expiry.
   *
   * Pessimistic and re-read, like every other write on this surface: the visible
   * change is a "Sent" date and a now-disabled button, and guessing either
   * locally would mean re-implementing the cooldown the server just applied.
   *
   * The confirmation is a status line (announced once) rather than the list itself,
   * because a successful re-send moves no row — without it the only feedback
   * would be a button going quiet, which reads like a failure.
   */
  protected async resend(invite: ManageableSeatInvite): Promise<void> {
    if (this.busyInvite() || invite.resend_state !== 'ok') return;
    this.busyInvite.set({ id: invite.id, action: 'resend' });
    this.actionError.set(null);
    this.actionStatus.set(null);
    try {
      await this.api.resendInvite(invite.id);
      this.settle(
        $localize`:@@vendor.seats.resend.sent:Invite sent again to ${invite.email}:email:.`,
      );
      // The server's row, not a local splice: it holds the new expiry and the
      // cooldown verdict that disables the button.
      await this.store.reload('seats');
    } catch (err) {
      this.actionError.set(resendErrorFor(err));
    } finally {
      this.busyInvite.set(null);
    }
  }

  /**
   * Accept a claim routed to this company (AECI-1368): the server issues a seat invite
   * to the claimant's work email and resolves the claim. Pessimistic and re-read like
   * every write here: the row moves from "Wants to join" to the pending invites, and
   * the server's list is what says so.
   */
  protected async acceptClaim(claim: PendingSeatClaim): Promise<void> {
    if (this.busyClaim()) return;
    this.busyClaim.set({ id: claim.id, action: 'accept' });
    this.actionError.set(null);
    this.actionStatus.set(null);
    try {
      const { invite, invite_sent } = await this.api.acceptSeatClaim(claim.id);
      // `invite_sent: false` means the claimant already held a pending invite, so the
      // server reused it and mailed nothing. Saying "was sent" there would be false.
      this.settle(
        invite_sent
          ? $localize`:@@vendor.seats.claims.accepted:Accepted. A seat invite was sent to ${invite.email}:email:.`
          : $localize`:@@vendor.seats.claims.acceptedExistingInvite:Accepted. ${invite.email}:email: already has a seat invite, so no new email was sent.`,
      );
      await this.store.reload('seats');
    } catch (err) {
      this.actionError.set(claimErrorFor(err, 'accept'));
      // A lost race (or the Accept guard's system reject, AECI-1420) is not a failure
      // to retry: re-read so the row leaves "Wants to join", as the contests list does.
      if (claimIsGone(err)) await this.store.reload('seats');
    } finally {
      this.busyClaim.set(null);
    }
  }

  /** Decline a claim routed to this company (AECI-1368). The claimant gets the
   *  neutral "not approved" email, which does not say who declined. */
  protected async declineClaim(claim: PendingSeatClaim): Promise<void> {
    if (this.busyClaim()) return;
    this.busyClaim.set({ id: claim.id, action: 'decline' });
    this.actionError.set(null);
    this.actionStatus.set(null);
    try {
      await this.api.declineSeatClaim(claim.id);
      const who = claim.submitter_name || claim.submitter_email;
      this.settle(
        $localize`:@@vendor.seats.claims.declined:Declined the request from ${who}:name:.`,
      );
      await this.store.reload('seats');
    } catch (err) {
      this.actionError.set(claimErrorFor(err, 'decline'));
      // A lost race (or the Accept guard's system reject, AECI-1420) is not a failure
      // to retry: re-read so the row leaves "Wants to join", as the contests list does.
      if (claimIsGone(err)) await this.store.reload('seats');
    } finally {
      this.busyClaim.set(null);
    }
  }

  /** A write succeeded: show the sentence as plain text under the list and say it
   *  once through the portal's one live region (STAGE_2_REALTIME_SPEC.md §6.3). */
  private settle(message: string): void {
    this.actionStatus.set(message);
    this.announcer.announce(message);
  }

  protected isClaimBusy(claim: PendingSeatClaim, action: 'accept' | 'decline'): boolean {
    const busy = this.busyClaim();
    return busy?.id === claim.id && busy.action === action;
  }

  /** When AEC Integrations takes the claim over: the shared 7-day rule. */
  protected decideBy(claim: PendingSeatClaim): string {
    return claimOwnerReviewDeadline(claim.routed_to_owners_at);
  }

  /** Is THIS action in flight on THIS invite? The action matters: a revoke and a
   *  re-send both hold the row, and only one of them is a send. */
  protected isBusy(invite: ManageableSeatInvite, action: 'resend' | 'revoke'): boolean {
    const busy = this.busyInvite();
    return busy?.id === invite.id && busy.action === action;
  }

  /** Why the Resend control is disabled, or `null` when it is not. Rendered as
   *  `title` and appended to the accessible name — a disabled button whose reason
   *  is invisible is a dead end, and the two reasons need opposite next steps. */
  protected resendHint(invite: ManageableSeatInvite): string | null {
    switch (invite.resend_state) {
      case 'cooling_down':
        return $localize`:@@vendor.seats.resend.hint.cooling:This invite was sent recently. You can send it again in a few minutes.`;
      case 'send_limit':
        return $localize`:@@vendor.seats.resend.hint.limit:This invite has been sent the maximum number of times. Revoke it and invite them again.`;
      default:
        return null;
    }
  }

  /** The hint as a screen-reader suffix, so the disabled button's accessible name
   *  carries the reason. Empty when the control is available. */
  protected resendHintSuffix(invite: ManageableSeatInvite): string {
    const hint = this.resendHint(invite);
    return hint ? `. ${hint}` : '';
  }
}

function claimErrorCode(err: unknown): string | null {
  return err instanceof HttpErrorResponse
    ? ((err.error as { error?: { code?: string } } | null)?.error?.code ?? null)
    : null;
}

/** The claim is no longer this owner's to decide: someone decided it, the 7-day
 *  fallback took it back, or the Accept guard rejected it (AECI-1420). */
function claimIsGone(err: unknown): boolean {
  const code = claimErrorCode(err);
  return code === 'NOT_FOUND' || code === 'CLAIM_ALREADY_DECIDED';
}

/** Map an accept or decline refusal onto copy that says what to do next
 *  (AECI-1368). An accept spends one of the day's invites, so it can hit the cap. */
function claimErrorFor(err: unknown, action: 'accept' | 'decline'): string {
  switch (claimErrorCode(err)) {
    case 'RATE_LIMITED':
      return $localize`:@@vendor.seats.claims.error.rate:You have sent the most invites allowed today. Try again tomorrow.`;
    case 'FORBIDDEN':
      return $localize`:@@vendor.seats.claims.error.forbidden:Only an account owner can decide who joins.`;
    case 'NOT_FOUND':
    case 'CLAIM_ALREADY_DECIDED':
      return $localize`:@@vendor.seats.claims.error.gone:That request was already decided. The list now shows where it stands.`;
    default:
      return action === 'accept'
        ? $localize`:@@vendor.seats.claims.error.accept:Could not accept that request. Try again.`
        : $localize`:@@vendor.seats.claims.error.decline:Could not decline that request. Try again.`;
  }
}

/** Map the re-send refusals onto copy that says what to do next — the same
 *  discipline as `vendor-seat-invite-form.ts`. The two 4xx here are genuinely
 *  different advice: a cooldown resolves by waiting, a spent invite never does. */
function resendErrorFor(err: unknown): string {
  const code =
    err instanceof HttpErrorResponse
      ? ((err.error as { error?: { code?: string } } | null)?.error?.code ?? null)
      : null;
  switch (code) {
    case 'RATE_LIMITED':
      return $localize`:@@vendor.seats.resend.error.rate:That invite was just sent. Give it a few minutes.`;
    case 'INVALID_STATE_TRANSITION':
      return $localize`:@@vendor.seats.resend.error.limit:That invite has been sent the maximum number of times. Revoke it and invite them again.`;
    case 'FORBIDDEN':
      return $localize`:@@vendor.seats.resend.error.forbidden:Only an account owner can manage seats.`;
    case 'NOT_FOUND':
      return $localize`:@@vendor.seats.resend.error.gone:That invite is no longer pending. Refresh the list.`;
    default:
      return $localize`:@@vendor.seats.resend.error.generic:Could not send that invite again. Try again.`;
  }
}
