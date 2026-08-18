import { Listbox, Option } from '@angular/aria/listbox';
import { Component, computed, inject, input, output, signal } from '@angular/core';

import {
  CreateVendorClaimSchema,
  type ContextDirection,
  type CreateVendorClaimInput,
  type DataObjectOption,
  type ProductVersion,
  type VendorClaim,
} from '@aeci/shared';

import { DIRECTION_ORDER, directionHeading } from '../../products/pair-direction-labels';
import { AecSelect, type AecSelectOption } from '../../shared/aec-select/aec-select';
import { readVendorApiError } from '../vendor-api-error';
import { VendorApi } from '../vendor-api';

/** The existing lane a duplicate submission should route to. */
export interface DuplicateClaimHit {
  readonly claimId: string;
  readonly dataObjectName: string;
}

/**
 * "Add a data flow" — create a claim plus the caller's affirming attestation
 * (AECI-606 / §6).
 *
 * ── THE VOCABULARY IS A PICKER, NOT A TEXT BOX ──────────────────────────────
 * `data_object` is find-only server-side: an unmatched term is a
 * `400 VALIDATION_FAILED`, because minting a term is an AECi curation act. §5.2
 * says the fix belongs here — "The UI (§6) should offer the closed list rather
 * than free text in the first place" — so the control is an Angular Aria
 * combobox over `GET /api/vendor/data-objects` and a vendor cannot type a term
 * the server will reject.
 *
 * ── THE DUPLICATE PIVOT ─────────────────────────────────────────────────────
 * A repeated `(integration, data_object, direction)` triple is a `400` carrying
 * `details.claim_id`, and the API returns that id specifically so this form can
 * send the vendor to the lane they already have. Two layers:
 *
 *  1. **Pre-emption.** The form already knows the integration's claims, so once
 *     both choices are made a local match replaces Submit with "Go to the
 *     existing lane". Most duplicates never reach the network.
 *  2. **The 400 backstop**, for a stale local list. Note the narrow condition —
 *     a `data_object` validation error *without* a `claim_id` is an unknown
 *     term, not a duplicate, and must render a field error instead of pivoting.
 *
 * ── FORM STYLE ──────────────────────────────────────────────────────────────
 * Hand-rolled signals validated against the shared `CreateVendorClaimSchema`,
 * matching its two siblings in this directory (`vendor-profile-form.ts`,
 * `vendor-product-form.ts`) rather than Signal Forms. The single-source-of-truth
 * property that matters — one Zod schema owns validity — is the same either way,
 * and Signal Forms does not materialise a field seeded `undefined`, which is
 * exactly the shape of both required choices here (there is no valid "nothing
 * chosen yet" member of `ContextDirection`). ADR 0010 still governs the controls
 * themselves: discrete choice is Aria, bridged by `[(value)]` + `(valueChange)`.
 *
 * A failed submit is always a notice signal, never a thrown error — the
 * `review-form.ts` rule: a `ValidationError` would mark the form permanently
 * invalid and disable Submit for good.
 */
@Component({
  selector: 'aec-vendor-add-claim-form',
  imports: [AecSelect, Listbox, Option],
  styles: [':host { display: block; }'],
  template: `
    <details class="border-t border-(--border-default) px-5 py-4" [open]="expanded()">
      <summary
        class="cursor-pointer text-sm font-medium text-(--text-primary)"
        (click)="expanded.set(!expanded())"
        i18n="@@vendor.attest.add.summary"
      >
        Add a data flow
      </summary>

      <div class="mt-4 space-y-4">
        @if (dataObjects().length === 0) {
          <p class="text-sm text-(--text-secondary)" i18n="@@vendor.attest.add.noVocabulary">
            The data object list could not be loaded, so new data flows cannot be added right now.
          </p>
        } @else {
          <aec-select
            layout="stacked"
            [label]="dataObjectLabel"
            [placeholder]="dataObjectPlaceholder"
            [options]="dataObjectOptions()"
            [value]="dataObjectSlug()"
            [idPrefix]="fieldId('data-object')"
            [describedBy]="dataObjectError() ? fieldId('data-object') + '-error' : ''"
            (changed)="onDataObject($event)"
          />
          @if (dataObjectError(); as message) {
            <p
              [id]="fieldId('data-object') + '-error'"
              role="alert"
              class="text-xs font-medium text-(--text-primary)"
            >
              {{ message }}
            </p>
          }

          <div class="space-y-2">
            <span [id]="fieldId('direction') + '-label'" [class]="labelClass">
              <ng-container i18n="@@vendor.attest.add.direction">Direction</ng-container>
            </span>
            <ul
              ngListbox
              orientation="horizontal"
              selectionMode="explicit"
              [(value)]="directionSelection"
              (valueChange)="onDirection()"
              [attr.aria-labelledby]="fieldId('direction') + '-label'"
              class="m-0 flex list-none flex-wrap gap-2 p-0"
            >
              @for (option of directionOptions(); track option.value) {
                <li
                  ngOption
                  [value]="option.value"
                  [label]="option.label"
                  class="cursor-pointer rounded-(--radius-md) border border-(--border-default) px-4 py-2 text-sm font-medium text-(--text-primary) transition-colors data-[active=true]:border-(--border-strong) aria-selected:border-(--accent-primary) aria-selected:bg-(--accent-primary) aria-selected:text-(--surface-base) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                >
                  {{ option.label }}
                </li>
              }
            </ul>
          </div>

          <div class="space-y-1.5">
            <label [for]="fieldId('note')" [class]="labelClass">
              <ng-container i18n="@@vendor.attest.add.note">Note</ng-container>
              <span class="ms-1 font-normal normal-case" i18n="@@vendor.attest.add.note.optional"
                >(optional)</span
              >
            </label>
            <textarea
              [id]="fieldId('note')"
              rows="2"
              maxlength="2000"
              [value]="note()"
              (input)="onNote($event)"
              [class]="inputClass"
            ></textarea>
          </div>

          @if (versions().length > 0) {
            <div class="grid gap-3 sm:grid-cols-2">
              <aec-select
                layout="stacked"
                [label]="introducedLabel"
                [placeholder]="anyVersionLabel"
                [options]="versionOptions()"
                [value]="introducedVersionId()"
                [idPrefix]="fieldId('introduced')"
                (changed)="introducedVersionId.set($event)"
              />
              <aec-select
                layout="stacked"
                [label]="deprecatedLabel"
                [placeholder]="anyVersionLabel"
                [options]="versionOptions()"
                [value]="deprecatedVersionId()"
                [idPrefix]="fieldId('deprecated')"
                (changed)="deprecatedVersionId.set($event)"
              />
            </div>
          }

          @if (localDuplicate(); as existing) {
            <div class="space-y-2">
              <p role="status" class="text-sm text-(--text-primary)">
                {{ duplicateMessage(existing.data_object_name) }}
              </p>
              <button
                type="button"
                [class]="secondaryButtonClass"
                (click)="goToExisting(existing)"
                i18n="@@vendor.attest.add.goToExisting"
              >
                Go to the existing data flow
              </button>
            </div>
          } @else {
            <button
              type="button"
              [class]="primaryButtonClass"
              [disabled]="submitting() || !valid()"
              (click)="onSubmit()"
              i18n="@@vendor.attest.add.submit"
            >
              Add data flow
            </button>
          }

          <p class="text-xs text-(--text-secondary)" i18n="@@vendor.attest.add.hint">
            Adding a data flow records your confirmation of it. The other vendor can confirm it too.
            Directory pages update right away; search refreshes within a day.
          </p>

          @if (notice(); as message) {
            <p role="alert" class="text-sm font-medium text-(--text-primary)">{{ message }}</p>
          }
        }
      </div>
    </details>
  `,
})
export class VendorAddClaimForm {
  private readonly api = inject(VendorApi);

  readonly integrationId = input.required<string>();
  readonly otherProductName = input.required<string>();
  readonly dataObjects = input.required<readonly DataObjectOption[]>();
  readonly versions = input.required<readonly ProductVersion[]>();
  /** The integration's current claims, so a duplicate is caught before the
   *  round-trip rather than after it. */
  readonly existingClaims = input.required<readonly VendorClaim[]>();

  readonly created = output<VendorClaim>();
  readonly duplicate = output<DuplicateClaimHit>();

  protected readonly expanded = signal(false);
  protected readonly submitting = signal(false);
  protected readonly notice = signal<string | null>(null);
  protected readonly dataObjectError = signal<string | null>(null);

  protected readonly dataObjectSlug = signal<string | null>(null);
  /** Aria's listbox model is always an array, even single-select. */
  protected readonly directionSelection = signal<ContextDirection[]>([]);
  protected readonly note = signal('');
  protected readonly introducedVersionId = signal<string | null>(null);
  protected readonly deprecatedVersionId = signal<string | null>(null);

  protected readonly dataObjectOptions = computed<readonly AecSelectOption[]>(() =>
    this.dataObjects().map((term) => ({ value: term.slug, label: term.name })),
  );

  protected readonly directionOptions = computed(() =>
    DIRECTION_ORDER.map((value) => ({
      value,
      label: directionHeading(value, this.otherProductName()),
    })),
  );

  protected readonly versionOptions = computed<readonly AecSelectOption[]>(() => [
    { value: null, label: this.anyVersionLabel },
    ...this.versions().map((v) => ({ value: v.id, label: v.label })),
  ]);

  private readonly direction = computed<ContextDirection | null>(
    () => this.directionSelection()[0] ?? null,
  );

  /** Validity is the shared schema's answer, never a second opinion. */
  protected readonly valid = computed(
    () => CreateVendorClaimSchema.safeParse(this.draft()).success,
  );

  /**
   * The lane this submission would collide with. `claims_identity_key` is
   * `(integration_id, data_object_id, direction)` — narrower than it looks,
   * because claims anchor to the mechanism row, so the same data object in the
   * same direction on a *different* mechanism is a different claim.
   */
  protected readonly localDuplicate = computed(() => {
    const slug = this.dataObjectSlug();
    const direction = this.direction();
    if (!slug || !direction) return null;
    return (
      this.existingClaims().find((c) => c.data_object_slug === slug && c.direction === direction) ??
      null
    );
  });

  protected readonly dataObjectLabel = $localize`:@@vendor.attest.add.dataObject:Data object`;
  protected readonly dataObjectPlaceholder = $localize`:@@vendor.attest.add.dataObject.placeholder:Choose a data object`;
  protected readonly introducedLabel = $localize`:@@vendor.attest.versions.introduced:Introduced in`;
  protected readonly deprecatedLabel = $localize`:@@vendor.attest.versions.deprecated:Removed in`;
  protected readonly anyVersionLabel = $localize`:@@vendor.attest.versions.any:Not specified`;

  protected readonly labelClass =
    'block text-xs font-bold tracking-[0.08em] text-(--text-secondary) uppercase';
  protected readonly inputClass =
    'w-full rounded-(--radius-md) border border-(--border-default) bg-(--surface-base) px-3 py-2 text-sm text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';
  protected readonly primaryButtonClass =
    'inline-flex items-center justify-center rounded-(--radius-md) border border-(--border-strong) bg-(--accent-primary) px-5 py-2.5 text-sm font-bold text-(--surface-base) transition-colors hover:bg-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) disabled:cursor-not-allowed disabled:opacity-50';
  protected readonly secondaryButtonClass =
    'inline-flex items-center justify-center rounded-(--radius-md) border border-(--border-default) px-4 py-2 text-sm font-medium text-(--text-primary) transition-colors hover:border-(--border-strong) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';

  protected fieldId(key: string): string {
    return `vendor-integration-${this.integrationId()}-${key}`;
  }

  protected duplicateMessage(dataObjectName: string): string {
    return $localize`:@@vendor.attest.add.duplicate:You already have a ${dataObjectName}:dataObject: data flow in that direction.`;
  }

  protected onDataObject(slug: string | null): void {
    this.dataObjectSlug.set(slug);
    this.dataObjectError.set(null);
    this.notice.set(null);
  }

  protected onDirection(): void {
    this.notice.set(null);
  }

  protected onNote(event: Event): void {
    this.note.set((event.target as HTMLTextAreaElement).value);
  }

  protected goToExisting(claim: VendorClaim): void {
    this.duplicate.emit({ claimId: claim.id, dataObjectName: claim.data_object_name });
  }

  private draft(): unknown {
    return {
      integration_id: this.integrationId(),
      data_object: this.dataObjectSlug() ?? '',
      direction: this.direction() ?? '',
      note: this.note().trim() || null,
      introduced_version_id: this.introducedVersionId(),
      deprecated_version_id: this.deprecatedVersionId(),
    };
  }

  protected async onSubmit(): Promise<void> {
    const parsed = CreateVendorClaimSchema.safeParse(this.draft());
    if (!parsed.success) return;

    this.submitting.set(true);
    this.notice.set(null);
    this.dataObjectError.set(null);
    try {
      const res = await this.api.createClaim(parsed.data as CreateVendorClaimInput);
      this.reset();
      this.created.emit(res.claim);
    } catch (err) {
      this.handleFailure(err);
    } finally {
      this.submitting.set(false);
    }
  }

  private handleFailure(err: unknown): void {
    const info = readVendorApiError(err);

    // The narrow branch: `claim_id` present means the identity already exists,
    // and the vendor should be routed to it. A `data_object` error WITHOUT one
    // is an unknown term — a different problem with a different remedy.
    if (info?.field === 'data_object' && info.claimId) {
      const name =
        this.dataObjects().find((t) => t.slug === this.dataObjectSlug())?.name ??
        this.dataObjectSlug() ??
        '';
      this.duplicate.emit({ claimId: info.claimId, dataObjectName: name });
      return;
    }

    if (info?.field === 'data_object') {
      this.dataObjectError.set(
        $localize`:@@vendor.attest.add.error.dataObject:That data object is not on the AEC Integrations list. Pick one from the menu.`,
      );
      return;
    }

    if (info?.field === 'introduced_version_id' || info?.field === 'deprecated_version_id') {
      this.notice.set(
        $localize`:@@vendor.attest.add.error.version:Version stamps must name a version of your own product.`,
      );
      return;
    }

    if (info?.status === 403) {
      this.notice.set(
        $localize`:@@vendor.attest.add.error.unverified:Adding a data flow needs a verified account. Verification is arranged with AEC Integrations.`,
      );
      return;
    }

    this.notice.set(
      $localize`:@@vendor.attest.add.error.generic:Could not add the data flow. Try again.`,
    );
  }

  private reset(): void {
    this.dataObjectSlug.set(null);
    this.directionSelection.set([]);
    this.note.set('');
    this.introducedVersionId.set(null);
    this.deprecatedVersionId.set(null);
    this.expanded.set(false);
  }
}
