import {
  Component,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';

import type { ProductVersion, VendorClaim } from '@aeci/shared';

import { AgreementBadge } from '../../products/agreement-badge';
import {
  directionAria,
  directionGlyph,
  directionHeading,
} from '../../products/pair-direction-labels';
import { RequestTrigger } from '../../requests/request-trigger';
import { NewTabIcon } from '../../shared/new-tab-icon/new-tab-icon';

import { VendorAttestationControl } from './vendor-attestation-control';
import {
  counterpartyColumnLabel,
  counterpartyLabel,
  counterpartyStanceLabel,
  ownStanceLabel,
  ownStancePhrase,
} from './vendor-attestation-labels';
import { claimOutcomeLine } from './vendor-claim-outcome';

/**
 * One `data_object` claim lane, as its own vendor sees it (AECI-606 / §6).
 *
 * Since AECI-999 (§6.3) it is the third level of the tab's drill-down: a
 * collapsed summary row (name, direction, stance, badge) that opens onto
 * everything below. Collapsed by default, local state, hidden not removed.
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
 * **Every state says what happens next** (AECI-961 / §6.2). `claimOutcomeLine`
 * turns the claim into one sentence naming the actual consequence — who gets
 * emailed, after how many days, and what the public listing shows meanwhile. It
 * renders in all nine states, not just the interesting ones, because the state
 * this issue was filed about is a *waiting* state: a vendor who denies a false
 * claim and sees no acknowledgement assumes nothing happened.
 *
 * It is **plain text, never a live region.** Standing state on this surface is
 * plain text and events go through the shell's one `VendorPortalAnnouncer`
 * channel (`STAGE_2_REALTIME_SPEC.md` §6.3, and the same reasoning written out at
 * `vendor-attestation-control.ts`'s `divergentSlots` block). The section
 * announces the same sentence when a write lands, which is why the copy lives in
 * one function that both call rather than being written twice.
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
  imports: [AgreementBadge, VendorAttestationControl, RequestTrigger, NewTabIcon],
  host: {
    '[class]': 'rowClass()',
    '[attr.aria-labelledby]': 'fieldId("name")',
    '[attr.aria-current]': 'highlighted() ? "true" : null',
    // Mid-write: the optimistic patch has already moved part of this lane and
    // the server has not answered yet. See the header.
    '[attr.aria-busy]': 'writing() ? "true" : null',
  },
  template: `
    <!--
      AECI-999 (section 6.3). The lane is a disclosure: the summary row is the
      button, and everything that manages the flow sits in the panel below it.
      The panel is hidden with the hidden attribute, never an @if, so a
      collapsed lane keeps its attestation control alive. A half-typed note
      survives collapsing, and an in-flight write still reconciles into it.
    -->
    <button
      type="button"
      [id]="fieldId('toggle')"
      [attr.aria-expanded]="expanded()"
      [attr.aria-controls]="fieldId('panel')"
      (click)="toggle()"
      class="flex w-full cursor-pointer flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3 text-start
        transition-colors hover:bg-(--surface-sunken) focus-visible:outline-2
        focus-visible:-outline-offset-2 focus-visible:outline-(--accent-primary)"
    >
      <span class="flex min-w-0 flex-1 items-center gap-3">
        <svg
          aria-hidden="true"
          class="h-4 w-4 shrink-0 text-(--text-secondary) transition-transform"
          [class.rotate-90]="expanded()"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="m9 6 6 6-6 6" />
        </svg>
        <span class="min-w-0">
          <span [id]="fieldId('name')" class="block font-label text-sm text-(--text-primary)">
            {{ claim().data_object_name }}
          </span>
          <span class="mt-0.5 block text-xs text-(--text-secondary)">
            <span aria-hidden="true">{{ glyph() }}</span>
            <span class="ms-1" [attr.aria-label]="directionAriaLabel()">{{
              directionLabel()
            }}</span>
          </span>
        </span>
      </span>
      <span class="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 ps-7 sm:ps-0">
        <span class="text-xs text-(--text-secondary)">{{ stance() }}</span>
        <aec-agreement-badge [agreement]="claim().agreement" [attributedTo]="attributedTo()" />
      </span>
    </button>

    <div
      [id]="fieldId('panel')"
      role="region"
      [attr.aria-labelledby]="fieldId('toggle')"
      [hidden]="!expanded()"
      class="px-5 pb-4 ps-12"
    >
      @if (claim().origin === 'aeci') {
        <p class="text-xs text-(--text-secondary)" i18n="@@vendor.attest.origin.aeci">
          On record from AEC Integrations
        </p>
      }
      <p class="mt-0.5 text-xs text-(--text-secondary)">{{ counterpartyLine() }}</p>

      <p class="mt-2 text-xs text-(--text-secondary)">{{ outcomeLine() }}</p>

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
          <!--
          AECI-967 (section 6.9). The second sentence named an action the portal
          gave no route to. The anchor opens the shared correction drawer in
          place; the href is the no-JS fallback and carries the new-tab
          treatment because that path navigates and the portal has no
          CanDeactivate guard.

          This is the ONE correction link that passes a bodyPrefill. Which data
          flow is disputed, and against which counterpart, is recorded nowhere in
          a correction request, unlike the product identity, which the request
          already carries as (target_type, slug).
        -->
          <p class="mt-2 text-xs text-(--text-secondary)" i18n="@@vendor.attest.conflict.next">
            Update your position below if it is out of date. If you think theirs is wrong,
            <a
              aecRequestTrigger
              [entity]="'product'"
              [kind]="'correction'"
              [slug]="contextProductSlug()"
              [bodyPrefill]="correctionPrefill()"
              [href]="'/products/' + contextProductSlug() + '/correction'"
              target="_blank"
              rel="noopener"
              class="text-(--accent-primary) underline underline-offset-2"
              >send us a correction request
              <span class="inline-flex align-middle"><aec-new-tab-icon /></span></a
            >.
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
    </div>
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
  /** The `context_product.slug` of the same listing (AECI-967). A correction
   *  request addresses its target by `(entity, slug)` — never a UUID — so the id
   *  above cannot serve. Both are on the wire at the card level
   *  (`vendor-integration-card.ts` builds its pair href from the same field), so
   *  this costs nothing to pass down. */
  readonly contextProductSlug = input.required<string>();
  readonly vendorName = input.required<string>();
  /** `false` for a vendor without active account access: the lane still renders its real data, but
   *  the authoring control is withheld (`GET` is not account-access-gated; authoring
   *  is). */
  readonly canWrite = input.required<boolean>();
  readonly versions = input.required<readonly ProductVersion[]>();
  readonly highlighted = input(false);

  readonly changed = output<VendorClaim>();
  readonly retracted = output<string>();

  private readonly control = viewChild(VendorAttestationControl);
  private readonly injector = inject(Injector);

  /** Collapsed by default (AECI-999). Local state: the lane is tracked by
   *  `claim.id`, so it survives every splice a write or a poll makes. */
  readonly expanded = signal(false);

  protected readonly stance = computed(() => ownStanceLabel(this.claim().mine));

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

  /** §6.2's what-happens-next sentence. Shared verbatim with the section's
   *  announcement so the printed and spoken receipts cannot drift. */
  protected readonly outcomeLine = computed(() =>
    claimOutcomeLine(this.claim(), this.otherProductName()),
  );
  protected readonly ownNote = computed(() => this.claim().mine[0]?.note ?? null);

  protected readonly conflictHeading = computed(
    () =>
      $localize`:@@vendor.attest.conflict.heading:You and ${this.otherProductName()}:other: describe this flow differently.`,
  );

  /**
   * Seed text for the correction drawer's free-text body (AECI-967).
   *
   * Built with `$localize` in TS rather than an interpolated `i18n-bodyPrefill`
   * attribute, which emits no attribute at all in this toolchain and would leave
   * the field empty rather than merely untranslated.
   *
   * It names the two things a correction request cannot otherwise carry: the
   * disputed `data_object` and the counterpart product. The target product is
   * deliberately NOT restated — the request already holds `(target_type, slug)`.
   * The trailing prompt is what makes this a scaffold rather than a submission:
   * the vendor is being asked for the part only they know. Comfortably past
   * `CorrectionFormSchema`'s 20-character floor either way.
   */
  protected readonly correctionPrefill = computed(
    () =>
      $localize`:@@vendor.attest.conflict.correction.prefill:The recorded ${this.claim().data_object_name}:dataObject: flow with ${this.otherProductName()}:other: is wrong.\n\nWhat is actually correct: `,
  );

  protected readonly rowClass = computed(() => {
    const base = 'block border-t border-(--border-default)';
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

  constructor() {
    // The duplicate pivot highlights a lane the vendor has to act on, so it
    // opens it. It never closes one: the highlight clearing is not a request to
    // hide what the vendor is working in.
    effect(() => {
      if (this.highlighted()) this.expanded.set(true);
    });
  }

  protected toggle(): void {
    this.expanded.update((open) => !open);
  }

  /** Hand focus to this lane's Affirm button — used by the duplicate pivot and
   *  after a new claim lands. Opens the lane first, and focuses after the render
   *  that un-hides the panel, because a hidden button cannot take focus. */
  focusPosition(): void {
    if (this.expanded()) {
      this.control()?.focusPosition();
      return;
    }
    this.expanded.set(true);
    afterNextRender(() => this.control()?.focusPosition(), { injector: this.injector });
  }
}
