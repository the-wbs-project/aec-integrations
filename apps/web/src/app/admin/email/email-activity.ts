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
  type AdminEmailSendRow,
  type AdminEmailSummaryResponse,
  type AdminEmailSummaryRow,
  type AdminEmailUnmatchedEvent,
} from '@aeci/shared';

import { AdminPaginator } from '../admin-paginator';
import { AecSelect, type AecSelectOption } from '../../shared/aec-select/aec-select';
import { AdminEmailApi, type AdminEmailFilters } from './admin-email-api';
import { EmailSwitches } from './email-switches';

/** Rows per page. The spec's figure (§5.14); one page is a morning's sends on production. */
const PER_PAGE = 25;

/** Why a read failed, for the copy. Only an auth failure mentions the session. */
type LoadError = 'session' | 'other';

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
  imports: [AdminPaginator, AecSelect, DatePipe, EmailSwitches, RouterLink],
  templateUrl: './email-activity.html',
})
export class EmailActivity {
  private readonly api = inject(AdminEmailApi);
  private readonly titleSvc = inject(Title);
  /** The sending switches (AECI-1224). Refresh re-reads them with the rest of the page. */
  private readonly switches = viewChild(EmailSwitches);

  protected readonly perPage = PER_PAGE;
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
  }

  protected submitSearch(): void {
    this.address.set(this.addressDraft().trim());
    this.refilter();
  }

  protected clearSearch(): void {
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
    this.listBusy.set(true);
    this.listError.set(null);
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
        this.sends.set(res.data);
        this.total.set(res.total);
        this.unmatched.set(res.unmatched_events);
      } else {
        const res = await this.api.listSends(filters);
        this.sends.set(res.data);
        this.total.set(res.total);
        this.unmatched.set([]);
      }
      this.liveMessage.set(
        $localize`:@@admin.email.announce.loaded:Matching sends: ${this.total()}:COUNT:.`,
      );
    } catch (err) {
      this.listError.set(errorKind(err));
      this.sends.set([]);
      this.unmatched.set([]);
      this.total.set(0);
    } finally {
      this.listBusy.set(false);
      this.listFirstLoad.set(false);
    }
  }

  // ── View helpers ───────────────────────────────────────────────────────────

  protected outcomeLabel = outcomeLabel;
  protected deliveryLabel = deliveryLabel;

  /** True for the two outcomes that mean the mail did not go: worth a second look. */
  protected isFailure(outcome: string): boolean {
    return outcome === 'failed' || outcome === 'unknown';
  }

  /** True for the two delivery events an operator must act on. */
  protected isProblem(event: AdminEmailDeliveryEvent): boolean {
    return event === 'bounced' || event === 'complained';
  }

  /** A plain count. A zero is a fact, so it stays, but quietly: a table of zeros at full
   *  weight hides the one number that matters. Tertiary is safe here (base surface). */
  protected countClass(n: number): string {
    return n > 0 ? 'text-(--text-primary)' : 'text-(--text-tertiary)';
  }

  /** A count an operator must act on (failed, bounced, spam). The number carries the
   *  meaning; the colour and weight only draw the eye. */
  protected problemClass(n: number): string {
    return n > 0 ? 'font-bold text-(--status-error)' : 'text-(--text-tertiary)';
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
    return n > 0 ? 'font-bold text-(--accent-secondary-deep)' : 'text-(--text-tertiary)';
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
        return $localize`:@@admin.email.entity.contest:Field contest`;
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
  return err instanceof HttpErrorResponse && (err.status === 401 || err.status === 403)
    ? 'session'
    : 'other';
}
