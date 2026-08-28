import { Component, afterNextRender, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';

import type { AdminUserDetail } from '@aeci/shared';

import { isStatus } from '../http-status';
import { ReviewerBansApi } from '../reviewers/reviewer-bans-api';
import { AdminUsersApi } from './admin-users-api';

/**
 * `/admin/users/:id` — the operator's user page (AECI-692 /
 * `ADMIN_PANEL_SPEC.md` §5.8), rendered in the `AdminShell` layout outlet.
 *
 * Sections in one component, not child routes: an operator reads them together
 * (the seat explains the role; the ban state explains the access), and a route
 * per tab would cost resolvers and a URL nobody bookmarks. Section headings are
 * `h3` — the shell owns the only `h1` and this screen owns the only `h2`.
 *
 * ── THIS IS NOW THE BAN HOME ─────────────────────────────────────────────────
 * Ban and reinstate call `PATCH /api/admin/reviewers/:id` (`ReviewerBansApi`)
 * completely unchanged — the same endpoint the review queue's repeat-offender
 * prompt has always used, and the sole writer of `profiles.banned_at`. Nothing
 * new writes that column; this screen just finally gives the action a subject.
 * Before it existed a ban could only be *initiated* from a queue row that
 * happened to mention the person, and *reversed* on a separate screen.
 *
 * ── WHAT THIS SCREEN DELIBERATELY CANNOT DO ──────────────────────────────────
 * **Revoke a vendor seat.** That stays on `/admin/vendors/:id`, and the seat
 * block links there. It is the exact mirror of the boundary `VendorDetail`
 * asserts in the other direction, and for the same reason: a revoke un-grants one
 * vendor's access, a ban locks the human out everywhere, and putting them
 * side-by-side as peer buttons would invite the wrong one. The vendor roster also
 * shows the blast radius — the other seats, the entitlement — that makes a revoke
 * decision safe, and a person-scoped page structurally cannot.
 *
 * **Edit the role, the trust tier, or anything else.** No writer exists for any
 * of them; granting `admin` is the per-environment SQL runbook in
 * `docs/environments.md` §10.7. Admin-triggered GDPR erasure waits on AECI-531's
 * silent-skip telemetry.
 *
 * **Show what this person browsed.** Impossible by design: AECI-585 dropped
 * `page_views.user_id` / `session_id` / `profile_role` and `ADMIN_PANEL_SPEC.md`
 * §9 item 7 forbids visitor↔account correlation. There is no join column to
 * reconstruct.
 */
@Component({
  selector: 'aec-user-detail',
  imports: [RouterLink],
  templateUrl: './user-detail.html',
})
export class UserDetail {
  private readonly api = inject(AdminUsersApi);
  /** The ban writer's client — reused, not re-implemented. */
  private readonly bans = inject(ReviewerBansApi);
  private readonly route = inject(ActivatedRoute);

  protected readonly userId = signal(this.route.snapshot.paramMap.get('id') ?? '');

  protected readonly user = signal<AdminUserDetail | null>(null);
  protected readonly loading = signal(true);
  protected readonly loadFailed = signal(false);
  protected readonly notFound = signal(false);

  /** The page owns exactly ONE live region, at the top. */
  protected readonly liveMessage = signal('');

  // ── Ban / reinstate ────────────────────────────────────────────────────────

  /** The two-step form is open. Ban needs a reason, so it is the claim-queue
   *  "open a form, then confirm" shape rather than a bare ask→confirm. */
  protected readonly banFormOpen = signal(false);
  protected readonly banReason = signal('');
  protected readonly actionPending = signal(false);
  protected readonly actionFailed = signal('');

  protected readonly isBanned = computed(() => this.user()?.banned_at !== null);

  /** `null` = the seam could not be reached, so nothing on the auth block says
   *  anything about the account. Distinct from an account that has no email. */
  protected readonly authAvailable = computed(() => this.user()?.auth_available !== false);

  constructor() {
    afterNextRender(() => {
      void this.load();
    });
  }

  protected retry(): void {
    void this.load();
  }

  private async load(): Promise<void> {
    const id = this.userId();
    if (!id) {
      this.notFound.set(true);
      this.loading.set(false);
      return;
    }
    this.loading.set(true);
    this.loadFailed.set(false);
    this.notFound.set(false);
    try {
      this.user.set(await this.api.getUser(id));
    } catch (err) {
      // Structural, not `instanceof` — the admin bundle is lazily chunked.
      if (isStatus(err, 404)) this.notFound.set(true);
      else this.loadFailed.set(true);
      this.user.set(null);
    } finally {
      this.loading.set(false);
    }
  }

  protected openBanForm(): void {
    this.actionFailed.set('');
    this.banReason.set('');
    this.banFormOpen.set(true);
  }

  protected closeBanForm(): void {
    this.banFormOpen.set(false);
  }

  protected onReasonInput(event: Event): void {
    this.banReason.set((event.target as HTMLTextAreaElement).value);
  }

  /**
   * Ban. The reason is REQUIRED by the endpoint's cross-field refine, so it is
   * required here too — checked client-side purely so the operator gets the
   * message next to the field rather than as a 400.
   */
  protected async confirmBan(): Promise<void> {
    const id = this.userId();
    const reason = this.banReason().trim();
    if (!id || this.actionPending()) return;
    if (!reason) {
      this.actionFailed.set(
        $localize`:@@admin.users.ban.error.reasonRequired:A reason is required to ban someone. It is recorded in the audit trail.`,
      );
      return;
    }
    await this.runBanAction(
      { action: 'ban', reason },
      $localize`:@@admin.users.ban.announce.banned:Account banned. They are locked out on their next request.`,
    );
  }

  /** Reinstate. No reason, no confirm step — `reviewer-bans.ts` records why:
   *  an unban is easily reversible, so an in-flight disabled state is enough. */
  protected async reinstate(): Promise<void> {
    if (!this.userId() || this.actionPending()) return;
    await this.runBanAction(
      { action: 'unban' },
      $localize`:@@admin.users.ban.announce.reinstated:Account reinstated. Their access is restored.`,
    );
  }

  /**
   * The shared half of both actions.
   *
   * On success the response IS the committed state (`banned_at` / `ban_reason`),
   * so the page patches in place rather than refetching — one fewer round trip,
   * and no window where the screen shows the pre-write state.
   */
  private async runBanAction(
    input: { action: 'ban'; reason: string } | { action: 'unban' },
    announcement: string,
  ): Promise<void> {
    this.actionPending.set(true);
    this.actionFailed.set('');
    try {
      const result = await this.bans.ban(this.userId(), input);
      this.user.update((u) =>
        u ? { ...u, banned_at: result.banned_at, ban_reason: result.ban_reason } : u,
      );
      this.banFormOpen.set(false);
      this.liveMessage.set(announcement);
    } catch (err) {
      this.actionFailed.set(this.banErrorMessage(err, input.action));
    } finally {
      this.actionPending.set(false);
    }
  }

  /**
   * Map the endpoint's refusals onto copy that says what actually happened.
   *
   * **403 covers TWO different refusals** — banning an admin and banning
   * yourself — because the handler throws one status for both and only the
   * message differs. The copy therefore names both rather than guessing; naming
   * the wrong one would be worse than naming neither.
   *
   * **422 is not an error to the operator.** It means the account was already in
   * the state being asked for, which is the outcome they wanted — so the page
   * refetches to show the truth rather than showing a failure.
   */
  private banErrorMessage(err: unknown, action: 'ban' | 'unban'): string {
    if (isStatus(err, 403)) {
      return $localize`:@@admin.users.ban.error.forbidden:You can't ban this account. Admin accounts can't be banned, and you can't ban yourself.`;
    }
    if (isStatus(err, 422)) {
      void this.load();
      return action === 'ban'
        ? $localize`:@@admin.users.ban.error.alreadyBanned:This account was already banned. Showing the current state.`
        : $localize`:@@admin.users.ban.error.alreadyActive:This account was not banned. Showing the current state.`;
    }
    if (isStatus(err, 404)) {
      return $localize`:@@admin.users.ban.error.gone:That account no longer exists. Reload the list.`;
    }
    return $localize`:@@admin.users.ban.error.failed:Something went wrong. Please try again.`;
  }

  // ── Read-only renderers ────────────────────────────────────────────────────

  protected displayName(): string {
    return this.user()?.display_name ?? $localize`:@@admin.users.noName:Unnamed account`;
  }

  /** The email, or which kind of "we don't know" this is. See the class doc on
   *  `UserList.emailLabel` — same three states, same reason. */
  protected emailLabel(): string {
    const u = this.user();
    if (!u) return '';
    if (!u.auth_available) return $localize`:@@admin.users.auth.unavailable:Unavailable`;
    if (!u.auth) return $localize`:@@admin.users.auth.noAccount:No account`;
    return u.auth.email ?? $localize`:@@admin.users.auth.noEmail:No email on file`;
  }

  protected lastSignInLabel(): string {
    const u = this.user();
    if (!u) return '';
    if (!u.auth_available) return $localize`:@@admin.users.auth.unavailable:Unavailable`;
    if (!u.auth) return $localize`:@@admin.users.auth.noAccount:No account`;
    return u.auth.last_sign_in_at ?? $localize`:@@admin.users.auth.neverSignedIn:Never signed in`;
  }

  protected emailConfirmedLabel(): string {
    const u = this.user();
    if (!u) return '';
    if (!u.auth_available) return $localize`:@@admin.users.auth.unavailable:Unavailable`;
    if (!u.auth) return $localize`:@@admin.users.auth.noAccount:No account`;
    return u.auth.email_confirmed_at ?? $localize`:@@admin.users.auth.notConfirmed:Not confirmed`;
  }

  protected roleLabel(): string {
    switch (this.user()?.role) {
      case 'admin':
        return $localize`:@@admin.users.role.admin:Admin`;
      case 'vendor_admin':
        return $localize`:@@admin.users.role.vendor:Vendor admin`;
      case 'reviewer':
        return $localize`:@@admin.users.role.reviewer:Reviewer`;
      default:
        return this.user()?.role ?? '';
    }
  }
}
