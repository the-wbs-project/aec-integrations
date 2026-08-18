import {
  Component,
  ElementRef,
  computed,
  inject,
  input,
  linkedSignal,
  output,
  signal,
  viewChild,
} from '@angular/core';

import type { ProductVersion, VendorClaim } from '@aeci/shared';

import { AecSelect, type AecSelectOption } from '../../shared/aec-select/aec-select';
import { readVendorApiError } from '../vendor-api-error';
import { VendorApi, type VendorAttestationPosition } from '../vendor-api';

import { ownStanceLabel } from './vendor-attestation-labels';

/**
 * The Affirm / Deny / Clear control for one claim (AECI-606 / §6).
 *
 * ── THE TRAP THIS COMPONENT EXISTS TO CLOSE ─────────────────────────────────
 * `PUT /api/vendor/claims/:id/attestation` **replaces** the caller's position;
 * it does not patch it. "An omitted `note` or version stamp lands as `null` on
 * the new row." So `{ asserted: false }` does not record a denial — it records a
 * denial *and erases* whatever note and version stamps the vendor wrote before.
 *
 * That is a live hazard here specifically, because every neighbouring write on
 * this dashboard is a PATCH of only-changed-fields (`vendor-profile-form.ts`,
 * `vendor-product-form.ts`). Four things stop it:
 *
 *  1. `VendorAttestationPosition` makes every field required, so an incomplete
 *     body is a compile error (`vendor-api.ts`).
 *  2. `position()` below is the ONLY place a body is built.
 *  3. The editor's collapsed summary names what a save will send — the current
 *     note, quoted verbatim, and the current version stamps. A disclosure that
 *     merely said "Details" would let a vendor believe there is nothing to lose,
 *     which is precisely the misdirection to avoid; six lanes of
 *     permanently-open editor was the alternative, and it buried the controls.
 *  4. `vendor-attestation-control.component.spec.ts` denies a stamped, noted
 *     claim without touching the editor and asserts the whole position went.
 *
 * ── OTHER LOAD-BEARING CHOICES ──────────────────────────────────────────────
 * **Buttons, not an Aria listbox.** ADR 0010 governs discrete-choice *form
 * controls* — values you pick and submit later. These are commands: they fire a
 * write on activation, map to two different HTTP verbs, and Clear is a
 * withdrawal rather than a third value. Aria is used where §6 does ask for it —
 * the version pickers here, and the data-object/direction controls on the add
 * form.
 *
 * **Affirm and Deny stay enabled at all times.** Re-affirming is the legitimate
 * way to save an edited note, and a button that disables itself as a
 * consequence of its own activation drops focus to `<body>`. Clear does disable
 * (there is nothing to withdraw), which is exactly why it hands focus to Affirm
 * afterwards.
 *
 * **`mine[0]` is the caller's own endpoint's slot**, always: the API sorts
 * `mine` `vendor_a` first and frames the context on endpoint A whenever the
 * caller owns it. The editor seeds from it.
 */
@Component({
  selector: 'aec-vendor-attestation-control',
  imports: [AecSelect],
  styles: [':host { display: block; }'],
  template: `
    <div class="mt-3 space-y-3">
      <p class="text-sm">
        <span class="text-(--text-secondary)" i18n="@@vendor.attest.yourPosition"
          >Your position:</span
        >
        <span class="ms-1 font-semibold text-(--text-primary)">{{ stanceLabel() }}</span>
      </p>

      <!--
        Collapsed by default, but the SUMMARY names what a save will send: the
        current note, verbatim, and the current version stamps. That is what
        keeps this honest despite being closed. PUT replaces the whole position,
        so a control that looked emptier than the payload would be the very trap
        this component exists to close. Six lanes of permanently-open editor was
        the alternative, and it buried the actual controls.
      -->
      <details class="rounded-(--radius-sm) border border-(--border-default) px-3 py-2">
        <summary class="cursor-pointer text-xs text-(--text-secondary)">
          {{ detailsSummary() }}
        </summary>

        <div class="mt-3 space-y-3">
          <div class="space-y-1.5">
            <label [for]="fieldId('note')" [class]="labelClass">
              <ng-container i18n="@@vendor.attest.note.label">Note</ng-container>
              <span class="ms-1 font-normal normal-case" i18n="@@vendor.attest.note.optional"
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
              [attr.aria-describedby]="fieldId('note') + '-hint'"
            ></textarea>
            <p [id]="fieldId('note') + '-hint'" class="text-xs text-(--text-secondary)">
              <ng-container i18n="@@vendor.attest.note.hint"
                >A short qualifier, shown alongside your position.</ng-container
              >
            </p>
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
            <p class="text-xs text-(--text-secondary)" i18n="@@vendor.attest.versions.hint">
              Versions of your own product only.
            </p>
          }
        </div>
      </details>

      <div class="flex flex-wrap items-center gap-2">
        <button
          #affirmButton
          type="button"
          [class]="primaryButtonClass"
          [disabled]="busy() !== null"
          (click)="onAffirm()"
          i18n="@@vendor.attest.action.affirm"
        >
          Affirm
        </button>
        <button
          type="button"
          [class]="secondaryButtonClass"
          [disabled]="busy() !== null"
          (click)="onDeny()"
          i18n="@@vendor.attest.action.deny"
        >
          Deny
        </button>
        <button
          type="button"
          [class]="secondaryButtonClass"
          [disabled]="busy() !== null || claim().mine.length === 0"
          (click)="onClear()"
          i18n="@@vendor.attest.action.clear"
        >
          Clear
        </button>
      </div>

      <p class="text-xs text-(--text-secondary)" i18n="@@vendor.attest.replaceWarning">
        Affirming or denying also saves the note and version stamps shown above.
      </p>

      @if (divergentSlots()) {
        <p role="status" class="text-xs text-(--text-secondary)" i18n="@@vendor.attest.divergent">
          Your two products on this integration currently record different details. Saving applies
          one position to both.
        </p>
      }

      @if (error(); as message) {
        <p role="alert" class="text-sm font-medium text-(--text-primary)">{{ message }}</p>
      }
    </div>
  `,
})
export class VendorAttestationControl {
  private readonly api = inject(VendorApi);

  readonly claim = input.required<VendorClaim>();
  /** Release labels for the caller's OWN endpoint product. Never the
   *  counterpart's — a foreign version id is a 400 by design (§8.2). */
  readonly versions = input.required<readonly ProductVersion[]>();

  readonly changed = output<VendorClaim>();
  readonly retracted = output<string>();

  private readonly affirmButton = viewChild<ElementRef<HTMLButtonElement>>('affirmButton');

  protected readonly busy = signal<null | 'affirm' | 'deny' | 'clear'>(null);
  protected readonly error = signal<string | null>(null);

  /** `mine[0]` is the caller's own endpoint's slot — see the header. */
  private readonly mineHead = computed(() => this.claim().mine[0] ?? null);

  // `linkedSignal`, not `signal`: these reset when — and only when — the server
  // has spoken and replaced the claim, so an in-progress edit is never clobbered
  // by an unrelated re-render.
  protected readonly note = linkedSignal(() => this.mineHead()?.note ?? '');
  protected readonly introducedVersionId = linkedSignal(
    () => this.mineHead()?.introduced_version_id ?? null,
  );
  protected readonly deprecatedVersionId = linkedSignal(
    () => this.mineHead()?.deprecated_version_id ?? null,
  );

  protected readonly stanceLabel = computed(() => ownStanceLabel(this.claim().mine));

  /**
   * A vendor owning both endpoints writes one position to every slot it owns, so
   * two rows that currently disagree get silently collapsed on the next save.
   * Say so rather than hide it: this is the only place the API's slot model has
   * to leak into the UI.
   *
   * **Only `note` and `asserted` count as divergence.** Version stamps
   * legitimately differ across slots — §8.2 requires a stamp to belong to the
   * attesting side's own endpoint product, so for an owns-both caller the server
   * lands the stamp on the one slot whose endpoint owns that version and leaves
   * the other null. Treating that as a conflict would fire this warning on every
   * stamped both-endpoints claim, which is noise, not signal.
   */
  protected readonly divergentSlots = computed(() => {
    const mine = this.claim().mine;
    if (mine.length < 2) return false;
    const [a, b] = mine;
    return a.note !== b.note || a.asserted !== b.asserted;
  });

  protected readonly versionOptions = computed<readonly AecSelectOption[]>(() => [
    { value: null, label: this.anyVersionLabel },
    ...this.versions().map((v) => ({ value: v.id, label: v.label })),
  ]);

  /**
   * What the disclosure says while it is closed.
   *
   * It must name the note and the stamps that a save would send, because `PUT`
   * replaces the whole position — a summary reading "Details" over a populated
   * note would be the exact misdirection this component is built to prevent.
   * The note is quoted verbatim (truncated only for length), never paraphrased.
   */
  protected readonly detailsSummary = computed(() => {
    const label = (id: string | null) => this.versions().find((v) => v.id === id)?.label ?? null;
    const introduced = label(this.introducedVersionId());
    const deprecated = label(this.deprecatedVersionId());
    const parts: string[] = [];

    const note = this.note().trim();
    if (note) {
      parts.push(`“${note.length > 60 ? `${note.slice(0, 60)}…` : note}”`);
    } else {
      parts.push($localize`:@@vendor.attest.details.noNote:No note`);
    }

    if (introduced && deprecated) {
      parts.push(
        $localize`:@@vendor.attest.versions.summary.both:from ${introduced}:from: to ${deprecated}:to:`,
      );
    } else if (introduced) {
      parts.push($localize`:@@vendor.attest.versions.summary.from:from ${introduced}:from:`);
    } else if (deprecated) {
      parts.push($localize`:@@vendor.attest.versions.summary.to:until ${deprecated}:to:`);
    }

    const detail = parts.join(' · ');
    return $localize`:@@vendor.attest.details.summary:Note and versions · ${detail}:detail:`;
  });

  protected readonly introducedLabel = $localize`:@@vendor.attest.versions.introduced:Introduced in`;
  protected readonly deprecatedLabel = $localize`:@@vendor.attest.versions.deprecated:Removed in`;
  protected readonly anyVersionLabel = $localize`:@@vendor.attest.versions.any:Not specified`;

  protected readonly labelClass =
    'block text-xs font-bold tracking-[0.08em] text-(--text-secondary) uppercase';
  protected readonly inputClass =
    'w-full rounded-(--radius-md) border border-(--border-default) bg-(--surface-base) px-3 py-2 text-sm text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';
  protected readonly primaryButtonClass =
    'inline-flex items-center justify-center rounded-(--radius-md) border border-(--border-strong) bg-(--accent-primary) px-5 py-2 text-sm font-bold text-(--surface-base) transition-colors hover:bg-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) disabled:cursor-not-allowed disabled:opacity-50';
  protected readonly secondaryButtonClass =
    'inline-flex items-center justify-center rounded-(--radius-md) border border-(--border-default) px-4 py-2 text-sm font-medium text-(--text-primary) transition-colors hover:border-(--border-strong) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) disabled:cursor-not-allowed disabled:opacity-50';

  protected fieldId(key: string): string {
    return `vendor-claim-${this.claim().id}-${key}`;
  }

  /** Move focus to Affirm. Used after a Clear (which disables its own button)
   *  and by the add-form's duplicate pivot, which lands the vendor on the lane
   *  they already have. */
  focusPosition(): void {
    this.affirmButton()?.nativeElement.focus();
  }

  protected onNote(event: Event): void {
    this.note.set((event.target as HTMLTextAreaElement).value);
  }

  /**
   * The ONLY place a PUT body is built. Every field is present, every time —
   * see the header. `note` normalises blank to `null` so an all-whitespace note
   * is not stored as a note.
   */
  private position(asserted: boolean): VendorAttestationPosition {
    return {
      asserted,
      note: this.note().trim() || null,
      introduced_version_id: this.introducedVersionId(),
      deprecated_version_id: this.deprecatedVersionId(),
    };
  }

  protected onAffirm(): void {
    void this.write('affirm', true);
  }

  protected onDeny(): void {
    void this.write('deny', false);
  }

  private async write(action: 'affirm' | 'deny', asserted: boolean): Promise<void> {
    this.busy.set(action);
    this.error.set(null);
    try {
      const res = await this.api.upsertAttestation(this.claim().id, this.position(asserted));
      this.changed.emit(res.claim);
    } catch (err) {
      this.error.set(this.messageFor(err));
    } finally {
      this.busy.set(null);
    }
  }

  protected async onClear(): Promise<void> {
    this.busy.set('clear');
    this.error.set(null);
    try {
      await this.api.retractAttestation(this.claim().id);
      // 204, no body — the section re-reads. Reconstructing the agreement here
      // would be wrong whenever a third vendor also holds a position, because
      // `counterparty` is a lossy reduction of every other voter.
      this.retracted.emit(this.claim().id);
      this.focusPosition();
    } catch (err) {
      this.error.set(this.messageFor(err));
    } finally {
      this.busy.set(null);
    }
  }

  private messageFor(err: unknown): string {
    const info = readVendorApiError(err);
    if (info?.status === 403) {
      // `verified` can flip between the SSR payload and this write.
      return $localize`:@@vendor.attest.error.unverified:Confirming a data flow needs a verified account. Verification is arranged with AEC Integrations.`;
    }
    if (info?.status === 404) {
      return $localize`:@@vendor.attest.error.gone:This data flow is no longer available. Reload to see the current list.`;
    }
    return $localize`:@@vendor.attest.error.generic:Could not save your position. Try again.`;
  }
}
