import { formatDate } from '@angular/common';
import {
  Component,
  ElementRef,
  Injector,
  LOCALE_ID,
  afterNextRender,
  computed,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';

import {
  CONTEST_VALUE_MAX_LENGTH,
  IntegrationMechanismKindSchema,
  SubmitIntegrationContestSchema,
  contestFieldsFor,
  type ContestAnchorKind,
  type IntegrationContestField,
  type SubmitIntegrationContestInput,
  type VendorIntegration,
} from '@aeci/shared';

import { directionHeading } from '../../products/pair-direction-labels';
import { mechanismKindLabel } from '../../search/mechanism-labels';
import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorApi } from '../vendor-api';
import { VendorPortalStore } from '../vendor-portal-store';

import {
  contestFieldLabel,
  contestSubmitErrorMessage,
  contestValueDisplay,
  contestValueMessage,
  noOwnerLabel,
} from './vendor-contest-labels';
import { VendorDocsLink } from './vendor-docs-link';
import { isReplayedEvent } from '../../core/event-replay';
import { AecButton } from '../../shared/button/button';
import {
  FIELD_ERROR_CLASS,
  FIELD_HINT_CLASS,
  FIELD_INPUT_CLASS,
  FIELD_LABEL_CLASS,
} from '../../shared/form-field/form-field-classes';
import { AecIcon } from '../../shared/icon/icon';
import { FORM_PANEL } from '../integration-detail/integration-detail-styles';
import { KeepClearOfSaveBar } from '../shared/keep-clear-of-save-bar';
import { PORTAL_NESTED_SAVE_BAR_CLASS, PORTAL_SAVE_BUTTON_CLASS } from '../shared/portal-form';

/** The owner picker's value for "neither endpoint vendor". Never a UUID, so it
 *  can never collide with a vendor id. It becomes `null` on the wire. */
export const NO_OWNER = 'none';

/** How each field is edited. See {@link VendorContestForm}. */
type ControlKind = 'url' | 'text' | 'textarea' | 'mechanism' | 'direction' | 'owner';

const URL_FIELDS: ReadonlySet<IntegrationContestField> = new Set([
  'listing_url',
  'docs_url',
  'website',
  'mechanism_url',
]);

function controlFor(field: IntegrationContestField): ControlKind {
  if (URL_FIELDS.has(field)) return 'url';
  switch (field) {
    case 'description':
      return 'textarea';
    case 'mechanism_kind':
      return 'mechanism';
    case 'direction':
      return 'direction';
    case 'owner':
      return 'owner';
    default:
      return 'text';
  }
}

/**
 * What the form needs to know about the row it contests. A `VendorIntegration`
 * satisfies it, and so does an `EvidencedPairContestTarget` from the connectors
 * read (AECI-1092), which is how a delivered pair is contested.
 */
export type VendorContestTarget = Pick<
  VendorIntegration,
  'id' | 'contestable_fields' | 'endpoint_vendors' | 'other_product' | 'context_product'
> & { readonly owner: { readonly id: string; readonly name: string } | null };

interface SelectOption {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
}

/**
 * "Contest a field" on a connector-delivered pair in the Connectors section (AECI-1008 /
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §11b).
 *
 * ── WHO SEES IT ─────────────────────────────────────────────────────────────
 * The Connectors section renders this only when `!is_owner`. Since AECI-1156 an
 * integration's own requests use the detail page's form (§6.17.6). There is no
 * entitlement or Verified check, on purpose: a seat is the whole gate (§11b.2),
 * because asking for a public fact to be fixed must not be something a vendor
 * buys. Every portal caller holds a seat, so "has a seat" needs no input here.
 *
 * ── PESSIMISTIC, NOT OPTIMISTIC ─────────────────────────────────────────────
 * A contest is a request, never the value, and it writes nothing the card
 * renders. There is no honest optimistic rendering, so the form waits for the
 * `201`, then announces, closes, and revalidates the `contests` resource.
 *
 * ── ONE RULE, SHARED ────────────────────────────────────────────────────────
 * The value check is `contestValueProblem` from `@aeci/shared`, the same
 * function the handler runs, and the body is parsed with the shared
 * `SubmitIntegrationContestSchema` before it is sent. Only the wording is
 * chosen here. Whether a proposed owner is one of the endpoint vendors stays a
 * server check, though the picker only offers those vendors.
 *
 * ── THE CONTROLS ────────────────────────────────────────────────────────────
 * Native `<select>` for the three closed vocabularies (type, direction, owner),
 * matching the data-flow pickers since 2026-09-17. Direction is caller-relative
 * on the wire, so its options are the pair page's own sentences against the
 * other product. Every control starts at the current value, so a vendor edits
 * what is on record rather than retyping it, and an unchanged value is caught
 * before it reaches the server's `CONTEST_NO_CHANGE`.
 *
 * ── THE LOOK (AECI-2132) ────────────────────────────────────────────────────
 * One family with the other nested contest forms (`integration-request-form.ts`,
 * `vendor-contest-protest.ts`, `vendor-not-ours.ts`): the opener is a compact
 * secondary `aecButton`, the form is the nested `FORM_PANEL` with the sticky nested
 * save bar (`aecKeepClearOfSaveBar` keeps a focused field clear of it), fields take
 * the shared recipe and the Label role, and a select's chevron is `aec-icon`. Send is
 * primary: a sent request can still be withdrawn from Messages.
 *
 * ── FOCUS ───────────────────────────────────────────────────────────────────
 * No Escape handler, like the three sibling forms: one keystroke must not wipe a long
 * draft (one behaviour per pattern). Cancel closes and returns focus to "Request a
 * change". A refusal from the server (or the schema) takes focus, so a keyboard user
 * hears it and is not left on the disabled Send button. A field error stays beside its
 * field and takes no focus.
 */
@Component({
  selector: 'aec-vendor-contest-form',
  imports: [AecButton, AecIcon, KeepClearOfSaveBar, VendorDocsLink],
  styles: [':host { display: block; }'],
  template: `
    <div class="border-t border-(--border-default) py-4">
      @if (openFieldLabels(); as labels) {
        <p class="mb-3" [class]="hintClass" data-testid="open-contests">
          {{ labels }}
        </p>
      }

      <button
        #trigger
        aecButton
        variant="secondary"
        compact
        type="button"
        [attr.aria-expanded]="open()"
        [attr.aria-controls]="fieldId('panel')"
        (click)="toggle()"
        i18n="@@vendor.contest.trigger"
      >
        Request a change
      </button>

      @if (open()) {
        <form
          aecKeepClearOfSaveBar
          method="dialog"
          [id]="fieldId('panel')"
          class="mt-4 space-y-6"
          [class]="panelClass"
          novalidate
          (submit)="onSubmit($event)"
          [attr.aria-labelledby]="fieldId('title')"
          data-testid="contest-form"
        >
          <div class="max-w-prose space-y-1">
            <p
              [id]="fieldId('title')"
              class="text-t-14 font-semibold text-(--text-primary)"
              i18n="@@vendor.contest.form.title"
            >
              Request a change on this integration
            </p>
            <p [class]="hintClass" i18n="@@vendor.contest.form.intro">
              Tell us which detail is wrong, what it should say, and why. The integration’s owner or
              AEC Integrations reviews it. Nothing on the public page changes unless it is accepted.
              You can follow it in Messages.
            </p>
            <p><aec-vendor-docs-link page="requesting-changes-and-appeals" /></p>
          </div>

          <div class="max-w-sm space-y-2">
            <label [for]="fieldId('field')" [class]="labelClass" i18n="@@vendor.contest.form.field"
              >Field</label
            >
            <div class="relative">
              <select
                [id]="fieldId('field')"
                (change)="onField(selectValue($event))"
                [class]="selectClass"
              >
                <option value="" disabled [selected]="field() === null">
                  {{ fieldPlaceholder }}
                </option>
                @for (option of fieldOptions(); track option.value) {
                  <option
                    [value]="option.value"
                    [disabled]="option.disabled"
                    [selected]="option.value === field()"
                  >
                    {{ option.label }}
                  </option>
                }
              </select>
              <span [class]="selectChevronClass">
                <aec-icon name="chevron-down" decorative [size]="4" />
              </span>
            </div>
            @if (attempted() && field() === null) {
              <p role="alert" [class]="errorClass">
                {{ fieldRequiredMessage }}
              </p>
            }
          </div>

          @if (field(); as f) {
            <div class="max-w-2xl space-y-1">
              <p [class]="labelClass" i18n="@@vendor.contest.form.current">On record now</p>
              <p class="text-sm break-words text-(--text-primary)" data-testid="contest-current">
                {{ currentDisplay() }}
              </p>
            </div>

            <div class="max-w-2xl space-y-2">
              <label
                [for]="fieldId('value')"
                [class]="labelClass"
                i18n="@@vendor.contest.form.proposed"
                >What it should say</label
              >
              @switch (control()) {
                @case ('textarea') {
                  <textarea
                    [id]="fieldId('value')"
                    rows="4"
                    [attr.maxlength]="maxLength()"
                    [value]="proposed()"
                    (input)="onProposed(inputValue($event))"
                    [attr.aria-invalid]="showValueError() ? 'true' : null"
                    [attr.aria-describedby]="showValueError() ? fieldId('value') + '-error' : null"
                    [class]="inputClass"
                  ></textarea>
                }
                @case ('url') {
                  <input
                    [id]="fieldId('value')"
                    type="url"
                    inputmode="url"
                    autocomplete="url"
                    [attr.maxlength]="maxLength()"
                    [value]="proposed()"
                    (input)="onProposed(inputValue($event))"
                    [attr.aria-invalid]="showValueError() ? 'true' : null"
                    [attr.aria-describedby]="showValueError() ? fieldId('value') + '-error' : null"
                    [class]="inputClass"
                  />
                }
                @case ('text') {
                  <input
                    [id]="fieldId('value')"
                    type="text"
                    [attr.maxlength]="maxLength()"
                    [value]="proposed()"
                    (input)="onProposed(inputValue($event))"
                    [attr.aria-invalid]="showValueError() ? 'true' : null"
                    [attr.aria-describedby]="showValueError() ? fieldId('value') + '-error' : null"
                    [class]="inputClass"
                  />
                }
                @default {
                  <div class="relative max-w-sm">
                    <select
                      [id]="fieldId('value')"
                      (change)="onProposed(selectValue($event))"
                      [attr.aria-invalid]="showValueError() ? 'true' : null"
                      [attr.aria-describedby]="
                        showValueError() ? fieldId('value') + '-error' : null
                      "
                      [class]="selectClass"
                    >
                      @if (proposed() === '') {
                        <option value="" disabled selected>{{ valuePlaceholder }}</option>
                      }
                      @for (option of valueOptions(); track option.value) {
                        <option [value]="option.value" [selected]="option.value === proposed()">
                          {{ option.label }}
                        </option>
                      }
                    </select>
                    <span [class]="selectChevronClass">
                      <aec-icon name="chevron-down" decorative [size]="4" />
                    </span>
                  </div>
                }
              }
              @if (showValueError()) {
                <p [id]="fieldId('value') + '-error'" role="alert" [class]="errorClass">
                  {{ valueError() }}
                </p>
              }
              @if (f === 'owner') {
                <p [class]="hintClass" i18n="@@vendor.contest.form.ownerHintOffered">
                  The vendor that owns and offers this integration. A change request about this
                  field always goes to AEC Integrations.
                </p>
              }
            </div>
          }

          <div class="max-w-2xl space-y-2">
            <label
              [for]="fieldId('reason')"
              [class]="labelClass"
              i18n="@@vendor.contest.form.reason"
              >Why</label
            >
            <textarea
              [id]="fieldId('reason')"
              rows="3"
              maxlength="2000"
              required
              [value]="reason()"
              (input)="reason.set(inputValue($event))"
              [attr.aria-invalid]="showReasonError() ? 'true' : null"
              [attr.aria-describedby]="
                fieldId('reason') +
                '-hint' +
                (showReasonError() ? ' ' + fieldId('reason') + '-error' : '')
              "
              [class]="inputClass"
            ></textarea>
            <p
              [id]="fieldId('reason') + '-hint'"
              [class]="hintClass"
              i18n="@@vendor.contest.form.reasonHint"
            >
              Required. Link to a source if you have one, such as your own documentation.
            </p>
            @if (showReasonError()) {
              <p [id]="fieldId('reason') + '-error'" role="alert" [class]="errorClass">
                {{ reasonRequiredMessage }}
              </p>
            }
          </div>

          @if (notice(); as message) {
            <p #noticeEl role="alert" tabindex="-1" [class]="noticeClass">{{ message }}</p>
          }

          <div [class]="saveBarClass">
            <button
              aecButton
              type="submit"
              [class]="saveButtonClass"
              [disabled]="submitting()"
              [attr.aria-busy]="submitting() ? 'true' : null"
            >
              @if (submitting()) {
                <span i18n="@@vendor.contest.form.sending">Sending…</span>
              } @else {
                <span i18n="@@vendor.contest.form.submit">Send request</span>
              }
            </button>
            <button
              aecButton
              variant="secondary"
              type="button"
              [class]="saveButtonClass"
              [disabled]="submitting()"
              (click)="close()"
              i18n="@@vendor.contest.form.cancel"
            >
              Cancel
            </button>
          </div>
        </form>
      }
    </div>
  `,
})
export class VendorContestForm {
  /** A field's inline error: the shared recipe (AECI-1984). */
  protected readonly errorClass = FIELD_ERROR_CLASS;
  private readonly api = inject(VendorApi);
  private readonly store = inject(VendorPortalStore);
  private readonly announcer = inject(VendorPortalAnnouncer);
  private readonly locale = inject(LOCALE_ID);
  private readonly injector = inject(Injector);

  readonly integration = input.required<VendorContestTarget>();
  /** AECI-1092: which table `integration.id` names. An evidenced pair posts to its
   *  own route and offers the eleven fields that table has (no type). */
  readonly anchor = input<ContestAnchorKind>('integration');
  /** The caller's company, for the owner picker when the wire carries no
   *  endpoint vendors (a pre-AECI-1008 API during a rollout). */
  readonly vendorId = input('');
  readonly vendorName = input('');

  /** The fields this anchor may contest, in the §11b.3 order. */
  private readonly fields = computed(() => contestFieldsFor(this.anchor()));

  /** A caller contest on THIS row: the same id on the same anchor table. */
  private readonly isHere = (c: { integration_id: string; anchor?: ContestAnchorKind }) =>
    c.integration_id === this.integration().id && (c.anchor ?? 'integration') === this.anchor();

  private readonly trigger = viewChild<ElementRef<HTMLButtonElement>>('trigger');
  private readonly noticeEl = viewChild<ElementRef<HTMLElement>>('noticeEl');

  protected readonly open = signal(false);
  protected readonly submitting = signal(false);
  protected readonly attempted = signal(false);
  protected readonly notice = signal<string | null>(null);
  protected readonly field = signal<IntegrationContestField | null>(null);
  protected readonly proposed = signal('');
  protected readonly reason = signal('');

  protected readonly fieldPlaceholder = $localize`:@@vendor.contest.form.field.placeholder:Choose a field`;
  protected readonly valuePlaceholder = $localize`:@@vendor.contest.form.value.placeholder:Choose a value`;
  protected readonly fieldRequiredMessage = $localize`:@@vendor.contest.error.field:Choose the field you want to change.`;
  protected readonly reasonRequiredMessage = $localize`:@@vendor.contest.error.reason:Say why the value on record is wrong.`;

  constructor() {
    // The open-contest line reads the contests resource. Load-once, and after
    // hydration only, like every other lazy portal read.
    afterNextRender(() => void this.store.ensure('contests'));
  }

  /** The caller's OPEN contests on this integration, by field. One open contest
   *  per (integration, field, vendor) is the server's rule, so those fields are
   *  disabled in the picker rather than left to collect a `409`. */
  private readonly openFields = computed<ReadonlySet<IntegrationContestField>>(() => {
    const id = this.integration().id;
    return new Set(
      this.store
        .contests()
        .submitted.filter((c) => c.integration_id === id && this.isHere(c) && c.status === 'open')
        .map((c) => c.field),
    );
  });

  protected readonly openFieldLabels = computed<string | null>(() => {
    const fields = this.fields().filter((f) => this.openFields().has(f));
    if (fields.length === 0) return null;
    const names = fields.map(contestFieldLabel).join(', ');
    return $localize`:@@vendor.contest.openLine:You have an open change request on this integration: ${names}:FIELDS:. Follow it in Messages.`;
  });

  /**
   * AECI-1009: fields a NEW contest would be refused on. An open protest on the
   * field (`409 CONTEST_PROTEST_OPEN`), or a lost protest's cooldown that has not
   * ended (`409 CONTEST_COOLDOWN`, mapped to its end date). The server sends
   * `cooldown_until` only while the value is unchanged; any owner edit refetches
   * the contests (the store revalidates them with `integrations`) and lifts it.
   */
  private readonly protestBlocks = computed<
    ReadonlyMap<IntegrationContestField, { readonly until: string | null }>
  >(() => {
    const id = this.integration().id;
    const now = Date.now();
    const blocks = new Map<IntegrationContestField, { until: string | null }>();
    for (const c of this.store.contests().submitted) {
      if (c.integration_id !== id || !this.isHere(c)) continue;
      if (c.protest?.status === 'open') blocks.set(c.field, { until: null });
      else if (c.cooldown_until && Date.parse(c.cooldown_until) > now && !blocks.has(c.field)) {
        blocks.set(c.field, { until: c.cooldown_until });
      }
    }
    return blocks;
  });

  protected readonly fieldOptions = computed<readonly SelectOption[]>(() =>
    this.fields().map((f) => {
      const busy = this.openFields().has(f);
      const block = this.protestBlocks().get(f);
      const label = contestFieldLabel(f);
      if (!busy && block) {
        const until = block.until ? formatDate(block.until, 'medium', this.locale) : null;
        return {
          value: f,
          label: until
            ? $localize`:@@vendor.contest.form.field.cooldown:${label}:FIELD: (not until ${until}:DATE:)`
            : $localize`:@@vendor.contest.form.field.protestOpen:${label}:FIELD: (with AEC Integrations for review)`,
          disabled: true,
        };
      }
      return {
        value: f,
        label: busy
          ? $localize`:@@vendor.contest.form.field.busy:${label}:FIELD: (you have an open request)`
          : label,
        disabled: busy,
      };
    }),
  );

  protected readonly control = computed<ControlKind>(() => controlFor(this.field() ?? 'name'));

  private readonly current = computed<string | null>(() => {
    const f = this.field();
    return f === null ? null : (this.integration().contestable_fields[f] ?? null);
  });

  protected readonly currentDisplay = computed(() => {
    const f = this.field();
    if (f === null) return '';
    const value = this.current();
    const label =
      f === 'owner'
        ? (this.ownerChoices().find((v) => v.id === value)?.name ??
          this.integration().owner?.name ??
          null)
        : null;
    return contestValueDisplay(f, value, label, this.integration().other_product.name);
  });

  protected readonly maxLength = computed(() => CONTEST_VALUE_MAX_LENGTH[this.field() ?? 'name']);

  /** Both endpoints' vendors, or the caller alone when the wire has none. */
  private readonly ownerChoices = computed(() => {
    const listed = this.integration().endpoint_vendors;
    return listed.length > 0 ? listed : [{ id: this.vendorId(), name: this.vendorName() }];
  });

  protected readonly valueOptions = computed<readonly SelectOption[]>(() => {
    switch (this.control()) {
      case 'mechanism':
        return IntegrationMechanismKindSchema.options.map((kind) => ({
          value: kind,
          label: mechanismKindLabel(kind) || kind,
        }));
      case 'direction': {
        const other = this.integration().other_product.name;
        return (['outbound', 'both', 'inbound'] as const).map((d) => ({
          value: d,
          label: directionHeading(d, other),
        }));
      }
      case 'owner':
        return [
          ...this.ownerChoices().map((v) => ({ value: v.id, label: v.name })),
          { value: NO_OWNER, label: noOwnerLabel() },
        ];
      default:
        return [];
    }
  });

  /** The proposal in wire form. `owner`'s "neither" is `null`. */
  private readonly wireValue = computed<string | null>(() => {
    const f = this.field();
    if (f === 'owner' && this.proposed() === NO_OWNER) return null;
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

  /** What the value control was prefilled with, so an error does not fire
   *  before the vendor has touched it. */
  private readonly seed = signal('');

  protected toggle(): void {
    if (this.open()) this.close();
    else this.open.set(true);
  }

  /** Close and reset, returning focus to the trigger so a keyboard user is not
   *  dropped at the top of the page when the form unmounts. */
  close(): void {
    this.open.set(false);
    this.reset();
    this.trigger()?.nativeElement.focus();
  }

  /** A refused send: show the sentence, then move focus to it once it renders, so
   *  focus never rests on the disabled Send button (AECI-1994). */
  private refuse(message: string): void {
    this.notice.set(message);
    afterNextRender(() => this.noticeEl()?.nativeElement.focus(), { injector: this.injector });
  }

  protected onField(value: string): void {
    const f = (this.fields() as readonly string[]).includes(value)
      ? (value as IntegrationContestField)
      : null;
    this.field.set(f);
    this.notice.set(null);
    const current = f === null ? null : (this.integration().contestable_fields[f] ?? null);
    const start = f === 'owner' ? (current ?? NO_OWNER) : (current ?? '');
    this.seed.set(start);
    this.proposed.set(start);
  }

  protected onProposed(value: string): void {
    this.proposed.set(value);
    this.notice.set(null);
  }

  protected async onSubmit(event: Event): Promise<void> {
    if (isReplayedEvent(event)) return;
    event.preventDefault();
    if (this.submitting()) return;
    this.attempted.set(true);
    this.notice.set(null);

    const f = this.field();
    if (f === null || this.valueError() !== null || this.reason().trim() === '') return;

    const parsed = SubmitIntegrationContestSchema.safeParse({
      field: f,
      proposed_value: this.wireValue(),
      reason: this.reason(),
      context_product_id: this.integration().context_product.id,
    } satisfies SubmitIntegrationContestInput);
    if (!parsed.success) {
      this.refuse(
        $localize`:@@vendor.contest.error.shape:Check the value and the reason, then try again.`,
      );
      return;
    }

    this.submitting.set(true);
    try {
      const { contest } = await this.api.submitContest(
        this.integration().id,
        parsed.data,
        this.anchor(),
      );
      const label = contestFieldLabel(f);
      this.announcer.announce(
        contest.routed_to === 'owner'
          ? $localize`:@@vendor.contest.live.sent.owner:Your change request on ${label}:FIELD: was sent to the integration’s owner. Follow it in Messages.`
          : $localize`:@@vendor.contest.live.sent.aeci:Your change request on ${label}:FIELD: was sent to AEC Integrations. Follow it in Messages.`,
      );
      this.submitting.set(false);
      this.close();
      void this.store.revalidate(['contests']);
    } catch (err) {
      this.submitting.set(false);
      this.refuse(contestSubmitErrorMessage(err));
    }
  }

  private reset(): void {
    this.field.set(null);
    this.proposed.set('');
    this.seed.set('');
    this.reason.set('');
    this.attempted.set(false);
    this.notice.set(null);
  }

  protected fieldId(key: string): string {
    return `vendor-contest-${this.anchor()}-${this.integration().id}-${this.integration().context_product.id}-${key}`;
  }

  protected selectValue(event: Event): string {
    return (event.target as HTMLSelectElement).value;
  }

  protected inputValue(event: Event): string {
    return (event.target as HTMLInputElement | HTMLTextAreaElement).value;
  }

  /** A select: the field recipe, with room for the chevron at the end. */
  protected readonly selectClass = `${FIELD_INPUT_CLASS} cursor-pointer appearance-none pe-12`;
  protected readonly selectChevronClass =
    'pointer-events-none absolute end-4 top-1/2 flex -translate-y-1/2 text-(--text-secondary)';
  protected readonly labelClass = FIELD_LABEL_CLASS;
  protected readonly inputClass = FIELD_INPUT_CLASS;
  protected readonly hintClass = FIELD_HINT_CLASS;
  /** A refusal from the server or the schema: the field error look. It takes focus, and
   *  shows the ring the portal's other focused refusals show. */
  protected readonly noticeClass = `${FIELD_ERROR_CLASS} rounded-mark focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--accent-primary)`;
  /** A form nested in a row: the bordered panel and the nested sticky save bar. */
  protected readonly panelClass = FORM_PANEL;
  protected readonly saveBarClass = PORTAL_NESTED_SAVE_BAR_CLASS;
  protected readonly saveButtonClass = PORTAL_SAVE_BUTTON_CLASS;
}
