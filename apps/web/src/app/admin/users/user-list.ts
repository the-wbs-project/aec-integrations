import { DatePipe, formatDate } from '@angular/common';
import {
  Component,
  LOCALE_ID,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, type ParamMap, type Params, Router, RouterLink } from '@angular/router';

import {
  ADMIN_USERS_DEFAULT_PER_PAGE,
  ADMIN_USER_SORT_DEFAULT_ORDER,
  type AdminUserRow,
  type AdminUsersSort,
  type SortOrder,
} from '@aeci/shared';

import { AdminPaginator } from '../admin-paginator';
import { CONSOLE_TABLE } from '../console/console-table';
import { adminStatusTone, type AdminStatusKey } from '../console/status-tones';
import { AecSelect, type AecSelectOption } from '../../shared/aec-select/aec-select';
import { AecButton } from '../../shared/button/button';
import { Chip, type ConsoleChipTone } from '../../shared/chip/chip';
import { FIELD_INPUT_CLASS } from '../../shared/form-field/form-field-classes';
import { USER_CLASSES } from './user-console-classes';
import { SortHeader } from '../../shared/sort-header/sort-header';
import { AdminUsersApi } from './admin-users-api';
import {
  COMPANY_SIZE_OPTIONS,
  COMPANY_TYPE_OPTIONS,
  labelFor,
} from '../../account/profile-details/profile-details-model';
import { isReplayedEvent } from '../../core/event-replay';

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
 * **The URL is the list's state (AECI-1935).** `role`, `banned`, `has_seat`,
 * `search`, `sort`, `order` and `page` live in the query string, the way
 * `/admin/vendors` keeps its own (AECI-1934). See {@link queryParams}.
 * `/admin/reviewers` redirects here as `?banned=true`, so that link arrives
 * filtered by the same read.
 *
 * **No ban control here.** Ban needs a reason, so an inline control would mean
 * the claim-queue two-step form on every row; and the issue's own premise is that
 * ban lacked a *user anchor*, which is the detail page. Asserted in the spec so a
 * later PR cannot quietly add one.
 *
 * ── A TABLE, WITH FOUR SORTABLE HEADERS (AECI-694) ──────────────────────────
 * Rows were cards; they are a table for the same reason `/admin/vendors` is.
 *
 * `AdminUsersSortSchema` is `created | updated | name | last_sign_in`, so those are
 * the only four sortable headers (Person sorts on the display name, AECI-1243). Each
 * accepts a direction: clicking the active one flips it (`order` on the wire),
 * clicking another adopts that column's natural direction — newest-first for
 * the dates, A to Z for Person. Everything else is
 * plain `<th>` text with no hover state.
 *
 * Last sign-in lives in GoTrue, so the API ranks the whole filtered set before it
 * chooses the page (`ADMIN_PANEL_SPEC.md` §5.8). With the seam down it cannot, and
 * the API orders by `created`: see {@link sortFellBack}.
 *
 * The Updated column exists so the second supported key is reachable at all;
 * `updated_at` was already on `AdminUserRowSchema` and simply had nowhere to go.
 */
@Component({
  selector: 'aec-user-list',
  imports: [RouterLink, AdminPaginator, AecButton, AecSelect, Chip, SortHeader, DatePipe],
  templateUrl: './user-list.html',
})
export class UserList {
  private readonly api = inject(AdminUsersApi);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly locale = inject(LOCALE_ID);

  protected readonly t = CONSOLE_TABLE;
  protected readonly c = USER_CLASSES;
  protected readonly inputClass = FIELD_INPUT_CLASS;
  protected readonly tone = (key: AdminStatusKey): ConsoleChipTone => adminStatusTone(key);

  protected readonly users = signal<readonly AdminUserRow[]>([]);
  protected readonly total = signal(0);
  protected readonly perPage = ADMIN_USERS_DEFAULT_PER_PAGE;

  protected readonly loading = signal(true);
  protected readonly loadFailed = signal(false);
  protected readonly liveMessage = signal('');

  /**
   * Whether the GoTrue seam ran at all. `false` means every `auth` block on the
   * page is `null` because the seam was unreachable — which is the NORMAL state
   * on local dev, where `SUPABASE_SERVICE_ROLE_KEY` is absent by
   * design. Surfaced as a banner, because a column of "Unavailable" with no
   * explanation is what made a real misconfiguration invisible for a day.
   */
  protected readonly authAvailable = signal(true);

  /** What the `@`-gated email leg of the search actually did — `null` when no
   *  email search was attempted. `'unavailable'` is the one that matters: an
   *  empty page from a seam-down email search reads as "no such user". */
  protected readonly emailSearch = signal<AdminUsersListResponseEmailSearch>(null);

  /**
   * The list's state lives in the URL (AECI-1935), as on `/admin/vendors`. It is
   * READ reactively, so reload, Back and a shared link all restore it, and it is
   * WRITTEN by pushing a navigation. Each change is a history entry, so Back walks
   * back through the operator's filters and pages. A default is left out, so the
   * bare `/admin/users` stays canonical. `/admin` is never edge-cached, so no
   * cache key forks.
   *
   * The page is in the URL here and not on `/admin/vendors` because this list
   * pages with Previous/Next, where the vendor list scrolls.
   *
   * A hand-edited junk value reads as the default rather than 400ing the request:
   * a bad link should narrow nothing, not break the screen.
   */
  private readonly queryParams = toSignal(this.route.queryParamMap, {
    initialValue: this.route.snapshot.queryParamMap,
  });
  private readonly urlState = computed(() => readUrlState(this.queryParams()), {
    equal: (a, b) => JSON.stringify(a) === JSON.stringify(b),
  });

  /** The committed search term, from the URL: what was last SENT, not what is
   *  being typed. A keystroke-per-request search over a `LIKE '%…%'` scan would be
   *  a lot of scans to answer a question the operator has not finished asking,
   *  and each one containing `@` would also cost a GoTrue round trip. */
  protected readonly search = computed(() => this.urlState().search);
  protected readonly searchDraft = signal('');

  /** The active sort key, from the URL. `created` when absent. */
  protected readonly sort = computed(() => this.urlState().sort);

  /** Direction for {@link sort}. Absent from the URL means the key's natural
   *  direction, so a first render matches a bare `?sort=` request. See
   *  `vendor-list.ts`, which documents the same pair. */
  protected readonly order = computed(() => this.urlState().order);

  /** The page shown, from the URL. 1 when absent. */
  protected readonly page = computed(() => this.urlState().page);

  /** The operator asked for last sign-in and the seam could not answer, so the API
   *  ordered by `created`. The arrow and `aria-sort` follow what the server did.
   *  The URL keeps `sort=last_sign_in`: it records what was asked. */
  protected readonly sortFellBack = computed(
    () => this.sort() === 'last_sign_in' && !this.authAvailable(),
  );
  protected readonly appliedSort = computed<AdminUsersSort>(() =>
    this.sortFellBack() ? 'created' : this.sort(),
  );

  protected readonly role = computed(() => this.urlState().role);
  protected readonly banned = computed(() => this.urlState().banned);
  protected readonly hasSeat = computed(() => this.urlState().hasSeat);

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

  /** False until the browser renders. Nothing is fetched during SSR, because the
   *  same-origin read needs the browser's session cookie. */
  private readonly ready = signal(false);

  /** Bumped by every load. A response from a superseded load (a fast Back, say)
   *  is dropped rather than painted over the newer one. */
  private loadSeq = 0;

  constructor() {
    afterNextRender(() => this.ready.set(true));

    // The search box follows the URL, so Back restores the text with the rows.
    effect(() => {
      const search = this.search();
      untracked(() => this.searchDraft.set(search));
    });

    // One load per distinct URL state, including the first.
    effect(() => {
      if (!this.ready()) return;
      this.urlState();
      untracked(() => void this.load());
    });
  }

  protected onSearchInput(event: Event): void {
    this.searchDraft.set((event.target as HTMLInputElement).value);
  }

  /** The form's submit. Drops a replayed early submit. The form is `method="dialog"`,
   *  so the native submit did nothing (AECI-1919, `core/event-replay.ts`). */
  protected onSearchSubmit(event: Event): void {
    if (isReplayedEvent(event)) return;
    event.preventDefault();
    this.submitSearch();
  }

  protected submitSearch(): void {
    this.refilter({ search: this.searchDraft().trim() });
  }

  protected clearSearch(): void {
    this.searchDraft.set('');
    this.refilter({ search: '' });
  }

  /** Live for the active column, natural for the other — read from the SHARED
   *  map so the arrow cannot disagree with the server's ORDER BY. */
  protected directionFor(key: AdminUsersSort): 'ascending' | 'descending' {
    const order = key === this.appliedSort() ? this.order() : ADMIN_USER_SORT_DEFAULT_ORDER[key];
    return order === 'asc' ? 'ascending' : 'descending';
  }

  protected onSortChange(change: { key: string; order: 'asc' | 'desc' }): void {
    const sort = isSortKey(change.key) ? change.key : DEFAULT_SORT;
    this.refilter({ sort, order: change.order });
  }

  protected onRoleChange(value: string | null): void {
    this.refilter({ role: (value as RoleFilter | null) ?? 'any' });
  }

  protected onBannedChange(value: string | null): void {
    this.refilter({ banned: (value as TriFilter | null) ?? 'any' });
  }

  protected onSeatChange(value: string | null): void {
    this.refilter({ hasSeat: (value as TriFilter | null) ?? 'any' });
  }

  protected goToPage(page: number): void {
    this.navigate({ ...this.urlState(), page });
  }

  protected retry(): void {
    void this.load();
  }

  /** Any filter, search or sort change: back to page 1. Without it, narrowing a
   *  filter while on page 6 lands the operator on an empty page that looks like
   *  "no results". Page 1 is the default, so `page` drops from the URL. */
  private refilter(change: Partial<UrlState>): void {
    this.navigate({ ...this.urlState(), ...change, page: 1 });
  }

  /** Push the new state into the URL, defaults left off. The URL effect in the
   *  constructor does the fetch, so Back takes the same path. */
  private navigate(state: UrlState): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: toQueryParams(state),
    });
  }

  private async load(): Promise<void> {
    const seq = ++this.loadSeq;
    this.loading.set(true);
    this.loadFailed.set(false);
    try {
      const { search, role, banned, hasSeat, sort, order, page } = this.urlState();
      const response = await this.api.listUsers({
        page,
        perPage: this.perPage,
        sort,
        order,
        ...(search ? { search } : {}),
        ...(role === 'any' ? {} : { role }),
        ...(banned === 'any' ? {} : { banned }),
        ...(hasSeat === 'any' ? {} : { has_seat: hasSeat }),
      });
      if (seq !== this.loadSeq) return;
      this.users.set(response.data);
      this.total.set(response.total);
      this.authAvailable.set(response.auth_available);
      this.emailSearch.set(response.email_search);
      this.liveMessage.set(
        $localize`:@@admin.users.announce.loaded:${response.total}:COUNT: people match.`,
      );
    } catch {
      if (seq !== this.loadSeq) return;
      this.loadFailed.set(true);
      this.users.set([]);
      this.total.set(0);
    } finally {
      if (seq === this.loadSeq) this.loading.set(false);
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

  /** "Works at" cell (AECI-1296): the company type label, or `null` when the
   *  person has not answered. */
  protected companyTypeLabel(row: AdminUserRow): string | null {
    return labelFor(COMPANY_TYPE_OPTIONS, row.company_type);
  }

  protected companySizeLabel(row: AdminUserRow): string | null {
    return labelFor(COMPANY_SIZE_OPTIONS, row.company_size);
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

// ─── URL state ───────────────────────────────────────────────────────────────

interface UrlState {
  search: string;
  role: RoleFilter;
  banned: TriFilter;
  hasSeat: TriFilter;
  sort: AdminUsersSort;
  order: SortOrder;
  page: number;
}

const DEFAULT_SORT: AdminUsersSort = 'created';

function isSortKey(value: string | null): value is AdminUsersSort {
  return value !== null && Object.hasOwn(ADMIN_USER_SORT_DEFAULT_ORDER, value);
}

function readTri(value: string | null): TriFilter {
  return value === 'true' || value === 'false' ? value : 'any';
}

function readRole(value: string | null): RoleFilter {
  return value === 'reviewer' || value === 'vendor_admin' || value === 'admin' ? value : 'any';
}

/** A positive integer, written in plain digits. Anything else is page 1. */
function readPage(value: string | null): number {
  if (value === null || !/^\d+$/.test(value)) return 1;
  const page = Number(value);
  return Number.isSafeInteger(page) && page >= 1 ? page : 1;
}

/** The URL, sanitised. A junk value reads as its default. An absent `order`
 *  is the sort key's natural direction. */
function readUrlState(params: ParamMap): UrlState {
  const rawSort = params.get('sort');
  const sort = isSortKey(rawSort) ? rawSort : DEFAULT_SORT;
  const rawOrder = params.get('order');
  const order: SortOrder =
    rawOrder === 'asc' || rawOrder === 'desc' ? rawOrder : ADMIN_USER_SORT_DEFAULT_ORDER[sort];
  return {
    search: params.get('search')?.trim() ?? '',
    role: readRole(params.get('role')),
    banned: readTri(params.get('banned')),
    hasSeat: readTri(params.get('has_seat')),
    sort,
    order,
    page: readPage(params.get('page')),
  };
}

/** Every key is written, with `null` for a default, so a default DROPS from the
 *  URL rather than lingering from the previous state. */
function toQueryParams(state: UrlState): Params {
  return {
    search: state.search || null,
    role: state.role === 'any' ? null : state.role,
    banned: state.banned === 'any' ? null : state.banned,
    has_seat: state.hasSeat === 'any' ? null : state.hasSeat,
    sort: state.sort === DEFAULT_SORT ? null : state.sort,
    order: state.order === ADMIN_USER_SORT_DEFAULT_ORDER[state.sort] ? null : state.order,
    page: state.page === 1 ? null : state.page,
  };
}
