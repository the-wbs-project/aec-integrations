import {
  Component,
  ElementRef,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';

import {
  REMOVAL_REASON_CODES,
  type EvidencedPairContestTarget,
  type PairFlowDirection,
  type RemovalReasonCode,
} from '@aeci/shared';

import { AecButton } from '../../shared/button/button';
import {
  CHOICE_CARD_CLASS,
  CHOICE_INPUT_CLASS,
  FIELD_INPUT_CLASS,
  FIELD_LABEL_CLASS,
} from '../../shared/form-field/form-field-classes';
import { removalReasonLabel } from './removal-labels';
import { VendorApi } from '../vendor-api';
import { CloseOnEscape } from '../shared/close-on-escape';
import { VendorPortalAnnouncer } from '../vendor-announcer';

type Panel = 'none' | 'veto' | 'existence' | 'flow';

/**
 * An endpoint vendor's three rights on a pair a Sync Service delivers (AECI-2042,
 * rulings 8 to 10 on AECI-2035, `STAGE_2_VENDOR_PORTAL_SPEC.md` §11e.6). Mounted by
 * the Connectors section under each delivered pair whose contest target carries
 * `sync_service_rights`.
 *
 * - "Remove this integration from our product" opens an inline form that says what
 *   happens before anything is sent: the pair leaves every public page at once, the
 *   public page shows nothing about it, the Sync Service is told at once with the
 *   reason, and the Sync Service cannot bring it back but can object to AEC
 *   Integrations on three grounds. Since AECI-2192 (ruling 66) the reason is a required
 *   choice from the fixed list (`REMOVAL_REASON_CODES`), not free text. This company
 *   can withdraw the removal later. The form's own button is the confirm step. No
 *   browser dialog and no `BrnDialog`.
 * - "Report that it is not offered" goes to AEC Integrations. The pair stays listed.
 * - "Report a wrong data flow" names one flow and, optionally, the right direction.
 *
 * Writes are pessimistic. Outcomes go through the portal's one live region, and focus
 * returns to the trigger on cancel. Directions are the pair's own A/B frame, named with
 * the two product names, so nothing is framed against the reader's product twice.
 */
@Component({
  selector: 'aec-vendor-sync-service-rights',
  imports: [AecButton, CloseOnEscape],
  host: { class: 'block' },
  template: `
    @let rights = target().sync_service_rights;
    @if (rights) {
      <div class="space-y-3 px-5 pb-4" data-sync-service-rights>
        <div class="flex flex-wrap gap-2">
          <button
            type="button"
            aecButton
            variant="secondary"
            compact
            #vetoTrigger
            [attr.aria-expanded]="panel() === 'veto'"
            (click)="open('veto')"
            i18n="@@vendor.syncRights.veto.trigger"
          >
            Remove this integration from our product
          </button>
          <button
            type="button"
            aecButton
            variant="secondary"
            compact
            [disabled]="rights.open_reports.includes('existence')"
            #existenceTrigger
            [attr.aria-expanded]="panel() === 'existence'"
            (click)="open('existence')"
            i18n="@@vendor.syncRights.existence.trigger"
          >
            Report that it is not offered
          </button>
          @if (rights.flows.length > 0) {
            <button
              type="button"
              aecButton
              variant="secondary"
              compact
              #flowTrigger
              [attr.aria-expanded]="panel() === 'flow'"
              (click)="open('flow')"
              i18n="@@vendor.syncRights.flow.trigger"
            >
              Report a wrong data flow
            </button>
          }
        </div>
        @if (rights.open_reports.includes('existence')) {
          <p class="text-sm text-(--text-secondary)" i18n="@@vendor.syncRights.existence.open">
            Your report that this is not offered is with AEC Integrations.
          </p>
        }

        @switch (panel()) {
          @case ('veto') {
            <form
              aecCloseOnEscape
              [escapeBusy]="busy()"
              (escapeCancel)="close()"
              method="dialog"
              class="space-y-2"
              (submit)="$event.preventDefault(); submitVeto()"
            >
              <p
                class="max-w-prose text-sm text-(--text-primary)"
                i18n="@@vendor.syncRights.veto.explain.v3"
              >
                This takes the integration off the public site at once: the pair page, both product
                pages and the {{ target().connector.name }} page. The public page shows nothing
                about the removal. {{ ownerName() }} is told at once, with the reason you pick and
                the time. {{ ownerName() }} cannot bring it back or add it again.
              </p>
              <p
                class="max-w-prose text-sm text-(--text-primary)"
                i18n="@@vendor.syncRights.veto.objection.v2"
              >
                {{ ownerName() }} can object to AEC Integrations on three grounds only: the removal
                came from an account that should not have had access, it named the wrong product, or
                its reason is plainly false on its face. We answer an objection within five business
                days of receiving it. If we agree, the integration returns and we tell you why. You
                can withdraw the removal later from Change requests.
              </p>
              <fieldset
                class="m-0 max-w-2xl space-y-2 border-0 p-0"
                [attr.aria-describedby]="error() ? 'veto-reason-error-' + target().id : null"
              >
                <legend [class]="labelClass" i18n="@@vendor.syncRights.veto.reasonLegend">
                  Your reason (required)
                </legend>
                @for (code of reasonCodes; track code) {
                  <label [class]="choiceCardClass">
                    <input
                      type="radio"
                      [class]="choiceInputClass"
                      [attr.name]="'veto-reason-' + target().id"
                      [value]="code"
                      [checked]="reasonCode() === code"
                      [attr.aria-invalid]="error() && !reasonCode() ? 'true' : null"
                      (change)="reasonCode.set(code)"
                    />
                    {{ reasonLabel(code) }}
                  </label>
                }
              </fieldset>
              <div class="flex gap-2">
                <button
                  type="submit"
                  aecButton
                  compact
                  [disabled]="busy()"
                  i18n="@@vendor.syncRights.veto.confirm"
                >
                  Remove it from our product
                </button>
                <button
                  type="button"
                  aecButton
                  variant="secondary"
                  compact
                  (click)="close()"
                  i18n="@@vendor.syncRights.cancel"
                >
                  Cancel
                </button>
              </div>
            </form>
          }
          @case ('existence') {
            <form
              aecCloseOnEscape
              [escapeBusy]="busy()"
              (escapeCancel)="close()"
              method="dialog"
              class="space-y-2"
              (submit)="$event.preventDefault(); submitExistence()"
            >
              <p
                class="max-w-prose text-sm text-(--text-primary)"
                i18n="@@vendor.syncRights.existence.explain"
              >
                AEC Integrations checks it. The integration stays listed while we check. If we
                confirm it, we take it off the site.
              </p>
              <label
                [class]="labelClass"
                for="exist-reason-{{ target().id }}"
                i18n="@@vendor.syncRights.existence.reasonLabel"
                >What you know (required)</label
              >
              <textarea
                id="exist-reason-{{ target().id }}"
                [class]="inputClass"
                rows="3"
                maxlength="1000"
                required
                [value]="reason()"
                (input)="reason.set(valueOf($event))"
              ></textarea>
              <div class="flex gap-2">
                <button
                  type="submit"
                  aecButton
                  compact
                  [disabled]="busy()"
                  i18n="@@vendor.syncRights.send"
                >
                  Send
                </button>
                <button
                  type="button"
                  aecButton
                  variant="secondary"
                  compact
                  (click)="close()"
                  i18n="@@vendor.syncRights.cancel"
                >
                  Cancel
                </button>
              </div>
            </form>
          }
          @case ('flow') {
            <form
              aecCloseOnEscape
              [escapeBusy]="busy()"
              (escapeCancel)="close()"
              method="dialog"
              class="space-y-2"
              (submit)="$event.preventDefault(); submitFlow()"
            >
              <p class="max-w-prose text-sm text-(--text-primary)">
                @if (rights.flows_decided_by_owner) {
                  <span i18n="@@vendor.syncRights.flow.owner"
                    >{{ ownerName() }} keeps the data flows on this integration and decides.</span
                  >
                } @else {
                  <span i18n="@@vendor.syncRights.flow.aeci"
                    >AEC Integrations keeps the data flows on this integration and decides.</span
                  >
                }
              </p>
              <label
                [class]="labelClass"
                for="flow-claim-{{ target().id }}"
                i18n="@@vendor.syncRights.flow.claimLabel"
                >Data flow</label
              >
              <select
                id="flow-claim-{{ target().id }}"
                [class]="inputClass"
                class="w-auto"
                (change)="claimId.set(valueOf($event))"
              >
                @for (f of rights.flows; track f.claim_id) {
                  <option
                    [value]="f.claim_id"
                    [disabled]="rights.open_flow_claim_ids.includes(f.claim_id)"
                  >
                    {{ f.data_object_name }}: {{ directionLabel(f.direction) }}
                  </option>
                }
              </select>
              <label
                [class]="labelClass"
                for="flow-dir-{{ target().id }}"
                i18n="@@vendor.syncRights.flow.proposedLabel"
                >What is right</label
              >
              <select
                id="flow-dir-{{ target().id }}"
                [class]="inputClass"
                class="w-auto"
                (change)="proposed.set(valueOf($event))"
              >
                <option value="" i18n="@@vendor.syncRights.flow.none">
                  It should not be listed
                </option>
                <option value="a_to_b">{{ directionLabel('a_to_b') }}</option>
                <option value="b_to_a">{{ directionLabel('b_to_a') }}</option>
                <option value="both">{{ directionLabel('both') }}</option>
              </select>
              <label
                [class]="labelClass"
                for="flow-reason-{{ target().id }}"
                i18n="@@vendor.syncRights.flow.reasonLabel"
                >Why (required)</label
              >
              <textarea
                id="flow-reason-{{ target().id }}"
                [class]="inputClass"
                rows="3"
                maxlength="1000"
                required
                [value]="reason()"
                (input)="reason.set(valueOf($event))"
              ></textarea>
              <div class="flex gap-2">
                <button
                  type="submit"
                  aecButton
                  compact
                  [disabled]="busy()"
                  i18n="@@vendor.syncRights.send"
                >
                  Send
                </button>
                <button
                  type="button"
                  aecButton
                  variant="secondary"
                  compact
                  (click)="close()"
                  i18n="@@vendor.syncRights.cancel"
                >
                  Cancel
                </button>
              </div>
            </form>
          }
        }
        @if (error()) {
          <p
            role="alert"
            [id]="'veto-reason-error-' + target().id"
            class="text-sm text-(--text-primary)"
          >
            {{ error() }}
          </p>
        }
      </div>
    }
  `,
})
export class VendorSyncServiceRights {
  readonly target = input.required<EvidencedPairContestTarget>();
  /** Emitted after a veto, so the section reloads and the pair drops out of it. */
  readonly changed = output<void>();

  private readonly api = inject(VendorApi);
  private readonly announcer = inject(VendorPortalAnnouncer);

  protected readonly panel = signal<Panel>('none');
  private readonly vetoTrigger = viewChild<ElementRef<HTMLButtonElement>>('vetoTrigger');
  private readonly existenceTrigger = viewChild<ElementRef<HTMLButtonElement>>('existenceTrigger');
  private readonly flowTrigger = viewChild<ElementRef<HTMLButtonElement>>('flowTrigger');
  protected readonly reason = signal('');
  /** The removal's fixed reason (AECI-2192, ruling 66). No free text. */
  protected readonly reasonCode = signal<RemovalReasonCode | null>(null);
  protected readonly reasonCodes = REMOVAL_REASON_CODES;
  protected readonly reasonLabel = removalReasonLabel;
  protected readonly choiceCardClass = CHOICE_CARD_CLASS;
  protected readonly choiceInputClass = CHOICE_INPUT_CLASS;
  protected readonly claimId = signal<string | null>(null);
  protected readonly proposed = signal<string>('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly ownerName = computed(
    () =>
      this.target().owner?.name ?? $localize`:@@vendor.syncRights.ownerFallback:The Sync Service`,
  );

  /** The Label role (AECI-2083 portal recipe). */
  protected readonly labelClass = FIELD_LABEL_CLASS;
  /** The shared field recipe (`shared/form-field/form-field-classes.ts`). */
  protected readonly inputClass = FIELD_INPUT_CLASS;

  /** A form control's value, from its event. */
  protected valueOf(event: Event): string {
    return (event.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).value;
  }

  /** A stored direction named with the two products, A first. */
  protected directionLabel(direction: PairFlowDirection): string {
    const t = this.target();
    const contextIsA = t.context_product.id < t.other_product.id;
    const a = contextIsA ? t.context_product.name : t.other_product.name;
    const b = contextIsA ? t.other_product.name : t.context_product.name;
    if (direction === 'both') return $localize`:@@vendor.syncRights.dir.both:both ways`;
    return direction === 'a_to_b'
      ? $localize`:@@vendor.syncRights.dir.oneWay:${a}:from: to ${b}:to:`
      : $localize`:@@vendor.syncRights.dir.oneWay:${b}:from: to ${a}:to:`;
  }

  protected open(panel: Panel): void {
    this.error.set(null);
    this.reason.set('');
    this.reasonCode.set(null);
    this.proposed.set('');
    const rights = this.target().sync_service_rights;
    const first = rights?.flows.find((f) => !rights.open_flow_claim_ids.includes(f.claim_id));
    this.claimId.set(first?.claim_id ?? null);
    this.panel.set(this.panel() === panel ? 'none' : panel);
  }

  /** Cancel or Escape: close, and return focus to the button that opened the form, so a
   *  keyboard user is not dropped at the top of the page (AECI-2191). */
  protected close(): void {
    const opener = this.triggerOf(this.panel());
    this.panel.set('none');
    this.error.set(null);
    opener?.nativeElement.focus();
  }

  private triggerOf(panel: Panel): ElementRef<HTMLButtonElement> | undefined {
    if (panel === 'veto') return this.vetoTrigger();
    if (panel === 'existence') return this.existenceTrigger();
    if (panel === 'flow') return this.flowTrigger();
    return undefined;
  }

  protected async submitVeto(): Promise<void> {
    const code = this.reasonCode();
    if (!code) {
      return this.error.set(
        $localize`:@@vendor.syncRights.veto.reasonCodeRequired:Choose a reason first.`,
      );
    }
    await this.run(async () => {
      await this.api.fileVeto(this.target().id, code);
      this.announcer.announce(
        $localize`:@@vendor.syncRights.veto.done:Removed from your product. It is off the public site now.`,
      );
      this.changed.emit();
    });
  }

  protected async submitExistence(): Promise<void> {
    const reason = this.reason().trim();
    if (!reason) return this.error.set(this.reasonRequired());
    await this.run(async () => {
      await this.api.submitPairContest(this.target().id, { kind: 'existence', reason });
      this.announcer.announce(
        $localize`:@@vendor.syncRights.existence.done:Sent to AEC Integrations. The integration stays listed while we check.`,
      );
      this.changed.emit();
    });
  }

  protected async submitFlow(): Promise<void> {
    const reason = this.reason().trim();
    const claimId = this.claimId();
    if (!reason) return this.error.set(this.reasonRequired());
    if (!claimId) return;
    const proposed = this.proposed();
    await this.run(async () => {
      await this.api.submitPairContest(this.target().id, {
        kind: 'data_flow',
        claim_id: claimId,
        reason,
        ...(proposed ? { proposed_direction: proposed as PairFlowDirection } : {}),
      });
      this.announcer.announce($localize`:@@vendor.syncRights.flow.done:Data flow report sent.`);
      this.changed.emit();
    });
  }

  private reasonRequired(): string {
    return $localize`:@@vendor.syncRights.reasonRequired:Add a reason first.`;
  }

  private async run(write: () => Promise<void>): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await write();
      this.panel.set('none');
    } catch (e) {
      const code = (e as { error?: { error?: { code?: string } } }).error?.error?.code;
      this.error.set(
        code === 'VETO_DUPLICATE'
          ? $localize`:@@vendor.syncRights.err.vetoDuplicate:Your company already removed this integration.`
          : code === 'PAIR_CONTEST_DUPLICATE'
            ? $localize`:@@vendor.syncRights.err.duplicate:You already have this report open.`
            : code === 'CONTEST_NO_CHANGE'
              ? $localize`:@@vendor.syncRights.err.noChange:That is the direction on record now.`
              : code === 'RATE_LIMITED'
                ? $localize`:@@vendor.syncRights.err.rateLimited:Too many requests. Try again in a minute.`
                : $localize`:@@vendor.syncRights.err.generic:That did not go through. Try again.`,
      );
    } finally {
      this.busy.set(false);
    }
  }
}
