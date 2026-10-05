import {
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';

import {
  CONTEST_VALUE_MAX_LENGTH,
  IntegrationMechanismKindSchema,
  SubmitIntegrationContestSchema,
  contestFieldsFor,
  type OfferedContestField,
  type SubmitIntegrationContestInput,
  type VendorContest,
  type VendorIntegration,
} from '@aeci/shared';

import { contestValueMessage } from '../components/vendor-contest-labels';
import { readVendorApiError } from '../vendor-api-error';
import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorApi } from '../vendor-api';
import { VendorPortalStore } from '../vendor-portal-store';

import {
  formatDay,
  howYouGetIt,
  noOwnerValueLabel,
  notSetLabel,
  pageFieldLabel,
} from './integration-detail-model';
import { IntegrationDetailState } from './integration-detail-state';
import {
  ALERT,
  BTN_PRIMARY,
  BTN_SECONDARY,
  HELP,
  ID_STYLES,
  LABEL,
} from './integration-detail-styles';

/** The owner picker's value for "neither company". Never a UUID. `null` on the wire. */
const NO_OWNER = 'none';

type ControlKind = 'url' | 'text' | 'textarea' | 'mechanism' | 'owner';

function controlFor(field: OfferedContestField): ControlKind {
  switch (field) {
    case 'listing_url':
    case 'docs_url':
      return 'url';
    case 'description':
      return 'textarea';
    case 'mechanism_kind':
      return 'mechanism';
    case 'owner':
      return 'owner';
    default:
      return 'text';
  }
}

interface FieldOption {
  readonly value: OfferedContestField;
  readonly label: string;
  readonly disabled: boolean;
}

/**
 * The request form in Change requests (AECI-1153, `STAGE_2_VENDOR_PORTAL_SPEC.md`
 * §6.17.6): a company that does not own the integration asks for one detail to be
 * corrected (a field contest, §11b.2).
 *
 * - "What is wrong?" offers the §6.17.11 offered fields for an integration, in the
 *   §11b.3 order, minus `direction` (no Direction row, §6.17.3). A field with an
 *   open request from the caller, an open review, or a cooldown is disabled, with
 *   its reason in the option text (§11b.12.12).
 * - "What it should say" starts at the value on record.
 * - "Why is it wrong?" is 1 to 2,000 characters, the shared schema's rule. No
 *   20-character floor: it is not a ruled rule and the API does not enforce it.
 *
 * Pessimistic: on `201` it announces where the request went, closes, and the host
 * focuses the new item.
 */
@Component({
  selector: 'aec-integration-request-form',
  styles: [ID_STYLES],
  template: `
    <form
      id="change-requests-form"
      tabindex="-1"
      class="id-well mt-4 scroll-mt-20 space-y-4 p-4 text-sm focus:outline-none"
      aria-labelledby="change-requests-form-title"
      (submit)="send($event)"
      data-testid="request-form"
    >
      <p id="change-requests-form-title" class="id-h4" i18n="@@vendor.im.request.formTitle">
        Request a correction
      </p>
      <div class="grid gap-4 sm:grid-cols-2">
        <div>
          <label for="request-field" [class]="label" i18n="@@vendor.im.request.whatWrong"
            >What is wrong?</label
          >
          <select
            #fieldSelect
            id="request-field"
            class="id-input mt-1"
            [attr.aria-invalid]="attempted() && field() === null ? 'true' : null"
            (change)="pickField(selectValue($event))"
          >
            <option value="" [selected]="field() === null" i18n="@@vendor.im.request.chooseDetail">
              Choose a detail
            </option>
            @for (option of fieldOptions(); track option.value) {
              <option
                [value]="option.value"
                [selected]="field() === option.value"
                [disabled]="option.disabled"
              >
                {{ option.label }}
              </option>
            }
          </select>
        </div>
        @if (field() !== null) {
          <div>
            <p [class]="label" i18n="@@vendor.im.request.onPageNow">On the public page now</p>
            <p class="mt-2 break-words text-(--text-primary)" data-testid="request-current">
              {{ currentDisplay() }}
            </p>
          </div>
        }
      </div>

      @if (field() !== null) {
        <div>
          <label for="request-value" [class]="label" i18n="@@vendor.im.request.shouldSay"
            >What it should say</label
          >
          @switch (control()) {
            @case ('textarea') {
              <textarea
                id="request-value"
                rows="3"
                class="id-input mt-1"
                [attr.maxlength]="maxLength()"
                [attr.aria-invalid]="showValueError() ? 'true' : null"
                [attr.aria-describedby]="showValueError() ? 'request-value-error' : null"
                [value]="proposed()"
                (input)="proposed.set(inputValue($event))"
              ></textarea>
            }
            @case ('mechanism') {
              <select
                id="request-value"
                class="id-input mt-1"
                (change)="proposed.set(selectValue($event))"
              >
                @for (kind of kinds; track kind) {
                  <option [value]="kind" [selected]="proposed() === kind">
                    {{ howLabel(kind) }}
                  </option>
                }
              </select>
            }
            @case ('owner') {
              <select
                id="request-value"
                class="id-input mt-1"
                (change)="proposed.set(selectValue($event))"
              >
                @for (choice of ownerChoices(); track choice.value) {
                  <option [value]="choice.value" [selected]="proposed() === choice.value">
                    {{ choice.label }}
                  </option>
                }
              </select>
            }
            @default {
              <input
                id="request-value"
                [type]="control() === 'url' ? 'url' : 'text'"
                class="id-input mt-1"
                [attr.inputmode]="control() === 'url' ? 'url' : null"
                [attr.maxlength]="maxLength()"
                [attr.aria-invalid]="showValueError() ? 'true' : null"
                [attr.aria-describedby]="showValueError() ? 'request-value-error' : null"
                [value]="proposed()"
                (input)="proposed.set(inputValue($event))"
              />
            }
          }
          @if (showValueError()) {
            <p id="request-value-error" role="alert" [class]="alert" class="mt-1">
              {{ valueError() }}
            </p>
          }
        </div>
        <div>
          <label for="request-reason" [class]="label" i18n="@@vendor.im.request.why"
            >Why is it wrong?</label
          >
          <textarea
            id="request-reason"
            rows="3"
            maxlength="2000"
            class="id-input mt-1"
            aria-describedby="request-route"
            [attr.aria-invalid]="showReasonError() ? 'true' : null"
            [value]="reason()"
            (input)="reason.set(inputValue($event))"
          ></textarea>
          <p id="request-route" [class]="help">{{ routeLine() }}</p>
          @if (showReasonError()) {
            <p role="alert" [class]="alert" class="mt-1" i18n="@@vendor.im.request.reasonRequired">
              Say why the value on the public page is wrong.
            </p>
          }
        </div>
      }

      @if (blocked(); as reason) {
        <p class="text-sm text-(--text-secondary)" data-testid="request-blocked">
          {{ blockedLine(reason) }}
        </p>
      }
      @if (attempted() && field() === null) {
        <p role="alert" [class]="alert" i18n="@@vendor.im.request.fieldRequired">
          Choose which detail is wrong.
        </p>
      }
      @if (notice()) {
        <p role="alert" [class]="alert">{{ notice() }}</p>
      }

      <div class="flex flex-wrap gap-3">
        <button type="submit" [class]="primary" [disabled]="sending()" data-testid="request-send">
          <span i18n="@@vendor.im.request.send">Send request</span>
        </button>
        <button
          type="button"
          [class]="secondary"
          [disabled]="sending()"
          (click)="cancelled.emit()"
          i18n="@@vendor.im.request.cancel"
        >
          Cancel
        </button>
      </div>
    </form>
  `,
})
export class IntegrationRequestForm {
  private readonly state = inject(IntegrationDetailState);
  private readonly api = inject(VendorApi);
  private readonly store = inject(VendorPortalStore);
  private readonly announcer = inject(VendorPortalAnnouncer);
  private readonly injector = inject(Injector);

  readonly integration = input.required<VendorIntegration>();
  /** The field the form opened on, or `null` for "choose". */
  readonly initialField = input<OfferedContestField | null>(null);
  /** Bumped by the host to re-seed the form when it is asked for again. */
  readonly seq = input(0);

  readonly sent = output<VendorContest>();
  readonly cancelled = output<void>();

  private readonly fieldSelect = viewChild<ElementRef<HTMLSelectElement>>('fieldSelect');

  protected readonly field = signal<OfferedContestField | null>(null);
  protected readonly proposed = signal('');
  protected readonly reason = signal('');
  protected readonly attempted = signal(false);
  protected readonly sending = signal(false);
  protected readonly notice = signal<string | null>(null);
  /** The option text of a field asked for that cannot be requested now. */
  protected readonly blocked = signal<string | null>(null);
  private readonly seed = signal('');

  protected readonly kinds = IntegrationMechanismKindSchema.options;

  constructor() {
    // Seed whenever the host asks for the form again, then focus it.
    effect(() => {
      const field = this.initialField();
      this.seq();
      untracked(() => {
        this.attempted.set(false);
        this.notice.set(null);
        this.reason.set('');
        this.pickField(field ?? '');
        afterNextRender(() => this.fieldSelect()?.nativeElement.focus(), {
          injector: this.injector,
        });
      });
    });
  }

  /** The offered fields, minus `direction` (§6.17.6). */
  private readonly fields = computed(() =>
    contestFieldsFor('integration').filter((f) => f !== 'direction'),
  );

  protected readonly fieldOptions = computed<readonly FieldOption[]>(() => {
    const submitted = this.state.contests().submitted;
    const now = Date.now();
    return this.fields().map((f) => {
      const label = pageFieldLabel(f);
      const mine = submitted.filter((c) => c.field === f);
      if (mine.some((c) => c.status === 'open')) {
        return {
          value: f,
          label: $localize`:@@vendor.im.request.option.open:${label}:field: (you already asked)`,
          disabled: true,
        };
      }
      if (mine.some((c) => c.protest?.status === 'open')) {
        return {
          value: f,
          label: $localize`:@@vendor.im.request.option.review:${label}:field: (with AEC Integrations for review)`,
          disabled: true,
        };
      }
      const cooldown = mine.find(
        (c) => c.cooldown_until && Date.parse(c.cooldown_until) > now,
      )?.cooldown_until;
      if (cooldown) {
        const date = formatDay(cooldown);
        return {
          value: f,
          label: $localize`:@@vendor.im.request.option.cooldown:${label}:field: (not until ${date}:date:)`,
          disabled: true,
        };
      }
      return { value: f, label, disabled: false };
    });
  });

  protected readonly control = computed<ControlKind>(() => controlFor(this.field() ?? 'name'));
  protected readonly maxLength = computed(() => CONTEST_VALUE_MAX_LENGTH[this.field() ?? 'name']);

  private readonly current = computed<string | null>(() => {
    const f = this.field();
    return f === null ? null : (this.integration().contestable_fields[f] ?? null);
  });

  protected readonly currentDisplay = computed(() => {
    const f = this.field();
    const value = this.current();
    if (f === 'owner') {
      return value === null
        ? noOwnerValueLabel()
        : (this.integration().endpoint_vendors.find((v) => v.id === value)?.name ??
            this.integration().owner?.name ??
            value);
    }
    if (value === null || value === '') return notSetLabel();
    if (f === 'mechanism_kind')
      return howYouGetIt(value, this.integration().powered_by?.name ?? null);
    return value;
  });

  protected readonly ownerChoices = computed(() => {
    const me = this.state.myVendorId();
    const listed = this.integration().endpoint_vendors;
    const vendors =
      listed.length > 0 ? listed : me ? [{ id: me, name: this.state.myCompany() }] : [];
    return [
      ...vendors.map((v) => ({
        value: v.id,
        label:
          v.id === me
            ? $localize`:@@vendor.im.request.owner.you:${v.name}:company: (your company)`
            : v.name,
      })),
      { value: NO_OWNER, label: $localize`:@@vendor.im.request.owner.neither:Neither company` },
    ];
  });

  /** The proposal in wire form. `owner`'s "neither" is `null`. */
  private readonly wireValue = computed<string | null>(() => {
    if (this.field() === 'owner' && this.proposed() === NO_OWNER) return null;
    return this.proposed().trim();
  });

  protected readonly valueError = computed<string | null>(() => {
    const f = this.field();
    if (f === null) return null;
    return contestValueMessage(f, this.wireValue(), this.current());
  });

  protected readonly showValueError = computed(
    () => this.valueError() !== null && (this.attempted() || this.proposed() !== this.seed()),
  );
  protected readonly showReasonError = computed(
    () => this.attempted() && this.reason().trim() === '',
  );

  /** Where the request goes (§11b.4). */
  protected readonly routeLine = computed(() => {
    const i = this.integration();
    if (this.field() === 'owner') {
      return $localize`:@@vendor.im.request.route.owner:A request about the owner always goes to AEC Integrations.`;
    }
    if (i.owner && i.claimed_at) {
      const owner = i.owner.name;
      return $localize`:@@vendor.im.request.route.claimed:This goes to ${owner}:owner:, the owner. If they say no, you can ask AEC Integrations to review it.`;
    }
    return $localize`:@@vendor.im.request.route.aeci:This goes to AEC Integrations, because no company has claimed this integration.`;
  });

  protected pickField(value: string): void {
    let f = (this.fields() as readonly string[]).includes(value)
      ? (value as OfferedContestField)
      : null;
    // A field that cannot be asked about now (an open request, a review, a
    // cooldown) is never preselected: its option says why, and the form waits
    // for another choice rather than sending a request the server refuses.
    const option = f === null ? null : this.fieldOptions().find((o) => o.value === f);
    this.blocked.set(option?.disabled ? option.label : null);
    if (option?.disabled) f = null;
    this.field.set(f);
    this.notice.set(null);
    const i = this.integration();
    const current = f === null ? null : (i.contestable_fields[f] ?? null);
    let start: string;
    if (f === 'owner') {
      // "Ask to be recorded as the owner" proposes the caller's company (§4.5.4).
      start = current === null ? (this.state.myVendorId() ?? NO_OWNER) : current;
    } else if (f === 'mechanism_kind') {
      start = current ?? this.kinds[0];
    } else {
      start = current ?? '';
    }
    this.seed.set(start);
    this.proposed.set(start);
  }

  protected blockedLine(reason: string): string {
    return $localize`:@@vendor.im.request.blocked:You cannot ask about this detail right now: ${reason}:reason:. Choose another detail, or wait.`;
  }

  protected howLabel(kind: string): string {
    return howYouGetIt(kind, null);
  }

  protected selectValue(event: Event): string {
    return (event.target as HTMLSelectElement).value;
  }

  protected inputValue(event: Event): string {
    return (event.target as HTMLInputElement | HTMLTextAreaElement).value;
  }

  protected async send(event: Event): Promise<void> {
    event.preventDefault();
    if (this.sending()) return;
    this.attempted.set(true);
    this.notice.set(null);
    const f = this.field();
    if (f === null || this.valueError() !== null || this.reason().trim() === '') return;
    const i = this.integration();
    const parsed = SubmitIntegrationContestSchema.safeParse({
      field: f,
      proposed_value: this.wireValue(),
      reason: this.reason(),
      context_product_id: i.context_product.id,
    } satisfies SubmitIntegrationContestInput);
    if (!parsed.success) {
      this.notice.set(
        $localize`:@@vendor.im.request.shape:Check the value and the reason, then try again.`,
      );
      return;
    }
    this.sending.set(true);
    try {
      const { contest } = await this.api.submitContest(i.id, parsed.data);
      const label = pageFieldLabel(f);
      this.announcer.announce(
        contest.routed_to === 'owner'
          ? $localize`:@@vendor.im.request.live.owner:Your request to change ${label}:field: was sent to the owner.`
          : $localize`:@@vendor.im.request.live.aeci:Your request to change ${label}:field: was sent to AEC Integrations.`,
      );
      await this.state.refreshContests();
      void this.store.revalidate(['contests']);
      this.sent.emit(contest);
    } catch (err) {
      this.notice.set(requestErrorMessage(err));
    } finally {
      this.sending.set(false);
    }
  }

  protected readonly label = LABEL;
  protected readonly help = HELP;
  protected readonly alert = ALERT;
  protected readonly primary = BTN_PRIMARY;
  protected readonly secondary = BTN_SECONDARY;
}

/** The refusals `POST …/contests` can answer, in this page's words (§6.17.8: a
 *  field contest is a "change request" here). */
export function requestErrorMessage(err: unknown): string {
  switch (readVendorApiError(err)?.code) {
    case 'FIELD_LOCKED_BY_AECI':
      return $localize`:@@vendor.im.request.error.locked:AEC Integrations corrected this detail and locked it, so a change cannot be requested. To dispute it, email support@aecintegrations.com.`;
    case 'CONTEST_DUPLICATE':
      return $localize`:@@vendor.im.request.error.duplicate:You already asked to change this detail. Withdraw that request below if you want to send a different value.`;
    case 'CONTEST_NO_CHANGE':
      return $localize`:@@vendor.im.request.error.noChange:That is already the value on the public page, so there is nothing to change.`;
    case 'CONTEST_INVALID_VALUE':
      return $localize`:@@vendor.im.request.error.invalid:That value is not valid for this detail. Check it and try again.`;
    case 'CONTEST_OWN_INTEGRATION':
      return $localize`:@@vendor.im.request.error.isOwner:Your company is recorded as the owner of this integration, so you edit it directly instead.`;
    case 'CONTEST_PROTEST_OPEN':
      return $localize`:@@vendor.im.request.error.protestOpen:You asked AEC Integrations to review a request on this detail. Wait for its answer, or withdraw that review first.`;
    case 'CONTEST_COOLDOWN':
      return $localize`:@@vendor.im.request.error.cooldown:AEC Integrations agreed with the owner on this detail, so you cannot ask again yet unless its value changes.`;
    case 'RATE_LIMITED':
      return $localize`:@@vendor.im.request.error.rate:Too many requests in a short time. Wait a minute and try again.`;
    default:
      return $localize`:@@vendor.im.request.error.generic:Could not send your request. Try again.`;
  }
}
