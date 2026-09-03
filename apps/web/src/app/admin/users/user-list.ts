import { DatePipe, formatDate } from '@angular/common';
import { Component, LOCALE_ID, afterNextRender, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';

import {
  ADMIN_USERS_DEFAULT_PER_PAGE,
  ADMIN_USER_SORT_DEFAULT_ORDER,
  type AdminUserRow,
  type AdminUsersSort,
  type SortOrder,
} from '@aeci/shared';

import { AdminPaginator } from '../admin-paginator';
import { AecSelect, type AecSelectOption } from '../../shared/aec-select/aec-select';
import { SortHeader } from '../../shared/sort-header/sort-header';
import { AdminUsersApi } from './admin-users-api';

/** Every boolean filter is a TRI-state, never a toggle: an operator needs "show
 *  me the banned ones", "show me the rest", and "don't filter" as three separate
 *  questions. The API's params are `'true'|'false'` enums for the same reason —
 *  `z.coerce.boolean()` would fold `false` back into `true` (AECI-691). */
type TriFilter = 'any' | 'true' | 'false';
type RoleFilter = 'any' | 'reviewer' | 'vendor_admin' | 'admin';

/**
 * `/admin/users` — the operator's user list (AECI-692 / `ADMIN_PANEL_SPEC.md`
 * §5.8), rendered in the `AdminShell` layout outlet.
 *
 * The screen whose absence was the whole problem. `GET /api/admin/reviewers` is
 * `WHERE banned_at IS NOT NULL`, so the console's only person-shaped list showed
 * *only banned people*; everyone else appeared incidentally as a review's author,
 * a claim's submitter, or a seat row on a claim card. There was no way to look up
 * an arbitrary account — which is also why ban had no home.
 *
 * Follows the `/admin/vendors` shape: the gate and nav SSR via
 * `adminSummaryResolver` on the parent route; this screen paints its shell during
 * SSR and fetches client-side in `afterNextRender`, where the same-origin
 * `GET /api/admin/users` carries the session cookie for `requireAdmin()` to
 * verify. It never reads cookies or session state directly.
 *
 * **Filters seed from the query string, once, on init.** `/admin/reviewers` now
 * redirects here as `?banned=true`, so that link has to actually arrive filtered.
 * Read-only and one-way: changing a filter does NOT write back to the URL. A
 * two-way binding would put a `Router.navigate` on every dropdown change, and the
 * back button would then walk the operator through their own filter history
 * instead of leaving the screen.
 *
 * **No ban control here.** Ban needs a reason, so an inline control would mean
 * the claim-queue two-step form on every row; and the issue's own premise is that
 * ban lacked a *user anchor*, which is the detail page. Asserted in the spec so a
 * later PR cannot quietly add one.
 *
 * ── A TABLE, AND LAST SIGN-IN IS NOT SORTABLE (AECI-694) ────────────────────
 * Rows were cards; they are a table for the same reason `/admin/vendors` is.
 *
 * `AdminUsersSortSchema` is `created | updated`, so those are the only two
 * sortable headers. Both now accept a direction: clicking the active one flips
 * it (`order` on the wire), clicking the other adopts that column's natural
 * direction — newest-first for both. Everything else is
 * plain `<th>` text with no hover state, and **Last sign-in will never join
 * them** (`ADMIN_PANEL_SPEC.md` §5.8, and `resolveAdminUserOrderBy` says the
 * same in the API): it lives in GoTrue and is fetched per-id AFTER the ORDER BY
 * has already chosen the page, so a control would reorder 24 arbitrary rows and
 * present it as a ranking. Email is unsortable for the same reason.
 *
 * The Updated column exists so the second supported key is reachable at all;
 * `updated_at` was already on `AdminUserRowSchema` and simply had nowhere to go.
 */
@Component({
  selector: 'aec-user-list',
  imports: [RouterLink, AdminPaginator, AecSelect, SortHeader, DatePipe],
  templateUrl: './user-list.html',
})
export class UserList {
  private readonly api = inject(AdminUsersApi);
  private readonly route = inject(ActivatedRoute);
  private readonly locale = inject(LOCALE_ID);

  protected readonly users = signal<readonly AdminUserRow[]>([]);
  protected readonly total = signal(0);
  protected readonly page = signal(1);
  protected readonly perPage = ADMIN_USERS_DEFAULT_PER_PAGE;

  protected readonly loading = signal(true);
  protected readonly loadFailed = signal(false);
  protected readonly liveMessage = signal('');

  /**
   * Whether the GoTrue seam ran at all. `false` means every `auth` block on the
   * page is `null` because the seam was unreachable — which is the NORMAL state
   * on local dev and PR previews, where `SUPABASE_SERVICE_ROLE_KEY` is absent by
   * design. Surfaced as a banner, because a column of "Unavailable" with no
   * explanation is what made a real misconfiguration invisible for a day.
   */
  protected readonly authAvailable = signal(true);

  /** What the `@`-gated email leg of the search actually did — `null` when no
   *  email search was attempted. `'unavailable'` is the one that matters: an
   *  empty page from a seam-down email search reads as "no such user". */
  protected readonly emailSearch = signal<AdminUsersListResponseEmailSearch>(null);

  /** The committed search term — what was last SENT, not what is being typed.
   *  A keystroke-per-request search over a `LIKE '%…%'` scan would be a lot of
   *  scans to answer a question the operator has not finished asking, and each
   *  one containing `@` would also cost a GoTrue round trip. */
  protected readonly search = signal('');
  protected readonly searchDraft = signal('');

  /** The active sort key. Component state, not a URL parameter: this screen
   *  already reads its filters from the query string ONE WAY and deliberately
   *  does not write back, and a sort control is no different. */
  protected readonly sort = signal<AdminUsersSort>('created');

  /** Direction for {@link sort}, starting at that key's natural direction so a
   *  first render matches a bare `?sort=` request. See `vendor-list.ts`, which
   *  documents the same pair. */
  protected readonly order = signal<SortOrder>(ADMIN_USER_SORT_DEFAULT_ORDER['created']);

  protected readonly role = signal<RoleFilter>('any');
  protected readonly banned = signal<TriFilter>('any');
  protected readonly hasSeat = signal<TriFilter>('any');

  protected readonly roleOptions: readonly AecSelectOption[] = [
    { value: 'any', label: $localize`:@@admin.users.filter.role.any:Any role` },
    { value: 'reviewer', label: $localize`:@@admin.users.filter.role.reviewer:Reviewer` },
    { value: 'vendor_admin', label: $localize`:@@admin.users.filter.role.vendor:Vendor admin` },
    { value: 'admin', label: $localize`:@@admin.users.filter.role.admin:Admin` },
  ];

  protected readonly bannedOptions: readonly AecSelectOption[] = [
    { value: 'any', label: $localize`:@@admin.users.filter.banned.any:Any status` },
    { value: 'true', label: $localize`:@@admin.users.filter.banned.yes:Banned` },
    { value: 'false', label: $localize`:@@admin.users.filter.banned.no:Not banned` },
  ];

  protected readonly seatOptions: readonly AecSelectOption[] = [
    { value: 'any', label: $localize`:@@admin.users.filter.seat.any:Any access` },
    { value: 'true', label: $localize`:@@admin.users.filter.seat.yes:Holds a vendor seat` },
    { value: 'false', label: $localize`:@@admin.users.filter.seat.no:No vendor seat` },
  ];

  protected readonly isEmpty = computed(() => !this.loading() && this.users().length === 0);

  constructor() {
    this.seedFromQueryParams();
    afterNextRender(() => {
      void this.load();
    });
  }

  /** One-way, on construction only. See the class doc for why it does not
   *  write back. Unknown values fall through to `'any'` rather than 400ing the
   *  request — a hand-edited URL should narrow nothing, not break the screen. */
  private seedFromQueryParams(): void {
    const params = this.route.snapshot.queryParamMap;
    const banned = params.get('banned');
    if (banned === 'true' || banned === 'false') this.banned.set(banned);
    const hasSeat = params.get('has_seat');
    if (hasSeat === 'true' || hasSeat === 'false') this.hasSeat.set(hasSeat);
    const role = params.get('role');
    if (role === 'reviewer' || role === 'vendor_admin' || role === 'admin') this.role.set(role);
    const search = params.get('search');
    if (search) {
      this.search.set(search);
      this.searchDraft.set(search);
    }
  }

  protected onSearchInput(event: Event): void {
    this.searchDraft.set((event.target as HTMLInputElement).value);
  }

  protected submitSearch(): void {
    this.search.set(this.searchDraft().trim());
    this.refilter();
  }

  protected clearSearch(): void {
    this.searchDraft.set('');
    this.search.set('');
    this.refilter();
  }

  /** Live for the active column, natural for the other — read from the SHARED
   *  map so the arrow cannot disagree with the server's ORDER BY. */
  protected directionFor(key: AdminUsersSort): 'ascending' | 'descending' {
    const order = key === this.sort() ? this.order() : ADMIN_USER_SORT_DEFAULT_ORDER[key];
    return order === 'asc' ? 'ascending' : 'descending';
  }

  protected onSortChange(change: { key: string; order: 'asc' | 'desc' }): void {
    this.sort.set(change.key as AdminUsersSort);
    this.order.set(change.order);
    this.refilter();
  }

  protected onRoleChange(value: string | null): void {
    this.role.set((value as RoleFilter | null) ?? 'any');
    this.refilter();
  }

  protected onBannedChange(value: string | null): void {
    this.banned.set((value as TriFilter | null) ?? 'any');
    this.refilter();
  }

  protected onSeatChange(value: string | null): void {
    this.hasSeat.set((value as TriFilter | null) ?? 'any');
    this.refilter();
  }

  protected goToPage(page: number): void {
    this.page.set(page);
    void this.load();
  }

  protected retry(): void {
    void this.load();
  }

  /** Any filter change: back to page 1, then refetch. Without it, narrowing a
   *  filter while on page 6 lands the operator on an empty page that looks like
   *  "no results". */
  private refilter(): void {
    this.page.set(1);
    void this.load();
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    this.loadFailed.set(false);
    try {
      const search = this.search();
      const role = this.role();
      const banned = this.banned();
      const hasSeat = this.hasSeat();
      const response = await this.api.listUsers({
        page: this.page(),
        perPage: this.perPage,
        sort: this.sort(),
        order: this.order(),
        ...(search ? { search } : {}),
        ...(role === 'any' ? {} : { role }),
        ...(banned === 'any' ? {} : { banned }),
        ...(hasSeat === 'any' ? {} : { has_seat: hasSeat }),
      });
      this.users.set(response.data);
      this.total.set(response.total);
      this.authAvailable.set(response.auth_available);
      this.emailSearch.set(response.email_search);
      this.liveMessage.set(
        $localize`:@@admin.users.announce.loaded:${response.total}:COUNT: people match.`,
      );
    } catch {
      this.loadFailed.set(true);
      this.users.set([]);
      this.total.set(0);
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * The email cell — the tri-state, spelled out.
   *
   * Three different sentences because they mean three different things, and
   * collapsing any two of them is exactly the failure that let an absent
   * service-role key read as ordinary missing data for a day (2026-08-24):
   *
   *   seam down          → we do not know (says nothing about the account)
   *   no auth row        → there IS no account; an orphaned profile, a defect
   *   account, no email  → the account exists and has no address on file
   */
  protected emailLabel(row: AdminUserRow): string {
    if (!this.authAvailable()) return $localize`:@@admin.users.auth.unavailable:Unavailable`;
    if (!row.auth) return $localize`:@@admin.users.auth.noAccount:No account`;
    return row.auth.email ?? $localize`:@@admin.users.auth.noEmail:No email on file`;
  }

  /** Same tri-state as {@link emailLabel}, with "never signed in" as the fourth
   *  case — an account that exists and has simply never been used. */
  protected lastSignInLabel(row: AdminUserRow): string {
    if (!this.authAvailable()) return $localize`:@@admin.users.auth.unavailable:Unavailable`;
    if (!row.auth) return $localize`:@@admin.users.auth.noAccount:No account`;
    return row.auth.last_sign_in_at
      ? formatDate(row.auth.last_sign_in_at, 'medium', this.locale, 'UTC')
      : $localize`:@@admin.users.auth.neverSignedIn:Never signed in`;
  }

  /** True when the cell above is a real value rather than one of the "we don't
   *  know" sentences, so the template can mute the latter without re-deriving
   *  the branch. */
  protected hasAuthValue(row: AdminUserRow): boolean {
    return this.authAvailable() && row.auth !== null;
  }

  protected roleLabel(row: AdminUserRow): string {
    switch (row.role) {
      case 'admin':
        return $localize`:@@admin.users.role.admin:Admin`;
      case 'vendor_admin':
        return $localize`:@@admin.users.role.vendor:Vendor admin`;
      case 'reviewer':
        return $localize`:@@admin.users.role.reviewer:Reviewer`;
      default:
        // The DB CHECK can gain a value without this file, so show it rather
        // than swallowing it into "Reviewer".
        return row.role;
    }
  }
}

/** The response field's type, without importing the whole envelope for one union. */
type AdminUsersListResponseEmailSearch = 'matched' | 'no_match' | 'unavailable' | null;
