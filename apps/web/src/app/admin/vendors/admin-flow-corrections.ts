import { DatePipe, DOCUMENT } from '@angular/common';
import {
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';

import {
  ADMIN_REASON_MAX,
  AdminReasonSchema,
  HttpsUrlSchema,
  isHttpsUrl,
  type AdminFlow,
  type AdminFlowCorrection,
  type AdminFlowsResponse,
  type FlowCorrectionAction,
  type FlowCorrectionBlock,
  type FlowCorrectionDirection,
} from '@aeci/shared';

import { AecButton } from '../../shared/button/button';
import { AecFormSubmit } from '../../shared/form-field/form-submit';
import { NewTabIcon } from '../../shared/new-tab-icon/new-tab-icon';
import { queueFocusAfterRemoval } from '../reviews/queue-focus';
import { AdminVendorsApi } from './admin-vendors-api';
import { FIELD_OVERRIDE_CLASSES, errorBody, fetchAllPages } from './admin-field-corrections';

/** One Sync Service row the form can correct a flow on. */
export interface FlowRecord {
  /** `${anchor}:${id}`, the select's value. */
  readonly key: string;
  readonly anchor: 'integration' | 'evidenced_pair';
  readonly id: string;
  readonly label: string;
}

/**
 * "Data flow corrections" on `/admin/vendors/:id`, beside Field corrections (AECI-2139,
 * `ADMIN_PANEL_SPEC.md` §5.12a, `STAGE_2_ATTESTATIONS_SPEC.md` §14.10).
 *
 * The owner of a claimed Sync Service pair maintains its data flows. When a verifiable
 * public source shows one flow is wrong, AECi removes it, or moves it to the right
 * direction. The rest of the integration stays listed, the owner is told why, and the
 * owner cannot undo the correction. Only a lift ends it.
 *
 * Two parts, as Field corrections has: the live corrections on this vendor's rows, each
 * with Lift, and a "Correct a data flow" form. The form picks a connector-powered row the
 * vendor holds, then one of its public flows, then Remove or Correct direction, the
 * source, the reason the owner reads and an optional internal note. A row the API will
 * refuse says why before anything is sent.
 *
 * `/admin/contests` links here for an owner-routed data flow report, with the row and
 * the flow in the query (`?flowRow=&flowAnchor=&flowClaim=`). The form opens on them.
 *
 * Same pattern as the field corrections beside it: inline forms, no browser dialog,
 * pessimistic writes, and one announcement through the page's live region.
 */
@Component({
  selector: 'aec-admin-flow-corrections',
  imports: [AecButton, AecFormSubmit, DatePipe, NewTabIcon],
  templateUrl: './admin-flow-corrections.html',
})
export class AdminFlowCorrections {
  readonly vendorId = input.required<string>();
  readonly announce = output<string>();

  protected readonly c = FIELD_OVERRIDE_CLASSES;
  protected readonly reasonMax = ADMIN_REASON_MAX;

  private readonly api = inject(AdminVendorsApi);
  private readonly injector = inject(Injector);
  private readonly document = inject(DOCUMENT);

  protected readonly corrections = signal<readonly AdminFlowCorrection[]>([]);
  protected readonly loading = signal(true);
  protected readonly failed = signal(false);

  protected readonly records = signal<readonly FlowRecord[]>([]);
  protected readonly recordsFailed = signal(false);
  protected readonly formOpen = signal(false);
  protected readonly recordKey = signal('');
  protected readonly flows = signal<AdminFlowsResponse | null>(null);
  protected readonly flowsLoading = signal(false);
  protected readonly flowsFailed = signal(false);
  protected readonly claimId = signal('');
  protected readonly action = signal<FlowCorrectionAction>('remove');
  protected readonly direction = signal<FlowCorrectionDirection | ''>('');
  protected readonly sourceUrl = signal('');
  protected readonly reason = signal('');
  protected readonly internalNote = signal('');
  protected readonly sourceError = signal(false);
  protected readonly reasonError = signal(false);
  protected readonly directionError = signal(false);
  protected readonly formError = signal<string | null>(null);
  protected readonly pending = signal(false);

  protected readonly liftFor = signal<string | null>(null);
  protected readonly liftReason = signal('');
  protected readonly liftError = signal<string | null>(null);

  private readonly recordEl = viewChild<ElementRef<HTMLSelectElement>>('recordInput');
  private readonly flowEl = viewChild<ElementRef<HTMLSelectElement>>('flowInput');
  private readonly directionEl = viewChild<ElementRef<HTMLSelectElement>>('directionInput');
  private readonly sourceEl = viewChild<ElementRef<HTMLInputElement>>('sourceInput');
  private readonly reasonEl = viewChild<ElementRef<HTMLTextAreaElement>>('reasonInput');
  private readonly liftReasonEl = viewChild<ElementRef<HTMLTextAreaElement>>('liftReasonInput');

  /** The flows the form may correct: public now, and not corrected already. */
  protected readonly correctable = computed<readonly AdminFlow[]>(() =>
    (this.flows()?.flows ?? []).filter((f) => f.public && f.correction === null),
  );

  protected readonly flow = computed(
    () => this.correctable().find((f) => f.claim_id === this.claimId()) ?? null,
  );

  /** The directions a redirect may pick: every one but the flow's own. */
  protected readonly directionOptions = computed(() => {
    const flows = this.flows();
    const a = flows?.product_a.name || 'A';
    const b = flows?.product_b.name || 'B';
    const all: ReadonlyArray<{ value: FlowCorrectionDirection; label: string }> = [
      {
        value: 'a_to_b',
        label: $localize`:@@admin.flowCorrections.direction.aToB:${a}:a: to ${b}:b:`,
      },
      {
        value: 'b_to_a',
        label: $localize`:@@admin.flowCorrections.direction.bToA:${b}:b: to ${a}:a:`,
      },
      { value: 'both', label: $localize`:@@admin.flowCorrections.direction.both:Both ways` },
    ];
    return all.filter((o) => o.value !== this.flow()?.direction);
  });

  constructor() {
    afterNextRender(() => {
      void this.loadCorrections();
      void this.openFromQuery();
    });
  }

  protected async loadCorrections(): Promise<void> {
    this.loading.set(true);
    this.failed.set(false);
    try {
      const res = await this.api.listFlowCorrections(this.vendorId());
      this.corrections.set(res.corrections);
    } catch {
      this.failed.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  /** `/admin/contests` deep link: open the form on the reported row and flow. */
  private async openFromQuery(): Promise<void> {
    const query = new URLSearchParams(this.document.location?.search ?? '');
    const row = query.get('flowRow');
    const anchor = query.get('flowAnchor');
    if (!row || (anchor !== 'integration' && anchor !== 'evidenced_pair')) return;
    await this.openForm();
    const key = `${anchor}:${row}`;
    if (!this.records().some((r) => r.key === key)) return;
    await this.pickRecord(key);
    const claim = query.get('flowClaim');
    if (claim && this.correctable().some((f) => f.claim_id === claim)) this.claimId.set(claim);
    this.document.getElementById(this.id('heading'))?.scrollIntoView?.({ block: 'start' });
  }

  protected async openForm(): Promise<void> {
    this.formOpen.set(true);
    this.formError.set(null);
    if (this.records().length === 0) await this.loadRecords();
    afterNextRender(() => this.recordEl()?.nativeElement.focus(), { injector: this.injector });
  }

  protected closeForm(): void {
    this.formOpen.set(false);
    this.resetForm();
    this.focusAfterRender(this.id('open'));
  }

  private resetForm(): void {
    this.recordKey.set('');
    this.flows.set(null);
    this.flowsFailed.set(false);
    this.claimId.set('');
    this.action.set('remove');
    this.direction.set('');
    this.sourceUrl.set('');
    this.reason.set('');
    this.internalNote.set('');
    this.sourceError.set(false);
    this.reasonError.set(false);
    this.directionError.set(false);
    this.formError.set(null);
  }

  /** The connector-powered rows this vendor holds. Sync Service is checked per row. */
  private async loadRecords(): Promise<void> {
    try {
      const rows = await fetchAllPages((query) =>
        this.api.listIntegrations(this.vendorId(), query),
      );
      this.recordsFailed.set(false);
      this.records.set(
        rows
          .filter((row) => row.connector_powered && row.claimed_at !== null)
          .map((row) => {
            const name = row.name ?? `${row.source.name} ↔ ${row.target.name}`;
            const via = row.connector?.name;
            return {
              key: `${row.anchor}:${row.id}`,
              anchor: row.anchor,
              id: row.id,
              label: via
                ? $localize`:@@admin.flowCorrections.record.via:${name}:name: (through ${via}:connector:)`
                : name,
            };
          }),
      );
    } catch {
      this.recordsFailed.set(true);
    }
  }

  protected onRecord(event: Event): void {
    void this.pickRecord((event.target as HTMLSelectElement).value);
  }

  private async pickRecord(key: string): Promise<void> {
    this.recordKey.set(key);
    this.flows.set(null);
    this.flowsFailed.set(false);
    this.claimId.set('');
    this.direction.set('');
    const record = this.records().find((r) => r.key === key);
    if (!record) return;
    this.flowsLoading.set(true);
    try {
      this.flows.set(await this.api.listFlows(record.anchor, record.id));
    } catch {
      this.flowsFailed.set(true);
    } finally {
      this.flowsLoading.set(false);
    }
  }

  protected onFlow(event: Event): void {
    this.claimId.set((event.target as HTMLSelectElement).value);
    this.direction.set('');
  }

  protected onAction(value: FlowCorrectionAction): void {
    this.action.set(value);
    this.directionError.set(false);
  }

  protected onDirection(event: Event): void {
    this.direction.set((event.target as HTMLSelectElement).value as FlowCorrectionDirection | '');
    if (this.directionError()) this.directionError.set(false);
  }

  protected onSource(event: Event): void {
    this.sourceUrl.set((event.target as HTMLInputElement).value);
    if (this.sourceError()) this.sourceError.set(false);
  }

  protected onReason(event: Event): void {
    this.reason.set((event.target as HTMLTextAreaElement).value);
    if (this.reasonError()) this.reasonError.set(false);
  }

  protected onNote(event: Event): void {
    this.internalNote.set((event.target as HTMLTextAreaElement).value);
  }

  protected async submit(): Promise<void> {
    if (this.pending()) return;
    const flow = this.flow();
    if (!flow) {
      this.formError.set(
        $localize`:@@admin.flowCorrections.error.pick:Choose the integration and the data flow to correct.`,
      );
      this.focusAfterRender(this.id('form-error'));
      return;
    }
    const direction = this.direction();
    if (this.action() === 'redirect' && !direction) {
      this.directionError.set(true);
      this.directionEl()?.nativeElement.focus();
      return;
    }
    const source = HttpsUrlSchema.safeParse(this.sourceUrl());
    if (!source.success) {
      this.sourceError.set(true);
      this.sourceEl()?.nativeElement.focus();
      return;
    }
    if (!AdminReasonSchema.safeParse(this.reason()).success) {
      this.reasonError.set(true);
      this.reasonEl()?.nativeElement.focus();
      return;
    }
    this.pending.set(true);
    this.formError.set(null);
    try {
      const res = await this.api.correctFlow(flow.claim_id, {
        action: this.action(),
        ...(this.action() === 'redirect' && direction ? { direction } : {}),
        sourceUrl: source.data,
        reason: this.reason().trim(),
        internalNote: this.internalNote(),
      });
      this.corrections.update((list) => [res.correction, ...list]);
      const redirected = this.action() === 'redirect';
      this.formOpen.set(false);
      this.resetForm();
      this.announce.emit(
        redirected
          ? $localize`:@@admin.flowCorrections.announce.redirected:Data flow corrected. It is listed in the right direction, and the owner was told, with your reason.`
          : $localize`:@@admin.flowCorrections.announce.removed:Data flow removed. The rest of the integration stays listed, and the owner was told, with your reason.`,
      );
      this.focusAfterRender(this.id('open'));
    } catch (err) {
      this.formError.set(flowCorrectionErrorMessage(err));
      this.focusAfterRender(this.id('form-error'));
    } finally {
      this.pending.set(false);
    }
  }

  protected onFormEscape(): void {
    if (!this.pending()) this.closeForm();
  }

  protected openLift(correction: AdminFlowCorrection): void {
    this.liftFor.set(correction.id);
    this.liftReason.set('');
    this.liftError.set(null);
    afterNextRender(() => this.liftReasonEl()?.nativeElement.focus(), { injector: this.injector });
  }

  protected closeLift(correction: AdminFlowCorrection): void {
    this.liftFor.set(null);
    this.liftError.set(null);
    this.focusAfterRender(this.liftTriggerId(correction));
  }

  protected onLiftEscape(correction: AdminFlowCorrection): void {
    if (!this.pending()) this.closeLift(correction);
  }

  protected onLiftReason(event: Event): void {
    this.liftReason.set((event.target as HTMLTextAreaElement).value);
  }

  protected async lift(correction: AdminFlowCorrection): Promise<void> {
    if (this.pending()) return;
    if (!AdminReasonSchema.safeParse(this.liftReason()).success) {
      this.liftError.set(
        $localize`:@@admin.flowCorrections.lift.reasonRequired:Enter a reason for the owner. The owner reads it in its portal messages.`,
      );
      this.liftReasonEl()?.nativeElement.focus();
      return;
    }
    this.pending.set(true);
    this.liftError.set(null);
    try {
      await this.api.liftFlowCorrection(correction.id, this.liftReason().trim());
      const index = this.corrections().findIndex((c) => c.id === correction.id);
      this.corrections.update((list) => list.filter((c) => c.id !== correction.id));
      this.liftFor.set(null);
      this.announce.emit(
        $localize`:@@admin.flowCorrections.announce.lifted:Correction lifted. The owner maintains the data flow again and was told why.`,
      );
      const next = queueFocusAfterRemoval(index, 1, 1, this.corrections());
      if (next.kind === 'row') this.focusAfterRender(this.liftTriggerId(next.row));
      else if (next.kind === 'heading') this.focusAfterRender(this.id('heading'));
    } catch (err) {
      this.liftError.set(flowCorrectionErrorMessage(err));
      if (errorBody(err).code === 'FLOW_CORRECTION_LIFTED') void this.loadCorrections();
      else this.focusAfterRender(this.liftFormId(correction, 'error'));
    } finally {
      this.pending.set(false);
    }
  }

  /** Why the picked row cannot be corrected here, or `null`. */
  protected blockText(block: FlowCorrectionBlock | null | undefined): string | null {
    switch (block) {
      case 'not_sync_service':
        return $localize`:@@admin.flowCorrections.block.notSyncService:No Sync Service delivers this integration, so the review app holds its data flows. Correct them there.`;
      case 'not_claimed':
        return $localize`:@@admin.flowCorrections.block.notClaimed:Nobody has claimed this integration, so the review app holds its data flows. Retract the flow there.`;
      case 'retired':
        return $localize`:@@admin.flowCorrections.block.retired:This integration is retired, so no public page shows it.`;
      case 'vetoed':
        return $localize`:@@admin.flowCorrections.block.vetoed:A vendor of one of the two products removed this integration, so no public page shows it.`;
      default:
        return null;
    }
  }

  /** "RFIs, Procore to Acumatica": the flow as the select and the table name it. */
  protected flowLabel(
    flow: { data_object_name: string; direction: FlowCorrectionDirection },
    flows: AdminFlowsResponse | null = this.flows(),
  ): string {
    return `${flow.data_object_name}, ${this.directionText(flow.direction, flows)}`;
  }

  protected directionText(
    direction: FlowCorrectionDirection | null,
    flows: AdminFlowsResponse | null = this.flows(),
  ): string {
    const a = flows?.product_a.name || 'A';
    const b = flows?.product_b.name || 'B';
    switch (direction) {
      case 'a_to_b':
        return $localize`:@@admin.flowCorrections.direction.aToB:${a}:a: to ${b}:b:`;
      case 'b_to_a':
        return $localize`:@@admin.flowCorrections.direction.bToA:${b}:b: to ${a}:a:`;
      case 'both':
        return $localize`:@@admin.flowCorrections.direction.both:Both ways`;
      default:
        return '';
    }
  }

  /** The correction's own line in the list: removed, or moved to a direction. */
  protected effectLabel(correction: AdminFlowCorrection): string {
    if (correction.replacement_direction === null) {
      return $localize`:@@admin.flowCorrections.effect.removed:Removed`;
    }
    const to = this.directionCode(correction.replacement_direction);
    return $localize`:@@admin.flowCorrections.effect.redirected:Moved to ${to}:direction:`;
  }

  /** The A/B frame without names, for the list, which spans several rows. */
  protected directionCode(direction: FlowCorrectionDirection): string {
    switch (direction) {
      case 'a_to_b':
        return $localize`:@@admin.flowCorrections.code.aToB:A to B`;
      case 'b_to_a':
        return $localize`:@@admin.flowCorrections.code.bToA:B to A`;
      case 'both':
        return $localize`:@@admin.flowCorrections.code.both:both ways`;
    }
  }

  protected sourceHref(url: string | null): string | null {
    return url && isHttpsUrl(url) ? url : null;
  }

  private focusAfterRender(id: string): void {
    afterNextRender(() => this.document.getElementById(id)?.focus(), { injector: this.injector });
  }

  protected id(part: string): string {
    return `admin-flow-corrections-${this.vendorId()}-${part}`;
  }

  protected liftTriggerId(correction: AdminFlowCorrection): string {
    return `admin-flow-correction-lift-${correction.id}`;
  }

  protected liftFormId(correction: AdminFlowCorrection, part: string): string {
    return `admin-flow-correction-${correction.id}-${part}`;
  }
}

/** One message per refusal the two routes can answer. */
export function flowCorrectionErrorMessage(err: unknown): string {
  const { code, field } = errorBody(err);
  if (code === 'VALIDATION_FAILED' && field === 'sourceUrl') {
    return $localize`:@@admin.flowCorrections.error.source:The source must be a full https:// link.`;
  }
  switch (code) {
    case 'FLOW_ALREADY_CORRECTED':
      return $localize`:@@admin.flowCorrections.error.already:This data flow is already corrected. Lift that correction below before correcting it again.`;
    case 'FLOW_CORRECTION_LIFTED':
      return $localize`:@@admin.flowCorrections.error.lifted:This correction was already lifted. The list has been reloaded.`;
    case 'FLOW_CORRECTION_NOT_AVAILABLE':
      return $localize`:@@admin.flowCorrections.error.notAvailable:No Sync Service delivers this integration, so the review app holds its data flows. Correct them there.`;
    case 'FLOW_DIRECTION_REMOVED_BY_OWNER':
      return $localize`:@@admin.flowCorrections.error.ownerRemoved:The owner removed the flow in that direction. Remove this flow instead.`;
    case 'FLOW_NO_CHANGE':
      return $localize`:@@admin.flowCorrections.error.noChange:The flow already runs in that direction. Choose another direction, or remove it.`;
    case 'INTEGRATION_NOT_CLAIMED':
      return $localize`:@@admin.flowCorrections.error.notClaimed:Nobody has claimed this integration now, so the review app holds its data flows. Retract the flow there.`;
    case 'INTEGRATION_RETIRED':
      return $localize`:@@admin.flowCorrections.error.retired:This integration is retired, so no public page shows it.`;
    case 'INTEGRATION_VETOED':
      return $localize`:@@admin.flowCorrections.error.vetoed:A vendor of one of the two products removed this integration, so no public page shows it.`;
    case 'INTEGRATION_CHANGED_WHILE_SAVING':
      return $localize`:@@admin.flowCorrections.error.changed:This integration changed while it was being saved. Choose it again and retry.`;
    case 'VALIDATION_FAILED':
      return $localize`:@@admin.flowCorrections.error.validation:Check the data flow, the direction, the source and the reason. The reason can be up to 1,000 characters.`;
    case 'RATE_LIMITED':
      return $localize`:@@admin.flowCorrections.error.rate:Too many requests in a short time. Wait a minute and try again.`;
    default:
      return $localize`:@@admin.flowCorrections.error.generic:Could not save the change. Try again.`;
  }
}
