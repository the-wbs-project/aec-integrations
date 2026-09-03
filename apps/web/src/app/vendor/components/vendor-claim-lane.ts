import { Component, computed, input, output, viewChild } from '@angular/core';

import type { ProductVersion, VendorClaim } from '@aeci/shared';

import { AgreementBadge } from '../../products/agreement-badge';
import {
  directionAria,
  directionGlyph,
  directionHeading,
} from '../../products/pair-direction-labels';

import { VendorAttestationControl } from './vendor-attestation-control';
import {
  counterpartyColumnLabel,
  counterpartyLabel,
  counterpartyStanceLabel,
  ownStancePhrase,
} from './vendor-attestation-labels';

/**
 * One `data_object` claim lane, as its own vendor sees it (AECI-606 / §6).
 *
 * Purely presentational apart from the control it hosts. Three things it must
 * get right:
 *
 * **Direction is rendered, never derived.** `VendorClaim.direction` already
 * arrives caller-relative (`inbound`/`outbound`/`both`, framed against
 * `context_product`), so the lane reads it verbatim through the same
 * `pair-direction-labels` the public pair page uses. `a_to_b`/`b_to_a` must
 * never reach the browser, and nothing here may reach for `source`/`target`.
 *
 * **The agreement badge is reused, not restated.** `AgreementBadge` owns the
 * four states' copy and tone for the whole app — including the rule that
 * `conflict` is the only red state and `single_source` never borrows
 * `confirmed`'s treatment. A vendor's view of a claim disagreeing with the
 * public page's view of the same claim would be worse than either.
 *
 * **A conflict shows both positions.** §6: "A conflict must be legible from the
 * vendor's side, with the counterparty's position shown." The disclosure below
 * is `--surface-sunken` + `--border-strong`, NOT `--status-error`: it is two
 * parties describing a flow differently, not a defect in either product, and
 * the vendor surface reserves red for the badge alone.
 *
 * ── THE OPTIMISTIC INTERIM (AECI-630) ───────────────────────────────────────
 * `STAGE_2_REALTIME_SPEC.md` §5 makes the three toggle-shaped writes optimistic:
 * Affirm / Deny / Clear patch {@link VendorPortalStore} before the round trip and
 * roll back with a visible error if it fails. This lane needs no code for that —
 * it renders `claim`, `claim` comes from the store, so the interim arrives the
 * same way any other update does. What it does owe is honesty about the interim:
 *
 * A retract is a `204` with **no body**, and the agreement it recomputes to
 * cannot be derived here (`counterparty` is a lossy reduction of every other
 * voter, so a third vendor would be invisible). The optimistic patch therefore
 * empties the caller's own rows — which the DELETE fully determines — and leaves
 * the badge alone until the section's re-read lands. For that window the lane is
 * genuinely mid-update, and it says so with `aria-busy`: the stance line has
 * already moved and the badge has not, and an assistive reader deserves to know
 * that rather than hear a contradiction.
 *
 * The **forms** on this dashboard (`vendor-profile-form.ts`,
 * `vendor-product-form.ts`) stay pessimistic by the same §5, and deliberately: a
 * toggle is one bit the vendor already decided and its rollback is
 * comprehensible, while a 15-field PATCH diff has no honest optimistic rendering
 * and "Saved" before it saved is a worse lie than a 300 ms wait.
 */
@Component({
  // An ATTRIBUTE selector on the `<li>` itself, not an element selector. A
  // component element between the `<ul>` and its `<li>` children breaks both
  // `list` and `listitem` — axe rates it serious, and the list semantics a
  // screen reader announces ("6 items") genuinely do disappear. Same fix, same
  // reason, as `tr[aec-product-card]` on the catalog table; the selector still
  // carries the `aec-` prefix, so it satisfies the namespacing intent of the
  // rule disabled below.
  // eslint-disable-next-line @angular-eslint/component-selector
  selector: 'li[aec-vendor-claim-lane]',
  imports: [AgreementBadge, VendorAttestationControl],
  host: {
    '[class]': 'rowClass()',
    '[attr.aria-labelledby]': 'fieldId("name")',
    '[attr.aria-current]': 'highlighted() ? "true" : null',
    // Mid-write: the optimistic patch has already moved part of this lane and
    // the server has not answered yet. See the header.
    '[attr.aria-busy]': 'writing() ? "true" : null',
  },
  template: `
    <div class="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
      <div class="min-w-0">
        <p [id]="fieldId('name')" class="font-label text-sm text-(--text-primary)">
          {{ claim().data_object_name }}
        </p>
        <p class="mt-0.5 text-xs text-(--text-secondary)">
          <span aria-hidden="true">{{ glyph() }}</span>
          <span class="ms-1" [attr.aria-label]="directionAriaLabel()">{{ directionLabel() }}</span>
        </p>
        @if (claim().origin === 'aeci') {
          <p class="mt-0.5 text-xs text-(--text-secondary)" i18n="@@vendor.attest.origin.aeci">
            On record from AEC Integrations
          </p>
        }
      </div>
      <div class="flex shrink-0 flex-col items-end gap-1.5">
        <aec-agreement-badge [agreement]="claim().agreement" [attributedTo]="attributedTo()" />
        <p class="text-xs text-(--text-secondary)">{{ counterpartyLine() }}</p>
      </div>
    </div>

    @if (claim().agreement === 'conflict' && claim().counterparty; as counterparty) {
      <div
        class="mt-3 rounded-(--radius-sm) border border-(--border-strong) bg-(--surface-sunken) p-3"
      >
        <p class="text-sm font-semibold text-(--text-primary)">{{ conflictHeading() }}</p>
        <dl class="mt-2 grid gap-3 text-xs sm:grid-cols-2">
          <div>
            <dt class="text-(--text-secondary)" i18n="@@vendor.attest.conflict.mine">
              Your position
            </dt>
            <dd class="mt-0.5 text-(--text-primary)">{{ ownPhrase() }}</dd>
            @if (ownNote(); as note) {
              <dd class="mt-1 text-(--text-secondary)">“{{ note }}”</dd>
            }
          </div>
          <div>
            <dt class="text-(--text-secondary)">{{ counterpartyColumn() }}</dt>
            <dd class="mt-0.5 text-(--text-primary)">
              {{ counterpartyStance(counterparty) }}
            </dd>
            @if (counterparty.note; as note) {
              <dd class="mt-1 text-(--text-secondary)">“{{ note }}”</dd>
            }
          </div>
        </dl>
        <p class="mt-2 text-xs text-(--text-secondary)" i18n="@@vendor.attest.conflict.next">
          Update your position below if it is out of date. If you think theirs is wrong, send us a
          correction request.
        </p>
      </div>
    }

    @if (canWrite()) {
      <aec-vendor-attestation-control
        [claim]="claim()"
        [contextProductId]="contextProductId()"
        [versions]="versions()"
        (changed)="changed.emit($event)"
        (retracted)="retracted.emit($event)"
      />
    }
  `,
})
export class VendorClaimLane {
  readonly claim = input.required<VendorClaim>();
  readonly otherProductName = input.required<string>();
  /** The `context_product.id` of the listing this lane belongs to (AECI-666),
   *  passed to the attestation control so its write frames the echoed claim
   *  against the endpoint the vendor is authoring from rather than the server's
   *  endpoint-A fallback. */
  readonly contextProductId = input.required<string>();
  readonly vendorName = input.required<string>();
  /** `false` for an unverified vendor: the lane still renders its real data, but
   *  the authoring control is withheld (`GET` is not Verified-gated; authoring
   *  is). */
  readonly canWrite = input.required<boolean>();
  readonly versions = input.required<readonly ProductVersion[]>();
  readonly highlighted = input(false);

  readonly changed = output<VendorClaim>();
  readonly retracted = output<string>();

  private readonly control = viewChild(VendorAttestationControl);

  /** Whether this lane's own control has a write in flight. `undefined` before
   *  the query resolves and on a read-only lane, which is not busy. */
  protected readonly writing = computed(() => (this.control()?.busy() ?? null) !== null);

  protected readonly glyph = computed(() => directionGlyph(this.claim().direction));
  protected readonly directionLabel = computed(() =>
    directionHeading(this.claim().direction, this.otherProductName()),
  );
  protected readonly directionAriaLabel = computed(() =>
    directionAria(this.claim().direction, this.otherProductName()),
  );

  /**
   * The vendor named on a `single_source` badge, or `null`.
   *
   * Only ever the caller's own name. When the lone affirmation is the
   * counterparty's we know their *product*, never their *vendor* — and the
   * badge's copy says "Confirmed by {vendor}", so passing a product name there
   * would be a quiet lie. `null` falls back to the badge's own unattributed
   * wording.
   */
  protected readonly attributedTo = computed(() =>
    this.claim().mine.some((a) => a.asserted) ? this.vendorName() : null,
  );

  protected readonly counterpartyLine = computed(() =>
    counterpartyLabel(this.claim().counterparty, this.claim().mine, this.otherProductName()),
  );
  protected readonly counterpartyColumn = computed(() =>
    counterpartyColumnLabel(this.otherProductName()),
  );
  protected readonly ownPhrase = computed(() => ownStancePhrase(this.claim().mine));
  protected readonly ownNote = computed(() => this.claim().mine[0]?.note ?? null);

  protected readonly conflictHeading = computed(
    () =>
      $localize`:@@vendor.attest.conflict.heading:You and ${this.otherProductName()}:other: describe this flow differently.`,
  );

  protected readonly rowClass = computed(() => {
    const base = 'block border-t border-(--border-default) px-5 py-4';
    // The highlight is the sighted half of the duplicate-claim pivot; the focus
    // move plus the section's live region is the assistive half.
    return this.highlighted()
      ? `${base} border-s-2 border-s-(--accent-primary) bg-(--surface-sunken)`
      : base;
  });

  protected counterpartyStance = counterpartyStanceLabel;

  protected fieldId(key: string): string {
    return `vendor-claim-${this.claim().id}-${key}`;
  }

  /** Hand focus to this lane's Affirm button — used by the duplicate pivot and
   *  after a new claim lands. */
  focusPosition(): void {
    this.control()?.focusPosition();
  }
}
