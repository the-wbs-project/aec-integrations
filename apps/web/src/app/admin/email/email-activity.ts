import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { Component, afterNextRender, computed, inject, signal, viewChild } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { RouterLink } from '@angular/router';

import {
  ADMIN_EMAIL_DELIVERY_FILTERS,
  ADMIN_EMAIL_SEND_OUTCOMES,
  resendEmailDashboardUrl,
  type AdminEmailDeliveryEvent,
  type AdminEmailEntity,
  type AdminEmailSendOutcome,
  type AdminEmailSendRow,
  type AdminEmailSummaryResponse,
  type AdminEmailSummaryRow,
  type AdminEmailUnmatchedEvent,
} from '@aeci/shared';

import { AdminPaginator } from '../admin-paginator';
import { CONSOLE_FILTER } from '../console/console-filter';
import { CONSOLE_CAPTION_CLASS, CONSOLE_TABLE } from '../console/console-table';
import { adminStatusTone, type AdminStatusKey } from '../console/status-tones';
import { AecSelect, type AecSelectOption } from '../../shared/aec-select/aec-select';
import { AecButton } from '../../shared/button/button';
import { Chip, type ConsoleChipTone } from '../../shared/chip/chip';
import {
  FIELD_ERROR_CLASS,
  FIELD_HINT_CLASS,
  FIELD_INPUT_CLASS,
  FIELD_LABEL_CLASS,
} from '../../shared/form-field/form-field-classes';
import { AecIcon } from '../../shared/icon/icon';
import { AdminEmailApi, type AdminEmailFilters } from './admin-email-api';
import { EmailSwitches } from './email-switches';
import { isReplayedEvent } from '../../core/event-replay';
import {
  CONSOLE_FAILED_TEXT_CLASS,
  CONSOLE_LOAD_FAILED_CLASS,
  CONSOLE_STATUS_LINE_CLASS,
} from '../console/console-detail';

/** A link in a cell that is not the row's identity: the text's ink, underlined. */
const EMAIL_INLINE_LINK_CLASS =
  'rounded-mark text-(--text-primary) underline decoration-(--border-strong) underline-offset-4 hover:decoration-(--accent-primary) focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--accent-primary)';
/** A template id: the code face at 13px, the row head's weight. */
const EMAIL_KEY_CLASS = 'block font-mono text-t-13 text-(--text-primary)';
/** The summary's column-group header over the outcome and delivery columns. */
const EMAIL_GROUP_HEAD_CLASS =
  'px-3 pb-1 text-start align-bottom text-t-13 font-semibold leading-[1.4] tracking-[0.01em] text-(--text-secondary)';
/** The hairline that starts the summary's delivery column group. */
const EMAIL_GROUP_START_CLASS = 'border-s border-s-(--border-default)';

/** Rows per page. The spec's figure (§5.14); one page is a morning's sends on production. */
const PER_PAGE = 25;

/** Why a read failed, for the copy. Only an auth failure mentions the session. `invalid` is
 *  input the server refuses (400): retrying the same input cannot help, so it has no retry. */
type LoadError = 'session' | 'invalid' | 'other';

/** The two summary windows. */
type SummaryWindow = 'd7' | 'd30';

/**
 * `/admin/email`: what we sent, and whether it arrived. AECI-1223.
 * Source of truth: `docs/ADMIN_PANEL_SPEC.md` §5.14 and §13 D23.
 *
 * Rendered in the `AdminShell` layout's outlet, so the gate and nav SSR through
 * `adminSummaryResolver` on the parent route. The screen paints its frame during SSR and
 * fetches in `afterNextRender`, like every other console screen.
 *
 * ─── Four things this screen is careful about ─────────────────────────────────
 *
 * **1. It never holds an address longer than the request.** The ledger is hash-only
 * (ADR 0038). The address the operator types is sent in a POST body, never put in the URL
 * or the page title, and the response carries none back. Filters are component state, not
 * query parameters, for the same reason: one rule for every filter is easier to keep than
 * "everything in the URL except the address".
 *
 * **2. The table stays mounted while it refetches.** Replacing it with a loading line would
 * destroy the control the operator just pressed and drop keyboard focus to the body (the
 * baseline critique of `/admin/subscribers`, `.impeccable/critique/`). Only the first load
 * shows the loading line. After that the region is `aria-busy` and says "Updating".
 *
 * **3. Summary and list fail separately.** Each has its own error block and retry, so a
 * failed summary does not hide the list an operator came for.
 *
 * **4. Empty and "no matches" are different sentences.** A tier that has sent nothing is a
 * state of the product. A filter that matched nothing is a state of the query.
 */
@Component({
  selector: 'aec-email-activity',
  imports: [
    AdminPaginator,
    AecButton,
    AecIcon,
    AecSelect,
    Chip,
    DatePipe,
    EmailSwitches,
    RouterLink,
  ],
  templateUrl: './email-activity.html',
})
export class EmailActivity {
  private readonly api = inject(AdminEmailApi);
  private readonly titleSvc = inject(Title);
  /** The sending switches (AECI-1224). Refresh re-reads them with the rest of the page. */
  private readonly switches = viewChild(EmailSwitches);

  protected readonly perPage = PER_PAGE;
  protected readonly t = CONSOLE_TABLE;
  protected readonly f = CONSOLE_FILTER;
  protected readonly captionClass = CONSOLE_CAPTION_CLASS;
  protected readonly labelClass = FIELD_LABEL_CLASS;
  protected readonly inputClass = FIELD_INPUT_CLASS;
  protected readonly hintClass = FIELD_HINT_CLASS;
  protected readonly errorClass = FIELD_ERROR_CLASS;
  protected readonly statusLineClass = CONSOLE_STATUS_LINE_CLASS;
  protected readonly loadFailedClass = CONSOLE_LOAD_FAILED_CLASS;
  protected readonly failedTextClass = CONSOLE_FAILED_TEXT_CLASS;
  protected readonly inlineLinkClass = EMAIL_INLINE_LINK_CLASS;
  protected readonly keyClass = EMAIL_KEY_CLASS;
  protected readonly groupHeadClass = EMAIL_GROUP_HEAD_CLASS;
  protected readonly groupStartClass = EMAIL_GROUP_START_CLASS;
  protected readonly resendUrl = resendEmailDashboardUrl;

  // ── Summary ────────────────────────────────────────────────────────────────
  protected readonly summary = signal<AdminEmailSummaryResponse | null>(null);
  protected readonly summaryLoading = signal(true);
  protected readonly summaryError = signal<LoadError | null>(null);
  protected readonly window = signal<SummaryWindow>('d7');
  protected readonly windows: readonly SummaryWindow[] = ['d7', 'd30'];

  // ── The list ───────────────────────────────────────────────────────────────
  protected readonly sends = signal<readonly AdminEmailSendRow[]>([]);
  protected readonly unmatched = signal<readonly AdminEmailUnmatchedEvent[]>([]);
  protected readonly total = signal(0);
  protected readonly page = signal(1);
  /** True until the first list response, success or failure. */
  protected readonly listFirstLoad = signal(true);
  protected readonly listBusy = signal(false);
  protected readonly listError = signal<LoadError | null>(null);
  protected readonly liveMessage = signal('');

  /** The address last SENT. Search is submit-only: nothing is hashed per keystroke. */
  protected readonly address = signal('');
  protected readonly addressDraft = signal('');
  /** The draft was submitted without an `@`. Checked here so a typo is not sent. */
  protected readonly addressInvalid = signal(false);

  /** Bumped by every list load. A response whose number is no longer current is dropped, so
   *  a slow earlier search can never paint its rows under a newer one. */
  private listSeq = 0;
  /** `null` is "any", the `AecSelect` convention. */
  protected readonly template = signal<string | null>(null);
  protected readonly outcome = signal<string | null>(null);
  protected readonly delivery = signal<string | null>(null);
  protected readonly from = signal('');
  protected readonly to = signal('');

  protected readonly anyFilter = computed(
    () =>
      this.address() !== '' ||
      this.template() !== null ||
      this.outcome() !== null ||
      this.delivery() !== null ||
      this.from() !== '' ||
      this.to() !== '',
  );

  /** Nothing sent from this tier yet, and no filter narrowing it. */
  protected readonly isEmpty = computed(
    () => !this.listFirstLoad() && !this.anyFilter() && this.total() === 0,
  );
  /** A filter or search matched nothing. */
  protected readonly noMatches = computed(
    () => !this.listFirstLoad() && this.anyFilter() && this.total() === 0,
  );

  protected readonly summaryRows = computed<readonly AdminEmailSummaryRow[]>(
    () => this.summary()?.rows ?? [],
  );

  protected readonly templateOptions = computed<readonly AecSelectOption[]>(() => {
    const ids = new Set((this.summary()?.templates ?? []).map((x) => x.id));
    // An id only the ledger knows (a renamed template) is still filterable.
    for (const row of this.summaryRows()) ids.add(row.notification_id);
    return [
      { value: null, label: $localize`:@@admin.email.filter.template.any:Any template` },
      ...[...ids].map((id) => ({ value: id, label: id })),
    ];
  });

  protected readonly outcomeOptions: readonly AecSelectOption[] = [
    { value: null, label: $localize`:@@admin.email.filter.outcome.any:Any outcome` },
    ...ADMIN_EMAIL_SEND_OUTCOMES.map((o) => ({ value: o, label: outcomeLabel(o) })),
  ];

  protected readonly deliveryOptions: readonly AecSelectOption[] = [
    { value: null, label: $localize`:@@admin.email.filter.delivery.any:Any delivery status` },
    ...ADMIN_EMAIL_DELIVERY_FILTERS.map((d) => ({
      value: d,
      label:
        d === 'none' ? $localize`:@@admin.email.delivery.none:No report yet` : deliveryLabel(d),
    })),
  ];

  constructor() {
    this.titleSvc.setTitle($localize`:@@admin.email.metaTitle:Email · Admin · AEC Integrations`);
    afterNextRender(() => {
      void this.loadSummary();
      void this.loadList();
    });
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  protected refresh(): void {
    void this.loadSummary();
    void this.loadList();
    this.switches()?.reload();
  }

  /** The switches section announces through this page's one live region. */
  protected onSwitchAnnounce(message: string): void {
    this.liveMessage.set(message);
  }

  protected setWindow(w: SummaryWindow): void {
    this.window.set(w);
  }

  protected onAddressInput(event: Event): void {
    this.addressDraft.set((event.target as HTMLInputElement).value);
    this.addressInvalid.set(false);
  }

  /** The form's submit. Drops a replayed early submit. The form is `method="dialog"`,
   *  so the native submit did nothing (AECI-1919, `core/event-replay.ts`). */
  protected onSearchSubmit(event: Event): void {
    if (isReplayedEvent(event)) return;
    event.preventDefault();
    this.submitSearch();
  }

  protected submitSearch(): void {
    const draft = this.addressDraft().trim();
    // The server refuses an address with no `@`. Say so here rather than send it.
    if (draft !== '' && !draft.includes('@')) {
      this.addressInvalid.set(true);
      return;
    }
    this.addressInvalid.set(false);
    this.address.set(draft);
    this.refilter();
  }

  protected clearSearch(): void {
    this.addressInvalid.set(false);
    this.addressDraft.set('');
    this.address.set('');
    this.refilter();
  }

  protected onTemplate(value: string | null): void {
    this.template.set(value);
    this.refilter();
  }

  protected onOutcome(value: string | null): void {
    this.outcome.set(value);
    this.refilter();
  }

  protected onDelivery(value: string | null): void {
    this.delivery.set(value);
    this.refilter();
  }

  protected onFrom(event: Event): void {
    this.from.set((event.target as HTMLInputElement).value);
    this.refilter();
  }

  protected onTo(event: Event): void {
    this.to.set((event.target as HTMLInputElement).value);
    this.refilter();
  }

  /** One action that resets every filter, the search included. */
  protected clearFilters(): void {
    this.addressInvalid.set(false);
    this.addressDraft.set('');
    this.address.set('');
    this.template.set(null);
    this.outcome.set(null);
    this.delivery.set(null);
    this.from.set('');
    this.to.set('');
    this.refilter();
  }

  protected goToPage(page: number): void {
    this.page.set(page);
    void this.loadList();
  }

  protected retrySummary(): void {
    void this.loadSummary();
  }

  protected retryList(): void {
    void this.loadList();
  }

  private refilter(): void {
    this.page.set(1);
    void this.loadList();
  }

  // ── Loads ──────────────────────────────────────────────────────────────────

  private async loadSummary(): Promise<void> {
    this.summaryLoading.set(true);
    this.summaryError.set(null);
    try {
      this.summary.set(await this.api.summary());
    } catch (err) {
      this.summaryError.set(errorKind(err));
    } finally {
      this.summaryLoading.set(false);
    }
  }

  private async loadList(): Promise<void> {
    const seq = ++this.listSeq;
    this.listBusy.set(true);
    this.listError.set(null);
    // A typed `from` after `to` gets past the pickers' min/max. The server refuses it, so
    // refuse it here without a request.
    if (this.from() && this.to() && this.from() > this.to()) {
      this.listError.set('invalid');
      this.sends.set([]);
      this.unmatched.set([]);
      this.total.set(0);
      this.listBusy.set(false);
      this.listFirstLoad.set(false);
      return;
    }
    const filters: AdminEmailFilters = {
      page: this.page(),
      perPage: this.perPage,
      template: this.template() ?? undefined,
      outcome: this.outcome() ?? undefined,
      delivery: this.delivery() ?? undefined,
      from: this.from() || undefined,
      to: this.to() || undefined,
    };
    const address = this.address();
    try {
      if (address) {
        const res = await this.api.searchSends(address, filters);
        if (seq !== this.listSeq) return;
        this.sends.set(res.data);
        this.total.set(res.total);
        this.unmatched.set(res.unmatched_events);
      } else {
        const res = await this.api.listSends(filters);
        if (seq !== this.listSeq) return;
        this.sends.set(res.data);
        this.total.set(res.total);
        this.unmatched.set([]);
      }
      this.liveMessage.set(
        $localize`:@@admin.email.announce.loaded:Matching sends: ${this.total()}:COUNT:.`,
      );
    } catch (err) {
      if (seq !== this.listSeq) return;
      this.listError.set(errorKind(err));
      this.sends.set([]);
      this.unmatched.set([]);
      this.total.set(0);
    } finally {
      // Only the newest load owns the busy flag. An older one finishing must not clear it
      // while the newer request is still in flight.
      if (seq === this.listSeq) {
        this.listBusy.set(false);
        this.listFirstLoad.set(false);
      }
    }
  }

  // ── View helpers ───────────────────────────────────────────────────────────

  protected outcomeLabel = outcomeLabel;
  protected deliveryLabel = deliveryLabel;

  /** A send outcome's chip tone (`ADMIN_STATUS_TONES`). */
  protected outcomeTone(outcome: AdminEmailSendOutcome): ConsoleChipTone {
    return adminStatusTone(outcomeStatusKey(outcome));
  }

  /** A delivery report's chip tone (`ADMIN_STATUS_TONES`). */
  protected deliveryTone(event: AdminEmailDeliveryEvent): ConsoleChipTone {
    return adminStatusTone(deliveryStatusKey(event));
  }

  /** A plain count, a console number cell. A zero is a fact, so it stays, but quietly: a
   *  table of zeros at full weight hides the one number that matters. Secondary, not
   *  tertiary, because a row takes the muted fill on hover. */
  protected countClass(n: number): string {
    return `${CONSOLE_TABLE.num} ${n > 0 ? 'text-(--text-primary)' : 'text-(--text-secondary)'}`;
  }

  /** A count an operator must act on (failed, bounced, spam). The number carries the
   *  meaning; the colour and weight only draw the eye. */
  protected problemClass(n: number): string {
    return `${CONSOLE_TABLE.num} ${n > 0 ? 'font-semibold text-(--status-error)' : 'text-(--text-secondary)'}`;
  }

  /** The summary's send-outcome columns, in order. `paused` (AECI-1224) is last. */
  protected readonly summaryOutcomes = [
    'sent',
    'failed',
    'unknown',
    'skipped',
    'suppressed',
    'duplicate',
    'paused',
  ] as const;

  /** `unknown`: the mail may or may not have gone. Warning hue, not error. */
  protected cautionClass(n: number): string {
    return `${CONSOLE_TABLE.num} ${n > 0 ? 'font-semibold text-(--accent-secondary-deep)' : 'text-(--text-secondary)'}`;
  }

  /** The related entity's kind, in words. The admin path already says whether a request is
   *  a claim or a correction, so it decides that label. An unknown type shows as stored. */
  protected entityLabel(entity: AdminEmailEntity): string {
    switch (entity.type) {
      case 'vendor':
        return $localize`:@@admin.email.entity.vendor:Vendor`;
      case 'profile':
        return $localize`:@@admin.email.entity.profile:Account`;
      case 'vendor_request':
        if (entity.admin_path?.startsWith('/admin/claims/')) {
          return $localize`:@@admin.email.entity.claim:Vendor claim`;
        }
        if (entity.admin_path === '/admin/requests') {
          return $localize`:@@admin.email.entity.correction:Correction request`;
        }
        return $localize`:@@admin.email.entity.request:Vendor request`;
      case 'review':
        return $localize`:@@admin.email.entity.review:Review`;
      case 'integration_field_challenge':
        return $localize`:@@admin.email.entity.contest:Change request`;
      case 'mailing_list':
        return $localize`:@@admin.email.entity.subscriber:Subscriber`;
      default:
        return entity.type;
    }
  }

  /** Resend's event time, parsed when it parses. A string Resend sends in another shape is
   *  shown as written rather than dropped. */
  protected eventDate(value: string): Date | null {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : new Date(ms);
  }
}

/**
 * Each ledger outcome's console status (AECI-2128). Exhaustive, so a new outcome is a
 * compile error. `unknown` is the email ledger's own key: a send nobody can confirm.
 */
function outcomeStatusKey(outcome: AdminEmailSendOutcome): AdminStatusKey {
  switch (outcome) {
    case 'sending':
      return 'sending';
    case 'sent':
      return 'sent';
    case 'failed':
      return 'failed';
    case 'unknown':
      return 'emailUnconfirmed';
    case 'skipped':
      return 'skipped';
    case 'suppressed':
      return 'suppressed';
    case 'duplicate':
      return 'duplicate';
    case 'paused':
      return 'paused';
  }
}

/** Each Resend delivery event's console status (AECI-2128). Exhaustive, as above. */
function deliveryStatusKey(event: AdminEmailDeliveryEvent): AdminStatusKey {
  switch (event) {
    case 'sent':
      return 'acceptedByProvider';
    case 'delivered':
      return 'delivered';
    case 'delivery_delayed':
      return 'delayed';
    case 'bounced':
      return 'bounced';
    case 'complained':
      return 'markedAsSpam';
  }
}

/** The ledger outcome, in words. */
function outcomeLabel(outcome: string): string {
  switch (outcome) {
    case 'sending':
      return $localize`:@@admin.email.outcome.sending:Sending`;
    case 'sent':
      return $localize`:@@admin.email.outcome.sent:Sent`;
    case 'failed':
      return $localize`:@@admin.email.outcome.failed:Failed`;
    case 'unknown':
      return $localize`:@@admin.email.outcome.unknown:Unknown`;
    case 'skipped':
      return $localize`:@@admin.email.outcome.skipped:Skipped`;
    case 'suppressed':
      return $localize`:@@admin.email.outcome.suppressed:Suppressed`;
    case 'duplicate':
      return $localize`:@@admin.email.outcome.duplicate:Duplicate`;
    case 'paused':
      return $localize`:@@admin.email.outcome.paused:Paused`;
    default:
      return outcome;
  }
}

/** A Resend delivery event, in words. */
function deliveryLabel(event: string): string {
  switch (event) {
    case 'sent':
      return $localize`:@@admin.email.delivery.sent:Accepted by Resend`;
    case 'delivered':
      return $localize`:@@admin.email.delivery.delivered:Delivered`;
    case 'delivery_delayed':
      return $localize`:@@admin.email.delivery.delayed:Delayed`;
    case 'bounced':
      return $localize`:@@admin.email.delivery.bounced:Bounced`;
    case 'complained':
      return $localize`:@@admin.email.delivery.complained:Marked as spam`;
    default:
      return event;
  }
}

function errorKind(err: unknown): LoadError {
  if (!(err instanceof HttpErrorResponse)) return 'other';
  if (err.status === 401 || err.status === 403) return 'session';
  if (err.status === 400) return 'invalid';
  return 'other';
}
