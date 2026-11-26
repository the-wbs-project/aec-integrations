import { DatePipe } from '@angular/common';
import { Component, afterNextRender, computed, inject, input, output, signal } from '@angular/core';

import {
  OBJECTION_GROUNDS,
  type ObjectionGround,
  type PairContest,
  type PairRightPair,
  type SyncServicePairVeto,
  type VendorPairContestsResponse,
  type VendorVetoesResponse,
  type VetoObjection,
} from '@aeci/shared';

import { AecButton } from '../../shared/button/button';
import {
  CHOICE_CARD_CLASS,
  CHOICE_INPUT_CLASS,
  FIELD_ERROR_CLASS,
  FIELD_INPUT_CLASS,
  FIELD_LABEL_CLASS,
} from '../../shared/form-field/form-field-classes';
import { CloseOnEscape } from '../shared/close-on-escape';
import { VendorApi } from '../vendor-api';
import { VendorPortalAnnouncer } from '../vendor-announcer';
import { objectionGroundLabel, removalEndReasonLabel, removalReasonText } from './removal-labels';

/**
 * Removals and reports on Sync Service pairs, in Messages (AECI-2042,
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §11e.6). Two reads, `GET /api/vendor/vetoes` and
 * `GET /api/vendor/pair-contests`, fetched once in the browser.
 *
 * - **Your removals**: the vetoes this company filed, each with Withdraw while in force.
 * - **Removed from your integrations**: the owner's view. A pair a vendor removed is
 *   marked "Removed by {vendor}" with the date and time and its reason, phrased as the
 *   vendor's statement, "{vendor} gave this reason" (since AECI-2192 the fixed reason's
 *   label; an older removal's own words "in its own words"). There
 *   is no Restore: only that vendor's withdraw, or AEC Integrations, ends it. "Object to
 *   this removal" opens an inline form with the three grounds of ruling 66, a required
 *   explanation and, for "plainly false", a required https link. An open or decided
 *   objection shows its outcome and AECi's note.
 * - **Reports you sent**: existence and data flow reports, with Withdraw while open and,
 *   after a decline, "Ask AEC Integrations to review it" (advice only).
 * - **Reports you received**: data flow reports on the owner's pairs, with Accept and
 *   Decline. An accept changes the flow on the public page.
 *
 * Writes are pessimistic and re-read both lists. Outcomes go through the portal's live
 * region. The section hides itself when all four lists are empty.
 *
 * AECI-2045: the owned row's page (§6.17.12) renders it in its Change requests section
 * with `integrationId`, which narrows the four lists to that pair, and `labelledBy`, which
 * drops the section's own heading. `loaded` hands the page the two received lists, so
 * the page's status counts the reports and removals without a second read.
 */
@Component({
  selector: 'aec-vendor-pair-rights-list',
  imports: [AecButton, CloseOnEscape, DatePipe],
  host: { class: 'block' },
  template: `
    @if (hasAny()) {
      <section class="space-y-4" [attr.aria-labelledby]="labelledBy() ?? 'pair-rights-heading'">
        @if (!labelledBy()) {
          <!-- The global h3 rule sets its type, so it carries no type utility (AECI-2083). -->
          <h3 id="pair-rights-heading" i18n="@@vendor.pairRights.heading">
            Sync Service integrations on your products
          </h3>
        }

        @if (vetoes().filed.length > 0) {
          <div class="space-y-2" data-vetoes-filed>
            <h4
              class="text-sm font-semibold text-(--text-primary)"
              i18n="@@vendor.pairRights.filed"
            >
              Your removals
            </h4>
            <ul class="m-0 list-none space-y-2 p-0">
              @for (v of vetoes().filed; track v.id) {
                <li class="rounded-panel border border-(--border-default) p-3 text-sm">
                  <p class="font-medium text-(--text-primary)">{{ pairName(v.pair) }}</p>
                  @if (v.in_force) {
                    <p class="text-(--text-secondary)" i18n="@@vendor.pairRights.filed.inForce">
                      Off the public site since {{ v.filed_at | date: 'mediumDate' }}.
                    </p>
                    <p class="text-(--text-secondary)" i18n="@@vendor.pairRights.filed.reason">
                      Your reason: {{ reasonText(v) }}
                    </p>
                    <button
                      type="button"
                      aecButton
                      variant="secondary"
                      compact
                      [disabled]="busy()"
                      (click)="withdrawVeto(v)"
                      i18n="@@vendor.pairRights.filed.withdraw"
                    >
                      Withdraw the removal
                    </button>
                  } @else {
                    <p class="text-(--text-secondary)">{{ endedText(v) }}</p>
                  }
                </li>
              }
            </ul>
          </div>
        }

        @if (vetoes().received.length > 0) {
          <div class="space-y-2" data-vetoes-received>
            <h4
              class="text-sm font-semibold text-(--text-primary)"
              i18n="@@vendor.pairRights.received"
            >
              Removed from your integrations
            </h4>
            <ul class="m-0 list-none space-y-2 p-0">
              @for (v of vetoes().received; track v.id) {
                <li class="rounded-panel border border-(--border-default) p-3 text-sm">
                  <p class="font-medium text-(--text-primary)">{{ pairName(v.pair) }}</p>
                  @if (v.in_force) {
                    <p class="text-(--text-primary)" i18n="@@vendor.pairRights.received.by.v2">
                      Removed by {{ v.vendor_name ?? unknownVendor }} on
                      {{ v.filed_at | date: 'mediumDate' }} at {{ v.filed_at | date: 'shortTime' }}.
                    </p>
                    <p class="text-(--text-secondary)">
                      @if (v.reason_code) {
                        <span i18n="@@vendor.pairRights.received.reason.v2"
                          >{{ v.vendor_name ?? unknownVendorStart }} gave this reason:
                          {{ reasonText(v) }}</span
                        >
                      } @else {
                        <span i18n="@@vendor.pairRights.received.reasonRecorded.v2"
                          >{{ v.vendor_name ?? unknownVendorStart }} gave this reason, in its own
                          words: {{ v.reason }}</span
                        >
                      }
                    </p>
                    <p
                      class="text-(--text-secondary)"
                      i18n="@@vendor.pairRights.received.noRestore.v3"
                    >
                      The public page shows nothing about the removal. You cannot restore it. It
                      returns if {{ v.vendor_name ?? unknownVendor }} withdraws the removal, or if
                      AEC Integrations agrees with an objection.
                    </p>
                    @if (v.objection; as o) {
                      <p class="text-(--text-primary)" data-objection-status>
                        {{ objectionStatusText(o) }}
                      </p>
                      @if (o.status !== 'open' && o.decision_note) {
                        <p class="text-(--text-secondary)">{{ o.decision_note }}</p>
                      }
                    }
                    @if (canObject(v)) {
                      <button
                        type="button"
                        aecButton
                        variant="secondary"
                        compact
                        class="mt-2"
                        [attr.aria-expanded]="objectingId() === v.id"
                        [attr.aria-controls]="'objection-form-' + v.id"
                        (click)="toggleObjection(v)"
                        i18n="@@vendor.pairRights.objection.trigger"
                      >
                        Object to this removal
                      </button>
                    }
                    @if (objectingId() === v.id) {
                      <form
                        [id]="'objection-form-' + v.id"
                        aecCloseOnEscape
                        [escapeBusy]="busy()"
                        (escapeCancel)="closeObjection()"
                        method="dialog"
                        novalidate
                        class="mt-3 max-w-2xl space-y-4"
                        (submit)="$event.preventDefault(); submitObjection(v)"
                      >
                        <p
                          class="max-w-prose text-(--text-primary)"
                          i18n="@@vendor.pairRights.objection.explain.v2"
                        >
                          AEC Integrations looks at an objection on three grounds only. We do not
                          decide whether {{ v.vendor_name ?? unknownVendor }} should support the
                          integration. We answer within five business days of receiving it. If we
                          agree, the integration returns on every page, and we tell both companies
                          why. If we do not agree, we tell you why. The integration stays off the
                          site while we look.
                        </p>
                        <fieldset class="m-0 max-w-2xl space-y-2 border-0 p-0">
                          <legend [class]="labelClass" i18n="@@vendor.pairRights.objection.ground">
                            Your ground (required)
                          </legend>
                          @for (g of grounds; track g) {
                            <label [class]="choiceCardClass">
                              <input
                                type="radio"
                                [class]="choiceInputClass"
                                [attr.name]="'objection-ground-' + v.id"
                                [value]="g"
                                [checked]="ground() === g"
                                [attr.aria-invalid]="objectionError() && !ground() ? 'true' : null"
                                (change)="ground.set(g)"
                              />
                              {{ groundLabel(g) }}
                            </label>
                          }
                        </fieldset>
                        <div class="space-y-2">
                          <label
                            [class]="labelClass"
                            [for]="'objection-explain-' + v.id"
                            i18n="@@vendor.pairRights.objection.explanationLabel"
                            >What shows it (required)</label
                          >
                          <textarea
                            [id]="'objection-explain-' + v.id"
                            [class]="inputClass"
                            class="min-h-24 resize-y py-3"
                            rows="3"
                            maxlength="2000"
                            required
                            [value]="explanation()"
                            (input)="explanation.set(valueOf($event))"
                          ></textarea>
                        </div>
                        @if (ground() === 'reason_plainly_false') {
                          <div class="space-y-2">
                            <label
                              [class]="labelClass"
                              [for]="'objection-link-' + v.id"
                              i18n="@@vendor.pairRights.objection.linkLabel"
                              >Link to their own public page that shows they support it
                              (required)</label
                            >
                            <input
                              [id]="'objection-link-' + v.id"
                              type="url"
                              inputmode="url"
                              autocomplete="off"
                              placeholder="https://"
                              [class]="inputClass"
                              [value]="sourceUrl()"
                              (input)="sourceUrl.set(valueOf($event))"
                            />
                          </div>
                        }
                        @if (objectionError(); as message) {
                          <p role="alert" [class]="errorClass">{{ message }}</p>
                        }
                        <div class="flex flex-wrap gap-2">
                          <button
                            type="submit"
                            aecButton
                            compact
                            [disabled]="busy()"
                            i18n="@@vendor.pairRights.objection.send"
                          >
                            Send the objection
                          </button>
                          <button
                            type="button"
                            aecButton
                            variant="secondary"
                            compact
                            (click)="closeObjection()"
                            i18n="@@vendor.pairRights.objection.cancel"
                          >
                            Cancel
                          </button>
                        </div>
                      </form>
                    }
                  } @else {
                    <p class="text-(--text-secondary)">{{ endedText(v) }}</p>
                  }
                </li>
              }
            </ul>
          </div>
        }

        @if (reports().submitted.length > 0) {
          <div class="space-y-2" data-reports-submitted>
            <h4
              class="text-sm font-semibold text-(--text-primary)"
              i18n="@@vendor.pairRights.submitted"
            >
              Reports you sent
            </h4>
            <ul class="m-0 list-none space-y-2 p-0">
              @for (r of reports().submitted; track r.id) {
                <li class="rounded-panel border border-(--border-default) p-3 text-sm">
                  <p class="font-medium text-(--text-primary)">{{ reportTitle(r) }}</p>
                  <p class="text-(--text-secondary)">{{ statusText(r) }}</p>
                  @if (r.decision_note) {
                    <p class="text-(--text-secondary)">{{ r.decision_note }}</p>
                  }
                  @if (r.protest) {
                    <p class="text-(--text-secondary)">{{ protestText(r) }}</p>
                  }
                  <div class="mt-2 flex flex-wrap gap-2">
                    @if (r.status === 'open') {
                      <button
                        type="button"
                        aecButton
                        variant="secondary"
                        compact
                        [disabled]="busy()"
                        (click)="withdrawReport(r)"
                        i18n="@@vendor.pairRights.submitted.withdraw"
                      >
                        Withdraw
                      </button>
                    }
                    @if (r.protest_closes_at && !r.protest) {
                      <button
                        type="button"
                        aecButton
                        variant="secondary"
                        compact
                        [disabled]="busy()"
                        (click)="protest(r)"
                        i18n="@@vendor.pairRights.submitted.protest"
                      >
                        Ask AEC Integrations to review it
                      </button>
                    }
                  </div>
                </li>
              }
            </ul>
          </div>
        }

        @if (reports().received.length > 0) {
          <div class="space-y-2" data-reports-received>
            <h4
              class="text-sm font-semibold text-(--text-primary)"
              i18n="@@vendor.pairRights.inbox"
            >
              Data flow reports you received
            </h4>
            <ul class="m-0 list-none space-y-2 p-0">
              @for (r of reports().received; track r.id) {
                <li class="rounded-panel border border-(--border-default) p-3 text-sm">
                  <p class="font-medium text-(--text-primary)">{{ reportTitle(r) }}</p>
                  <p class="text-(--text-secondary)" i18n="@@vendor.pairRights.inbox.from">
                    From {{ r.submitter_name ?? unknownVendor }}: {{ r.reason }}
                  </p>
                  <p class="text-(--text-secondary)">{{ statusText(r) }}</p>
                  @if (r.status === 'open') {
                    <p class="text-(--text-secondary)" i18n="@@vendor.pairRights.inbox.acceptHelp">
                      Accept changes the data flow on the public page as the report asks.
                    </p>
                    <div class="mt-2 flex flex-wrap gap-2">
                      <button
                        type="button"
                        aecButton
                        variant="secondary"
                        compact
                        [disabled]="busy()"
                        (click)="decide(r, 'accept')"
                        i18n="@@vendor.pairRights.inbox.accept"
                      >
                        Accept
                      </button>
                      <button
                        type="button"
                        aecButton
                        variant="secondary"
                        compact
                        [disabled]="busy()"
                        (click)="decide(r, 'decline')"
                        i18n="@@vendor.pairRights.inbox.decline"
                      >
                        Decline
                      </button>
                    </div>
                  }
                </li>
              }
            </ul>
          </div>
        }
        @if (error()) {
          <p role="alert" class="text-sm text-(--text-primary)">{{ error() }}</p>
        }
      </section>
    }
  `,
})
export class VendorPairRightsList {
  private readonly api = inject(VendorApi);
  private readonly announcer = inject(VendorPortalAnnouncer);

  /** Narrow every list to this pair (AECI-2045, the owned row's page). */
  readonly integrationId = input<string | null>(null);
  /** The id of a heading outside that names the block. Then it renders none of its own. */
  readonly labelledBy = input<string | null>(null);
  /** The received lists after every read, unnarrowed. */
  readonly loaded = output<{
    readonly reports: VendorPairContestsResponse['received'];
    readonly vetoes: VendorVetoesResponse['received'];
  }>();

  private readonly allVetoes = signal<VendorVetoesResponse>({ filed: [], received: [] });
  private readonly allReports = signal<VendorPairContestsResponse>({
    submitted: [],
    received: [],
  });

  private onPair<T extends { readonly pair: PairRightPair }>(rows: readonly T[]): T[] {
    const id = this.integrationId();
    return id === null ? [...rows] : rows.filter((row) => row.pair.integration_id === id);
  }

  protected readonly vetoes = computed<VendorVetoesResponse>(() => ({
    filed: this.onPair(this.allVetoes().filed),
    received: this.onPair(this.allVetoes().received),
  }));
  protected readonly reports = computed<VendorPairContestsResponse>(() => ({
    submitted: this.onPair(this.allReports().submitted),
    received: this.onPair(this.allReports().received),
  }));
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly unknownVendor = $localize`:@@vendor.pairRights.unknownVendor:a vendor`;
  /** The same, at the start of a sentence. */
  protected readonly unknownVendorStart = $localize`:@@vendor.pairRights.unknownVendorStart:A vendor`;

  constructor() {
    afterNextRender(() => void this.load());
  }

  protected hasAny(): boolean {
    const v = this.vetoes();
    const r = this.reports();
    return v.filed.length + v.received.length + r.submitted.length + r.received.length > 0;
  }

  protected pairName(pair: PairRightPair): string {
    if (pair.name) return pair.name;
    const a = pair.product_a?.name ?? '';
    const b = pair.product_b?.name ?? '';
    return $localize`:@@vendor.pairRights.pairName:${a}:a: and ${b}:b:`;
  }

  protected endedText(v: SyncServicePairVeto): string {
    if (v.ended_how === 'lifted' && v.end_reason) {
      const why = removalEndReasonLabel(v.end_reason);
      return $localize`:@@vendor.pairRights.ended.liftedWhy:AEC Integrations ended this removal. Why: ${why}:why:. ${v.end_note ?? ''}:note:`;
    }
    return v.ended_how === 'lifted'
      ? $localize`:@@vendor.pairRights.ended.lifted:AEC Integrations ended this removal: ${v.end_note ?? ''}:note:`
      : $localize`:@@vendor.pairRights.ended.withdrawn:The removal was withdrawn.`;
  }

  // ── AECI-2192 (ruling 66): the reason and the objection ────────────────────

  protected readonly reasonText = removalReasonText;
  protected readonly groundLabel = objectionGroundLabel;
  protected readonly grounds = OBJECTION_GROUNDS;
  protected readonly labelClass = FIELD_LABEL_CLASS;
  protected readonly inputClass = FIELD_INPUT_CLASS;
  protected readonly errorClass = FIELD_ERROR_CLASS;
  protected readonly choiceCardClass = CHOICE_CARD_CLASS;
  protected readonly choiceInputClass = CHOICE_INPUT_CLASS;

  /** The removal whose objection form is open, if any. */
  protected readonly objectingId = signal<string | null>(null);
  protected readonly ground = signal<ObjectionGround | null>(null);
  protected readonly explanation = signal('');
  protected readonly sourceUrl = signal('');
  protected readonly objectionError = signal<string | null>(null);

  /** A form control's value, from its event. */
  protected valueOf(event: Event): string {
    return (event.target as HTMLInputElement | HTMLTextAreaElement).value;
  }

  /** One open objection per removal, and none once it ended. */
  protected canObject(v: SyncServicePairVeto): boolean {
    return v.in_force && v.objection?.status !== 'open';
  }

  protected objectionStatusText(o: VetoObjection): string {
    const ground = objectionGroundLabel(o.ground);
    switch (o.status) {
      case 'open':
        return $localize`:@@vendor.pairRights.objection.open:Your objection is with AEC Integrations. Ground: ${ground}:ground:.`;
      case 'accepted':
        return $localize`:@@vendor.pairRights.objection.accepted:AEC Integrations agreed with your objection. Ground: ${ground}:ground:.`;
      case 'declined':
        return $localize`:@@vendor.pairRights.objection.declined:AEC Integrations did not agree with your objection. The removal stands. Ground: ${ground}:ground:.`;
      default:
        return $localize`:@@vendor.pairRights.objection.closed:Your objection closed when the removal ended.`;
    }
  }

  protected toggleObjection(v: SyncServicePairVeto): void {
    if (this.objectingId() === v.id) return this.closeObjection();
    this.ground.set(null);
    this.explanation.set('');
    this.sourceUrl.set('');
    this.objectionError.set(null);
    this.objectingId.set(v.id);
  }

  protected closeObjection(): void {
    if (this.busy()) return;
    this.objectingId.set(null);
    this.objectionError.set(null);
  }

  protected async submitObjection(v: SyncServicePairVeto): Promise<void> {
    const ground = this.ground();
    const explanation = this.explanation().trim();
    const link = this.sourceUrl().trim();
    if (!ground) {
      return this.objectionError.set(
        $localize`:@@vendor.pairRights.objection.err.ground:Choose one of the three grounds.`,
      );
    }
    if (!explanation) {
      return this.objectionError.set(
        $localize`:@@vendor.pairRights.objection.err.explanation:Say what shows it.`,
      );
    }
    if (ground === 'reason_plainly_false' && !link.startsWith('https://')) {
      return this.objectionError.set(
        $localize`:@@vendor.pairRights.objection.err.link:Add an https link to their own public page.`,
      );
    }
    this.busy.set(true);
    this.objectionError.set(null);
    try {
      await this.api.fileVetoObjection(v.id, {
        ground,
        explanation,
        ...(ground === 'reason_plainly_false' ? { source_url: link } : {}),
      });
      this.objectingId.set(null);
      this.announcer.announce(
        $localize`:@@vendor.pairRights.objection.sent.v2:Objection sent to AEC Integrations. We answer within five business days. The integration stays off the site while we look.`,
      );
    } catch (e) {
      const code = (e as { error?: { error?: { code?: string } } }).error?.error?.code;
      this.objectionError.set(
        code === 'VETO_OBJECTION_DUPLICATE'
          ? $localize`:@@vendor.pairRights.objection.err.duplicate:An objection to this removal is already with AEC Integrations.`
          : code === 'VETO_NOT_IN_FORCE'
            ? $localize`:@@vendor.pairRights.objection.err.ended:This removal has ended. The list is reloaded.`
            : $localize`:@@vendor.pairRights.objection.err.generic:That did not go through. Try again.`,
      );
    } finally {
      this.busy.set(false);
      await this.load();
    }
  }

  protected reportTitle(r: PairContest): string {
    const pair = this.pairName(r.pair);
    if (r.kind === 'existence') {
      return $localize`:@@vendor.pairRights.title.existence:${pair}:pair:: not offered`;
    }
    const flow = r.flow?.data_object_name ?? '';
    return $localize`:@@vendor.pairRights.title.flow:${pair}:pair:: the ${flow}:flow: data flow`;
  }

  protected statusText(r: PairContest): string {
    switch (r.status) {
      case 'open':
        return r.routed_to === 'owner'
          ? $localize`:@@vendor.pairRights.status.withOwner:Open. With the Sync Service.`
          : $localize`:@@vendor.pairRights.status.withAeci:Open. With AEC Integrations.`;
      case 'accepted':
        return $localize`:@@vendor.pairRights.status.accepted:Accepted.`;
      case 'declined':
        return $localize`:@@vendor.pairRights.status.declined:Declined. The listing stays as it is.`;
      default:
        return $localize`:@@vendor.pairRights.status.withdrawn:Withdrawn.`;
    }
  }

  protected protestText(r: PairContest): string {
    switch (r.protest?.status) {
      case 'open':
        return $localize`:@@vendor.pairRights.protest.open:With AEC Integrations for review.`;
      case 'upheld':
        return $localize`:@@vendor.pairRights.protest.upheld.v2:AEC Integrations agrees with the report. This is advice. The Sync Service decides the listing of that data flow.`;
      case 'rejected':
        return $localize`:@@vendor.pairRights.protest.rejected:AEC Integrations agrees with the Sync Service.`;
      default:
        return $localize`:@@vendor.pairRights.protest.withdrawn:The review was withdrawn.`;
    }
  }

  protected withdrawVeto(v: SyncServicePairVeto): Promise<void> {
    return this.write(async () => {
      const res = await this.api.withdrawVeto(v.id);
      this.announcer.announce(
        res.pair_public
          ? $localize`:@@vendor.pairRights.withdrawn.public:Removal withdrawn. The integration is back on the public site.`
          : $localize`:@@vendor.pairRights.withdrawn.hidden:Removal withdrawn. The integration stays off the site while another removal or a retire is in place.`,
      );
    });
  }

  protected withdrawReport(r: PairContest): Promise<void> {
    return this.write(async () => {
      await this.api.withdrawPairContest(r.id);
      this.announcer.announce($localize`:@@vendor.pairRights.report.withdrawn:Report withdrawn.`);
    });
  }

  protected protest(r: PairContest): Promise<void> {
    return this.write(async () => {
      await this.api.protestPairContest(
        r.id,
        $localize`:@@vendor.pairRights.protest.defaultReason:Please review the owner's answer on this data flow.`,
      );
      this.announcer.announce(
        $localize`:@@vendor.pairRights.protest.sent:Sent to AEC Integrations for review.`,
      );
    });
  }

  protected decide(r: PairContest, decision: 'accept' | 'decline'): Promise<void> {
    return this.write(async () => {
      await this.api.decidePairContest(r.id, { decision });
      this.announcer.announce(
        decision === 'accept'
          ? $localize`:@@vendor.pairRights.decided.accept:Accepted. The data flow is changed on the public page.`
          : $localize`:@@vendor.pairRights.decided.decline:Declined.`,
      );
    });
  }

  private async write(action: () => Promise<void>): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await action();
    } catch {
      this.error.set(
        $localize`:@@vendor.pairRights.err:That did not go through. It may have changed already. The list is reloaded.`,
      );
    } finally {
      this.busy.set(false);
      await this.load();
    }
  }

  private async load(): Promise<void> {
    try {
      const [vetoes, reports] = await Promise.all([
        this.api.listVetoes(),
        this.api.listPairContests(),
      ]);
      this.allVetoes.set(vetoes);
      this.allReports.set(reports);
      this.loaded.emit({ reports: reports.received, vetoes: vetoes.received });
    } catch {
      // A failed read leaves the section hidden. The rest of Messages still works.
    }
  }
}
