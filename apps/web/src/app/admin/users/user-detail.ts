import { DatePipe, formatDate } from '@angular/common';
import {
  Component,
  ElementRef,
  Injector,
  LOCALE_ID,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';

import type {
  AdminAuditRow,
  AdminUserAuditScope,
  AdminUserDetail,
  AdminUserPendingInvite,
} from '@aeci/shared';
import { compareText } from '@aeci/shared/text-sort';

import { AdminBreadcrumbStore } from '../admin-breadcrumb.store';
import { AuditTrail } from '../audit/audit-trail';
import { ADMIN_DETAIL_FALLBACK_LABELS } from '../admin-nav';
import { isStatus } from '../http-status';
import { lastSeatRefusalVendorId } from '../last-seat-refusal';
import { ReviewerBansApi } from '../reviewers/reviewer-bans-api';
import { SortHeader } from '../../shared/sort-header/sort-header';
import { AdminUsersApi } from './admin-users-api';
import {
  ALL_ROLE_OPTIONS,
  COMPANY_SIZE_OPTIONS,
  COMPANY_TYPE_OPTIONS,
  labelFor,
} from '../../account/profile-details/profile-details-model';
import { AecFormSubmit } from '../../shared/form-field/form-submit';
import { AecButton } from '../../shared/button/button';
import { Chip, type ConsoleChipTone } from '../../shared/chip/chip';
import {
  FIELD_HINT_CLASS,
  FIELD_INPUT_CLASS,
  FIELD_LABEL_CLASS,
} from '../../shared/form-field/form-field-classes';
import { AecIcon } from '../../shared/icon/icon';
import { CONSOLE_FILTER } from '../console/console-filter';
import { CONSOLE_TABLE } from '../console/console-table';
import { adminStatusTone, type AdminStatusKey } from '../console/status-tones';
import { USER_CLASSES } from './user-console-classes';

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
 * **Ban a vendor's last unbanned seat.** The API refuses it (`409
 * VENDOR_LAST_SEAT_USE_SUSPEND`, AECI-1623) and the refusal links to the vendor page, where
 * ending a vendor is Suspend, then Terminate.
 *
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
 * ── AUDIT TRAIL (AECI-693) ───────────────────────────────────────────────────
 * The last section is the person's audit trail, through the shared
 * `<aec-audit-trail>`. Its scope toggle is the vendor page's control, with the
 * same three scopes, so the two pages behave alike. The trail loads once the
 * detail resolves, and reloads at page 1 after a ban or reinstate, because both
 * write a profile row. It does not update live.
 *
 * **Show what this person browsed.** Impossible by design: AECI-585 dropped
 * `page_views.user_id` / `session_id` / `profile_role` and `ADMIN_PANEL_SPEC.md`
 * §9 item 7 forbids visitor↔account correlation. There is no join column to
 * reconstruct.
 */
@Component({
  selector: 'aec-user-detail',
  imports: [AecButton, AecFormSubmit, AecIcon, AuditTrail, Chip, RouterLink, DatePipe, SortHeader],
  templateUrl: './user-detail.html',
})
export class UserDetail {
  protected readonly t = CONSOLE_TABLE;
  protected readonly f = CONSOLE_FILTER;
  protected readonly c = USER_CLASSES;
  protected readonly fieldLabelClass = FIELD_LABEL_CLASS;
  protected readonly fieldHintClass = FIELD_HINT_CLASS;
  protected readonly inputClass = FIELD_INPUT_CLASS;
  protected readonly tone = (key: AdminStatusKey): ConsoleChipTone => adminStatusTone(key);

  private readonly api = inject(AdminUsersApi);
  /** The ban writer's client — reused, not re-implemented. */
  private readonly bans = inject(ReviewerBansApi);
  private readonly route = inject(ActivatedRoute);
  private readonly locale = inject(LOCALE_ID);

  private readonly breadcrumbs = inject(AdminBreadcrumbStore);

  protected readonly userId = signal(this.route.snapshot.paramMap.get('id') ?? '');

  /** The heading names WHOSE account this is once we know; until then it shows the
   *  SAME word the shell's breadcrumb shows for this section, from the one place
   *  it is defined. `displayName()` already carries the "Unnamed account" case. */
  protected readonly headingLabel = computed(() =>
    this.user() ? this.displayName() : (ADMIN_DETAIL_FALLBACK_LABELS['users'] ?? ''),
  );

  protected readonly user = signal<AdminUserDetail | null>(null);

  /** The "About you" answers as labels (AECI-1296). A value this build does not
   *  know shows raw rather than disappearing. */
  protected readonly about = computed(() => {
    const about = this.user()?.about;
    if (!about) return null;
    return {
      companyType: labelFor(COMPANY_TYPE_OPTIONS, about.company_type),
      companySize: labelFor(COMPANY_SIZE_OPTIONS, about.company_size),
      primaryRole: labelFor(ALL_ROLE_OPTIONS, about.primary_role),
      firmName: about.firm_name,
      linkedinUrl: about.linkedin_url,
      audiences: about.audiences.map((a) => a.name).join(', '),
      onboarding: about.onboarding,
    };
  });
  protected readonly loading = signal(true);
  protected readonly loadFailed = signal(false);
  protected readonly notFound = signal(false);

  /** The page owns exactly ONE live region, at the top. */
  protected readonly liveMessage = signal('');

  // ── Pending invites table (AECI-1243) ──────────────────────────────────────

  /**
   * The invites table sorts in place. The whole set is on the page (live
   * invites to one address, a handful at most), so a client sort reorders every
   * row rather than one page of many. Default: newest invite first, the order
   * the API ships.
   */
  protected readonly inviteSort = signal<InviteSortKey>('created');
  protected readonly inviteOrder = signal<'asc' | 'desc'>(INVITE_SORT_NATURAL_ORDER.created);

  protected readonly sortedInvites = computed<readonly AdminUserPendingInvite[]>(() => {
    const invites = this.user()?.pending_invites ?? [];
    return sortInvites(invites, this.inviteSort(), this.inviteOrder());
  });

  protected inviteDirection(key: InviteSortKey): 'ascending' | 'descending' {
    const order = key === this.inviteSort() ? this.inviteOrder() : INVITE_SORT_NATURAL_ORDER[key];
    return order === 'asc' ? 'ascending' : 'descending';
  }

  protected onInviteSortChange(change: { key: string; order: 'asc' | 'desc' }): void {
    this.inviteSort.set(change.key as InviteSortKey);
    this.inviteOrder.set(change.order);
  }

  // ── Ban / reinstate ────────────────────────────────────────────────────────

  /** The two-step form is open. Ban needs a reason, so it is the claim-queue
   *  "open a form, then confirm" shape rather than a bare ask→confirm. */
  protected readonly banFormOpen = signal(false);
  protected readonly banReason = signal('');
  protected readonly actionPending = signal(false);
  protected readonly actionFailed = signal('');
  /** `409 VENDOR_LAST_SEAT_USE_SUSPEND` names the vendor, so the refusal can link to it. */
  protected readonly lastSeatVendorId = signal<string | null>(null);

  // AECI-1989: where focus goes after each ban step. Every step removes or disables
  // the button the operator pressed, and without a target focus falls to the body.
  private readonly injector = inject(Injector);
  private readonly banButton = viewChild<ElementRef<HTMLButtonElement>>('banButton');
  private readonly banReasonInput = viewChild<ElementRef<HTMLTextAreaElement>>('banReasonInput');
  private readonly bannedStatus = viewChild<ElementRef<HTMLElement>>('bannedStatus');
  private readonly lastSeatAlert = viewChild<ElementRef<HTMLElement>>('lastSeatAlert');
  private readonly failedAlert = viewChild<ElementRef<HTMLElement>>('failedAlert');

  // ── Audit trail (AECI-693) ─────────────────────────────────────────────────
  // Page-owned state, the same set the claim and vendor pages keep. The trail
  // component is display-only.
  protected readonly auditRows = signal<readonly AdminAuditRow[]>([]);
  protected readonly auditTotal = signal(0);
  protected readonly auditPage = signal(1);
  protected readonly auditPerPage = AUDIT_PAGE_SIZE;
  protected readonly auditScope = signal<AdminUserAuditScope>('all');
  protected readonly auditLoading = signal(true);
  protected readonly auditFailed = signal(false);
  protected readonly auditEmailsAvailable = signal(true);

  protected readonly scopeOptions: ReadonlyArray<{ key: AdminUserAuditScope; label: string }> = [
    { key: 'all', label: $localize`:@@admin.users.audit.scope.all:Everything` },
    { key: 'entity', label: $localize`:@@admin.users.audit.scope.entity:Done to this person` },
    { key: 'actor', label: $localize`:@@admin.users.audit.scope.actor:Done by this person` },
  ];

  constructor() {
    afterNextRender(() => {
      void this.load();
    });

    // AECI-777 — feed the shell's breadcrumb. An effect rather than a line inside
    // `load()` so a refetch republishes too, and so the id travels with the label
    // (the store keys on it to reject a label left over from the last page).
    effect(() => {
      if (this.user()) this.breadcrumbs.publish(this.userId(), this.displayName());
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
      // Only once the account is known to exist. A 404 has no trail to show,
      // and the trail's own failure never touches the flags above.
      void this.loadAudit();
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
    this.lastSeatVendorId.set(null);
    this.banReason.set('');
    this.banFormOpen.set(true);
    this.focusAfterRender(() => this.banReasonInput()?.nativeElement);
  }

  protected closeBanForm(): void {
    this.banFormOpen.set(false);
    this.focusAfterRender(() => this.banButton()?.nativeElement);
  }

  /** Escape closes the ban form, as Cancel does, except while the ban is in flight
   *  (AECI-2128, the console's inline-form rule). */
  protected onBanFormEscape(): void {
    if (!this.actionPending()) this.closeBanForm();
  }

  private focusAfterRender(target: () => HTMLElement | undefined): void {
    afterNextRender(() => target()?.focus(), { injector: this.injector });
  }

  /** A refusal's message: the last-seat one when it rendered, else the generic alert. */
  private focusRefusal(): void {
    this.focusAfterRender(
      () => this.lastSeatAlert()?.nativeElement ?? this.failedAlert()?.nativeElement,
    );
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
      this.focusAfterRender(() => this.banReasonInput()?.nativeElement);
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
    this.lastSeatVendorId.set(null);
    try {
      const result = await this.bans.ban(this.userId(), input);
      this.user.update((u) =>
        u ? { ...u, banned_at: result.banned_at, ban_reason: result.ban_reason } : u,
      );
      this.banFormOpen.set(false);
      this.liveMessage.set(announcement);
      // A ban swaps the form for the "Banned since" status; a reinstate swaps it back
      // for the ban button.
      this.focusAfterRender(() =>
        input.action === 'ban'
          ? this.bannedStatus()?.nativeElement
          : this.banButton()?.nativeElement,
      );
      // Both actions write a profile row, so the trail now has a new first row.
      this.auditPage.set(1);
      void this.loadAudit();
    } catch (err) {
      const lastSeatVendorId = lastSeatRefusalVendorId(err);
      if (lastSeatVendorId) {
        this.lastSeatVendorId.set(lastSeatVendorId);
      } else if (isStatus(err, 422)) {
        // Already in that state: the page reloads to show the truth. The reload
        // re-renders the whole page, so focus the message once it has landed.
        this.actionFailed.set(this.alreadyInStateMessage(input.action));
        await this.load();
      } else {
        this.actionFailed.set(this.banErrorMessage(err));
      }
      this.focusRefusal();
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
   * refetches to show the truth rather than showing a failure
   * ({@link alreadyInStateMessage}).
   *
   * **409 on the last seat** never reaches here when it names its vendor: it renders with a
   * link instead (AECI-1623). The generic line below covers a response that names none.
   */
  private banErrorMessage(err: unknown): string {
    if (isStatus(err, 403)) {
      return $localize`:@@admin.users.ban.error.forbidden:You can't ban this account. Admin accounts can't be banned, and you can't ban yourself.`;
    }
    if (isStatus(err, 404)) {
      return $localize`:@@admin.users.ban.error.gone:That account no longer exists. Reload the list.`;
    }
    return $localize`:@@admin.users.ban.error.failed:Something went wrong. Please try again.`;
  }

  private alreadyInStateMessage(action: 'ban' | 'unban'): string {
    return action === 'ban'
      ? $localize`:@@admin.users.ban.error.alreadyBanned:This account was already banned. Showing the current state.`
      : $localize`:@@admin.users.ban.error.alreadyActive:This account was not banned. Showing the current state.`;
  }

  // ── Audit trail (AECI-693) ─────────────────────────────────────────────────

  protected setScope(scope: AdminUserAuditScope): void {
    if (this.auditScope() === scope) return;
    this.auditScope.set(scope);
    // A scope change resets to page 1. Page 4 of a narrower set is an empty
    // page that reads as "nothing happened".
    this.auditPage.set(1);
    void this.loadAudit();
  }

  protected goToAuditPage(page: number): void {
    this.auditPage.set(page);
    void this.loadAudit();
  }

  protected retryAudit(): void {
    void this.loadAudit();
  }

  /**
   * The newest audit request's number. Every write after the await checks it,
   * so a superseded response (an earlier scope or page that resolves last) is
   * dropped and cannot overwrite the rows the pressed button asked for.
   */
  private auditRequestSeq = 0;

  private async loadAudit(): Promise<void> {
    const id = this.userId();
    if (!id) return;
    const seq = ++this.auditRequestSeq;
    this.auditLoading.set(true);
    this.auditFailed.set(false);
    try {
      const response = await this.api.listAudit(id, {
        page: this.auditPage(),
        perPage: this.auditPerPage,
        scope: this.auditScope(),
      });
      if (seq !== this.auditRequestSeq) return;
      this.auditRows.set(response.data);
      this.auditTotal.set(response.total);
      this.auditEmailsAvailable.set(response.actor_emails_available);
    } catch {
      if (seq !== this.auditRequestSeq) return;
      this.auditFailed.set(true);
      this.auditRows.set([]);
      this.auditTotal.set(0);
    } finally {
      if (seq === this.auditRequestSeq) this.auditLoading.set(false);
    }
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
    return u.auth.last_sign_in_at
      ? this.formatTs(u.auth.last_sign_in_at)
      : $localize`:@@admin.users.auth.neverSignedIn:Never signed in`;
  }

  protected emailConfirmedLabel(): string {
    const u = this.user();
    if (!u) return '';
    if (!u.auth_available) return $localize`:@@admin.users.auth.unavailable:Unavailable`;
    if (!u.auth) return $localize`:@@admin.users.auth.noAccount:No account`;
    return u.auth.email_confirmed_at
      ? this.formatTs(u.auth.email_confirmed_at)
      : $localize`:@@admin.users.auth.notConfirmed:Not confirmed`;
  }

  /** Locale-aware, UTC — matches the `| date: 'medium' : 'UTC'` the rest of the
   *  admin console uses. Applied in TS (not the template) because these methods
   *  return a timestamp OR a status word, and only the timestamp gets formatted. */
  private formatTs(iso: string): string {
    return formatDate(iso, 'medium', this.locale, 'UTC');
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

/** Rows per audit page, the size the claim and vendor trails use. */
const AUDIT_PAGE_SIZE = 25;

/** The sortable columns of the pending-invites table. */
export type InviteSortKey = 'vendor' | 'invited_by' | 'created' | 'expires';

/** What a first click on each header does: names A to Z, invited newest
 *  first, expiry soonest first. `created` is when the invite was first made; a
 *  resend does not move it. */
const INVITE_SORT_NATURAL_ORDER: Record<InviteSortKey, 'asc' | 'desc'> = {
  vendor: 'asc',
  invited_by: 'asc',
  created: 'desc',
  expires: 'asc',
};

const binary = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Sort the invites by one column (AECI-1243). Names compare case-insensitively
 * (`compareText`). Timestamps are ISO strings and compare in binary. A missing
 * sender sorts last in either direction. `id` breaks every tie, so the order
 * never depends on the order the rows arrived in.
 */
export function sortInvites(
  invites: readonly AdminUserPendingInvite[],
  key: InviteSortKey,
  order: 'asc' | 'desc',
): AdminUserPendingInvite[] {
  const sign = order === 'asc' ? 1 : -1;
  const primary = (a: AdminUserPendingInvite, b: AdminUserPendingInvite): number => {
    switch (key) {
      case 'vendor':
        return sign * compareText(a.vendor_name, b.vendor_name);
      case 'invited_by': {
        // An empty name is unnamed too, as the API's `blankLast` treats it.
        const an = a.invited_by || null;
        const bn = b.invited_by || null;
        if (an === bn) return 0;
        if (an === null) return 1;
        if (bn === null) return -1;
        return sign * compareText(an, bn);
      }
      case 'created':
        return sign * binary(a.created_at, b.created_at);
      case 'expires':
        return sign * binary(a.expires_at, b.expires_at);
    }
  };
  return [...invites].sort((a, b) => primary(a, b) || binary(a.id, b.id));
}
