import {
  Component,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';

import {
  CONTEST_VALUE_MAX_LENGTH,
  INTEGRATION_CONTEST_FIELDS,
  IntegrationMechanismKindSchema,
  SubmitIntegrationContestSchema,
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

interface SelectOption {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
}

/**
 * "Contest a field" on an integration card (AECI-1008 /
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §11b).
 *
 * ── WHO SEES IT ─────────────────────────────────────────────────────────────
 * The card renders this only when `!integration.is_owner`. There is no
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
 */
@Component({
  selector: 'aec-vendor-contest-form',
  styles: [':host { display: block; }'],
  template: `
    <div class="border-t border-(--border-default) px-5 py-4">
      @if (openFieldLabels(); as labels) {
        <p class="mb-3 text-xs text-(--text-secondary)" data-testid="open-contests">
          {{ labels }}
        </p>
      }

      <button
        #trigger
        type="button"
        [attr.aria-expanded]="open()"
        [attr.aria-controls]="fieldId('panel')"
        (click)="toggle()"
        [class]="triggerClass"
        i18n="@@vendor.contest.trigger"
      >
        Contest a field
      </button>

      @if (open()) {
        <form
          [id]="fieldId('panel')"
          class="mt-4 space-y-5"
          novalidate
          (submit)="onSubmit($event)"
          [attr.aria-labelledby]="fieldId('title')"
        >
          <div class="max-w-prose space-y-1">
            <p
              [id]="fieldId('title')"
              class="text-sm font-semibold text-(--text-primary)"
              i18n="@@vendor.contest.form.title"
            >
              Contest a field on this integration
            </p>
            <p class="text-xs text-(--text-secondary)" i18n="@@vendor.contest.form.intro">
              Tell us which detail is wrong, what it should say, and why. The integration’s owner or
              AEC Integrations reviews it. Nothing on the public page changes unless it is accepted.
              You can follow it in Messages.
            </p>
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
              <svg
                class="pointer-events-none absolute end-3 top-1/2 h-4 w-4 -translate-y-1/2 text-(--text-secondary)"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path d="m6 9 6 6 6-6" />
              </svg>
            </div>
            @if (attempted() && field() === null) {
              <p role="alert" class="text-xs font-medium text-(--text-primary)">
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
                    <svg
                      class="pointer-events-none absolute end-3 top-1/2 h-4 w-4 -translate-y-1/2 text-(--text-secondary)"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      aria-hidden="true"
                    >
                      <path d="m6 9 6 6 6-6" />
                    </svg>
                  </div>
                }
              }
              @if (showValueError()) {
                <p
                  [id]="fieldId('value') + '-error'"
                  role="alert"
                  class="text-xs font-medium text-(--text-primary)"
                >
                  {{ valueError() }}
                </p>
              }
              @if (f === 'owner') {
                <p class="text-xs text-(--text-secondary)" i18n="@@vendor.contest.form.ownerHint">
                  Who built this integration. A contest about this field always goes to AEC
                  Integrations.
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
              class="text-xs text-(--text-secondary)"
              i18n="@@vendor.contest.form.reasonHint"
            >
              Required. Link to a source if you have one, such as your own documentation.
            </p>
            @if (showReasonError()) {
              <p
                [id]="fieldId('reason') + '-error'"
                role="alert"
                class="text-xs font-medium text-(--text-primary)"
              >
                {{ reasonRequiredMessage }}
              </p>
            }
          </div>

          <div class="flex flex-wrap items-center gap-3 border-t border-(--border-default) pt-4">
            <button type="submit" [class]="primaryButtonClass" [disabled]="submitting()">
              @if (submitting()) {
                <span i18n="@@vendor.contest.form.sending">Sending…</span>
              } @else {
                <span i18n="@@vendor.contest.form.submit">Send contest</span>
              }
            </button>
            <button
              type="button"
              [class]="secondaryButtonClass"
              [disabled]="submitting()"
              (click)="close()"
              i18n="@@vendor.contest.form.cancel"
            >
              Cancel
            </button>
          </div>

          @if (notice(); as message) {
            <p role="alert" class="text-sm font-medium text-(--text-primary)">{{ message }}</p>
          }
        </form>
      }
    </div>
  `,
})
export class VendorContestForm {
  private readonly api = inject(VendorApi);
  private readonly store = inject(VendorPortalStore);
  private readonly announcer = inject(VendorPortalAnnouncer);

  readonly integration = input.required<VendorIntegration>();
  /** The caller's company, for the owner picker when the wire carries no
   *  endpoint vendors (a pre-AECI-1008 API during a rollout). */
  readonly vendorId = input.required<string>();
  readonly vendorName = input.required<string>();

  private readonly trigger = viewChild<ElementRef<HTMLButtonElement>>('trigger');

  protected readonly open = signal(false);
  protected readonly submitting = signal(false);
  protected readonly attempted = signal(false);
  protected readonly notice = signal<string | null>(null);
  protected readonly field = signal<IntegrationContestField | null>(null);
  protected readonly proposed = signal('');
  protected readonly reason = signal('');

  protected readonly fieldPlaceholder = $localize`:@@vendor.contest.form.field.placeholder:Choose a field`;
  protected readonly valuePlaceholder = $localize`:@@vendor.contest.form.value.placeholder:Choose a value`;
  protected readonly fieldRequiredMessage = $localize`:@@vendor.contest.error.field:Choose the field you want to contest.`;
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
        .submitted.filter((c) => c.integration_id === id && c.status === 'open')
        .map((c) => c.field),
    );
  });

  protected readonly openFieldLabels = computed<string | null>(() => {
    const fields = INTEGRATION_CONTEST_FIELDS.filter((f) => this.openFields().has(f));
    if (fields.length === 0) return null;
    const names = fields.map(contestFieldLabel).join(', ');
    return $localize`:@@vendor.contest.openLine:You have an open contest on this integration: ${names}:FIELDS:. Follow it in Messages.`;
  });

  protected readonly fieldOptions = computed<readonly SelectOption[]>(() =>
    INTEGRATION_CONTEST_FIELDS.map((f) => {
      const busy = this.openFields().has(f);
      const label = contestFieldLabel(f);
      return {
        value: f,
        label: busy
          ? $localize`:@@vendor.contest.form.field.busy:${label}:FIELD: (you have an open contest)`
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

  protected onField(value: string): void {
    const f = (INTEGRATION_CONTEST_FIELDS as readonly string[]).includes(value)
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
      this.notice.set(
        $localize`:@@vendor.contest.error.shape:Check the value and the reason, then try again.`,
      );
      return;
    }

    this.submitting.set(true);
    try {
      const { contest } = await this.api.submitContest(this.integration().id, parsed.data);
      const label = contestFieldLabel(f);
      this.announcer.announce(
        contest.routed_to === 'owner'
          ? $localize`:@@vendor.contest.live.sent.owner:Your contest on ${label}:FIELD: was sent to the integration’s owner. Follow it in Messages.`
          : $localize`:@@vendor.contest.live.sent.aeci:Your contest on ${label}:FIELD: was sent to AEC Integrations. Follow it in Messages.`,
      );
      this.submitting.set(false);
      this.close();
      void this.store.revalidate(['contests']);
    } catch (err) {
      this.notice.set(contestSubmitErrorMessage(err));
      this.submitting.set(false);
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
    return `vendor-contest-${this.integration().id}-${this.integration().context_product.id}-${key}`;
  }

  protected selectValue(event: Event): string {
    return (event.target as HTMLSelectElement).value;
  }

  protected inputValue(event: Event): string {
    return (event.target as HTMLInputElement | HTMLTextAreaElement).value;
  }

  protected readonly triggerClass =
    'inline-flex items-center rounded-(--radius-md) border border-(--border-default) px-3 py-1.5 text-sm font-medium text-(--text-primary) transition-colors hover:border-(--border-strong) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';
  protected readonly selectClass =
    'w-full cursor-pointer appearance-none rounded-(--radius-md) border border-(--border-default) bg-(--surface-base) py-2 pe-9 ps-3 text-sm text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';
  protected readonly labelClass =
    'block text-xs font-bold tracking-[0.08em] text-(--text-secondary) uppercase';
  protected readonly inputClass =
    'w-full rounded-(--radius-md) border border-(--border-default) bg-(--surface-base) px-3 py-2 text-sm text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';
  protected readonly primaryButtonClass =
    'inline-flex items-center justify-center rounded-(--radius-md) border border-(--border-strong) bg-(--accent-primary) px-5 py-2.5 text-sm font-bold text-(--surface-base) transition-colors hover:bg-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) disabled:cursor-not-allowed disabled:opacity-50';
  protected readonly secondaryButtonClass =
    'inline-flex items-center justify-center rounded-(--radius-md) border border-(--border-default) px-4 py-2 text-sm font-medium text-(--text-primary) transition-colors hover:border-(--border-strong) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) disabled:cursor-not-allowed disabled:opacity-50';
}
