import {
  Component,
  ElementRef,
  InjectionToken,
  Injector,
  afterNextRender,
  computed,
  type OnInit,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';

import {
  CONNECTOR_POWERED_FROZEN_EDIT_FIELDS,
  INTEGRATION_EDIT_FIELDS,
  INTEGRATION_EDIT_REQUIRED_FIELDS,
  OWNER_EDITABLE_MECHANISM_KINDS,
  CONTEST_VALUE_MAX_LENGTH,
  UpdateVendorIntegrationSchema,
  type IntegrationEditField,
  type UpdateVendorIntegrationInput,
  type VendorIntegration,
} from '@aeci/shared';

import { directionHeading } from '../../products/pair-direction-labels';
import { mechanismKindLabel } from '../../search/mechanism-labels';
import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorApi } from '../vendor-api';
import { vendorHasActiveEntitlement } from '../vendor-capabilities';
import { VendorPortalStore } from '../vendor-portal-store';

import { contestFieldLabel } from './vendor-contest-labels';
import {
  claimErrorMessage,
  editSaveErrorMessage,
  editValueMessage,
} from './vendor-integration-ownership-labels';

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

/**
 * Render one card's edit form open on first paint: the id of the integration
 * whose form starts open. Provided ONLY by the dev preview
 * (`/preview/vendor-dashboard/products/<slug>/integrations?edit=<integration id>`),
 * so `npx impeccable detect`, which reads the first render, can see the form.
 * Nothing in the product provides it.
 */
export const VENDOR_EDIT_FORM_START_OPEN = new InjectionToken<string | null>(
  'VENDOR_EDIT_FORM_START_OPEN',
);

/** Where the caller stands on this integration. See {@link VendorIntegrationOwnership}. */
export type OwnershipState =
  | 'owner-claimed'
  | 'owner-retired'
  | 'owner-unclaimed'
  // AECI-1089: the owner of a connector-delivered row. It may claim with an active
  // entitlement (`owner-connector-unclaimed`), and is told a plan is needed without
  // one (`owner-connector-locked`). Once claimed, an entitled owner gets the
  // ordinary `owner-claimed` edit (AECI-1090); `owner-connector-claimed` is the
  // claimed row whose vendor no longer holds an active entitlement.
  | 'owner-connector-unclaimed'
  | 'owner-connector-locked'
  | 'owner-connector-claimed'
  | 'other-owned'
  | 'other-unclaimed'
  | 'no-owner';

/**
 * Integration ownership on the card (AECI-1005 claim, AECI-1006 edit;
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §4.5.6 and §6.14).
 *
 * ── WHAT IT SHOWS ───────────────────────────────────────────────────────────
 * One line saying who offers the integration, and the one action the caller's
 * relationship to the row allows:
 *
 * - **the owner, unclaimed** — a Claim button. Editing is meaningless until the
 *   row is claimed, because promote still writes it;
 * - **the owner, claimed** — "Edit details", a disclosure over the edit form;
 * - **the owner of a connector-delivered row** (AECI-1089) — Claim when the vendor
 *   holds an active entitlement, and a sentence saying a plan is needed when it
 *   does not (AECI-1040 ruling 2). Once claimed (AECI-1090), "Edit details" with
 *   an active entitlement, with the frozen type left out of the form and named
 *   instead (ruling 5), and without one a sentence saying editing needs an active
 *   plan. `attestable` is the server's connector-powered verdict, read off the
 *   wire and never re-derived;
 * - **anyone else** — "Offered by {vendor}", and who reviews a contest on it.
 *   The contest form below the card is their recourse.
 *
 * A seat is the whole gate (decision 15), so nothing here reads `canWrite`. The
 * one exception is the connector-delivered row, which reads the resolved tier
 * through `vendorHasActiveEntitlement`, the client half of the server's gate.
 *
 * ── PESSIMISTIC, NOT OPTIMISTIC ─────────────────────────────────────────────
 * The realtime spec keeps forms pessimistic (`STAGE_2_REALTIME_SPEC.md` §4):
 * both writes wait for the server, then announce through the portal's one live
 * region and revalidate `integrations`. An edit goes live on the public page
 * with no review (decision 8), and the copy says so before the vendor saves.
 *
 * ── ONE RULE, SHARED ────────────────────────────────────────────────────────
 * Each value is checked with `integrationEditValueProblem`, the function the
 * handler runs, and the body is parsed with `UpdateVendorIntegrationSchema`
 * before it is sent. Only changed fields are sent. The type picker leaves out
 * the connector-delivered kinds, which the server refuses.
 */
@Component({
  selector: 'aec-vendor-integration-ownership',
  styles: [':host { display: block; }'],
  template: `
    <div class="border-t border-(--border-default) px-5 py-4" data-testid="integration-ownership">
      <p
        #line
        tabindex="-1"
        class="max-w-prose text-sm text-(--text-primary) focus:outline-none"
        data-testid="ownership-line"
      >
        {{ ownershipLine() }}
      </p>

      @if (state() === 'owner-connector-locked') {
        <p
          class="mt-1 max-w-prose text-xs text-(--text-secondary)"
          data-testid="claim-needs-plan"
          i18n="@@vendor.integrationClaim.needsPlan"
        >
          Claiming an integration delivered through a connector needs an active plan. Contact AEC
          Integrations to activate it.
        </p>
      }
      @if (state() === 'owner-unclaimed' || state() === 'owner-connector-unclaimed') {
        @if (state() === 'owner-connector-unclaimed') {
          <p
            class="mt-1 max-w-prose text-xs text-(--text-secondary)"
            i18n="@@vendor.integrationClaim.hintConnector"
          >
            Claiming takes this integration over from AEC Integrations. Our catalogue updates stop
            reaching it. The other product's vendor is told that you claimed it.
          </p>
        } @else {
          <p
            class="mt-1 max-w-prose text-xs text-(--text-secondary)"
            i18n="@@vendor.integrationClaim.hint"
          >
            Claiming takes this integration over from AEC Integrations. Our catalogue updates stop
            reaching it, and your edits go live on the public page with no review. The other
            product's vendor is told that you claimed it.
          </p>
        }
        <div class="mt-3 flex flex-wrap items-center gap-3">
          <button
            type="button"
            [class]="primaryButtonClass"
            [disabled]="claiming()"
            (click)="onClaim()"
            data-testid="claim-integration"
          >
            @if (claiming()) {
              <span i18n="@@vendor.integrationClaim.claiming">Claiming…</span>
            } @else {
              <span i18n="@@vendor.integrationClaim.button">Claim this integration</span>
            }
          </button>
        </div>
        @if (claimNotice(); as message) {
          <p role="alert" class="mt-3 text-sm font-medium text-(--text-primary)">
            {{ message }}
          </p>
        }
      } @else if (state() === 'owner-connector-claimed') {
        <p
          class="mt-1 max-w-prose text-xs text-(--text-secondary)"
          data-testid="ownership-entitlement-hint"
          i18n="@@vendor.integrationEdit.connectorEntitlementHint"
        >
          Editing an integration delivered through a connector product needs an active plan.
          Contact AEC Integrations to activate or renew it.
        </p>
      } @else if (state() === 'owner-claimed') {
        <div class="mt-3">
          <button
            #trigger
            type="button"
            [attr.aria-expanded]="editing()"
            [attr.aria-controls]="fieldId('form')"
            (click)="toggleEdit()"
            [class]="triggerClass"
            data-testid="edit-integration"
            i18n="@@vendor.integrationEdit.trigger"
          >
            Edit details
          </button>
        </div>

        @if (editing()) {
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
                Changes go live on the public integration page as soon as you save. There is no
                review step. The other product's vendor is told what changed.
              </p>
              @if (connectorDelivered()) {
                <p
                  class="max-w-prose text-xs text-(--text-secondary)"
                  data-testid="edit-frozen-type"
                  i18n="@@vendor.integrationEdit.connectorTypeFrozen"
                >
                  A connector product delivers this integration, so AEC Integrations sets its type.
                  You can edit everything else.
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
                        <span class="font-normal tracking-normal normal-case">{{
                          optionalLabel
                        }}</span>
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
                          [attr.aria-describedby]="
                            showError(field) ? fieldId(field) + '-error' : null
                          "
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
                          [attr.aria-describedby]="
                            showError(field) ? fieldId(field) + '-error' : null
                          "
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
                          [attr.aria-describedby]="
                            showError(field) ? fieldId(field) + '-error' : null
                          "
                          [class]="inputClass"
                        />
                      }
                      @default {
                        <div class="relative max-w-sm">
                          <select
                            [id]="fieldId(field)"
                            (change)="onInput(field, selectValue($event))"
                            [attr.aria-invalid]="showError(field) ? 'true' : null"
                            [attr.aria-describedby]="
                              showError(field) ? fieldId(field) + '-error' : null
                            "
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
                (click)="closeEdit()"
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
        }
      }
    </div>
  `,
})
export class VendorIntegrationOwnership implements OnInit {
  private readonly api = inject(VendorApi);
  private readonly store = inject(VendorPortalStore);
  private readonly announcer = inject(VendorPortalAnnouncer);
  private readonly injector = inject(Injector);

  readonly integration = input.required<VendorIntegration>();

  private readonly trigger = viewChild<ElementRef<HTMLButtonElement>>('trigger');
  private readonly line = viewChild<ElementRef<HTMLParagraphElement>>('line');

  private readonly startOpenId = inject(VENDOR_EDIT_FORM_START_OPEN, { optional: true }) ?? null;

  /** The server's connector-powered verdict (AECI-705), read off the wire. */
  protected readonly connectorDelivered = computed(() => !this.integration().attestable);

  /** The fields this row's form edits: all eleven, or on a connector-delivered row
   *  all but the frozen type (AECI-1090 / AECI-1040 ruling 5). An evidenced pair
   *  has no type column at all, which is the same set. */
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

  protected readonly claiming = signal(false);
  protected readonly claimNotice = signal<string | null>(null);

  protected readonly editing = signal(false);
  protected readonly saving = signal(false);
  protected readonly saveNotice = signal<string | null>(null);
  /** The values the form opened with, so only real changes are sent. */
  private readonly seed = signal<Draft>(emptyDraft());
  protected readonly draft = signal<Draft>(emptyDraft());

  protected readonly optionalLabel = $localize`:@@vendor.integrationEdit.optional:(optional)`;
  protected readonly choosePlaceholder = $localize`:@@vendor.integrationEdit.choose:Choose a value`;

  /** The client half of the carve-out's entitlement gate (AECI-1089). */
  private readonly entitled = vendorHasActiveEntitlement(this.store);

  readonly state = computed<OwnershipState>(() => {
    const integration = this.integration();
    if (integration.is_owner) {
      // `attestable` is the server's connector-powered verdict (AECI-705).
      const connector = !integration.attestable;
      if (!integration.claimed_at) {
        if (!connector) return 'owner-unclaimed';
        return this.entitled() ? 'owner-connector-unclaimed' : 'owner-connector-locked';
      }
      if (integration.retired_at) return 'owner-retired';
      // AECI-1090: a claimed connector-delivered row takes the ordinary edit from an
      // entitled owner, with its type frozen. Without an entitlement it says so.
      if (connector && !this.entitled()) return 'owner-connector-claimed';
      // AECI-1010: a retired row takes no edit. The server answers 409
      // INTEGRATION_RETIRED; the form is not offered. Restore is on the card's foot.
      return integration.retired_at ? 'owner-retired' : 'owner-claimed';
    }
    if (!integration.owner) return 'no-owner';
    return integration.claimed_at ? 'other-owned' : 'other-unclaimed';
  });

  protected readonly ownershipLine = computed(() => {
    const owner = this.integration().owner?.name ?? '';
    switch (this.state()) {
      case 'owner-claimed':
        return $localize`:@@vendor.integrationOwnership.ownerClaimed:Your company owns this integration and keeps its details up to date.`;
      case 'owner-retired':
        // AECI-1046: an admin retire is AECi's to undo, not the owner's.
        return this.integration().retired_by === 'aeci'
          ? $localize`:@@vendor.integrationOwnership.ownerRetiredByAeci:Your company owns this integration. AEC Integrations retired it, so it cannot be edited or restored here.`
          : $localize`:@@vendor.integrationOwnership.ownerRetired:Your company owns this integration and has retired it. Restore it to edit its details.`;
      case 'owner-unclaimed':
        return $localize`:@@vendor.integrationOwnership.ownerUnclaimed:Your company is recorded as the owner of this integration. Claim it to edit its details.`;
      case 'owner-connector-unclaimed':
        return $localize`:@@vendor.integrationOwnership.ownerConnectorUnclaimed:Your company is recorded as the owner of this integration, which is delivered through a connector. Claim it to take over its details.`;
      case 'owner-connector-locked':
        // No Claim button renders here, so the line does not ask for one. The note
        // below says an active plan is needed (AECI-1089 review).
        return $localize`:@@vendor.integrationOwnership.ownerConnectorLocked:Your company is recorded as the owner of this integration, which is delivered through a connector. AEC Integrations maintains its details.`;
      case 'owner-connector-claimed':
        return $localize`:@@vendor.integrationOwnership.ownerConnectorClaimed:Your company owns this integration, which is delivered through a connector.`;
      case 'other-owned':
        return $localize`:@@vendor.integrationOwnership.otherOwned:Offered by ${owner}:owner:. ${owner}:owner: maintains its details, and reviews any contest you send about them. A contest about who owns it goes to AEC Integrations.`;
      case 'other-unclaimed':
        return $localize`:@@vendor.integrationOwnership.otherUnclaimed:Offered by ${owner}:owner:. ${owner}:owner: has not claimed it yet, so AEC Integrations reviews any contest you send about it.`;
      case 'no-owner':
        return $localize`:@@vendor.integrationOwnership.noOwner:No owner is on file for this integration. If your company offers it, contest the Owner field below and AEC Integrations will review it.`;
    }
  });

  /** The dev preview's `?edit=<id>` (see {@link VENDOR_EDIT_FORM_START_OPEN}).
   *  Inputs are set by now, and this runs before the first render, so the form is
   *  in the server-rendered HTML. */
  ngOnInit(): void {
    if (this.startOpenId !== null && this.startOpenId === this.integration().id) {
      if (this.state() === 'owner-claimed') this.openEdit();
    }
  }

  // ─── Claim (AECI-1005) ─────────────────────────────────────────────────────

  protected async onClaim(): Promise<void> {
    if (this.claiming()) return;
    this.claiming.set(true);
    this.claimNotice.set(null);
    // AECI-1089: the connector announcement names what the claim changed. Focus goes
    // to the Edit trigger (AECI-1090) when the row now offers one, else the status line.
    const connector = !this.integration().attestable;
    try {
      await this.api.claimIntegration(this.integration().id);
      this.announcer.announce(
        connector
          ? $localize`:@@vendor.integrationClaim.live.doneConnector:You claimed this integration. AEC Integrations no longer updates it.`
          : $localize`:@@vendor.integrationClaim.live.done:You claimed this integration. You can now edit its details.`,
      );
      await this.store.revalidate(['integrations']);
      // The Claim button is gone once the row reads as claimed. Hand focus to the
      // Edit trigger that replaced it (or the status line when there is none), so a
      // keyboard user is not dropped at the top of the page.
      afterNextRender(() => (this.trigger() ?? this.line())?.nativeElement.focus(), {
        injector: this.injector,
      });
    } catch (err) {
      this.claimNotice.set(claimErrorMessage(err));
    } finally {
      this.claiming.set(false);
    }
  }

  // ─── Edit (AECI-1006) ──────────────────────────────────────────────────────

  protected toggleEdit(): void {
    if (this.editing()) {
      this.closeEdit();
      return;
    }
    this.openEdit();
  }

  private openEdit(): void {
    const start = draftFrom(this.integration());
    this.seed.set(start);
    this.draft.set(start);
    this.saveNotice.set(null);
    this.editing.set(true);
  }

  /** Close and discard, returning focus to the trigger so a keyboard user is not
   *  dropped at the top of the page when the form unmounts. */
  closeEdit(): void {
    this.editing.set(false);
    this.saveNotice.set(null);
    this.trigger()?.nativeElement.focus();
  }

  protected onInput(field: IntegrationEditField, value: string): void {
    this.draft.update((current) => ({ ...current, [field]: value }));
    this.saveNotice.set(null);
  }

  /** The fields whose draft differs from what the form opened with, as wire
   *  values (`''` means clear, which the schema turns into `null`). */
  private readonly changes = computed<Partial<Record<IntegrationEditField, string>>>(() => {
    const draft = this.draft();
    const seed = this.seed();
    const out: Partial<Record<IntegrationEditField, string>> = {};
    // Only the fields the form shows: a frozen type is never sent (AECI-1090).
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

    const parsed = UpdateVendorIntegrationSchema.safeParse({
      ...changes,
      context_product_id: this.integration().context_product.id,
    } satisfies UpdateVendorIntegrationInput);
    if (!parsed.success) {
      this.saveNotice.set(
        $localize`:@@vendor.integrationEdit.error.shape:Check the values, then try again.`,
      );
      return;
    }

    this.saving.set(true);
    try {
      // The raw body, not `parsed.data`: the schema's clear transform maps `''`
      // to `null`, and the server applies the same parse.
      await this.api.updateIntegration(this.integration().id, {
        ...changes,
        context_product_id: this.integration().context_product.id,
      });
      this.announcer.announce(
        $localize`:@@vendor.integrationEdit.live.saved:Your changes are saved and live on the public integration page.`,
      );
      this.saving.set(false);
      this.closeEdit();
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
    const other = this.integration().other_product.name;
    return (['outbound', 'both', 'inbound'] as const).map((direction) => ({
      value: direction,
      label: directionHeading(direction, other),
    }));
  }

  protected fieldId(key: string): string {
    return `vendor-ownership-${this.integration().id}-${this.integration().context_product.id}-${key}`;
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

/** The form's starting values: the current value of every field, from the
 *  contest prefill map (same wire form, `direction` framed per entry). */
function draftFrom(integration: VendorIntegration): Draft {
  return Object.fromEntries(
    INTEGRATION_EDIT_FIELDS.map((field) => [field, integration.contestable_fields[field] ?? '']),
  ) as Draft;
}
