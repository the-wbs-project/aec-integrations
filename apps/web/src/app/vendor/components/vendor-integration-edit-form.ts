import {
  Component,
  InjectionToken,
  computed,
  inject,
  input,
  output,
  signal,
  type OnInit,
} from '@angular/core';

import {
  CONNECTOR_POWERED_FROZEN_EDIT_FIELDS,
  INTEGRATION_EDIT_FIELDS,
  INTEGRATION_EDIT_MAX_LENGTH,
  INTEGRATION_EDIT_REQUIRED_FIELDS,
  INTEGRATION_EDIT_URL_FIELDS,
  OWNER_EDITABLE_MECHANISM_KINDS,
  UpdateVendorIntegrationSchema,
  hiddenField,
  lockedField,
  type IntegrationEditField,
  type HiddenField,
  type LockedField,
  type UpdateVendorIntegrationInput,
} from '@aeci/shared';

import { directionHeading } from '../../products/pair-direction-labels';
import { mechanismKindLabel } from '../../search/mechanism-labels';
import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorApi } from '../vendor-api';
import { VendorPortalStore } from '../vendor-portal-store';
import { VendorHiddenNote } from './vendor-hidden-note';
import { VendorLockedNote } from './vendor-locked-note';

import { editFieldLabel } from './vendor-contest-labels';
import { editSaveErrorMessage, editValueMessage } from './vendor-integration-ownership-labels';
import { isReplayedEvent } from '../../core/event-replay';
import { AecButton } from '../../shared/button/button';
import {
  FIELD_ERROR_CLASS,
  FIELD_INPUT_CLASS,
  FIELD_LABEL_CLASS,
  FIELD_OPTIONAL_CLASS,
} from '../../shared/form-field/form-field-classes';
import { AecIcon } from '../../shared/icon/icon';
import {
  PORTAL_FIELDSET_CLASS,
  PORTAL_FIELD_CLASS,
  PORTAL_FORM_CLASS,
  PORTAL_FORM_GRID_CLASS,
  PORTAL_FORM_SPAN_CLASS,
  PORTAL_LEGEND_CLASS,
  PORTAL_NESTED_SAVE_BAR_CLASS,
  PORTAL_SAVE_BUTTON_CLASS,
  PORTAL_SAVE_STATUS_CLASS,
} from '../shared/portal-form';
import { KeepClearOfSaveBar } from '../shared/keep-clear-of-save-bar';
import { CloseOnEscape } from '../shared/close-on-escape';

/** How each field is edited. Same split as the contest form. */
type ControlKind = 'url' | 'text' | 'textarea' | 'mechanism' | 'direction';

function controlFor(field: IntegrationEditField): ControlKind {
  if (INTEGRATION_EDIT_URL_FIELDS.has(field)) return 'url';
  if (field === 'description') return 'textarea';
  if (field === 'mechanism_kind') return 'mechanism';
  if (field === 'direction') return 'direction';
  return 'text';
}

/**
 * The integration id whose owner edit form starts open. Provided ONLY by the dev
 * preview (`/preview/vendor-dashboard/products/<slug>/integrations?edit=<integration id>`),
 * so `npx impeccable detect`, which reads the first render, can see the form.
 * Nothing in the product provides it. Moved here from the retired
 * `vendor-integration-ownership.ts` (AECI-1156): §6.15's owned rows are the one
 * surface that still opens this form.
 */
export const VENDOR_EDIT_FORM_START_OPEN = new InjectionToken<string | null>(
  'VENDOR_EDIT_FORM_START_OPEN',
);

/** The form's three groups, each a `<fieldset>` so a screen reader hears which
 *  part of the integration a control belongs to. Together they are exactly
 *  `INTEGRATION_EDIT_FIELDS`; `vendor-integration-edit-form.component.spec.ts`
 *  asserts that. */
export const EDIT_GROUPS: readonly {
  readonly key: 'about' | 'links' | 'terms';
  readonly fields: readonly IntegrationEditField[];
}[] = [
  {
    key: 'about',
    fields: ['name', 'description', 'mechanism_kind', 'mechanism_name', 'direction'],
  },
  // AECI-1155: website and connection link left the portal. AECI-1154: the pricing
  // page joins the terms group beside the pricing text.
  { key: 'links', fields: ['listing_url', 'docs_url'] },
  { key: 'terms', fields: ['pricing_model', 'pricing_url', 'maturity'] },
];

type Draft = Record<IntegrationEditField, string>;

/** The values on record, in wire form (`direction` framed against the context
 *  product). The `contestable_fields` map of either list entry fits. */
export type EditFormValues = Partial<Record<IntegrationEditField, string | null>>;

/** How the form closed, so the host can put focus back in the right place. */
export type EditFormOutcome = 'saved' | 'cancelled';

/**
 * The owner's edit form (AECI-1006, reused for the AECI-1090 carve-out;
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §4.5.6 and §6.14).
 *
 * One form for both places an owner meets its integration: the ownership block on an
 * attestable card, and a row in the owned-rows list (AECI-1089), which is where a
 * third-party owner sees its connector-delivered rows. The host owns the "Edit
 * details" trigger and whether the form is open. This owns the draft, the value rule,
 * the save and its announcement, and says when it is done through `closed`.
 *
 * ── CONNECTOR-DELIVERED ROWS (AECI-1090) ────────────────────────────────────
 * With `connectorDelivered`, the type is frozen (AECI-1040 ruling 5): the picker is
 * left out, a sentence says AEC Integrations sets it, and the field is never sent. An
 * evidenced pair has no type column, which is the same ten fields.
 *
 * ── PESSIMISTIC ─────────────────────────────────────────────────────────────
 * The save waits for the `200`, announces through the portal's one live region and
 * revalidates `integrations` (`STAGE_2_REALTIME_SPEC.md` §4). Only changed fields are
 * sent, each checked with the shared rule the handler runs. Each refusal code renders
 * its own sentence in a `role="alert"`, and the form stays open.
 */
@Component({
  selector: 'aec-vendor-integration-edit-form',
  imports: [
    CloseOnEscape,
    AecButton,
    AecIcon,
    KeepClearOfSaveBar,
    VendorHiddenNote,
    VendorLockedNote,
  ],
  styles: [':host { display: block; margin-top: 1.5rem; }'],
  template: `
    <form
      aecCloseOnEscape
      [escapeBusy]="saving()"
      (escapeCancel)="closed.emit('cancelled')"
      aecKeepClearOfSaveBar
      method="dialog"
      [id]="fieldId('form')"
      [class]="formClass"
      novalidate
      (submit)="onSave($event)"
      [attr.aria-labelledby]="fieldId('title')"
    >
      <div class="mb-8 max-w-prose space-y-1">
        <p
          [id]="fieldId('title')"
          class="font-display text-t-20 font-semibold text-(--text-primary)"
          i18n="@@vendor.integrationEdit.title"
        >
          Edit this integration
        </p>
        <p
          class="max-w-prose text-sm text-(--text-secondary)"
          i18n="@@vendor.integrationEdit.intro"
        >
          Changes go live on the public integration page as soon as you save. There is no review
          step. The other product's vendor is told what changed.
        </p>
        @if (connectorDelivered()) {
          <p
            class="max-w-prose text-sm text-(--text-secondary)"
            data-testid="edit-frozen-type"
            i18n="@@vendor.integrationEdit.connectorTypeFrozen.v2"
          >
            A connector product delivers this integration, so its type is fixed. You can edit
            everything else.
          </p>
        }
      </div>

      @for (group of groups(); track group.key) {
        <fieldset [class]="fieldsetClass">
          <legend [class]="legendClass">{{ groupLabel(group.key) }}</legend>
          <div [class]="gridClass">
            @for (field of group.fields; track field) {
              <div [class]="field === 'description' ? fieldClass + ' ' + spanClass : fieldClass">
                <label [for]="fieldId(field)" [class]="labelClass">
                  {{ fieldLabel(field) }}
                  @if (!required(field)) {
                    <span [class]="optionalClass">{{ optionalLabel }}</span>
                  }
                </label>
                @if (lockOf(field); as lock) {
                  <!-- AECI-1237: a field AEC Integrations locked is shown, not edited. -->
                  <input
                    [id]="fieldId(field)"
                    type="text"
                    readonly
                    [value]="displayValue(field)"
                    [attr.aria-describedby]="fieldId(field) + '-locked'"
                    [class]="lockedInputClass"
                  />
                  <aec-vendor-locked-note [lock]="lock" [noteId]="fieldId(field) + '-locked'" />
                } @else {
                  @switch (control(field)) {
                    @case ('textarea') {
                      <textarea
                        [id]="fieldId(field)"
                        rows="4"
                        [attr.maxlength]="maxLength(field)"
                        [value]="draft()[field]"
                        (input)="onInput(field, inputValue($event))"
                        [attr.aria-invalid]="showError(field) ? 'true' : null"
                        [attr.aria-describedby]="describedBy(field)"
                        [class]="inputClass"
                      ></textarea>
                    }
                    @case ('url') {
                      <input
                        [id]="fieldId(field)"
                        type="url"
                        inputmode="url"
                        autocomplete="url"
                        [attr.maxlength]="maxLength(field)"
                        [value]="draft()[field]"
                        (input)="onInput(field, inputValue($event))"
                        [attr.aria-invalid]="showError(field) ? 'true' : null"
                        [attr.aria-describedby]="describedBy(field)"
                        [class]="inputClass"
                      />
                    }
                    @case ('text') {
                      <input
                        [id]="fieldId(field)"
                        type="text"
                        [attr.maxlength]="maxLength(field)"
                        [value]="draft()[field]"
                        (input)="onInput(field, inputValue($event))"
                        [attr.aria-invalid]="showError(field) ? 'true' : null"
                        [attr.aria-describedby]="describedBy(field)"
                        [class]="inputClass"
                      />
                    }
                    @default {
                      <div class="relative">
                        <select
                          [id]="fieldId(field)"
                          (change)="onInput(field, selectValue($event))"
                          [attr.aria-invalid]="showError(field) ? 'true' : null"
                          [attr.aria-describedby]="describedBy(field)"
                          [class]="selectClass"
                        >
                          @if (draft()[field] === '') {
                            <option value="" disabled selected>{{ choosePlaceholder }}</option>
                          }
                          @for (option of optionsFor(field); track option.value) {
                            <option
                              [value]="option.value"
                              [selected]="option.value === draft()[field]"
                            >
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
                  <!-- AECI-1238 (§11d.7): hidden from the public page, still editable. -->
                  @if (hideOf(field); as hide) {
                    <aec-vendor-hidden-note [hide]="hide" [noteId]="fieldId(field) + '-hidden'" />
                  }
                }
                @if (showError(field)) {
                  <p [id]="fieldId(field) + '-error'" role="alert" [class]="errorClass">
                    {{ errorFor(field) }}
                  </p>
                }
              </div>
            }
          </div>
        </fieldset>
      }

      <!-- The save bar, sticky at the foot of the form. This form sits inside a row of
           the owned list, not at the foot of its own card, so the bar keeps to the
           row's width rather than pulling out over a card's padding. -->
      <div [class]="saveBarClass">
        <div [class]="saveStatusClass">
          @if (saveNotice(); as message) {
            <p role="alert" class="font-semibold text-(--text-primary)">
              {{ message }}
            </p>
          }
        </div>
        <button aecButton type="submit" [class]="saveButtonClass" [disabled]="saving()">
          @if (saving()) {
            <span i18n="@@vendor.integrationEdit.saving">Saving…</span>
          } @else {
            <span i18n="@@vendor.integrationEdit.save">Save changes</span>
          }
        </button>
        <button
          aecButton
          variant="secondary"
          type="button"
          [class]="saveButtonClass"
          [disabled]="saving()"
          (click)="closed.emit('cancelled')"
          i18n="@@vendor.integrationEdit.cancel"
        >
          Cancel
        </button>
      </div>
    </form>
  `,
})
export class VendorIntegrationEditForm implements OnInit {
  /** A field's inline error: the shared recipe (AECI-1984). */
  protected readonly errorClass = FIELD_ERROR_CLASS;
  private readonly api = inject(VendorApi);
  private readonly store = inject(VendorPortalStore);
  private readonly announcer = inject(VendorPortalAnnouncer);

  /** The row's id, in either table: the PATCH route finds it (AECI-1090). */
  readonly integrationId = input.required<string>();
  /** Frames `direction` on the wire (`context_product_id`). */
  readonly contextProductId = input.required<string>();
  /** The other endpoint's name, for the direction sentences. */
  readonly otherProductName = input.required<string>();
  /** The values on record, framed against `contextProductId`. */
  readonly values = input.required<EditFormValues>();
  /** The server's connector-powered verdict, read off the wire. */
  readonly connectorDelivered = input(false);
  /** Unique per rendering of a row, so two forms for one row never share ids. */
  readonly idPrefix = input.required<string>();
  /** AECI-1237 (§11d.5): the fields AEC Integrations locked on this row. They render
   *  read-only with AECi's reason, and are never sent. */
  readonly lockedFields = input<readonly LockedField[] | undefined>(undefined);
  /** AECI-1238 (§11d.7): the fields AECi hid from the public page on this row. They stay
   *  editable, and a save that changes one ends its hide. */
  readonly hiddenFields = input<readonly HiddenField[] | undefined>(undefined);

  readonly closed = output<EditFormOutcome>();

  /** The fields this row's form edits: all of them, or on a connector-delivered row
   *  all but the frozen type (AECI-1090 / AECI-1040 ruling 5). */
  protected readonly editableFields = computed<readonly IntegrationEditField[]>(() =>
    this.connectorDelivered()
      ? INTEGRATION_EDIT_FIELDS.filter((field) => !CONNECTOR_POWERED_FROZEN_EDIT_FIELDS.has(field))
      : INTEGRATION_EDIT_FIELDS,
  );

  protected readonly groups = computed(() => {
    const editable = new Set(this.editableFields());
    return EDIT_GROUPS.map((group) => ({
      key: group.key,
      fields: group.fields.filter((field) => editable.has(field)),
    }));
  });

  protected readonly saving = signal(false);
  protected readonly saveNotice = signal<string | null>(null);
  /** The values the form opened with, so only real changes are sent. */
  private readonly seed = signal<Draft>(emptyDraft());
  protected readonly draft = signal<Draft>(emptyDraft());

  protected readonly optionalLabel = $localize`:@@vendor.integrationEdit.optional:(optional)`;
  protected readonly choosePlaceholder = $localize`:@@vendor.integrationEdit.choose:Choose a value`;

  /** Seeded once, when the form opens. A background revalidation must not reset
   *  what the vendor is typing. */
  ngOnInit(): void {
    const start = draftFrom(this.values());
    this.seed.set(start);
    this.draft.set(start);
  }

  protected onInput(field: IntegrationEditField, value: string): void {
    this.draft.update((current) => ({ ...current, [field]: value }));
    this.saveNotice.set(null);
  }

  /** The fields whose draft differs from what the form opened with, as wire
   *  values (`''` means clear, which the schema turns into `null`). Only the fields
   *  the form shows: a frozen type is never sent (AECI-1090). */
  private readonly changes = computed<Partial<Record<IntegrationEditField, string>>>(() => {
    const draft = this.draft();
    const seed = this.seed();
    const out: Partial<Record<IntegrationEditField, string>> = {};
    for (const field of this.editableFields()) {
      if (this.lockOf(field)) continue;
      if (draft[field].trim() !== seed[field].trim()) out[field] = draft[field];
    }
    return out;
  });

  private readonly errors = computed<Partial<Record<IntegrationEditField, string>>>(() => {
    const out: Partial<Record<IntegrationEditField, string>> = {};
    for (const [field, value] of Object.entries(this.changes()) as [
      IntegrationEditField,
      string,
    ][]) {
      const trimmed = value.trim();
      const message = editValueMessage(field, trimmed === '' ? null : trimmed);
      if (message) out[field] = message;
    }
    return out;
  });

  protected errorFor(field: IntegrationEditField): string | null {
    return this.errors()[field] ?? null;
  }

  /** An error shows only on a field the vendor has changed: what is on record
   *  is never flagged, and only changed fields are sent. */
  protected showError(field: IntegrationEditField): boolean {
    return this.errorFor(field) !== null;
  }

  protected async onSave(event: Event): Promise<void> {
    if (isReplayedEvent(event)) return;
    event.preventDefault();
    if (this.saving()) return;
    this.saveNotice.set(null);

    const changes = this.changes();
    if (Object.keys(changes).length === 0) {
      this.saveNotice.set(
        $localize`:@@vendor.integrationEdit.error.noChange:Nothing has changed yet. Edit a field before you save.`,
      );
      return;
    }
    if (Object.keys(this.errors()).length > 0) {
      this.saveNotice.set(
        $localize`:@@vendor.integrationEdit.error.fix:Fix the fields marked above, then save again.`,
      );
      return;
    }

    const body = {
      ...changes,
      context_product_id: this.contextProductId(),
    } satisfies UpdateVendorIntegrationInput;
    if (!UpdateVendorIntegrationSchema.safeParse(body).success) {
      this.saveNotice.set(
        $localize`:@@vendor.integrationEdit.error.shape:Check the values, then try again.`,
      );
      return;
    }

    this.saving.set(true);
    try {
      // The raw body, not the parsed one: the schema's clear transform maps `''`
      // to `null`, and the server applies the same parse.
      await this.api.updateIntegration(this.integrationId(), body);
      this.announcer.announce(
        $localize`:@@vendor.integrationEdit.live.saved:Your changes are saved and live on the public integration page.`,
      );
      this.saving.set(false);
      this.closed.emit('saved');
      void this.store.revalidate(['integrations']);
    } catch (err) {
      this.saveNotice.set(editSaveErrorMessage(err));
      this.saving.set(false);
    }
  }

  protected groupLabel(key: (typeof EDIT_GROUPS)[number]['key']): string {
    switch (key) {
      case 'about':
        return $localize`:@@vendor.integrationEdit.group.about:About the integration`;
      case 'links':
        return $localize`:@@vendor.integrationEdit.group.links:Links`;
      case 'terms':
        return $localize`:@@vendor.integrationEdit.group.terms:Pricing and maturity`;
    }
  }

  protected fieldLabel(field: IntegrationEditField): string {
    return editFieldLabel(field);
  }

  protected required(field: IntegrationEditField): boolean {
    return INTEGRATION_EDIT_REQUIRED_FIELDS.has(field);
  }

  protected control(field: IntegrationEditField): ControlKind {
    return controlFor(field);
  }

  protected maxLength(field: IntegrationEditField): number {
    return INTEGRATION_EDIT_MAX_LENGTH[field];
  }

  protected optionsFor(field: IntegrationEditField): readonly { value: string; label: string }[] {
    if (field === 'mechanism_kind') {
      return OWNER_EDITABLE_MECHANISM_KINDS.map((kind) => ({
        value: kind,
        label: mechanismKindLabel(kind) || kind,
      }));
    }
    const other = this.otherProductName();
    return (['outbound', 'both', 'inbound'] as const).map((direction) => ({
      value: direction,
      label: directionHeading(direction, other),
    }));
  }

  protected fieldId(key: string): string {
    return `${this.idPrefix()}-${key}`;
  }

  protected lockOf(field: IntegrationEditField): LockedField | undefined {
    return lockedField(this.lockedFields(), field);
  }

  protected hideOf(field: IntegrationEditField): HiddenField | undefined {
    return hiddenField(this.hiddenFields(), field);
  }

  /** An editable control's descriptions: its error when shown, and AECi's hide note. */
  protected describedBy(field: IntegrationEditField): string | null {
    const ids = [
      this.showError(field) ? `${this.fieldId(field)}-error` : null,
      this.hideOf(field) ? `${this.fieldId(field)}-hidden` : null,
    ].filter((id): id is string => id !== null);
    return ids.length > 0 ? ids.join(' ') : null;
  }

  /** A locked field's value as a vendor reads it: the option label on a picker. */
  protected displayValue(field: IntegrationEditField): string {
    const value = this.seed()[field];
    if (field === 'mechanism_kind' || field === 'direction') {
      return this.optionsFor(field).find((o) => o.value === value)?.label ?? value;
    }
    return value;
  }

  protected selectValue(event: Event): string {
    return (event.target as HTMLSelectElement).value;
  }

  protected inputValue(event: Event): string {
    return (event.target as HTMLInputElement | HTMLTextAreaElement).value;
  }

  // AECI-1811: the portal form layout (`vendor/shared/portal-form.ts`) and the shared
  // field recipe (`shared/form-field/form-field-classes.ts`).
  protected readonly formClass = PORTAL_FORM_CLASS;
  protected readonly fieldsetClass = PORTAL_FIELDSET_CLASS;
  protected readonly legendClass = PORTAL_LEGEND_CLASS;
  protected readonly gridClass = PORTAL_FORM_GRID_CLASS;
  protected readonly spanClass = PORTAL_FORM_SPAN_CLASS;
  protected readonly fieldClass = PORTAL_FIELD_CLASS;
  protected readonly saveStatusClass = PORTAL_SAVE_STATUS_CLASS;
  protected readonly saveButtonClass = PORTAL_SAVE_BUTTON_CLASS;
  /**
   * The portal save bar without its pull over a card's padding: this form sits inside
   * an owned row, above the row's retire controls, so `PORTAL_SAVE_BAR_CLASS`'s
   * negative margins would run it into them. Same sticky foot, hairline, order and
   * wrap. It keeps the `aec-portal-save-bar` marker, so `PORTAL_FORM_CLASS` still
   * leaves its own buttons out of the scroll margin.
   */
  protected readonly saveBarClass = PORTAL_NESTED_SAVE_BAR_CLASS;
  protected readonly labelClass = FIELD_LABEL_CLASS;
  protected readonly optionalClass = FIELD_OPTIONAL_CLASS;
  protected readonly inputClass = FIELD_INPUT_CLASS;
  protected readonly selectClass = `${FIELD_INPUT_CLASS} cursor-pointer appearance-none pe-12`;
  protected readonly selectChevronClass =
    'pointer-events-none absolute end-4 top-1/2 flex -translate-y-1/2 text-(--text-secondary)';
  /** A field AECi locked: the field recipe, read-only on the sunken surface (DESIGN.md "Locked field"). */
  protected readonly lockedInputClass = FIELD_INPUT_CLASS.replace(
    'bg-(--surface-base)',
    'bg-(--surface-sunken)',
  );
}

function emptyDraft(): Draft {
  return Object.fromEntries(INTEGRATION_EDIT_FIELDS.map((field) => [field, ''])) as Draft;
}

function draftFrom(values: EditFormValues): Draft {
  return Object.fromEntries(
    INTEGRATION_EDIT_FIELDS.map((field) => [field, values[field] ?? '']),
  ) as Draft;
}
