import {
  Injectable,
  computed,
  effect,
  inject,
  signal,
  untracked,
  type Signal,
} from '@angular/core';

import {
  attestationNoteProblem,
  mirrorContextDirection,
  type ContextDirection,
  type ListVendorContestsResponse,
  type OfferedContestField,
  type VendorClaim,
  type VendorIntegration,
  type VendorOwnAttestation,
} from '@aeci/shared';

import { claimOutcomeLine } from '../components/vendor-claim-outcome';
import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorApi, type VendorAttestationPosition } from '../vendor-api';
import { readVendorApiError } from '../vendor-api-error';
import { vendorCan, vendorHasActiveEntitlement } from '../vendor-capabilities';
import { VendorPortalStore } from '../vendor-portal-store';

import { contestsFor, otherCompanyName, stampsToKeep } from './integration-detail-model';

/** Which filter the Change requests list shows (§6.17.6). */
export type RequestFilter = 'all' | 'open' | 'closed';

/** The outcome of a write, for the component that made it. `null` is success. */
export type WriteError = string | null;

const NO_CONTESTS: ListVendorContestsResponse = { submitted: [], received: [] };

/**
 * Page-scoped state for one integration detail page (§6.17).
 *
 * Provided by `VendorIntegrationDetailPage` in its own `providers`, so it lives
 * exactly as long as the page and resolves `VendorApi` and `VendorPortalStore`
 * from the surface above it (the preview's DI shadow applies, as it does for the
 * store). It holds what more than one section needs:
 *
 * - the page's one extra read, `GET /api/vendor/contests?integration_id=`
 *   (§6.17.6), refetched when the store's `contests` or `integrations` move after
 *   it has loaded (`STAGE_2_REALTIME_SPEC.md` §2.3);
 * - the Change requests form and filters, so a "Request a change" in the Overview
 *   and a jump from "Things that need you" can drive them;
 * - the answer writes (§6.17.4), because a row's Yes and No live in "Data that's
 *   shared" AND in the Change requests items, and both must behave the same.
 *
 * The integration itself is NOT held here: it is a slice of the store's
 * `integrations` list, which the live cursor keeps fresh. The page binds it.
 */
// eslint-disable-next-line @angular-eslint/use-injectable-provided-in -- page-scoped, provided by the detail page
@Injectable()
export class IntegrationDetailState {
  private readonly api = inject(VendorApi);
  private readonly store = inject(VendorPortalStore);
  private readonly announcer = inject(VendorPortalAnnouncer);

  private readonly bound = signal<Signal<VendorIntegration | null>>(signal(null));

  /** The integration the page is about, framed against its context product. */
  readonly integration = computed(() => this.bound()());

  readonly myVendorId = computed(() => this.store.me()?.vendor.id ?? null);
  readonly myCompany = computed(() => this.store.me()?.vendor.company_name ?? '');
  /** The other company's name, or `null` when the wire names none. */
  readonly company = computed(() => {
    const integration = this.integration();
    return integration ? otherCompanyName(integration, this.myVendorId()) : null;
  });

  /** `attestation.author` (AECI-623): answering and adding need it. */
  readonly canAuthor = vendorCan(this.store, 'attestation.author');
  /** An active plan: owner writes on a connector-powered row need one (§4.5.6). */
  readonly entitled = vendorHasActiveEntitlement(this.store);

  // ── Contests (§6.17.6) ─────────────────────────────────────────────────────

  private readonly contestsState = signal<ListVendorContestsResponse>(NO_CONTESTS);
  /**
   * The integration's contests: the page's own filtered read once it has landed,
   * and until then the store's vendor-wide contests narrowed to this row, so a
   * flag or a status that the Messages read already knows does not flash absent.
   */
  readonly contests = computed<ListVendorContestsResponse>(() => {
    if (this.contestsStatus() === 'loaded') return this.contestsState();
    const integration = this.integration();
    return integration ? contestsFor(this.store.contests(), integration.id) : NO_CONTESTS;
  });
  readonly contestsStatus = signal<'idle' | 'loading' | 'loaded' | 'failed'>('idle');
  private contestsFor: string | null = null;
  private contestsSeq = 0;

  // ── Change requests UI state ───────────────────────────────────────────────

  /** The request form: open with a field chosen (or none). `seq` re-opens it even
   *  when the same field is asked for twice. */
  readonly requestForm = signal<{ field: OfferedContestField | null; seq: number } | null>(null);
  private formSeq = 0;
  readonly requestQuery = signal('');
  readonly requestFilter = signal<RequestFilter>('all');

  /** The add-a-row form in "Data that's shared". */
  readonly addingRow = signal(false);

  /** Set by the page: scroll to and focus an element id. */
  private jumpHandler: ((target: string) => void) | null = null;

  constructor() {
    // Refetch the page's contests when the store's contests or integrations move
    // after the first load. `integrations` too, because an owner edit changes a
    // field's live value, and a protest window depends on it (§2.3 there).
    // Only SERVER reads count (the store's revision counters): a local optimistic
    // write changes the store's value but is not a cursor move, and must not cost a
    // contests read (§6.17.6).
    let seen: readonly number[] | null = null;
    effect(() => {
      const tracked = [
        this.store.contestsServerRevision(),
        this.store.integrationsServerRevision(),
      ];
      untracked(() => {
        if (seen !== null && (seen[0] !== tracked[0] || seen[1] !== tracked[1])) {
          if (this.contestsStatus() === 'loaded' || this.contestsStatus() === 'failed') {
            void this.refreshContests();
          }
        }
        seen = tracked;
      });
    });
  }

  bind(integration: Signal<VendorIntegration | null>): void {
    this.bound.set(integration);
  }

  /** Load the page's contests once per integration id. Browser only: the page
   *  calls it from `afterNextRender`. */
  async ensureContests(integrationId: string): Promise<void> {
    if (this.contestsFor === integrationId && this.contestsStatus() !== 'idle') return;
    this.contestsFor = integrationId;
    this.contestsStatus.set('loading');
    await this.refreshContests();
  }

  /** Re-read the page's contests. Never rejects. */
  async refreshContests(): Promise<void> {
    const id = this.contestsFor;
    if (!id) return;
    const seq = ++this.contestsSeq;
    try {
      const next = await this.api.getContests(id);
      if (seq !== this.contestsSeq || id !== this.contestsFor) return;
      this.contestsState.set(next);
      this.contestsStatus.set('loaded');
    } catch {
      if (seq !== this.contestsSeq) return;
      this.contestsStatus.set('failed');
    }
  }

  // ── Navigation within the page ─────────────────────────────────────────────

  setJumpHandler(handler: ((target: string) => void) | null): void {
    this.jumpHandler = handler;
  }

  /** Jump to one element and focus it. A target inside Change requests first
   *  clears its search and sets its filter to All, so it is on the page. */
  jumpTo(target: string, inRequests = false): void {
    if (inRequests) {
      this.requestQuery.set('');
      this.requestFilter.set('all');
    }
    this.jumpHandler?.(target);
  }

  /** Open the request form with a field chosen, and move to it (§6.17.3). */
  openRequestForm(field: OfferedContestField | null): void {
    this.requestQuery.set('');
    this.requestForm.set({ field, seq: ++this.formSeq });
    this.jumpHandler?.('change-requests-form');
  }

  closeRequestForm(): void {
    this.requestForm.set(null);
  }

  // ── Answers (§6.17.4) ──────────────────────────────────────────────────────

  /**
   * Yes, saved at once: optimistic, rolled back with a visible error on failure
   * (`STAGE_2_REALTIME_SPEC.md` §5). Re-sends the caller's version stamps, because
   * a `PUT` replaces the whole position.
   */
  async answerYes(claim: VendorClaim): Promise<WriteError> {
    return this.writeAnswer(claim, true, yesNoteOf(claim), 'optimistic');
  }

  /**
   * A position with a note: a No with its reason, or a Yes with a note. Waits for
   * the server (the form is open, and "saved" before it saved would be a lie).
   */
  async answerWithNote(
    claim: VendorClaim,
    asserted: boolean,
    note: string,
    silent = false,
  ): Promise<WriteError> {
    const trimmed = note.trim();
    if (attestationNoteProblem(asserted, trimmed) !== null) return noteRequiredMessage();
    return this.writeAnswer(
      claim,
      asserted,
      trimmed === '' ? null : trimmed,
      'pessimistic',
      silent,
    );
  }

  /** Pressing the pressed button again clears the answer (`DELETE`). */
  async clearAnswer(claim: VendorClaim, silent = false): Promise<WriteError> {
    const integration = this.integration();
    if (!integration) return genericAnswerError();
    const mutation = this.patchMine(claim, []);
    try {
      await this.api.retractAttestation(claim.id);
      mutation.commit();
      if (!silent) {
        this.announcer.announce(
          $localize`:@@vendor.im.live.cleared:${claim.data_object_name}:data:: your answer is cleared.`,
        );
      }
      // A 204 carries nothing to reconcile from, and agreement must not be guessed.
      // One targeted re-read, spliced by claim id.
      await this.rereadClaim(claim.id);
      return null;
    } catch (err) {
      mutation.rollback();
      return answerErrorMessage(err);
    }
  }

  /**
   * "The direction is wrong" (§6.17.4): two writes, shown as one outcome. The No
   * with its reason first, because that is the statement that matters if the
   * second write fails. Then the corrected row, with no note. A duplicate corrected
   * row is answered Yes instead.
   *
   * Returns `'partial'` when the No saved and the corrected row did not, so the
   * form can offer "Add the corrected row" as a retry.
   */
  async directionWrong(
    claim: VendorClaim,
    reason: string,
    right: ContextDirection,
  ): Promise<WriteError | 'partial'> {
    // Silent: the outcome is announced once, after both writes (§6.17.4).
    const first = await this.answerWithNote(claim, false, reason, true);
    if (first !== null) return first;
    return (await this.addCorrectedRow(claim, right)) ? null : 'partial';
  }

  /**
   * Cancel a submitted change (§6.17.4, AECI-1246): withdraw the Yes on the
   * correction, then the No on the denied row. One announcement after both land.
   * The correction stays on record as an unanswered row until AECI-1245 lets a
   * vendor delete a row it added.
   */
  async cancelChange(denied: VendorClaim, correction: VendorClaim): Promise<WriteError> {
    const first = await this.clearAnswer(correction, true);
    if (first !== null) return first;
    const second = await this.clearAnswer(denied, true);
    if (second !== null) return second;
    this.announcer.announce(
      $localize`:@@vendor.im.live.changeCancelled:${denied.data_object_name}:data:: your change is canceled and your answers are cleared.`,
    );
    return null;
  }

  /**
   * Save the reason form opened from a submitted change's Change (§6.17.4,
   * AECI-1246). The same direction re-saves the No with the new reason. A new
   * direction withdraws the Yes on the old correction, then runs the two writes of
   * "the direction is wrong". Any other choice withdraws the Yes on the correction
   * and saves the No alone.
   *
   * The withdraw runs only while the correction still carries the caller's answer.
   * A retry after a failed second write finds it already withdrawn, and a second
   * `DELETE` would answer 404.
   */
  async reviseChange(
    denied: VendorClaim,
    correction: VendorClaim,
    reason: string,
    right: ContextDirection | null,
  ): Promise<WriteError | 'partial'> {
    if (attestationNoteProblem(false, reason.trim()) !== null) return noteRequiredMessage();
    if (right === correction.direction) {
      return this.answerWithNote(denied, false, reason);
    }
    const current = this.integration()?.claims.find((c) => c.id === correction.id) ?? correction;
    if (current.mine.length > 0) {
      const withdrawn = await this.clearAnswer(current, true);
      if (withdrawn !== null) return withdrawn;
    }
    if (right === null) return this.answerWithNote(denied, false, reason);
    return this.directionWrong(denied, reason, right);
  }

  /** The second half of "the direction is wrong", also the retry. */
  async addCorrectedRow(claim: VendorClaim, right: ContextDirection): Promise<boolean> {
    const integration = this.integration();
    if (!integration) return false;
    const data = claim.data_object_name;
    try {
      const res = await this.api.createClaim({
        integration_id: integration.id,
        data_object: claim.data_object_slug,
        direction: right,
        context_product_id: integration.context_product.id,
        note: null,
      });
      this.applyClaim(res.claim, 'append');
      this.announcer.announce(
        $localize`:@@vendor.im.live.directionFixed:${data}:data:: you said the direction is wrong and added the corrected row.`,
      );
      return true;
    } catch (err) {
      const existing = readVendorApiError(err)?.claimId ?? null;
      if (existing) {
        // The corrected row already exists: answer Yes on it instead.
        const target = integration.claims.find((c) => c.id === existing);
        if (target) {
          const error = await this.writeAnswer(
            target,
            true,
            yesNoteOf(target),
            'pessimistic',
            true,
          );
          if (error === null) {
            this.announcer.announce(
              $localize`:@@vendor.im.live.directionFixedExisting:${data}:data:: you said the direction is wrong and confirmed the row that was already listed.`,
            );
            return true;
          }
        }
      }
      this.announcer.announce(
        $localize`:@@vendor.im.live.directionPartial:${data}:data:: your No was saved. The corrected row was not added.`,
      );
      return false;
    }
  }

  /**
   * Add a row (§6.17.4). Pessimistic. A duplicate answers with the existing row's
   * id, which the caller focuses.
   */
  async addRow(
    dataObject: string,
    direction: ContextDirection,
    note: string,
  ): Promise<
    { ok: true; claimId: string } | { ok: false; duplicateOf: string | null; error: string }
  > {
    const integration = this.integration();
    if (!integration) return { ok: false, duplicateOf: null, error: genericAnswerError() };
    const trimmed = note.trim();
    try {
      const res = await this.api.createClaim({
        integration_id: integration.id,
        data_object: dataObject,
        direction,
        context_product_id: integration.context_product.id,
        note: trimmed === '' ? null : trimmed,
      });
      this.applyClaim(res.claim, 'append');
      const data = res.claim.data_object_name;
      this.announcer.announce(
        $localize`:@@vendor.im.live.added:${data}:data:: row added and recorded as confirmed by you.`,
      );
      return { ok: true, claimId: res.claim.id };
    } catch (err) {
      const info = readVendorApiError(err);
      if (info?.claimId) {
        return {
          ok: false,
          duplicateOf: info.claimId,
          error: $localize`:@@vendor.im.add.duplicate:That row is already listed. Your answer on it is below.`,
        };
      }
      return { ok: false, duplicateOf: null, error: answerErrorMessage(err) };
    }
  }

  private async writeAnswer(
    claim: VendorClaim,
    asserted: boolean,
    note: string | null,
    mode: 'optimistic' | 'pessimistic',
    silent = false,
  ): Promise<WriteError> {
    const integration = this.integration();
    if (!integration) return genericAnswerError();
    const position: VendorAttestationPosition = {
      asserted,
      note,
      ...stampsToKeep(integration, claim),
    };
    const mutation =
      mode === 'optimistic' ? this.patchMine(claim, this.ownRows(integration, position)) : null;
    try {
      const res = await this.api.upsertAttestation(
        claim.id,
        position,
        integration.context_product.id,
      );
      if (mutation) mutation.commit();
      this.applyClaim(res.claim, 'replace');
      if (!silent) this.announceOutcome(res.claim, asserted);
      return null;
    } catch (err) {
      mutation?.rollback();
      return answerErrorMessage(err);
    }
  }

  private announceOutcome(claim: VendorClaim, asserted: boolean): void {
    const data = claim.data_object_name;
    const stance = asserted
      ? $localize`:@@vendor.im.live.yes:${data}:data:: you said this is right.`
      : $localize`:@@vendor.im.live.no:${data}:data:: you said this is wrong.`;
    const other = this.integration()?.other_product.name ?? null;
    this.announcer.announce(
      other === null ? stance : `${stance} ${claimOutcomeLine(claim, other)}`,
    );
  }

  /** The caller's own rows as they will read once the position lands. */
  private ownRows(
    integration: VendorIntegration,
    position: VendorAttestationPosition,
  ): VendorOwnAttestation[] {
    const now = new Date().toISOString();
    return integration.slots.map((slot) => ({ slot, ...position, updated_at: now }));
  }

  /** Patch this claim's own rows in every entry of the integration. */
  private patchMine(claim: VendorClaim, mine: VendorOwnAttestation[]) {
    return this.store.apply('integrations', (list) =>
      list.map((entry) =>
        entry.id === claim.integration_id
          ? { ...entry, claims: entry.claims.map((c) => (c.id === claim.id ? { ...c, mine } : c)) }
          : entry,
      ),
    );
  }

  /**
   * Splice one claim into EVERY entry of its integration (AECI-666): an owns-both
   * integration is listed once per endpoint, and the two are one position seen
   * from two sides. `direction` is context-relative, so an entry framed from the
   * other side gets the mirrored direction.
   */
  applyClaim(claim: VendorClaim, mode: 'replace' | 'append'): void {
    const authoredFrom = this.integration()?.context_product.id ?? null;
    this.store
      .apply('integrations', (list) =>
        list.map((entry) => {
          if (entry.id !== claim.integration_id) return entry;
          const framed =
            authoredFrom === null || entry.context_product.id === authoredFrom
              ? claim
              : { ...claim, direction: mirrorContextDirection(claim.direction) };
          const claims =
            mode === 'append' && !entry.claims.some((c) => c.id === framed.id)
              ? [...entry.claims, framed]
              : entry.claims.map((c) => (c.id === framed.id ? framed : c));
          return { ...entry, claims };
        }),
      )
      .commit();
  }

  private async rereadClaim(claimId: string): Promise<void> {
    try {
      const res = await this.api.getIntegrations();
      const authoredFrom = this.integration()?.context_product.id ?? null;
      const fresh =
        res.integrations
          .filter((i) => authoredFrom === null || i.context_product.id === authoredFrom)
          .flatMap((i) => i.claims)
          .find((c) => c.id === claimId) ??
        res.integrations.flatMap((i) => i.claims).find((c) => c.id === claimId);
      if (fresh) this.applyClaim(fresh, 'replace');
    } catch {
      // The write committed; only the refresh failed. The live cursor catches up.
    }
  }
}

/**
 * The note a one-click Yes re-sends: the saved note only when the saved answer is
 * already Yes. A saved No's reason is not a note on a Yes, and a `PUT` would
 * otherwise publish it under the other stance.
 */
function yesNoteOf(claim: VendorClaim): string | null {
  const own = claim.mine[0];
  return own?.asserted ? (own.note ?? null) : null;
}

export function noteRequiredMessage(): string {
  return $localize`:@@vendor.im.error.reasonRequired:Give a reason, so the other company and AEC Integrations know what to fix.`;
}

function genericAnswerError(): string {
  return $localize`:@@vendor.im.error.answerGeneric:Could not save your answer. Try again.`;
}

/** One sentence per refusal an answer can collect. */
export function answerErrorMessage(err: unknown): string {
  const info = readVendorApiError(err);
  if (info?.code === 'ATTESTATION_NOTE_REQUIRED') return noteRequiredMessage();
  if (info?.code === 'ENTITLEMENT_REQUIRED') {
    return $localize`:@@vendor.im.error.access:Answering needs active vendor access. Contact AEC Integrations to arrange it.`;
  }
  if (info?.status === 403) {
    return $localize`:@@vendor.im.error.forbidden:You cannot change this row. Reload to see where it stands.`;
  }
  if (info?.status === 404) {
    return $localize`:@@vendor.im.error.gone:This row is no longer listed. Reload to see where it stands.`;
  }
  if (info?.code === 'RATE_LIMITED') {
    return $localize`:@@vendor.im.error.rate:Too many requests in a short time. Wait a minute and try again.`;
  }
  return genericAnswerError();
}
