import {
  Component,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, type ParamMap, type Params } from '@angular/router';
import { z } from 'zod';

import {
  AUDIT_ACTOR_TYPES,
  AUDIT_DEFAULT_PAGE_SIZE,
  AUDIT_ENTITY_TYPES,
  AUDIT_PAGE_SIZES,
  AdminAuditLogQuerySchema,
  UtcCalendarDaySchema,
  decodeAuditCursor,
  type AdminAuditRow,
  type AuditActorType,
} from '@aeci/shared';

import { AecSelect, type AecSelectOption } from '../../shared/aec-select/aec-select';
import { isStatus } from '../http-status';
import { AdminAuditApi, type AdminAuditListParams } from './admin-audit-api';
import { knownAuditActions } from './audit-action-labels';
import { AuditTrail } from './audit-trail';

/** Length of the default landing window, in days, today included. */
export const AUDIT_DEFAULT_WINDOW_DAYS = 30;

const DAY_MS = 86_400_000;

/** The date presets. Client-only: resolved to `from` / `to` before the fetch,
 *  so the API never sees one (`admin-audit.ts` keeps its index table honest). */
export const AUDIT_RANGES = ['today', '7d', '30d', '90d', 'all'] as const;
export type AuditRange = (typeof AUDIT_RANGES)[number];

/** Days in each trailing preset, today included. `all` has no window. */
const RANGE_DAYS: Record<Exclude<AuditRange, 'all'>, number> = {
  today: 1,
  '7d': 7,
  '30d': AUDIT_DEFAULT_WINDOW_DAYS,
  '90d': 90,
};

/** The chip the preset row shows as pressed, or `custom` for typed dates. */
export type AuditRangeChip = AuditRange | 'custom';

/** The filters, as the URL carries them. Every field is optional. */
export interface AuditLogFilters {
  readonly entity_type?: string;
  readonly entity_id?: string;
  readonly action?: string;
  readonly actor_id?: string;
  readonly actor_type?: AuditActorType;
  readonly from?: string;
  readonly to?: string;
}

/** A keyset cursor as the URL carries it: which way, and the raw wire value. */
export interface AuditUrlCursor {
  readonly kind: 'after' | 'before';
  readonly value: string;
}

/** Everything the URL says, sanitised. */
export interface AuditUrlState {
  readonly filters: AuditLogFilters;
  /** An explicit preset. Dropped when the URL also names a date. */
  readonly range: AuditRange | null;
  readonly order: 'asc' | 'desc';
  readonly perPage: number;
  readonly cursor: AuditUrlCursor | null;
  /** The URL's `from` was after its `to`, so both were dropped. */
  readonly datesOutOfOrder: boolean;
}

/** The fields an inline message can sit under. */
type FilterField =
  | 'entity_type'
  | 'entity_id'
  | 'action'
  | 'actor_id'
  | 'actor_type'
  | 'from'
  | 'to';

const uuid = z.string().uuid();

/** `YYYY-MM-DD` for a UTC instant. */
function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

function addDays(day: string, delta: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + delta * DAY_MS).toISOString().slice(0, 10);
}

/** A trimmed value within `max`, or `undefined`. */
function text(params: ParamMap, key: string, max: number): string | undefined {
  const value = params.get(key)?.trim();
  return value && value.length <= max ? value : undefined;
}

function day(params: ParamMap, key: string): string | undefined {
  const value = params.get(key)?.trim();
  return value && UtcCalendarDaySchema.safeParse(value).success ? value : undefined;
}

/** A raw cursor that decodes, or `undefined`. */
function cursorParam(params: ParamMap, key: string): string | undefined {
  const value = params.get(key)?.trim();
  return value && decodeAuditCursor(value) !== null ? value : undefined;
}

/**
 * Read the URL. Anything the server would refuse is dropped rather than sent,
 * the same rule as `user-list.ts` `seedFromQueryParams`: a hand-edited URL
 * should narrow nothing, not break the screen.
 *
 *  - an `entity_id` with no `entity_type` is dropped;
 *  - an `actor_id` that is not a uuid is dropped;
 *  - an unknown `actor_type` or `range` is dropped;
 *  - a date that is not a real `YYYY-MM-DD` day is dropped, and a `from` after
 *    `to` drops both and sets `datesOutOfOrder`;
 *  - a `range` next to a date is dropped: typed dates win;
 *  - `order` is `desc` unless it is exactly `asc`, and `perPage` is 25 unless it
 *    is one of the offered sizes;
 *  - the cursor pair is kept only when exactly one of them decodes.
 */
export function readUrlState(params: ParamMap): AuditUrlState {
  const entity_type = text(params, 'entity_type', 64);
  const entity_id = entity_type ? text(params, 'entity_id', 128) : undefined;
  const actorId = params.get('actor_id')?.trim();
  const actorType = params.get('actor_type');
  let from = day(params, 'from');
  let to = day(params, 'to');
  const datesOutOfOrder = !!(from && to && from > to);
  if (datesOutOfOrder) {
    from = undefined;
    to = undefined;
  }
  const rawRange = params.get('range');
  const range =
    !from && !to && (AUDIT_RANGES as readonly string[]).includes(rawRange ?? '')
      ? (rawRange as AuditRange)
      : null;
  const perPage = Number(params.get('perPage'));
  const after = cursorParam(params, 'after');
  const before = cursorParam(params, 'before');
  let cursor: AuditUrlCursor | null = null;
  if (after && !before) cursor = { kind: 'after', value: after };
  else if (before && !after) cursor = { kind: 'before', value: before };
  return {
    filters: dropUndefined({
      entity_type,
      entity_id,
      action: text(params, 'action', 128),
      actor_id: actorId && uuid.safeParse(actorId).success ? actorId : undefined,
      actor_type: (AUDIT_ACTOR_TYPES as readonly string[]).includes(actorType ?? '')
        ? (actorType as AuditActorType)
        : undefined,
      from,
      to,
    }),
    range,
    order: params.get('order') === 'asc' ? 'asc' : 'desc',
    perPage: (AUDIT_PAGE_SIZES as readonly number[]).includes(perPage)
      ? perPage
      : AUDIT_DEFAULT_PAGE_SIZE,
    cursor,
    datesOutOfOrder,
  };
}

/** The `from` / `to` a preset means on `today`. `all` means no dates. */
export function resolveRange(range: AuditRange, today: string): { from?: string; to?: string } {
  if (range === 'all') return {};
  return { from: addDays(today, -(RANGE_DAYS[range] - 1)), to: today };
}

/**
 * The chip the preset row shows as pressed. Derived, never stored: an explicit
 * range is that chip; typed dates are Custom; otherwise the default applies,
 * which is 30 days when nothing indexed narrows the log and All time when
 * something does.
 */
export function selectedRangeChip(
  filters: AuditLogFilters,
  range: AuditRange | null,
): AuditRangeChip {
  if (range !== null) return range;
  if (filters.from !== undefined || filters.to !== undefined) return 'custom';
  return needsDefaultWindow(filters) ? '30d' : 'all';
}

/** Structural equality for the small plain objects these signals carry, so a
 *  query change that leaves one of them alone does not re-fire its effect. */
function sameJson<T>(a: T, b: T): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * True when the default landing window applies: no indexed filter and no date.
 *
 * `actor_type` does not count. On its own it is the one shape the server
 * refuses (the count would read the whole table), and with the window it is a
 * valid query. So a URL carrying only `?actor_type=system` gets the window too
 * rather than a 400.
 */
export function needsDefaultWindow(filters: AuditLogFilters): boolean {
  return (
    filters.entity_type === undefined &&
    filters.action === undefined &&
    filters.actor_id === undefined &&
    filters.from === undefined &&
    filters.to === undefined
  );
}

function dropUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

/**
 * `/admin/audit`, the global audit log (AECI-653, `ADMIN_PANEL_SPEC.md` §5.18),
 * rendered in the `AdminShell` layout's outlet.
 *
 * `audit_log` is written by every domain-state write and kept forever. Before
 * this screen it had three scoped read surfaces, the vendor, claim and
 * connector-catalogue trails, and no global one. This is the unscoped,
 * filterable read over `GET /api/admin/audit`. The table is the shared
 * `<aec-audit-trail>`, so a row reads the same here as on a detail page.
 *
 * Like the other admin screens, the gate and nav SSR via `adminSummaryResolver`
 * on the parent route. This screen paints its shell during SSR and fetches in
 * `afterNextRender`. The SSR HTML carries no rows and no clock-derived date.
 *
 * ── THE URL IS THE STATE ─────────────────────────────────────────────────────
 * The filters, the preset, the order, the page size and the cursor live in the
 * query string and are read from the LIVE query map, as `vendor-detail.ts`
 * reads `?tab=`. A link from one row of this page to `?entity_type=…` reuses
 * this component instance, so a snapshot read would freeze it.
 *
 * This screen writes back to the URL, and `user-list.ts` deliberately does not.
 * The difference is when the write happens. User-list would write on every
 * dropdown change. Here the form writes only on an explicit Apply, and paging
 * and sorting write the cursor and order. And this page has to be
 * deep-linkable: the detail pages link into it, and an operator pastes a
 * filtered view into a Linear issue.
 *
 * ── PAGING IS BY CURSOR (ADR 0046) ───────────────────────────────────────────
 * An append-only ledger drifts under offset paging. The server hands back
 * `next_cursor` / `prev_cursor` and this page writes them to the URL as `after`
 * / `before`. The total is counted once per filter set: later pages send
 * `count=0` and keep the remembered total. A cursored deep link has none, so it
 * counts. An empty page reached by a cursor offers "First page", because its
 * cursors are null while rows still exist before it.
 *
 * ── THE WINDOW AND THE PRESET ROW ────────────────────────────────────────────
 * Ruled 2026-10-23. With no entity, action or actor filter and no date, the log
 * shows the last 30 days, today included, in UTC. The `count()` behind the total
 * would otherwise walk the whole `created_at` index. A preset row (Today, 7, 30,
 * 90 days, All time) picks another window. Its pressed chip is derived, never
 * stored, so the date inputs only ever show dates the operator or the link
 * typed. Presets and the default window resolve to dates in the browser only,
 * because a clock-derived value in SSR HTML diverges from what the browser
 * computes (the `activity-feed.ts` rule). A filter on entity, action or actor
 * gets no window: that full history is indexed and is the point of the link.
 *
 * ── VALIDATION MIRRORS THE SERVER ────────────────────────────────────────────
 * Apply runs the draft through the same `AdminAuditLogQuerySchema` the API
 * parses with, so the two refusals (an entity id without a type, an actor type
 * on its own) show as messages beside the fields instead of a 400. A 400 from
 * the server still renders a readable error, for the day the two drift.
 */
@Component({
  selector: 'aec-admin-audit-log',
  imports: [AecSelect, AuditTrail],
  templateUrl: './audit-log.html',
})
export class AuditLog {
  private readonly api = inject(AdminAuditApi);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);
  private readonly trail = viewChild(AuditTrail);

  private readonly queryParams = toSignal(this.route.queryParamMap, {
    initialValue: this.route.snapshot.queryParamMap,
  });

  /** False until the browser has computed today's date. The filter bar and
   *  the fetch wait on it (see the class doc). */
  protected readonly ready = signal(false);
  private readonly today = signal<string | null>(null);

  // ── URL state ──────────────────────────────────────────────────────────────
  private readonly urlState = computed(() => readUrlState(this.queryParams()));
  /** The filters the URL carries, sanitised. */
  protected readonly urlFilters = computed(() => this.urlState().filters, { equal: sameJson });
  private readonly urlRange = computed(() => this.urlState().range);
  protected readonly order = computed(() => this.urlState().order);
  protected readonly perPage = computed(() => this.urlState().perPage);
  private readonly cursor = computed(() => this.urlState().cursor, { equal: sameJson });
  /** The one-line notice under the form when the link's dates were dropped. */
  protected readonly urlNotice = computed(() =>
    this.urlState().datesOutOfOrder
      ? $localize`:@@admin.auditLog.notice.datesOutOfOrder:The dates in the link were out of order and were ignored.`
      : null,
  );

  /** What is actually sent: the URL's filters with its preset, or the default
   *  window, resolved to dates. `null` until the browser knows today's date. */
  protected readonly effectiveFilters = computed<AuditLogFilters | null>(
    () => {
      const today = this.today();
      if (today === null) return null;
      const filters = this.urlFilters();
      if (filters.from !== undefined || filters.to !== undefined) return filters;
      const range = this.urlRange();
      if (range !== null) return { ...filters, ...resolveRange(range, today) };
      if (!needsDefaultWindow(filters)) return filters;
      return { ...filters, ...resolveRange('30d', today) };
    },
    { equal: sameJson },
  );

  // ── Draft form state ───────────────────────────────────────────────────────
  protected readonly entityType = signal('');
  protected readonly entityId = signal('');
  protected readonly action = signal('');
  protected readonly actorId = signal('');
  protected readonly actorType = signal<string | null>(null);
  protected readonly from = signal('');
  protected readonly to = signal('');
  /** The preset the operator chose, or the URL named. `null` when none was
   *  chosen explicitly; the pressed chip is then derived. */
  protected readonly range = signal<AuditRange | null>(null);

  /** Field errors from the last Apply. Empty until one is attempted, and
   *  re-checked as the operator edits after that. */
  private readonly submitted = signal(false);
  protected readonly errors = computed<Partial<Record<FilterField, string>>>(() =>
    this.submitted() ? this.validate() : {},
  );
  protected readonly hasErrors = computed(() => Object.keys(this.errors()).length > 0);

  /** The entity id is only meaningful with a type. It stays enabled while it
   *  still holds a value, so an operator who cleared the type can still clear
   *  the id instead of being stuck with a locked field and an error. */
  protected readonly entityIdDisabled = computed(
    () => this.entityType().trim() === '' && this.entityId().trim() === '',
  );

  /** The pressed chip, derived from the draft (see `selectedRangeChip`). */
  protected readonly selectedChip = computed(() => selectedRangeChip(this.draft(), this.range()));

  /** True when the draft names no entity, action or actor, so the default
   *  window note applies. */
  protected readonly onDefaultWindow = computed(() => {
    const draft = this.draft();
    return (
      draft.entity_type === undefined && draft.action === undefined && draft.actor_id === undefined
    );
  });

  /** A typed value the suggestions do not know. Not an error: the server
   *  matches it exactly, so a typo is explained rather than silently empty. */
  protected readonly entityTypeUnknown = computed(() => {
    const value = this.entityType().trim();
    return value !== '' && !(AUDIT_ENTITY_TYPES as readonly string[]).includes(value);
  });
  protected readonly actionUnknown = computed(() => {
    const value = this.action().trim();
    return value !== '' && !this.actionSuggestions.includes(value);
  });

  // ── Result state ───────────────────────────────────────────────────────────
  protected readonly rows = signal<readonly AdminAuditRow[]>([]);
  /** The total for the current filters, remembered across cursor pages. */
  protected readonly total = signal<number | null>(null);
  protected readonly hasNext = signal(false);
  protected readonly hasPrev = signal(false);
  private readonly nextCursor = signal<string | null>(null);
  private readonly prevCursor = signal<string | null>(null);
  protected readonly emailsAvailable = signal(true);
  protected readonly loading = signal(true);
  protected readonly failed = signal(false);
  /** A 400: the server refused the filters. Retrying the same request would
   *  get the same answer, so this renders its own message, not the retry. */
  protected readonly rejected = signal(false);
  protected readonly liveMessage = signal('');

  /** Move only when the cursor for that direction is in hand. An empty page
   *  reached by a cursor has null cursors even when its flags say rows exist. */
  protected readonly canNext = computed(() => this.hasNext() && this.nextCursor() !== null);
  protected readonly canPrev = computed(() => this.hasPrev() && this.prevCursor() !== null);
  protected readonly canFirst = computed(
    () => this.canPrev() || (this.cursor() !== null && this.rows().length === 0),
  );

  protected readonly pageSizes = AUDIT_PAGE_SIZES;
  protected readonly entityTypeSuggestions = AUDIT_ENTITY_TYPES;
  protected readonly actionSuggestions = knownAuditActions();

  protected readonly rangeChips: readonly { value: AuditRange; label: string }[] = [
    { value: 'today', label: $localize`:@@admin.auditLog.range.today:Today` },
    { value: '7d', label: $localize`:@@admin.auditLog.range.7d:7 days` },
    { value: '30d', label: $localize`:@@admin.auditLog.range.30d:30 days` },
    { value: '90d', label: $localize`:@@admin.auditLog.range.90d:90 days` },
    { value: 'all', label: $localize`:@@admin.auditLog.range.all:All time` },
  ];

  protected readonly actorTypeLabel = $localize`:@@admin.auditLog.filter.actorType:Actor type`;
  protected readonly actorTypeOptions: readonly AecSelectOption[] = [
    { value: null, label: $localize`:@@admin.auditLog.filter.actorType.any:Any` },
    { value: 'user', label: $localize`:@@admin.auditLog.filter.actorType.user:User` },
    { value: 'admin', label: $localize`:@@admin.auditLog.filter.actorType.admin:Admin` },
    { value: 'system', label: $localize`:@@admin.auditLog.filter.actorType.system:System` },
    { value: 'workflow', label: $localize`:@@admin.auditLog.filter.actorType.workflow:Workflow` },
  ];

  protected readonly emptyText = computed(() =>
    this.cursor() !== null
      ? $localize`:@@admin.auditLog.emptyPage:No entries on this page.`
      : $localize`:@@admin.auditLog.empty:No entries match these filters.`,
  );

  /** Guards against an older response landing after a newer one. */
  private requestSeq = 0;
  /** The filter set `total` was counted for, so later pages can skip the count. */
  private totalKey: string | null = null;
  /** Set by a page or sort move; the fetch it causes moves focus when it lands. */
  private focusAfterLoad = false;

  constructor() {
    afterNextRender(() => {
      this.today.set(utcDay(new Date()));
      this.ready.set(true);
    });

    // Seed the draft when the filters change. Paging and sorting leave the
    // filters alone, so they never overwrite what the operator is typing.
    effect(() => {
      if (this.effectiveFilters() === null) return;
      untracked(() => this.seedDraft(this.urlFilters(), this.urlRange()));
    });

    // One fetch per distinct query, including the first. `effectiveFilters` is
    // null on the server, so nothing is fetched during SSR.
    effect(() => {
      const filters = this.effectiveFilters();
      const cursor = this.cursor();
      const order = this.order();
      const perPage = this.perPage();
      if (filters === null) return;
      untracked(() => void this.load(filters, cursor, order, perPage));
    });
  }

  /** Dates are seeded only from the URL's explicit `from` / `to`, never from
   *  the computed window, so a preset never masquerades as typed dates. */
  private seedDraft(filters: AuditLogFilters, range: AuditRange | null): void {
    this.entityType.set(filters.entity_type ?? '');
    this.entityId.set(filters.entity_id ?? '');
    this.action.set(filters.action ?? '');
    this.actorId.set(filters.actor_id ?? '');
    this.actorType.set(filters.actor_type ?? null);
    this.from.set(filters.from ?? '');
    this.to.set(filters.to ?? '');
    this.range.set(range);
    this.submitted.set(false);
  }

  private async load(
    filters: AuditLogFilters,
    cursor: AuditUrlCursor | null,
    order: 'asc' | 'desc',
    perPage: number,
  ): Promise<void> {
    const seq = ++this.requestSeq;
    const key = JSON.stringify(filters);
    const reuseTotal = this.totalKey === key && this.total() !== null;
    const moved = this.focusAfterLoad;
    this.focusAfterLoad = false;
    this.loading.set(true);
    this.failed.set(false);
    this.rejected.set(false);
    const params: AdminAuditListParams = {
      ...filters,
      perPage,
      order,
      count: reuseTotal ? 0 : 1,
      ...(cursor ? { [cursor.kind]: cursor.value } : {}),
    };
    try {
      const res = await this.api.listAudit(params);
      if (seq !== this.requestSeq) return;
      this.rows.set(res.data);
      if (res.total !== null) {
        this.total.set(res.total);
        this.totalKey = key;
      } else if (!reuseTotal) {
        this.total.set(null);
        this.totalKey = null;
      }
      this.hasNext.set(res.has_next);
      this.hasPrev.set(res.has_prev);
      this.nextCursor.set(res.next_cursor);
      this.prevCursor.set(res.prev_cursor);
      this.emailsAvailable.set(res.actor_emails_available);
      this.liveMessage.set(moved ? this.pageMessage(res.data.length, order) : this.loadedMessage());
      if (moved) {
        afterNextRender(() => this.trail()?.focusResultLine(), { injector: this.injector });
      }
    } catch (err) {
      if (seq !== this.requestSeq) return;
      this.rows.set([]);
      this.total.set(null);
      this.totalKey = null;
      this.hasNext.set(false);
      this.hasPrev.set(false);
      this.nextCursor.set(null);
      this.prevCursor.set(null);
      if (isStatus(err, 400)) this.rejected.set(true);
      else this.failed.set(true);
    } finally {
      if (seq === this.requestSeq) this.loading.set(false);
    }
  }

  private loadedMessage(): string {
    const total = this.total();
    return total === null
      ? $localize`:@@admin.auditLog.announce.loadedShown:${this.rows().length}:SHOWN: entries shown.`
      : $localize`:@@admin.auditLog.announce.loaded:${total}:TOTAL: entries match these filters.`;
  }

  /** `$localize` has no plural, so the one-row case is its own message. */
  private pageMessage(shown: number, order: 'asc' | 'desc'): string {
    if (shown === 1) {
      return order === 'asc'
        ? $localize`:@@admin.auditLog.announce.pageOneOldest:Showing 1 entry, oldest first`
        : $localize`:@@admin.auditLog.announce.pageOneNewest:Showing 1 entry, newest first`;
    }
    return order === 'asc'
      ? $localize`:@@admin.auditLog.announce.pageOldest:Showing ${shown}:SHOWN: entries, oldest first`
      : $localize`:@@admin.auditLog.announce.pageNewest:Showing ${shown}:SHOWN: entries, newest first`;
  }

  protected retry(): void {
    const filters = this.effectiveFilters();
    if (filters) void this.load(filters, this.cursor(), this.order(), this.perPage());
  }

  // ── Form ───────────────────────────────────────────────────────────────────

  private draft(): AuditLogFilters {
    return dropUndefined({
      entity_type: this.entityType().trim() || undefined,
      entity_id: this.entityId().trim() || undefined,
      action: this.action().trim() || undefined,
      actor_id: this.actorId().trim() || undefined,
      actor_type: (this.actorType() ?? undefined) as AuditActorType | undefined,
      from: this.from() || undefined,
      to: this.to() || undefined,
    });
  }

  /** The draft as it would be sent: a preset (or the default window) resolved
   *  to dates. Validation runs on this, so "actor type with All time" is caught
   *  in the form, while "actor type with the 30-day default" is not refused. */
  private resolvedDraft(): AuditLogFilters {
    const draft = this.draft();
    if (draft.from !== undefined || draft.to !== undefined) return draft;
    const today = this.today() ?? utcDay(new Date());
    const chip = selectedRangeChip(draft, this.range());
    return chip === 'custom' ? draft : { ...draft, ...resolveRange(chip, today) };
  }

  /** Run the draft through the server's own schema and turn each refusal into
   *  a message beside its field. */
  private validate(): Partial<Record<FilterField, string>> {
    const result = AdminAuditLogQuerySchema.safeParse(this.resolvedDraft());
    if (result.success) return {};
    const out: Partial<Record<FilterField, string>> = {};
    for (const issue of result.error.issues) {
      const field = issue.path[0] as FilterField | undefined;
      if (!field || out[field]) continue;
      out[field] = this.messageFor(field, issue.code === 'custom');
    }
    return out;
  }

  private messageFor(field: FilterField, refinement: boolean): string {
    switch (field) {
      case 'entity_id':
        return refinement
          ? $localize`:@@admin.auditLog.error.entityIdNeedsType:An entity id needs an entity type. Add the type, or clear the id.`
          : $localize`:@@admin.auditLog.error.tooLong:This value is too long.`;
      case 'actor_type':
        return $localize`:@@admin.auditLog.error.actorTypeAlone:Actor type needs another filter or a date range. On its own it would count the whole ledger.`;
      case 'actor_id':
        return $localize`:@@admin.auditLog.error.actorId:Enter the account id. It is a UUID, never an email address.`;
      case 'from':
        return refinement
          ? $localize`:@@admin.auditLog.error.fromAfterTo:The start date is after the end date.`
          : $localize`:@@admin.auditLog.error.date:Enter a real date.`;
      case 'to':
        return $localize`:@@admin.auditLog.error.date:Enter a real date.`;
      case 'entity_type':
      case 'action':
        return $localize`:@@admin.auditLog.error.tooLong:This value is too long.`;
    }
  }

  protected errorId(field: FilterField): string {
    return `admin-audit-log-${field.replace('_', '-')}-error`;
  }

  /** `aria-describedby` for a field: its hint and its error, when present. */
  protected describedBy(field: FilterField, hintId: string | null = null): string | null {
    const ids = [hintId, this.errors()[field] ? this.errorId(field) : null].filter(Boolean);
    return ids.length > 0 ? ids.join(' ') : null;
  }

  protected apply(event?: Event): void {
    event?.preventDefault();
    this.submitted.set(true);
    if (this.hasErrors()) return;
    const queryParams: Params = { ...this.draft() };
    // A preset is written only when one was chosen, so a filter plus Apply
    // reads the full history rather than freezing the default window.
    if (this.range() !== null && !queryParams['from'] && !queryParams['to']) {
      queryParams['range'] = this.range();
    }
    void this.router.navigate([], {
      relativeTo: this.route,
      // Every field is written as-is, so an omitted one drops from the URL and
      // the cursor goes with it. Order and page size carry over.
      queryParams: { ...queryParams, ...this.viewParams() },
    });
  }

  /** Back to the bare URL (keeping order and page size), which is the default
   *  window. The draft is reset here, not by the URL effect: when the URL's
   *  filters are already clear, the navigation changes no filter and the
   *  effect never re-seeds. */
  protected clear(): void {
    this.seedDraft({}, null);
    void this.router.navigate([], { relativeTo: this.route, queryParams: this.viewParams() });
  }

  /** Order and page size, as URL params, with defaults left off. */
  private viewParams(): Params {
    const out: Params = {};
    if (this.order() !== 'desc') out['order'] = this.order();
    if (this.perPage() !== AUDIT_DEFAULT_PAGE_SIZE) out['perPage'] = this.perPage();
    return out;
  }

  // ── Presets ────────────────────────────────────────────────────────────────

  /** A chip clears both dates and becomes the draft preset. Apply sends it. */
  protected pickRange(range: AuditRange): void {
    this.range.set(range);
    this.from.set('');
    this.to.set('');
  }

  /** Typing a date clears the preset: the dates are now the window. */
  protected setDate(field: 'from' | 'to', value: string): void {
    this[field].set(value);
    if (value) this.range.set(null);
  }

  // ── Paging and sort ────────────────────────────────────────────────────────

  protected next(): void {
    const cursor = this.nextCursor();
    if (cursor) this.navigateView({ after: cursor, before: null });
  }

  protected prev(): void {
    const cursor = this.prevCursor();
    if (cursor) this.navigateView({ before: cursor, after: null });
  }

  protected first(): void {
    this.navigateView({ after: null, before: null });
  }

  protected setOrder(order: 'asc' | 'desc'): void {
    this.navigateView({ order: order === 'desc' ? null : order, after: null, before: null });
  }

  /** A new page size starts from the first page. Focus stays on the select. */
  protected setPerPage(perPage: number): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: {
        perPage: perPage === AUDIT_DEFAULT_PAGE_SIZE ? null : perPage,
        after: null,
        before: null,
      },
      queryParamsHandling: 'merge',
    });
  }

  /** A page or sort move: merge into the URL, and move focus to the result
   *  line once the rows land (the `reindex-history.ts` focus rule). */
  private navigateView(queryParams: Params): void {
    this.focusAfterLoad = true;
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams,
      queryParamsHandling: 'merge',
    });
  }

  protected inputValue(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }
}
