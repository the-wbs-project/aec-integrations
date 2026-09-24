import { Component, computed, inject, input, output, signal, type OnInit } from '@angular/core';

import {
  CONNECTOR_POWERED_FROZEN_EDIT_FIELDS,
  CONTEST_VALUE_MAX_LENGTH,
  INTEGRATION_EDIT_FIELDS,
  INTEGRATION_EDIT_REQUIRED_FIELDS,
  OWNER_EDITABLE_MECHANISM_KINDS,
  UpdateVendorIntegrationSchema,
  type IntegrationEditField,
  type UpdateVendorIntegrationInput,
} from '@aeci/shared';

import { directionHeading } from '../../products/pair-direction-labels';
import { mechanismKindLabel } from '../../search/mechanism-labels';
import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorApi } from '../vendor-api';
import { VendorPortalStore } from '../vendor-portal-store';

import { contestFieldLabel } from './vendor-contest-labels';
import { editSaveErrorMessage, editValueMessage } from './vendor-integration-ownership-labels';

/** How each field is edited. Same split as the contest form. */
type ControlKind = 'url' | 'text' | 'textarea' | 'mechanism' | 'direction';

const URL_FIELDS: ReadonlySet<IntegrationEditField> = new Set([
  'listing_url',
  'docs_url',
  'website',
  'mechanism_url',
]);

function controlFor(field: IntegrationEditField): ControlKind {
  if (URL_FIELDS.has(field)) return 'url';
  if (field === 'description') return 'textarea';
  if (field === 'mechanism_kind') return 'mechanism';
  if (field === 'direction') return 'direction';
  return 'text';
}

/** The form's three groups, each a `<fieldset>` so a screen reader hears which
 *  part of the integration a control belongs to. Together they are exactly
 *  `INTEGRATION_EDIT_FIELDS`; `vendor-integration-ownership.component.spec.ts`
 *  asserts that. */
export const EDIT_GROUPS: readonly {
  readonly key: 'about' | 'links' | 'terms';
  readonly fields: readonly IntegrationEditField[];
}[] = [
  {
    key: 'about',
    fields: ['name', 'description', 'mechanism_kind', 'mechanism_name', 'direction'],
  },
  { key: 'links', fields: ['website', 'listing_url', 'docs_url', 'mechanism_url'] },
  { key: 'terms', fields: ['pricing_model', 'maturity'] },
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
  styles: [':host { display: block; }'],
  template: `
    <form
      [id]="fieldId('form')"
      class="mt-4 space-y-6"
      novalidate
      (submit)="onSave($event)"
      [attr.aria-labelledby]="fieldId('title')"
    >
      <div class="max-w-prose space-y-1">
        <p
          [id]="fieldId('title')"
          class="text-sm font-semibold text-(--text-primary)"
          i18n="@@vendor.integrationEdit.title"
        >
          Edit this integration
        </p>
        <p
          class="max-w-prose text-xs text-(--text-secondary)"
          i18n="@@vendor.integrationEdit.intro"
        >
          Changes go live on the public integration page as soon as you save. There is no review
          step. The other product's vendor is told what changed.
        </p>
        @if (connectorDelivered()) {
          <p
            class="max-w-prose text-xs text-(--text-secondary)"
            data-testid="edit-frozen-type"
            i18n="@@vendor.integrationEdit.connectorTypeFrozen"
          >
            A connector product delivers this integration, so AEC Integrations sets its type. You
            can edit everything else.
          </p>
        }
      </div>

      @for (group of groups(); track group.key) {
        <fieldset class="space-y-4">
          <legend [class]="legendClass">{{ groupLabel(group.key) }}</legend>
          @for (field of group.fields; track field) {
            <div class="max-w-2xl space-y-2">
              <label [for]="fieldId(field)" [class]="labelClass">
                {{ fieldLabel(field) }}
                @if (!required(field)) {
                  <span class="font-normal tracking-normal normal-case">{{ optionalLabel }}</span>
                }
              </label>
              @switch (control(field)) {
                @case ('textarea') {
                  <textarea
                    [id]="fieldId(field)"
                    rows="4"
                    [attr.maxlength]="maxLength(field)"
                    [value]="draft()[field]"
                    (input)="onInput(field, inputValue($event))"
                    [attr.aria-invalid]="showError(field) ? 'true' : null"
                    [attr.aria-describedby]="showError(field) ? fieldId(field) + '-error' : null"
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
                    [attr.aria-describedby]="showError(field) ? fieldId(field) + '-error' : null"
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
                    [attr.aria-describedby]="showError(field) ? fieldId(field) + '-error' : null"
                    [class]="inputClass"
                  />
                }
                @default {
                  <div class="relative max-w-sm">
                    <select
                      [id]="fieldId(field)"
                      (change)="onInput(field, selectValue($event))"
                      [attr.aria-invalid]="showError(field) ? 'true' : null"
                      [attr.aria-describedby]="showError(field) ? fieldId(field) + '-error' : null"
                      [class]="selectClass"
                    >
                      @if (draft()[field] === '') {
                        <option value="" disabled selected>{{ choosePlaceholder }}</option>
                      }
                      @for (option of optionsFor(field); track option.value) {
                        <option [value]="option.value" [selected]="option.value === draft()[field]">
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
              @if (showError(field)) {
                <p
                  [id]="fieldId(field) + '-error'"
                  role="alert"
                  class="text-xs font-medium text-(--text-primary)"
                >
                  {{ errorFor(field) }}
                </p>
              }
            </div>
          }
        </fieldset>
      }

      <div class="flex flex-wrap items-center gap-3 border-t border-(--border-default) pt-4">
        <button type="submit" [class]="primaryButtonClass" [disabled]="saving()">
          @if (saving()) {
            <span i18n="@@vendor.integrationEdit.saving">Saving…</span>
          } @else {
            <span i18n="@@vendor.integrationEdit.save">Save changes</span>
          }
        </button>
        <button
          type="button"
          [class]="secondaryButtonClass"
          [disabled]="saving()"
          (click)="closed.emit('cancelled')"
          i18n="@@vendor.integrationEdit.cancel"
        >
          Cancel
        </button>
      </div>

      @if (saveNotice(); as message) {
        <p role="alert" class="text-sm font-medium text-(--text-primary)">
          {{ message }}
        </p>
      }
    </form>
  `,
})
export class VendorIntegrationEditForm implements OnInit {
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

  readonly closed = output<EditFormOutcome>();

  /** The fields this row's form edits: all eleven, or on a connector-delivered row
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
    return contestFieldLabel(field);
  }

  protected required(field: IntegrationEditField): boolean {
    return INTEGRATION_EDIT_REQUIRED_FIELDS.has(field);
  }

  protected control(field: IntegrationEditField): ControlKind {
    return controlFor(field);
  }

  protected maxLength(field: IntegrationEditField): number {
    return CONTEST_VALUE_MAX_LENGTH[field];
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

  protected selectValue(event: Event): string {
    return (event.target as HTMLSelectElement).value;
  }

  protected inputValue(event: Event): string {
    return (event.target as HTMLInputElement | HTMLTextAreaElement).value;
  }

  protected readonly selectClass =
    'w-full cursor-pointer appearance-none rounded-(--radius-md) border border-(--border-default) bg-(--surface-base) py-2 pe-9 ps-3 text-sm text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';
  protected readonly legendClass = 'mb-3 text-sm font-semibold text-(--text-primary)';
  protected readonly labelClass =
    'block text-xs font-bold tracking-[0.08em] text-(--text-secondary) uppercase';
  protected readonly inputClass =
    'w-full rounded-(--radius-md) border border-(--border-default) bg-(--surface-base) px-3 py-2 text-sm text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';
  protected readonly primaryButtonClass =
    'inline-flex items-center justify-center rounded-(--radius-md) border border-(--border-strong) bg-(--accent-primary) px-5 py-2.5 text-sm font-bold text-(--surface-base) transition-colors hover:bg-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) disabled:cursor-not-allowed disabled:opacity-50';
  protected readonly secondaryButtonClass =
    'inline-flex items-center justify-center rounded-(--radius-md) border border-(--border-default) px-4 py-2 text-sm font-medium text-(--text-primary) transition-colors hover:border-(--border-strong) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) disabled:cursor-not-allowed disabled:opacity-50';
}

function emptyDraft(): Draft {
  return Object.fromEntries(INTEGRATION_EDIT_FIELDS.map((field) => [field, ''])) as Draft;
}

function draftFrom(values: EditFormValues): Draft {
  return Object.fromEntries(
    INTEGRATION_EDIT_FIELDS.map((field) => [field, values[field] ?? '']),
  ) as Draft;
}
