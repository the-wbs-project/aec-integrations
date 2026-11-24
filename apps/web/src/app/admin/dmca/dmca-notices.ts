import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import {
  Component,
  Injector,
  LOCALE_ID,
  afterNextRender,
  computed,
  inject,
  signal,
} from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';

import {
  ApiErrorCode,
  dmcaTakedownLacksContent,
  type CreateDmcaNoticeRequest,
  type DmcaAction,
  type DmcaNotice,
  type DmcaNoticeKind,
  type DmcaNoticesResponse,
  type DmcaRestoreClock,
  type DmcaRestoreOutcome,
  type UpdateDmcaNoticeRequest,
} from '@aeci/shared';

import { AecSelect, type AecSelectOption } from '../../shared/aec-select/aec-select';
import { AecButton } from '../../shared/button/button';
import { Chip, type ConsoleChipTone } from '../../shared/chip/chip';
import {
  CHOICE_INPUT_CLASS,
  FIELD_HINT_CLASS,
  FIELD_INPUT_CLASS,
  FIELD_LABEL_CLASS,
} from '../../shared/form-field/form-field-classes';
import {
  CONSOLE_CAPTION_CLASS,
  CONSOLE_PANEL_CLASS,
  CONSOLE_TABLE,
} from '../console/console-table';
import { adminStatusTone, type AdminStatusKey } from '../console/status-tones';
import { AdminDmcaApi } from './admin-dmca-api';
import { isReplayedEvent } from '../../core/event-replay';
import {
  CONSOLE_FAILED_TEXT_CLASS,
  CONSOLE_LOAD_FAILED_CLASS,
  CONSOLE_STATUS_LINE_CLASS,
  CONSOLE_TEXT_LINK_CLASS,
} from '../console/console-detail';

/** The form's values. Dates are `YYYY-MM-DD` (UTC), and `''` means empty. */
export interface DmcaDraft {
  kind: DmcaNoticeKind;
  notice_id: string;
  received_on: string;
  submitter_name: string;
  submitter_contact: string;
  content_identified: string;
  work_claimed: string;
  account_id: string;
  vendor_id: string;
  action: DmcaAction;
  action_on: string;
  forwarded_on: string;
  court_action_on: string;
  restore_outcome: DmcaRestoreOutcome | '';
  restore_outcome_on: string;
  closed_on: string;
  notes: string;
}

export function emptyDraft(kind: DmcaNoticeKind = 'notice', today = ''): DmcaDraft {
  return {
    kind,
    notice_id: '',
    received_on: today,
    submitter_name: '',
    submitter_contact: '',
    content_identified: '',
    work_claimed: '',
    account_id: '',
    vendor_id: '',
    action: 'pending',
    action_on: '',
    forwarded_on: '',
    court_action_on: '',
    restore_outcome: '',
    restore_outcome_on: '',
    closed_on: '',
    notes: '',
  };
}

/** The UTC date of an ISO instant, or `''`. */
export function isoToDay(iso: string | null): string {
  return iso ? iso.slice(0, 10) : '';
}

/** Noon UTC of a `YYYY-MM-DD` day, or null. Noon UTC is the same calendar day in New York,
 *  which the restore clock counts from. */
export function dayToIso(day: string): string | null {
  return day ? `${day}T12:00:00.000Z` : null;
}

export function draftFrom(n: DmcaNotice): DmcaDraft {
  return {
    kind: n.kind,
    notice_id: n.notice_id ?? '',
    received_on: isoToDay(n.received_at),
    submitter_name: n.submitter_name ?? '',
    submitter_contact: n.submitter_contact ?? '',
    content_identified: n.content_identified ?? '',
    work_claimed: n.work_claimed ?? '',
    account_id: n.account_id ?? '',
    vendor_id: n.vendor_id ?? '',
    action: n.action,
    action_on: isoToDay(n.action_at),
    forwarded_on: isoToDay(n.forwarded_at),
    court_action_on: isoToDay(n.court_action_at),
    restore_outcome: n.restore_outcome ?? '',
    restore_outcome_on: isoToDay(n.restore_outcome_at),
    closed_on: isoToDay(n.closed_at),
    notes: n.notes ?? '',
  };
}

/** Draft key to its request value. Fields the kind does not carry map to undefined. */
function requestValues(d: DmcaDraft): Record<string, unknown> {
  const text = (s: string) => (s.trim() === '' ? null : s.trim());
  const counter = d.kind === 'counter_notice';
  return {
    received_at: dayToIso(d.received_on),
    submitter_name: text(d.submitter_name),
    submitter_contact: text(d.submitter_contact),
    content_identified: text(d.content_identified),
    work_claimed: counter ? undefined : text(d.work_claimed),
    account_id: text(d.account_id),
    vendor_id: text(d.vendor_id),
    action: d.action,
    action_at: dayToIso(d.action_on),
    forwarded_at: dayToIso(d.forwarded_on),
    court_action_at: counter ? dayToIso(d.court_action_on) : undefined,
    restore_outcome: counter ? d.restore_outcome || null : undefined,
    restore_outcome_at: counter ? dayToIso(d.restore_outcome_on) : undefined,
    closed_at: dayToIso(d.closed_on),
    notes: text(d.notes),
  };
}

/** The POST body. Empty optional fields are left out. */
export function createBody(d: DmcaDraft): CreateDmcaNoticeRequest {
  const body: Record<string, unknown> = { kind: d.kind };
  if (d.kind === 'counter_notice') body['notice_id'] = d.notice_id;
  for (const [key, value] of Object.entries(requestValues(d))) {
    if (value !== null && value !== undefined) body[key] = value;
  }
  return body as CreateDmcaNoticeRequest;
}

/** The PATCH body: only what the operator changed, plus the race sentinel. */
export function updateBody(
  original: DmcaDraft,
  d: DmcaDraft,
  expectedUpdatedAt: string,
): UpdateDmcaNoticeRequest {
  const before = requestValues(original);
  const after = requestValues(d);
  const body: Record<string, unknown> = { expected_updated_at: expectedUpdatedAt };
  for (const [key, value] of Object.entries(after)) {
    if (value === undefined) continue;
    if (value !== before[key]) body[key] = value;
  }
  return body as UpdateDmcaNoticeRequest;
}

/**
 * A draft that would take material down without saying what it is: `removed` or `disabled`
 * with no material identified. The API refuses it too (`dmcaTakedownLacksContent`).
 */
export function draftTakedownLacksContent(d: DmcaDraft): boolean {
  return dmcaTakedownLacksContent({
    action: d.action,
    content_identified: d.content_identified.trim(),
  });
}

/**
 * Can the draft be sent? Every notice is logged on receipt, complete or not, so the name,
 * the contact details and the material may be blank. A draft needs its received date, a
 * counter-notice its notice, and a takedown the material it took down.
 */
export function draftComplete(d: DmcaDraft): boolean {
  return (
    d.received_on !== '' &&
    (d.kind === 'notice' || d.notice_id !== '') &&
    !draftTakedownLacksContent(d)
  );
}

/** What the list shows for a value the notice did not give. */
export const NOT_GIVEN = $localize`:@@admin.dmca.notGiven:Not given`;

/** What the form is doing: logging a new row, or editing one. */
type DmcaFormMode = { mode: 'create' } | { mode: 'edit'; notice: DmcaNotice };

/** A notice followed by the counter-notices that answer it. */
export interface DmcaGroup {
  key: string;
  rows: DmcaNotice[];
}

/**
 * Nest counter-notices under their notice, keeping the API's urgency order: a group sits
 * where its most urgent row sat. A counter-notice whose notice is not in the list (a
 * filter hid it) is a group of its own.
 */
export function groupNotices(notices: readonly DmcaNotice[]): DmcaGroup[] {
  const present = new Set(notices.filter((n) => n.kind === 'notice').map((n) => n.id));
  const groups = new Map<string, DmcaGroup>();
  for (const n of notices) {
    const key = n.notice_id && present.has(n.notice_id) ? n.notice_id : n.id;
    if (!groups.has(key)) groups.set(key, { key, rows: [] });
  }
  for (const n of notices) {
    if (n.kind !== 'notice') continue;
    groups.get(n.id)?.rows.push(n);
  }
  for (const n of notices) {
    if (n.kind === 'notice') continue;
    const key = n.notice_id && present.has(n.notice_id) ? n.notice_id : n.id;
    groups.get(key)?.rows.push(n);
  }
  return [...groups.values()];
}

/** What a restore clock says, in a short sentence. Dates are formatted by the caller. */
export function clockLabel(clock: DmcaRestoreClock, opens: string, due: string): string {
  switch (clock.state) {
    case 'awaiting_forward':
      return $localize`:@@admin.dmca.clock.awaitingForward:Waiting to be forwarded to the complainant`;
    case 'waiting':
      return $localize`:@@admin.dmca.clock.waiting:Restore window opens ${opens}:DATE:`;
    case 'restore_window_open':
      return $localize`:@@admin.dmca.clock.open:Restore by ${due}:DATE:`;
    case 'overdue':
      return $localize`:@@admin.dmca.clock.overdue:Overdue. Restore was due by ${due}:DATE:`;
    case 'court_action':
      return $localize`:@@admin.dmca.clock.courtAction:Court action reported. Do not restore.`;
    case 'restored':
      return $localize`:@@admin.dmca.clock.restored:Restored`;
    case 'not_restored':
      return $localize`:@@admin.dmca.clock.notRestored:Not restored`;
  }
}

/**
 * The console status each restore clock state reads as (AECI-2128). Exhaustive, so a new
 * clock state is a compile error. The chip's words carry the state; the tone never does.
 */
export function clockStatusKey(state: DmcaRestoreClock['state']): AdminStatusKey {
  switch (state) {
    case 'awaiting_forward':
      return 'waitingToForward';
    case 'waiting':
      return 'restoreWindowOpens';
    case 'restore_window_open':
      return 'restoreBy';
    case 'overdue':
      return 'overdue';
    case 'court_action':
      return 'courtActionReported';
    case 'restored':
      return 'restored';
    case 'not_restored':
      return 'notRestored';
  }
}

/**
 * The page's looks beyond the console recipe (AECI-2128, mock-up 14). The table, panel
 * and label are the console's own; the fields are the shared field recipe.
 */
export const DMCA_CLASSES = {
  caption: CONSOLE_CAPTION_CLASS,
  panel: CONSOLE_PANEL_CLASS,
  /** A count's value under its Label-role term. */
  factValue: 'mt-1 text-t-16 font-semibold tabular-nums text-(--text-primary)',
  /** The log form: a console panel, fields 24px apart. */
  form: `${CONSOLE_PANEL_CLASS} grid gap-6`,
  /** Two columns of fields from 640px. */
  grid: 'grid gap-6 sm:grid-cols-2',
  /** One field: label, hint, control. */
  field: 'grid content-start gap-2',
  input: FIELD_INPUT_CLASS,
  /** An id field: the field recipe in the mono face. */
  inputMono: `${FIELD_INPUT_CLASS} font-mono`,
  hint: FIELD_HINT_CLASS,
  choice: CHOICE_INPUT_CLASS,
  /** The button row at the foot of the form. */
  actions: 'flex flex-wrap items-center gap-3',
  /** A link inside running text or a cell: the text's own ink, underlined. */
  inlineLink: CONSOLE_TEXT_LINK_CLASS,
  /** A loading or empty line. */
  statusLine: CONSOLE_STATUS_LINE_CLASS,
  /** A load failure: the sentence, then its Try again button. */
  loadFailed: CONSOLE_LOAD_FAILED_CLASS,
  /** The sentence of a load failure or a refused save. */
  failedText: CONSOLE_FAILED_TEXT_CLASS,
  /** A refresh that failed over rows already shown: a sunken box, hairline edge. */
  staleBox:
    'flex flex-wrap items-center justify-between gap-3 rounded-control border border-(--border-default) bg-(--surface-sunken) px-4 py-3',
} as const;

const ACTION_LABELS: Record<DmcaAction, string> = {
  pending: $localize`:@@admin.dmca.action.pending:Pending`,
  removed: $localize`:@@admin.dmca.action.removed:Removed`,
  disabled: $localize`:@@admin.dmca.action.disabled:Disabled`,
  no_action: $localize`:@@admin.dmca.action.noAction:No action`,
};

/**
 * `/admin/dmca`, the copyright notice log (AECI-1665, counsel Q38). Source of truth:
 * `docs/ADMIN_PANEL_SPEC.md` §5.23.
 *
 * One table of every DMCA notice, each followed by the counter-notices that answer it. A
 * counter-notice shows its restore clock, computed by the API: when the window opens, the
 * date to restore by, or that it is overdue. "Open only" hides closed rows, and
 * `?account=<profile id>` (linked from `/admin/users/:id`) shows one account's rows with
 * its takedown and counter-notice counts. One form logs a notice or a counter-notice and
 * edits either. An edit sends only the changed fields and the row's `updated_at`, so a
 * save that lost a race is refused (409) and says so.
 *
 * Rendered in the `AdminShell` layout's outlet; the parent's `adminSummaryResolver` is the
 * gate. The frame paints during SSR and the data loads in `afterNextRender`. The page
 * copies `/admin/legal`'s heading row, live region, bordered cards and button recipes,
 * and its focus handling: opening the form focuses its heading, and closing it returns
 * focus to the button that opened it.
 */
@Component({
  selector: 'aec-admin-dmca-notices',
  imports: [AecButton, AecSelect, Chip, RouterLink],
  templateUrl: './dmca-notices.html',
})
export class AdminDmcaNotices {
  private readonly api = inject(AdminDmcaApi);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);
  private readonly datePipe = new DatePipe(inject(LOCALE_ID));

  protected readonly t = CONSOLE_TABLE;
  protected readonly c = DMCA_CLASSES;
  protected readonly labelClass = FIELD_LABEL_CLASS;

  protected readonly data = signal<DmcaNoticesResponse | null>(null);
  protected readonly loading = signal(true);
  /**
   * The last load failed. With no rows yet the page shows only the error. With rows from an
   * earlier load it keeps them, so the deadlines stay visible, under a banner that says they
   * may be out of date. Cleared by the next successful load, not by starting one.
   */
  protected readonly loadFailed = signal(false);
  protected readonly liveMessage = signal('');

  /** `?account=`: one account's rows and counts. */
  protected readonly account = signal<string | null>(null);
  /** `?open=true`: hide closed rows. */
  protected readonly openOnly = signal(false);

  /** The open form: a new row, or the row being edited. Null when closed. */
  protected readonly editing = signal<DmcaFormMode | null>(null);
  protected readonly draft = signal<DmcaDraft>(emptyDraft());
  private original: DmcaDraft = emptyDraft();
  protected readonly saving = signal(false);
  /**
   * Which form a save belongs to. Every open, cancel and reload takes the next number, so a
   * save that completes after its form was replaced never closes or marks the newer one.
   * "Log a notice" and the row Edit buttons are also disabled while a save is pending.
   */
  private formToken = 0;
  protected readonly formError = signal('');
  /** The save lost a race (409). The form offers a reload. */
  protected readonly stale = signal(false);

  protected readonly groups = computed(() => groupNotices(this.data()?.notices ?? []));
  protected readonly complete = computed(() => draftComplete(this.draft()));
  protected readonly takedownLacksContent = computed(() => draftTakedownLacksContent(this.draft()));
  protected readonly notGiven = NOT_GIVEN;

  /**
   * Each list load takes the next number. Only the latest load may set `data`, `loading`
   * and `loadFailed`, so a slow response to an older filter never overwrites a newer one.
   */
  private listSeq = 0;
  /** The same rule for the "Counter-notice to" select's own load. */
  private noticesSeq = 0;
  protected readonly isCounter = computed(() => this.draft().kind === 'counter_notice');

  protected readonly actionOptions: readonly AecSelectOption[] = (
    ['pending', 'removed', 'disabled', 'no_action'] as const
  ).map((value) => ({ value, label: ACTION_LABELS[value] }));

  protected readonly outcomeOptions: readonly AecSelectOption[] = [
    { value: null, label: $localize`:@@admin.dmca.outcome.open:Not decided yet` },
    { value: 'restored', label: $localize`:@@admin.dmca.outcome.restored:Restored` },
    { value: 'not_restored', label: $localize`:@@admin.dmca.outcome.notRestored:Not restored` },
  ];

  /**
   * Every notice in the log, for the "Counter-notice to" select. Loaded unfiltered
   * (`?kind=notice`) when the create form opens, so "Open only" and `?account=` never hide
   * the notice a counter-notice answers. Null until loaded.
   */
  protected readonly allNotices = signal<readonly DmcaNotice[] | null>(null);
  protected readonly noticesFailed = signal(false);

  /** The notices a new counter-notice can answer: every notice, not just those on screen. */
  protected readonly noticeOptions = computed<readonly AecSelectOption[]>(() =>
    (this.allNotices() ?? [])
      .filter((n) => n.kind === 'notice')
      .map((n) => {
        const name = n.submitter_name ?? NOT_GIVEN;
        const day = this.day(n.received_at);
        return {
          value: n.id,
          label: $localize`:@@admin.dmca.form.noticeOption:${name}:NAME:, received ${day}:DATE:`,
        };
      }),
  );

  constructor() {
    afterNextRender(() => {
      const params = this.route.snapshot.queryParamMap;
      this.account.set(params.get('account') || null);
      this.openOnly.set(params.get('open') === 'true');
      void this.load();
    });
  }

  protected refresh(): void {
    void this.load();
  }

  private async load(): Promise<void> {
    const seq = ++this.listSeq;
    const latest = () => seq === this.listSeq;
    this.loading.set(true);
    try {
      const account = this.account();
      const data = await this.api.list({
        ...(account ? { account_id: account } : {}),
        ...(this.openOnly() ? { open: 'true' as const } : {}),
      });
      if (!latest()) return;
      this.data.set(data);
      this.loadFailed.set(false);
      const n = data.notices.length;
      this.liveMessage.set(
        n === 1
          ? $localize`:@@admin.dmca.live.loadedOne:1 row loaded.`
          : $localize`:@@admin.dmca.live.loaded:${n}:N: rows loaded.`,
      );
    } catch {
      if (!latest()) return;
      this.loadFailed.set(true);
      this.liveMessage.set(
        this.data()
          ? $localize`:@@admin.dmca.live.refreshFailed:The log could not be refreshed. It may be out of date.`
          : $localize`:@@admin.dmca.live.loadFailed:The log could not be loaded.`,
      );
    } finally {
      if (latest()) this.loading.set(false);
    }
  }

  protected onOpenOnly(event: Event): void {
    this.openOnly.set((event.target as HTMLInputElement).checked);
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { open: this.openOnly() ? 'true' : null },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
    void this.load();
  }

  protected clearAccount(): void {
    this.account.set(null);
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { account: null },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
    void this.load();
  }

  // ── Display helpers ────────────────────────────────────────────────────────

  /** `d MMM y` of a UTC date or instant. */
  protected day(value: string | null): string {
    if (!value) return '';
    const iso = value.length === 10 ? `${value}T00:00:00.000Z` : value;
    return this.datePipe.transform(iso, 'd MMM y', 'UTC') ?? '';
  }

  /** `HH:mm` (UTC) of an instant: when the rows on screen were loaded. */
  protected time(value: string): string {
    return this.datePipe.transform(value, 'HH:mm', 'UTC') ?? '';
  }

  protected clockText(clock: DmcaRestoreClock): string {
    return clockLabel(clock, this.day(clock.opens_on), this.day(clock.due_on));
  }

  protected clockTone(clock: DmcaRestoreClock): ConsoleChipTone {
    return adminStatusTone(clockStatusKey(clock.state));
  }

  protected actionLabel(action: DmcaAction): string {
    return ACTION_LABELS[action] ?? action;
  }

  // ── The form ───────────────────────────────────────────────────────────────

  protected openCreate(): void {
    const today = new Date().toISOString().slice(0, 10);
    const d = emptyDraft('notice', today);
    if (this.account()) d.account_id = this.account()!;
    this.original = d;
    this.draft.set(d);
    this.resetFormState();
    this.editing.set({ mode: 'create' });
    this.focusAfterRender('admin-dmca-form-heading');
    void this.loadAllNotices();
  }

  /** `GET ?kind=notice` with no other filter: the select's options. */
  protected async loadAllNotices(): Promise<void> {
    const seq = ++this.noticesSeq;
    this.noticesFailed.set(false);
    try {
      const all = await this.api.list({ kind: 'notice' });
      if (seq === this.noticesSeq) this.allNotices.set(all.notices);
    } catch {
      if (seq === this.noticesSeq) this.noticesFailed.set(true);
    }
  }

  protected openEdit(notice: DmcaNotice): void {
    const d = draftFrom(notice);
    this.original = d;
    this.draft.set(d);
    this.resetFormState();
    this.editing.set({ mode: 'edit', notice });
    this.focusAfterRender('admin-dmca-form-heading');
  }

  protected cancel(): void {
    const editing = this.editing();
    this.editing.set(null);
    this.resetFormState();
    this.returnFocus(editing);
  }

  /**
   * Escape closes the form, as Cancel does, except while a save is in flight. An Escape
   * that an open select inside the form already handled (it closes its own list) is left
   * alone.
   */
  protected onEscape(event: Event): void {
    if (this.saving() || event.defaultPrevented) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('[aria-expanded="true"]')) return;
    this.cancel();
  }

  /** Focus an element by id once the view has rendered. */
  private focusAfterRender(id: string): void {
    afterNextRender(() => globalThis.document?.getElementById(id)?.focus(), {
      injector: this.injector,
    });
  }

  /** Back to the button that opened the form: "Log a notice", or the row's Edit. */
  private returnFocus(editing: DmcaFormMode | null): void {
    if (!editing) return;
    this.focusAfterRender(
      editing.mode === 'create' ? 'admin-dmca-new' : `admin-dmca-edit-${editing.notice.id}`,
    );
  }

  private resetFormState(): void {
    this.formToken++;
    this.formError.set('');
    this.stale.set(false);
    this.saving.set(false);
  }

  protected setKind(kind: DmcaNoticeKind): void {
    this.patch({ kind });
  }

  protected onText(key: keyof DmcaDraft, event: Event): void {
    this.patch({ [key]: (event.target as HTMLInputElement | HTMLTextAreaElement).value });
  }

  protected onSelect(key: 'action' | 'restore_outcome' | 'notice_id', value: string | null): void {
    this.patch({ [key]: value ?? '' } as Partial<DmcaDraft>);
  }

  private patch(change: Partial<DmcaDraft>): void {
    this.draft.update((d) => ({ ...d, ...change }));
  }

  protected async save(event: Event): Promise<void> {
    if (isReplayedEvent(event)) return;
    event.preventDefault();
    const editing = this.editing();
    if (!editing || !this.complete() || this.saving()) return;
    this.saving.set(true);
    this.formError.set('');
    this.stale.set(false);
    const token = this.formToken;
    const mine = () => token === this.formToken;
    try {
      if (editing.mode === 'create') {
        await this.api.create(createBody(this.draft()));
        this.liveMessage.set($localize`:@@admin.dmca.live.created:Notice logged.`);
      } else {
        const body = updateBody(this.original, this.draft(), editing.notice.updated_at);
        await this.api.update(editing.notice.id, body);
        this.liveMessage.set($localize`:@@admin.dmca.live.updated:Notice saved.`);
      }
      // The write landed, so the list reloads either way. Only the form that sent it closes.
      if (!mine()) {
        await this.load();
        return;
      }
      this.editing.set(null);
      await this.load();
      this.returnFocus(editing);
    } catch (error) {
      if (mine()) {
        this.formError.set(this.errorText(error));
        // A refused save moves focus to its message (AECI-2128).
        this.focusAfterRender('admin-dmca-form-error');
      }
    } finally {
      if (mine()) this.saving.set(false);
    }
  }

  /** Reload after a 409, and close the form so the operator edits the current row. */
  protected async reloadAfterConflict(): Promise<void> {
    this.editing.set(null);
    this.resetFormState();
    await this.load();
  }

  private errorText(error: unknown): string {
    const generic = $localize`:@@admin.dmca.error.generic:The notice was not saved. Try again.`;
    if (!(error instanceof HttpErrorResponse)) return generic;
    const body = error.error as { error?: { code?: string; field?: string } } | null;
    const code = body?.error?.code;
    const field = body?.error?.field;
    if (error.status === 409 && code === ApiErrorCode.DMCA_NOTICE_CHANGED) {
      this.stale.set(true);
      return $localize`:@@admin.dmca.error.changed:Someone else changed this notice. Reload.`;
    }
    if (error.status === 404) {
      return $localize`:@@admin.dmca.error.notFound:This notice no longer exists. Reload.`;
    }
    if (code === ApiErrorCode.VALIDATION_FAILED) {
      switch (field) {
        case 'notice_id':
          return $localize`:@@admin.dmca.error.noticeId:Pick the notice this counter-notice answers.`;
        case 'account_id':
          return $localize`:@@admin.dmca.error.accountId:No account has that id.`;
        case 'vendor_id':
          return $localize`:@@admin.dmca.error.vendorId:No vendor has that id.`;
        case 'content_identified':
          return $localize`:@@admin.dmca.error.content:A removed or disabled notice needs the material identified.`;
      }
      return $localize`:@@admin.dmca.error.validation:Check the form. A value was refused.`;
    }
    return generic;
  }
}
