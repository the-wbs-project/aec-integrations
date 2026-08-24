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

import type {
  ProductVersion,
  VendorAttestationSlot,
  VendorClaim,
  VendorIntegration,
  VendorOwnAttestation,
} from '@aeci/shared';

import { AecSelect, type AecSelectOption } from '../../shared/aec-select/aec-select';
import { readVendorApiError } from '../vendor-api-error';
import { VendorApi, type VendorAttestationPosition } from '../vendor-api';
import { VendorPortalStore } from '../vendor-portal-store';

import { isProvisionalClaimId } from './vendor-add-claim-form';
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
 * ── WHY THESE THREE WRITES ARE OPTIMISTIC AND THE FORMS ARE NOT (AECI-630) ───
 * `STAGE_2_REALTIME_SPEC.md` §5: **toggle-shaped writes apply locally first**,
 * then reconcile against the server echo and roll back with a **visible** error
 * on failure. Affirm / Deny / Clear qualify — each is a single bit the vendor
 * has already decided, activation is the whole interaction, and the round trip
 * is the only thing between the click and the answer. A rollback is
 * comprehensible because there is exactly one thing to put back, and it is never
 * silent: a reverted toggle with no message reads as a UI glitch and the vendor
 * simply clicks it again.
 *
 * `vendor-profile-form.ts` and `vendor-product-form.ts` deliberately stay
 * **pessimistic**, and that is a decision rather than unfinished work. A 15-field
 * PATCH diff has no honest optimistic rendering — a form carries a large surface
 * of partially-valid intermediate states an optimistic render would have to guess
 * at, and **showing "Saved" before it saved is a worse lie than a 300 ms wait**.
 * Do not "finish the job" by making them optimistic too.
 *
 * ── WHAT MAY BE RENDERED OPTIMISTICALLY, AND WHAT MAY NOT ───────────────────
 * Only what the request itself determines: **the caller's own rows**. `agreement`
 * and `counterparty` are left exactly as they were until the echo replaces them,
 * because the dashboard never re-derives `computeAgreement` and `counterparty` is
 * a *lossy* reduction of every other voter — with a third vendor in play, a local
 * guess can be actively wrong. So an in-flight lane can briefly show "You confirm
 * this flow" under a badge that has not moved yet. That is the honest state: we
 * know what we sent, we do not yet know what it computed to.
 *
 * The optimistic value is built from the SAME {@link position} object that goes
 * on the wire, for the reason the header opens with: a second, hand-built
 * partial position is precisely the data-loss bug `VendorAttestationPosition`
 * exists to prevent.
 *
 * ── OTHER LOAD-BEARING CHOICES ──────────────────────────────────────────────
 * **Buttons, not an Aria listbox.** ADR 0010 governs discrete-choice *form
 * controls* — values you pick and submit later. These are commands: they fire a
 * write on activation, map to two different HTTP verbs, and Clear is a
 * withdrawal rather than a third value. Aria is used where §6 does ask for it —
 * the version pickers here, and the data-object/direction controls on the add
 * form.
 *
 * **Affirm and Deny disable only while a write is in flight, or on a lane that
 * does not exist server-side yet.** Re-affirming is the legitimate way to save an
 * edited note, and a button that disables itself as a lasting consequence of its
 * own activation drops focus to `<body>`. Clear also disables when there is
 * nothing to withdraw, which is exactly why it hands focus to Affirm afterwards.
 * The provisional case is the add form's optimistic placeholder lane
 * ({@link isProvisionalClaimId}): its id has never been to the server, so a write
 * against it could only 404.
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
          [disabled]="busy() !== null || provisional()"
          (click)="onAffirm()"
          i18n="@@vendor.attest.action.affirm"
        >
          Affirm
        </button>
        <button
          type="button"
          [class]="secondaryButtonClass"
          [disabled]="busy() !== null || provisional()"
          (click)="onDeny()"
          i18n="@@vendor.attest.action.deny"
        >
          Deny
        </button>
        <button
          type="button"
          [class]="secondaryButtonClass"
          [disabled]="busy() !== null || provisional() || claim().mine.length === 0"
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
        <!--
          Deliberately NOT role="status" (AECI-516 close-out). This sentence
          describes a standing CONDITION of the claim, not the outcome of an
          action: it is context for the Save button, read when a user reaches it.
          As a live region it announced on a state flip the user did not cause,
          because divergentSlots() is computed off store data that a background
          revalidation can move. On the Integrations tab that put it in direct
          competition with VendorPortalAnnouncer for the same event, which is the
          two-competing-utterances case the single channel exists to prevent.

          The rule this follows is in STAGE_2_REALTIME_SPEC.md 6.3: a local
          role="status" is for immediate feedback on an action the user just
          took, beside the control they took it with. Standing state is plain
          text; events go through the channel.
        -->
        <p class="text-xs text-(--text-secondary)" i18n="@@vendor.attest.divergent">
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
  /** The one owner of the integration list (AECI-628). Every write here patches
   *  it optimistically and then settles the handle exactly once. */
  private readonly store = inject(VendorPortalStore);

  readonly claim = input.required<VendorClaim>();
  /** Release labels for the caller's OWN endpoint product. Never the
   *  counterpart's — a foreign version id is a 400 by design (§8.2). */
  readonly versions = input.required<readonly ProductVersion[]>();

  readonly changed = output<VendorClaim>();
  readonly retracted = output<string>();

  private readonly affirmButton = viewChild<ElementRef<HTMLButtonElement>>('affirmButton');

  /** Which write is in flight, or `null`. Public because `VendorClaimLane`
   *  reports it as `aria-busy` on the lane the write belongs to. */
  readonly busy = signal<null | 'affirm' | 'deny' | 'clear'>(null);
  protected readonly error = signal<string | null>(null);

  /**
   * This lane is the add form's optimistic placeholder: the server has never
   * seen its id, so every write against it would 404. The controls disable for
   * the one round trip it lives, then the echo replaces it with a real lane.
   */
  protected readonly provisional = computed(() => isProvisionalClaimId(this.claim().id));

  /** `mine[0]` is the caller's own endpoint's slot — see the header. */
  private readonly mineHead = computed(() => this.claim().mine[0] ?? null);

  /**
   * The slots a write of ours will fill. The server fills **every** slot the
   * caller owns (§2.1), and `VendorIntegration.slots` is the read's own answer to
   * "which are mine" — so the optimistic rows are built from it rather than from
   * whatever happens to be in `mine` today (which is empty on a first
   * attestation, and is exactly one row short on an owns-both claim the vendor
   * has only half-voted).
   *
   * Degrades to the slots already on the claim, and then to none. A slot is
   * never invented: with nothing to build from, the write is simply not rendered
   * optimistically, which is a slower surface rather than a wrong one.
   */
  private readonly mySlots = computed<readonly VendorAttestationSlot[]>(() => {
    const claim = this.claim();
    const integration = this.store.integrations().find((i) => i.id === claim.integration_id);
    return integration?.slots ?? claim.mine.map((a) => a.slot);
  });

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

  /**
   * The caller's own rows as they will read once this position lands: one per
   * owned slot, every field taken from the single {@link position} object that is
   * also the request body. Spreading it is what makes an incomplete optimistic
   * row impossible to write — the same guarantee the required fields give the
   * PUT.
   */
  private ownRows(position: VendorAttestationPosition): VendorOwnAttestation[] {
    const now = new Date().toISOString();
    return this.mySlots().map((slot) => ({ slot, ...position, updated_at: now }));
  }

  /** Patch this claim's own rows in the store and hand back the handle. Nothing
   *  else on the claim is touched — see the header on what may be rendered
   *  optimistically. */
  private patchOwnRows(mine: VendorOwnAttestation[]) {
    const next: VendorClaim = { ...this.claim(), mine };
    return this.store.apply('integrations', (list) => withClaim(list, next));
  }

  protected onAffirm(): void {
    void this.write('affirm', true);
  }

  protected onDeny(): void {
    void this.write('deny', false);
  }

  private async write(action: 'affirm' | 'deny', asserted: boolean): Promise<void> {
    if (this.provisional()) return;
    this.busy.set(action);
    this.error.set(null);
    // Built ONCE, then used for both the local render and the wire. Two
    // separately-built positions is how an optimistic path drifts into a partial
    // update.
    const position = this.position(asserted);
    const mutation = this.patchOwnRows(this.ownRows(position));
    try {
      const res = await this.api.upsertAttestation(this.claim().id, position);
      // The echo carries the recomputed `agreement`, so it is the truth for the
      // whole claim, not just for our rows.
      mutation.reconcile((list) => withClaim(list, res.claim));
      this.changed.emit(res.claim);
    } catch (err) {
      // Never silently: the rollback and the alert ship together, or a reverted
      // toggle reads as a glitch and gets clicked again (§5).
      mutation.rollback();
      this.error.set(this.messageFor(err));
    } finally {
      this.busy.set(null);
    }
  }

  protected async onClear(): Promise<void> {
    if (this.provisional()) return;
    const claimId = this.claim().id;
    this.busy.set('clear');
    this.error.set(null);
    // A retract removes exactly the caller's own rows, and that much the request
    // fully determines — so the lane stops asserting immediately instead of
    // sitting frozen for a round trip plus a re-read. `agreement` deliberately
    // does NOT move here.
    const mutation = this.patchOwnRows([]);
    try {
      await this.api.retractAttestation(claimId);
      // 204, no body — nothing to reconcile FROM, so the interim stands and the
      // section re-reads. Reconstructing the agreement here would be wrong
      // whenever a third vendor also holds a position, because `counterparty` is
      // a lossy reduction of every other voter.
      mutation.commit();
      this.retracted.emit(claimId);
      this.focusPosition();
    } catch (err) {
      mutation.rollback();
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

/**
 * Splice one claim into the store's integration list, leaving every other object
 * identity untouched.
 *
 * That is load-bearing rather than tidy: the card's `@for` tracks lanes by
 * `claim.id` and the sections above track integrations the same way, so rebuilding
 * an untouched neighbour would discard its focus and whatever the vendor had typed
 * into its note editor.
 */
function withClaim(
  list: readonly VendorIntegration[],
  claim: VendorClaim,
): readonly VendorIntegration[] {
  return list.map((integration) =>
    integration.id === claim.integration_id
      ? { ...integration, claims: integration.claims.map((c) => (c.id === claim.id ? claim : c)) }
      : integration,
  );
}
