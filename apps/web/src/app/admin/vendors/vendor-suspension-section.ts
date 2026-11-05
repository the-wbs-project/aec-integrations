import { DatePipe } from '@angular/common';
import {
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';

import {
  ADMIN_REASON_MAX,
  VENDOR_SUSPENSION_EVIDENCE_MAX,
  VENDOR_SUSPENSION_RULE_MAX,
  type VendorSuspension,
  type VendorSuspensionKind,
  type VendorSuspensionStateResponse,
  type VendorSuspensionWriteResponse,
  type VendorTerminationRefund,
} from '@aeci/shared';

import { AdminVendorSuspensionApi } from './admin-vendor-suspension-api';
import { SuspensionCostLog } from './suspension-cost-log';
import { SuspensionStatement } from './suspension-statement';
import { SuspensionTerminate } from './suspension-terminate';
import {
  SUSPENSION_BUTTON,
  SUSPENSION_CONFIRM_BUTTON,
  SUSPENSION_INPUT,
  currentNoticeUnconfirmed,
  formatCents,
  isStaleError,
  suspensionErrorMessage,
} from './vendor-suspension-model';

/**
 * How long after Terminate the page re-reads the state. The API answers once the D1 batch
 * commits, and the Stripe refunds settle after that under `waitUntil`, so the first answer
 * always shows them `pending`. Refresh is on screen for a refund that takes longer.
 */
export const REFUND_SETTLE_DELAY_MS = 5_000;

/** The actions that share a pending flag and a failure slot. */
type SuspensionAction = 'suspend' | 'resend' | 'stage2' | 'lift' | 'retry';

/**
 * Suspend, then terminate, on the Vendor tab of `/admin/vendors/:id` (AECI-1623,
 * `ADMIN_PANEL_SPEC.md` §5.7, `routes/admin-vendor-suspension.ts`).
 *
 * Suspend locks every seat out and sends a notice. The first confirmed send starts 7
 * business days. Then the operator lifts or terminates. A false-claim finding adds stage 2,
 * with its own notice and 7 more business days. A notice that was not confirmed means no
 * clock, and this section says so.
 *
 * ── ONE READ BEHIND EVERY WRITE ─────────────────────────────────────────────
 * A write answers with the suspension it changed, which is applied at once. The state is
 * then re-read, because only that read carries the refund preview, and Terminate must send
 * the numbers it shows. {@link load} drops an answer that a newer read has overtaken.
 *
 * ── HOST-OWNED CHROME ───────────────────────────────────────────────────────
 * No heading and no live region: `VendorDetail` owns both. It reloads the audit trail on
 * {@link changed} and the vendor and Billing on {@link terminated}. Nothing here blanks the
 * section on a re-read, so a form in progress keeps its text and its focus.
 */
@Component({
  selector: 'aec-vendor-suspension-section',
  imports: [DatePipe, SuspensionCostLog, SuspensionStatement, SuspensionTerminate],
  templateUrl: './vendor-suspension-section.html',
})
export class VendorSuspensionSection {
  private readonly api = inject(AdminVendorSuspensionApi);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);

  readonly vendorId = input.required<string>();
  readonly idPrefix = input.required<string>();

  /** A write committed, so the audit trail moved. */
  readonly changed = output<void>();
  /** Terminate committed: seats, ownership and subscriptions all moved. */
  readonly terminated = output<void>();
  /** Text for the host's polite live region. */
  readonly announce = output<string>();

  protected readonly buttonClass = SUSPENSION_BUTTON;
  protected readonly confirmClass = SUSPENSION_CONFIRM_BUTTON;
  protected readonly inputClass = SUSPENSION_INPUT;
  protected readonly ruleMax = VENDOR_SUSPENSION_RULE_MAX;
  protected readonly evidenceMax = VENDOR_SUSPENSION_EVIDENCE_MAX;
  protected readonly reasonMax = ADMIN_REASON_MAX;

  protected readonly state = signal<VendorSuspensionStateResponse | null>(null);
  protected readonly loading = signal(true);
  protected readonly loadFailed = signal(false);
  /** A re-read failed with state on screen: it stays, with a note and a Refresh. */
  protected readonly refreshFailed = signal(false);
  private loadSeq = 0;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;

  protected readonly open = computed(() => this.state()?.open ?? null);
  protected readonly preview = computed(() => this.state()?.preview ?? null);
  protected readonly resolvedRows = computed(() =>
    (this.state()?.history ?? []).filter((s) => s.resolution !== null),
  );
  /** The retry route acts on the newest terminated suspension and no other. */
  private readonly latestTerminatedId = computed(
    () => this.resolvedRows().find((s) => s.resolution === 'terminated')?.id ?? null,
  );
  protected readonly noticeUnconfirmed = computed(() => {
    const open = this.open();
    return open !== null && currentNoticeUnconfirmed(open);
  });

  protected readonly pendingAction = signal<SuspensionAction | null>(null);
  private readonly failure = signal<{ action: SuspensionAction; message: string } | null>(null);
  /** The last send's answer, when it reached no address. */
  protected readonly noticeFailed = signal(false);

  // ── Suspend form ───────────────────────────────────────────────────────────
  protected readonly suspendOpen = signal(false);
  protected readonly kind = signal<VendorSuspensionKind>('breach');
  protected readonly rule = signal('');
  protected readonly evidence = signal('');
  protected readonly reason = signal('');
  protected readonly suspendShowErrors = signal(false);

  // ── Stage 2 and Lift forms ─────────────────────────────────────────────────
  protected readonly stage2Open = signal(false);
  protected readonly finding = signal('');
  protected readonly findingError = signal(false);
  protected readonly liftOpen = signal(false);
  protected readonly liftReason = signal('');
  protected readonly liftReasonError = signal(false);

  constructor() {
    afterNextRender(() => void this.load());
    this.destroyRef.onDestroy(() => this.clearSettleTimer());
  }

  protected reload(): void {
    void this.load();
  }

  private async load(): Promise<void> {
    const seq = ++this.loadSeq;
    if (!this.state()) this.loadFailed.set(false);
    try {
      const next = await this.api.getState(this.vendorId());
      if (seq !== this.loadSeq) return;
      this.state.set(next);
      this.refreshFailed.set(false);
    } catch {
      if (seq !== this.loadSeq) return;
      if (this.state()) this.refreshFailed.set(true);
      else this.loadFailed.set(true);
    } finally {
      if (seq === this.loadSeq) this.loading.set(false);
    }
  }

  protected retryLoad(): void {
    this.loading.set(true);
    this.loadFailed.set(false);
    void this.load();
  }

  /** Puts a write's answer on screen, ahead of the re-read that follows it. */
  private apply(suspension: VendorSuspension): void {
    this.state.update((current) => {
      const history = current?.history ?? [];
      const nextHistory = history.some((s) => s.id === suspension.id)
        ? history.map((s) => (s.id === suspension.id ? suspension : s))
        : [suspension, ...history];
      const open =
        suspension.resolved_at === null
          ? suspension
          : current?.open?.id === suspension.id
            ? null
            : (current?.open ?? null);
      return { open, history: nextHistory, preview: open ? (current?.preview ?? null) : null };
    });
  }

  protected failureFor(action: SuspensionAction): string {
    const failure = this.failure();
    return failure?.action === action ? failure.message : '';
  }

  /** The shared half of each action: one in flight, its failure beside its button. */
  private async run(
    action: SuspensionAction,
    call: () => Promise<VendorSuspensionWriteResponse>,
    announcement: (response: VendorSuspensionWriteResponse) => string,
  ): Promise<boolean> {
    if (this.pendingAction()) return false;
    this.pendingAction.set(action);
    this.failure.set(null);
    try {
      const response = await call();
      this.apply(response.suspension);
      if (response.notice_sent !== undefined) this.noticeFailed.set(!response.notice_sent);
      this.changed.emit();
      this.announce.emit(announcement(response));
      void this.load();
      return true;
    } catch (err) {
      this.failure.set({ action, message: suspensionErrorMessage(err) });
      if (isStaleError(err)) void this.load();
      return false;
    } finally {
      this.pendingAction.set(null);
    }
  }

  private noticeAnnouncement(response: VendorSuspensionWriteResponse, done: string): string {
    return response.notice_sent === false
      ? $localize`:@@admin.vendors.suspension.announce.noticeFailed:${done}:DONE: The notice was not confirmed sent, so there is no clock yet.`
      : $localize`:@@admin.vendors.suspension.announce.noticeSent:${done}:DONE: The notice was sent and the window has started.`;
  }

  private focusFirstInvalid(): void {
    this.focus('[aria-invalid="true"]');
  }

  private focus(selector: string): void {
    afterNextRender(() => this.host.nativeElement.querySelector<HTMLElement>(selector)?.focus(), {
      injector: this.injector,
    });
  }

  // ── Suspend ────────────────────────────────────────────────────────────────

  protected openSuspend(): void {
    this.kind.set('breach');
    this.rule.set('');
    this.evidence.set('');
    this.reason.set('');
    this.suspendShowErrors.set(false);
    this.failure.set(null);
    this.suspendOpen.set(true);
    this.focus(`[id="${this.idPrefix()}-suspend-kind-breach"]`);
  }

  protected cancelSuspend(): void {
    this.suspendOpen.set(false);
  }

  protected onSuspendInput(field: 'rule' | 'evidence' | 'reason', event: Event): void {
    this[field].set((event.target as HTMLTextAreaElement).value);
  }

  protected async submitSuspend(): Promise<void> {
    const rule = this.rule().trim();
    const evidence = this.evidence().trim();
    const reason = this.reason().trim();
    if (!rule || !evidence || !reason) {
      this.suspendShowErrors.set(true);
      this.focusFirstInvalid();
      return;
    }
    const ok = await this.run(
      'suspend',
      () => this.api.suspend(this.vendorId(), { kind: this.kind(), rule, evidence, reason }),
      (response) =>
        this.noticeAnnouncement(
          response,
          $localize`:@@admin.vendors.suspension.announce.suspended:Vendor suspended. Every seat is locked out.`,
        ),
    );
    if (ok) this.suspendOpen.set(false);
  }

  // ── Re-send ────────────────────────────────────────────────────────────────

  protected resend(): void {
    void this.run(
      'resend',
      () => this.api.resendNotice(this.vendorId()),
      (response) =>
        response.notice_sent === false
          ? $localize`:@@admin.vendors.suspension.announce.resendFailed:The notice was still not confirmed sent. There is no clock yet.`
          : $localize`:@@admin.vendors.suspension.announce.resent:The notice was sent and the window has started.`,
    );
  }

  // ── Stage 2 ────────────────────────────────────────────────────────────────

  protected openStage2(): void {
    this.finding.set('');
    this.findingError.set(false);
    this.failure.set(null);
    this.stage2Open.set(true);
    this.focus(`[id="${this.idPrefix()}-stage2-finding"]`);
  }

  protected cancelStage2(): void {
    this.stage2Open.set(false);
  }

  protected onFindingInput(event: Event): void {
    this.finding.set((event.target as HTMLTextAreaElement).value);
    if (this.findingError()) this.findingError.set(false);
  }

  protected async submitStage2(): Promise<void> {
    const finding = this.finding().trim();
    if (!finding) {
      this.findingError.set(true);
      this.focusFirstInvalid();
      return;
    }
    const ok = await this.run(
      'stage2',
      () => this.api.startStage2(this.vendorId(), { finding }),
      (response) =>
        this.noticeAnnouncement(
          response,
          $localize`:@@admin.vendors.suspension.announce.stage2:Stage 2 started.`,
        ),
    );
    if (ok) this.stage2Open.set(false);
  }

  // ── Lift ───────────────────────────────────────────────────────────────────

  protected openLift(): void {
    this.liftReason.set('');
    this.liftReasonError.set(false);
    this.failure.set(null);
    this.liftOpen.set(true);
    this.focus(`[id="${this.idPrefix()}-lift-reason"]`);
  }

  protected cancelLift(): void {
    this.liftOpen.set(false);
  }

  protected onLiftReasonInput(event: Event): void {
    this.liftReason.set((event.target as HTMLTextAreaElement).value);
    if (this.liftReasonError()) this.liftReasonError.set(false);
  }

  protected async submitLift(): Promise<void> {
    const reason = this.liftReason().trim();
    if (!reason) {
      this.liftReasonError.set(true);
      this.focusFirstInvalid();
      return;
    }
    const ok = await this.run(
      'lift',
      () => this.api.lift(this.vendorId(), reason),
      () =>
        $localize`:@@admin.vendors.suspension.announce.lifted:Suspension lifted. Every seat has its access back.`,
    );
    if (ok) this.liftOpen.set(false);
  }

  // ── Children ───────────────────────────────────────────────────────────────

  protected onCostChanged(): void {
    this.changed.emit();
    void this.load();
  }

  protected onTerminated(suspension: VendorSuspension): void {
    this.apply(suspension);
    this.terminated.emit();
    void this.load();
    this.clearSettleTimer();
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      // The settled refunds wrote audit rows too.
      this.changed.emit();
      void this.load();
    }, REFUND_SETTLE_DELAY_MS);
  }

  private clearSettleTimer(): void {
    if (this.settleTimer === null) return;
    clearTimeout(this.settleTimer);
    this.settleTimer = null;
  }

  // ── History ────────────────────────────────────────────────────────────────

  protected hasUnsettledRefund(s: VendorSuspension): boolean {
    return s.refunds.some((r) => r.status === 'failed' || r.status === 'pending');
  }

  protected canRetryRefunds(s: VendorSuspension): boolean {
    return s.id === this.latestTerminatedId() && this.hasUnsettledRefund(s);
  }

  protected retryRefunds(): void {
    void this.run(
      'retry',
      () => this.api.retryRefunds(this.vendorId()),
      () => $localize`:@@admin.vendors.suspension.announce.retried:Refunds retried.`,
    );
  }

  // ── Renderers ──────────────────────────────────────────────────────────────

  protected money(cents: number, currency: string): string {
    return formatCents(cents, currency);
  }

  protected kindLabel(kind: VendorSuspensionKind): string {
    return kind === 'breach'
      ? $localize`:@@admin.vendors.suspension.kind.breach:Breach`
      : $localize`:@@admin.vendors.suspension.kind.falseClaim:False claim`;
  }

  protected refundStatusLabel(status: VendorTerminationRefund['status']): string {
    switch (status) {
      case 'pending':
        return $localize`:@@admin.vendors.suspension.refund.pending:Pending`;
      case 'succeeded':
        return $localize`:@@admin.vendors.suspension.refund.succeeded:Refunded`;
      case 'failed':
        return $localize`:@@admin.vendors.suspension.refund.failed:Failed`;
      case 'manual':
        return $localize`:@@admin.vendors.suspension.refund.manual:Invoice-paid: the operator pays this by hand`;
    }
  }
}
