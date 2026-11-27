import { DatePipe } from '@angular/common';
import { Component, LOCALE_ID, afterNextRender, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import {
  REMOVAL_END_REASONS,
  type AdminPairContest,
  type AdminVeto,
  type PairContest,
  type PairKeyRowWire,
  type PairRightPair,
  type RemovalEndReason,
  type VetoObjection,
} from '@aeci/shared';

import { AecButton } from '../../shared/button/button';
import { Chip, type ConsoleChipTone } from '../../shared/chip/chip';
import {
  objectionGroundLabel,
  removalEndReasonLabel,
  removalReasonText,
} from '../../vendor/components/removal-labels';
import {
  CHOICE_CARD_CLASS,
  CHOICE_INPUT_CLASS,
  FIELD_ERROR_CLASS,
  FIELD_HINT_CLASS,
  FIELD_INPUT_CLASS,
  FIELD_LABEL_CLASS,
} from '../../shared/form-field/form-field-classes';
import {
  CONSOLE_CAPTION_CLASS,
  CONSOLE_PANEL_CLASS,
  CONSOLE_TABLE,
} from '../console/console-table';
import { AdminDangerAction } from '../console/danger-action';
import { AdminDisclosureButton } from '../console/disclosure-button';
import { adminStatusTone } from '../console/status-tones';
import { QUEUE_DETAIL_GRID_CLASS, QUEUE_FORM_CLASS } from '../reviews/queue-classes';

import { AdminContestsApi } from './admin-contests-api';

type Form = {
  id: string;
  kind: 'accept' | 'decline' | 'lift' | 'upheld' | 'rejected' | 'objAccept' | 'objDecline';
} | null;

/**
 * Sync Service pair reports and endpoint vetoes on `/admin/contests` (AECI-2042,
 * `ADMIN_PANEL_SPEC.md` §5.12, `STAGE_2_VENDOR_PORTAL_SPEC.md` §11e).
 *
 * Four lists below the field contests, with the same one-decision-at-a-time,
 * pessimistic pattern:
 *
 * - **Reports AEC Integrations decides**: existence reports, and data flow reports on
 *   unclaimed pairs. Accept needs a note; an existence accept also needs a proof link,
 *   and on a vendor-held pair it retires the pair. Data flow reports on a claimed pair
 *   are the owner's and are listed read-only. Decline is the console's shared danger
 *   form (`aec-admin-danger-action`, AECI-2104), with an optional reason, as the field
 *   contests' Decline above.
 *   AECI-2170: an existence accept acts on the whole pair key. Its form previews what
 *   it does before Confirm: how many listings it retires and whose, and how many
 *   AEC Integrations holds, which are retracted in the review app instead.
 * - **To retract in the review app** (AECI-2170): accepted existence reports whose pair
 *   still has a live listing AEC Integrations holds, with the retract-by date (five
 *   business days) and an "Overdue" chip once it has passed. A pair drops off once the
 *   retraction lands.
 * - **Reviews of an owner's answer**: protests. Upheld or rejected, with a note. Advice
 *   only: nothing on the listing changes.
 * - **Removals in force**: endpoint vetoes, with "Reason the vendor gave" and the filed
 *   time. Not checked when sent (ruling 66). An open objection from the Sync Service shows
 *   its received date, its answer-by date (five business days, `objection_answer_due`), an
 *   "Answer overdue" chip once that has passed, its ground, explanation and link, with Accept (ends the removal, required note) and
 *   Decline (the removal stands, required note), both the shared danger form.
 *   "End this removal" is a hand-built queue form because it carries a radio group: a
 *   required end reason from the five of ruling 66 and a required note. A radio inside
 *   the danger form's projected facts would submit it on Enter (`danger-action.ts`).
 *
 * The forms that stay hand-built (Accept, and the two protest answers) use the console
 * queue's form recipe and the shared field classes (`QUEUE_FORM_CLASS`, `FIELD_*`).
 *
 * AECI-2191: each list is a console table (`CONSOLE_TABLE`), a region named by its
 * visually hidden caption, one `th scope="row"` per record. Reports, protests and
 * removals open a detail row with the record and its forms (`AdminDisclosureButton`).
 * An open objection sits in its removal's detail row as a flat panel, and its row's
 * Objection column carries the chip. The retractions have nothing to decide here, so
 * they are a plain table. An empty list is one line and no table.
 */
@Component({
  selector: 'aec-admin-pair-rights',
  imports: [AdminDangerAction, AdminDisclosureButton, AecButton, Chip, DatePipe, RouterLink],
  host: { class: 'block' },
  template: `
    <section class="mt-10 space-y-6" aria-labelledby="admin-pair-rights-heading">
      <h3 id="admin-pair-rights-heading" class="m-0">
        <span
          class="block font-display text-xl font-semibold text-(--text-primary)"
          i18n="@@admin.pairRights.heading"
          >Sync Service integrations</span
        >
      </h3>

      <!-- AECI-2191: each list is a console table (DESIGN.md "Claims, requests and row
           threads follow the same recipe"). A row with a decision opens a detail row that
           holds the record and its forms. -->
      <div class="space-y-3" data-admin-pair-reports>
        <h4 class="text-base font-semibold text-(--text-primary)" i18n="@@admin.pairRights.reports">
          Reports
        </h4>
        @if (reports().length === 0) {
          <p [class]="t.empty" i18n="@@admin.pairRights.reports.empty">No open reports.</p>
        } @else {
          <div
            [class]="t.region"
            role="region"
            tabindex="0"
            aria-labelledby="admin-pair-reports-caption"
          >
            <table [class]="t.table" class="min-w-[44rem]">
              <caption
                id="admin-pair-reports-caption"
                [class]="t.caption"
                i18n="@@admin.pairRights.reports"
              >
                Reports
              </caption>
              <thead>
                <tr>
                  <th scope="col" [class]="t.head">
                    <span class="sr-only" i18n="@@admin.contests.col.details">Details</span>
                  </th>
                  <th scope="col" [class]="t.head" i18n="@@admin.pairRights.col.report">Report</th>
                  <th scope="col" [class]="t.head">
                    <span i18n="@@admin.contests.meta.submitter">Filed by</span>
                  </th>
                  <th scope="col" [class]="t.head">
                    <span i18n="@@admin.contests.meta.submitted">Submitted</span>
                  </th>
                  <th scope="col" [class]="t.head">
                    <span i18n="@@admin.contests.filter.status.label">Status</span>
                  </th>
                </tr>
              </thead>
              @for (r of reports(); track r.id) {
                @let key = 'rpt-' + r.id;
                <tbody data-admin-pair-report>
                  <tr [class]="isRowOpen(key) ? t.rowOpen : t.row">
                    <td [class]="t.disclosure">
                      <aec-admin-disclosure-button
                        [expanded]="isRowOpen(key)"
                        [controls]="key + '-detail'"
                        [label]="reportRowLabel(r)"
                        (toggled)="toggleRow(key)"
                      />
                    </td>
                    <th scope="row" [id]="key + '-head'" [class]="t.rowHead">{{ title(r) }}</th>
                    <td [class]="t.cell">
                      @if (r.submitter_name) {
                        {{ r.submitter_name }}
                      } @else {
                        <span
                          class="text-(--text-secondary)"
                          i18n-aria-label="@@admin.pairRights.submitter.none"
                          aria-label="Not on file"
                          >&ndash;</span
                        >
                      }
                    </td>
                    <td [class]="t.nowrap">{{ r.created_at | date: 'mediumDate' }}</td>
                    <td [class]="t.cell">
                      @if (r.routed_to === 'owner') {
                        <aec-chip density="dense" [tone]="withOwnerTone"
                          ><span i18n="@@admin.contests.route.withOwner"
                            >With the owner</span
                          ></aec-chip
                        >
                      } @else {
                        <aec-chip density="dense" [tone]="openTone"
                          ><span i18n="@@admin.pairRights.status.open">Open</span></aec-chip
                        >
                      }
                    </td>
                  </tr>
                  <tr [id]="key + '-detail'" [class]="t.detailRow" [hidden]="!isRowOpen(key)">
                    <td [attr.colspan]="reportColumns" [class]="t.detailCell">
                      <div [class]="t.detailInner">
                        <div [class]="detailGridClass" class="text-t-14">
                          <div class="grid min-w-0 content-start gap-2">
                            <p
                              class="text-(--text-secondary)"
                              i18n="@@admin.pairRights.reports.from"
                            >
                              {{ r.submitter_name }} on {{ r.created_at | date: 'mediumDate' }}:
                              {{ r.reason }}
                            </p>
                            @if (r.routed_to === 'owner') {
                              <p
                                class="text-(--text-secondary)"
                                i18n="@@admin.pairRights.reports.owner"
                              >
                                With the owner, {{ r.owner_name }}. The owner decides.
                              </p>
                              <!-- AECI-2139: the report stays the owner's. AECi may still correct the
                                   flow on a public source, from the owner's vendor page. -->
                              @if (flowCorrectionLink(r); as link) {
                                <a
                                  class="mt-1 inline-block justify-self-start rounded-mark text-sm font-semibold text-(--text-primary) underline decoration-(--border-strong) underline-offset-4 hover:decoration-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                                  [routerLink]="link.path"
                                  [queryParams]="link.queryParams"
                                  data-testid="pair-report-correct-flow"
                                  i18n="@@admin.pairRights.reports.correctFlow"
                                  >Correct this data flow on a public source</a
                                >
                              }
                            }
                          </div>
                          @if (r.routed_to !== 'owner') {
                            <div class="grid min-w-0 content-start gap-3">
                              <div class="flex flex-wrap items-start gap-2">
                                <button
                                  type="button"
                                  aecButton
                                  variant="secondary"
                                  compact
                                  [attr.aria-expanded]="isOpen(r.id, 'accept')"
                                  [attr.aria-describedby]="key + '-head'"
                                  (click)="openForm(r.id, 'accept')"
                                  i18n="@@admin.pairRights.accept"
                                >
                                  Accept
                                </button>
                                <aec-admin-danger-action
                                  class="min-w-0 flex-1"
                                  [openerLabel]="declineCopy.opener"
                                  [confirmLabel]="declineCopy.confirm"
                                  [busyLabel]="declineCopy.busy"
                                  [reasonLabel]="declineCopy.label"
                                  [reasonRequired]="null"
                                  [maxLength]="noteMax"
                                  [busy]="busy() && isOpen(r.id, 'decline')"
                                  [error]="isOpen(r.id, 'decline') ? error() : null"
                                  [open]="isOpen(r.id, 'decline')"
                                  (openChange)="setOpen(r.id, 'decline', $event)"
                                  (confirmed)="decline(r, $event)"
                                />
                              </div>
                              @if (isOpen(r.id, 'accept')) {
                                <form
                                  method="dialog"
                                  [class]="formClass"
                                  (submit)="$event.preventDefault(); accept(r)"
                                  (keydown.escape)="closeForm()"
                                >
                                  @if (r.kind === 'existence') {
                                    @if (r.key_rows; as rows) {
                                      @let retire = toRetire(rows);
                                      @let retireCount = retire.length;
                                      @let retractCount = toRetract(rows).length;
                                      <div class="space-y-1 text-sm" data-admin-accept-preview>
                                        <p
                                          class="font-medium text-(--text-primary)"
                                          i18n="@@admin.pairRights.accept.retires"
                                        >
                                          {retireCount, plural,
                                            =0 {This retires no listings.}
                                            =1 {This retires 1 listing:}
                                            other {This retires {{ retireCount }} listings:}
                                          }
                                        </p>
                                        @if (retireCount > 0) {
                                          <ul
                                            class="m-0 list-disc space-y-0.5 ps-5 text-(--text-secondary)"
                                          >
                                            @for (k of retire; track k.id) {
                                              <li data-admin-accept-retire>
                                                {{ keyRowLabel(r, k) }}
                                              </li>
                                            }
                                          </ul>
                                        }
                                        @if (retractCount > 0) {
                                          <p
                                            class="text-(--text-secondary)"
                                            data-admin-accept-upstream
                                            i18n="@@admin.pairRights.accept.upstream"
                                          >
                                            {retractCount, plural,
                                              =1 {
                                                1 listing AEC Integrations holds. Retract it in the
                                                review app within five business days.
                                              }
                                              other {
                                                {{ retractCount }} listings AEC Integrations holds.
                                                Retract them in the review app within five business
                                                days.
                                              }
                                            }
                                          </p>
                                        }
                                      </div>
                                    } @else {
                                      <p
                                        [class]="hintClass"
                                        i18n="@@admin.pairRights.accept.existenceHelp.v2"
                                      >
                                        This retires every listing of this pair that a vendor holds.
                                        Retract the ones AEC Integrations holds in the review app.
                                      </p>
                                    }
                                  }
                                  <label
                                    [class]="labelClass"
                                    for="rpt-note-{{ r.id }}"
                                    i18n="@@admin.pairRights.note"
                                    >Note shown to the vendor</label
                                  >
                                  <textarea
                                    id="rpt-note-{{ r.id }}"
                                    rows="3"
                                    [attr.maxlength]="noteMax"
                                    [class]="inputClass"
                                    class="min-h-24 resize-y py-3"
                                    (input)="note.set(valueOf($event))"
                                  ></textarea>
                                  @if (r.kind === 'existence') {
                                    <label
                                      [class]="labelClass"
                                      class="pt-2"
                                      for="rpt-src-{{ r.id }}"
                                      i18n="@@admin.pairRights.source"
                                      >Proof link (required)</label
                                    >
                                    <input
                                      id="rpt-src-{{ r.id }}"
                                      type="url"
                                      inputmode="url"
                                      autocomplete="off"
                                      placeholder="https://"
                                      [class]="inputClass"
                                      (input)="source.set(valueOf($event))"
                                    />
                                  }
                                  @if (error()) {
                                    <p role="alert" [class]="errorClass">{{ error() }}</p>
                                  }
                                  <div class="mt-2 flex flex-wrap gap-3">
                                    <button
                                      type="submit"
                                      aecButton
                                      compact
                                      [disabled]="busy()"
                                      i18n="@@admin.pairRights.confirm"
                                    >
                                      Confirm
                                    </button>
                                    <button
                                      type="button"
                                      aecButton
                                      variant="ghost"
                                      compact
                                      [disabled]="busy()"
                                      (click)="closeForm()"
                                      i18n="@@admin.pairRights.cancel"
                                    >
                                      Cancel
                                    </button>
                                  </div>
                                </form>
                              }
                            </div>
                          }
                        </div>
                      </div>
                    </td>
                  </tr>
                </tbody>
              }
            </table>
          </div>
        }
      </div>

      <div class="space-y-3" data-admin-retractions>
        <h4
          class="text-base font-semibold text-(--text-primary)"
          i18n="@@admin.pairRights.retractions"
        >
          To retract in the review app
        </h4>
        <p [class]="captionClass" class="max-w-prose" i18n="@@admin.pairRights.retractions.explain">
          A confirmed not offered report retired the listings vendors hold. These listings AEC
          Integrations holds are still on the site. Retract each in the review app by the date
          shown.
        </p>
        @if (retractions().length === 0) {
          <p [class]="t.empty" i18n="@@admin.pairRights.retractions.empty">Nothing to retract.</p>
        } @else {
          <!-- Nothing to decide here, so a plain table: no disclosure, no detail row. -->
          <div
            [class]="t.region"
            role="region"
            tabindex="0"
            aria-labelledby="admin-pair-retractions-caption"
          >
            <table [class]="t.table" class="min-w-[44rem]">
              <caption
                id="admin-pair-retractions-caption"
                [class]="t.caption"
                i18n="@@admin.pairRights.retractions"
              >
                To retract in the review app
              </caption>
              <thead>
                <tr>
                  <th scope="col" [class]="t.head">
                    <span i18n="@@admin.contests.col.integration">Integration</span>
                  </th>
                  <th scope="col" [class]="t.head" i18n="@@admin.pairRights.col.dates">Dates</th>
                  <th scope="col" [class]="t.head" i18n="@@admin.pairRights.col.listings">
                    Listings to retract
                  </th>
                </tr>
              </thead>
              <tbody>
                @for (r of retractions(); track r.id) {
                  <tr [class]="t.row" data-admin-retraction>
                    <th scope="row" [class]="t.rowHead">{{ pairName(r.pair) }}</th>
                    <td [class]="t.cell">
                      @if (r.decided_at; as decided) {
                        <span class="block" i18n="@@admin.pairRights.retractions.accepted"
                          >Accepted {{ decided | date: 'mediumDate' }}</span
                        >
                      }
                      @if (r.retract_by; as due) {
                        <span class="block" i18n="@@admin.pairRights.retractions.due"
                          >Retract by {{ dueDay(due) }}</span
                        >
                      }
                      @if (retractOverdue(r)) {
                        <aec-chip
                          density="dense"
                          [tone]="overdueTone"
                          data-testid="retraction-overdue"
                          ><span i18n="@@admin.pairRights.retractions.overdue"
                            >Overdue</span
                          ></aec-chip
                        >
                      }
                    </td>
                    <td [class]="t.cell">
                      <ul class="m-0 list-none space-y-0.5 p-0">
                        @for (k of toRetract(r.key_rows ?? []); track k.id) {
                          <li data-admin-retraction-row>
                            {{ k.name ?? pairName(r.pair) }}:
                            <code class="text-t-13">{{ tableOf(k) }} {{ k.id }}</code>
                          </li>
                        }
                      </ul>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      </div>

      <div class="space-y-3" data-admin-pair-protests>
        <h4
          class="text-base font-semibold text-(--text-primary)"
          i18n="@@admin.pairRights.protests"
        >
          Reviews of an owner's answer
        </h4>
        @if (protests().length === 0) {
          <p [class]="t.empty" i18n="@@admin.pairRights.protests.empty">No open reviews.</p>
        } @else {
          <div
            [class]="t.region"
            role="region"
            tabindex="0"
            aria-labelledby="admin-pair-protests-caption"
          >
            <table [class]="t.table" class="min-w-[36rem]">
              <caption
                id="admin-pair-protests-caption"
                [class]="t.caption"
                i18n="@@admin.pairRights.protests"
              >
                Reviews of an owner's answer
              </caption>
              <thead>
                <tr>
                  <th scope="col" [class]="t.head">
                    <span class="sr-only" i18n="@@admin.contests.col.details">Details</span>
                  </th>
                  <th scope="col" [class]="t.head" i18n="@@admin.pairRights.col.report">Report</th>
                  <th scope="col" [class]="t.head">
                    <span i18n="@@admin.contests.meta.submitted">Submitted</span>
                  </th>
                </tr>
              </thead>
              @for (r of protests(); track r.id) {
                @let key = 'pp-' + r.id;
                <tbody data-admin-pair-protest>
                  <tr [class]="isRowOpen(key) ? t.rowOpen : t.row">
                    <td [class]="t.disclosure">
                      <aec-admin-disclosure-button
                        [expanded]="isRowOpen(key)"
                        [controls]="key + '-detail'"
                        [label]="protestRowLabel(r)"
                        (toggled)="toggleRow(key)"
                      />
                    </td>
                    <th scope="row" [id]="key + '-head'" [class]="t.rowHead">{{ title(r) }}</th>
                    <td [class]="t.nowrap">
                      @if (r.protest?.protested_at; as asked) {
                        {{ asked | date: 'mediumDate' }}
                      }
                    </td>
                  </tr>
                  <tr [id]="key + '-detail'" [class]="t.detailRow" [hidden]="!isRowOpen(key)">
                    <td [attr.colspan]="protestColumns" [class]="t.detailCell">
                      <div [class]="t.detailInner">
                        <div [class]="detailGridClass" class="text-t-14">
                          <div class="grid min-w-0 content-start gap-2">
                            <p class="text-(--text-secondary)">{{ r.protest?.reason }}</p>
                            <p
                              class="text-(--text-secondary)"
                              i18n="@@admin.pairRights.protests.advice"
                            >
                              Your answer is advice. It does not change the listing.
                            </p>
                          </div>
                          <div class="grid min-w-0 content-start gap-3">
                            <div class="flex flex-wrap gap-2">
                              <button
                                type="button"
                                aecButton
                                variant="secondary"
                                compact
                                [attr.aria-expanded]="isOpen(r.id, 'upheld')"
                                [attr.aria-describedby]="key + '-head'"
                                (click)="openForm(r.id, 'upheld')"
                                i18n="@@admin.pairRights.upheld"
                              >
                                Agree with the report
                              </button>
                              <button
                                type="button"
                                aecButton
                                variant="secondary"
                                compact
                                [attr.aria-expanded]="isOpen(r.id, 'rejected')"
                                [attr.aria-describedby]="key + '-head'"
                                (click)="openForm(r.id, 'rejected')"
                                i18n="@@admin.pairRights.rejected"
                              >
                                Agree with the owner
                              </button>
                            </div>
                            @if (form()?.id === r.id) {
                              <form
                                method="dialog"
                                [class]="formClass"
                                (submit)="$event.preventDefault(); decideProtest(r)"
                                (keydown.escape)="closeForm()"
                              >
                                <label
                                  [class]="labelClass"
                                  for="pp-note-{{ r.id }}"
                                  i18n="@@admin.pairRights.noteRequired"
                                  >Note shown to both vendors (required)</label
                                >
                                <textarea
                                  id="pp-note-{{ r.id }}"
                                  rows="3"
                                  [attr.maxlength]="noteMax"
                                  required
                                  [class]="inputClass"
                                  class="min-h-24 resize-y py-3"
                                  (input)="note.set(valueOf($event))"
                                ></textarea>
                                @if (error()) {
                                  <p role="alert" [class]="errorClass">{{ error() }}</p>
                                }
                                <div class="mt-2 flex flex-wrap gap-3">
                                  <button
                                    type="submit"
                                    aecButton
                                    compact
                                    [disabled]="busy()"
                                    i18n="@@admin.pairRights.confirm"
                                  >
                                    Confirm
                                  </button>
                                  <button
                                    type="button"
                                    aecButton
                                    variant="ghost"
                                    compact
                                    [disabled]="busy()"
                                    (click)="closeForm()"
                                    i18n="@@admin.pairRights.cancel"
                                  >
                                    Cancel
                                  </button>
                                </div>
                              </form>
                            }
                          </div>
                        </div>
                      </div>
                    </td>
                  </tr>
                </tbody>
              }
            </table>
          </div>
        }
      </div>

      <div class="space-y-3" data-admin-vetoes>
        <h4 class="text-base font-semibold text-(--text-primary)" i18n="@@admin.pairRights.vetoes">
          Removals in force
        </h4>
        <p [class]="captionClass" class="max-w-prose" i18n="@@admin.pairRights.vetoes.explain.v2">
          A vendor of an endpoint product removed these from its product. A removal takes effect
          when it is sent and is not checked first. End one only on one of the five grounds below.
          Decide nothing else, and not whether the vendor should support the integration.
        </p>
        @if (vetoes().length === 0) {
          <p [class]="t.empty" i18n="@@admin.pairRights.vetoes.empty">No removals in force.</p>
        } @else {
          <div
            [class]="t.region"
            role="region"
            tabindex="0"
            aria-labelledby="admin-pair-vetoes-caption"
          >
            <table [class]="t.table" class="min-w-[44rem]">
              <caption
                id="admin-pair-vetoes-caption"
                [class]="t.caption"
                i18n="@@admin.pairRights.vetoes"
              >
                Removals in force
              </caption>
              <thead>
                <tr>
                  <th scope="col" [class]="t.head">
                    <span class="sr-only" i18n="@@admin.contests.col.details">Details</span>
                  </th>
                  <th scope="col" [class]="t.head">
                    <span i18n="@@admin.contests.col.integration">Integration</span>
                  </th>
                  <th scope="col" [class]="t.head" i18n="@@admin.pairRights.col.removedBy">
                    Removed by
                  </th>
                  <th scope="col" [class]="t.head">
                    <span i18n="@@admin.contests.meta.submitted">Submitted</span>
                  </th>
                  <th scope="col" [class]="t.head" i18n="@@admin.pairRights.col.objection">
                    Objection
                  </th>
                </tr>
              </thead>
              @for (v of vetoes(); track v.id) {
                @let key = 'veto-' + v.id;
                <tbody data-admin-veto>
                  <tr [class]="isRowOpen(key) ? t.rowOpen : t.row">
                    <td [class]="t.disclosure">
                      <aec-admin-disclosure-button
                        [expanded]="isRowOpen(key)"
                        [controls]="key + '-detail'"
                        [label]="vetoRowLabel(v)"
                        (toggled)="toggleRow(key)"
                      />
                    </td>
                    <th scope="row" [id]="key + '-head'" [class]="t.rowHead">
                      {{ pairName(v.pair) }}
                    </th>
                    <td [class]="t.cell">{{ v.vendor_name }}</td>
                    <td [class]="t.nowrap">
                      {{ v.filed_at | date: 'mediumDate' }}
                      <span [class]="t.sub">{{ v.filed_at | date: 'shortTime' }}</span>
                    </td>
                    <td [class]="t.cell">
                      @if (answerOverdue(v)) {
                        <aec-chip
                          density="dense"
                          [tone]="overdueTone"
                          data-testid="objection-overdue"
                          ><span i18n="@@admin.pairRights.objection.overdue"
                            >Answer overdue</span
                          ></aec-chip
                        >
                      } @else if (v.objection?.status === 'open') {
                        <aec-chip density="dense" [tone]="openTone"
                          ><span i18n="@@admin.pairRights.status.open">Open</span></aec-chip
                        >
                      } @else {
                        <span
                          class="text-(--text-secondary)"
                          i18n-aria-label="@@admin.pairRights.objection.none"
                          aria-label="No open objection"
                          >&ndash;</span
                        >
                      }
                    </td>
                  </tr>
                  <tr [id]="key + '-detail'" [class]="t.detailRow" [hidden]="!isRowOpen(key)">
                    <td [attr.colspan]="vetoColumns" [class]="t.detailCell">
                      <div [class]="t.detailInner">
                        <div [class]="detailGridClass" class="text-t-14">
                          <div class="grid min-w-0 content-start gap-2">
                            <p
                              class="text-(--text-secondary)"
                              i18n="@@admin.pairRights.vetoes.by.v3"
                            >
                              Removed by {{ v.vendor_name }} on
                              {{ v.filed_at | date: 'mediumDate' }} at
                              {{ v.filed_at | date: 'shortTime' }}.
                            </p>
                            <p
                              class="text-(--text-secondary)"
                              i18n="@@admin.pairRights.vetoes.reasonGiven"
                            >
                              Reason the vendor gave: {{ reasonText(v) }}
                            </p>
                            @if (v.owner_name) {
                              <p
                                class="text-(--text-secondary)"
                                i18n="@@admin.pairRights.vetoes.owner"
                              >
                                Owner: {{ v.owner_name }}
                              </p>
                            }
                            @if (v.objection?.status !== 'open' && v.objection; as o) {
                              <p class="text-(--text-secondary)">{{ objectionOutcome(o) }}</p>
                            }
                          </div>
                          <div class="grid min-w-0 content-start gap-4">
                            @if (v.objection?.status === 'open' && v.objection; as o) {
                              <div [class]="panelClass" class="space-y-1" data-admin-objection>
                                <p
                                  class="font-semibold text-(--text-primary)"
                                  i18n="@@admin.pairRights.objection.title"
                                >
                                  Objection from {{ o.vendor_name }} on
                                  {{ o.created_at | date: 'mediumDate' }}
                                </p>
                                <p class="text-t-13 text-(--text-secondary)">
                                  <span class="block" i18n="@@admin.pairRights.objection.received"
                                    >Received {{ o.created_at | date: 'mediumDate' }}</span
                                  >
                                  @if (v.objection_answer_due; as due) {
                                    <span
                                      class="block"
                                      i18n="@@admin.pairRights.objection.answerDue"
                                      >Answer by {{ dueDay(due) }}</span
                                    >
                                  }
                                </p>
                                <p
                                  class="text-(--text-primary)"
                                  i18n="@@admin.pairRights.objection.ground"
                                >
                                  Ground: {{ groundLabel(o.ground) }}
                                </p>
                                <p class="text-(--text-secondary)">{{ o.explanation }}</p>
                                @if (o.source_url) {
                                  <p class="text-(--text-secondary)">
                                    <span i18n="@@admin.pairRights.objection.link"
                                      >Link given:</span
                                    >
                                    {{ ' ' }}
                                    <a
                                      class="underline"
                                      [href]="o.source_url"
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      >{{ o.source_url }}</a
                                    >
                                  </p>
                                }
                                <p [class]="hintClass" i18n="@@admin.pairRights.objection.help">
                                  Accept only when the ground holds. An account: check the seat and
                                  its grant in the vendor's record. Wrong product: compare the
                                  removal's product with the integration's two products. Plainly
                                  false: the vendor's own public page must show it supports the
                                  integration.
                                </p>
                                <div class="mt-2 flex flex-wrap items-start gap-2">
                                  <aec-admin-danger-action
                                    class="min-w-0"
                                    [openerLabel]="objAcceptCopy.opener"
                                    [confirmLabel]="objAcceptCopy.confirm"
                                    [busyLabel]="objAcceptCopy.busy"
                                    [reasonLabel]="objAcceptCopy.label"
                                    [reasonRequired]="objAcceptCopy.required"
                                    [warning]="objAcceptCopy.warning"
                                    [maxLength]="noteMax"
                                    [busy]="busy() && isOpen(o.id, 'objAccept')"
                                    [error]="isOpen(o.id, 'objAccept') ? error() : null"
                                    [open]="isOpen(o.id, 'objAccept')"
                                    (openChange)="setOpen(o.id, 'objAccept', $event)"
                                    (confirmed)="decideObjection(o.id, 'accept', $event)"
                                  />
                                  <aec-admin-danger-action
                                    class="min-w-0"
                                    [openerLabel]="objDeclineCopy.opener"
                                    [confirmLabel]="objDeclineCopy.confirm"
                                    [busyLabel]="objDeclineCopy.busy"
                                    [reasonLabel]="objDeclineCopy.label"
                                    [reasonRequired]="objDeclineCopy.required"
                                    [maxLength]="noteMax"
                                    [busy]="busy() && isOpen(o.id, 'objDecline')"
                                    [error]="isOpen(o.id, 'objDecline') ? error() : null"
                                    [open]="isOpen(o.id, 'objDecline')"
                                    (openChange)="setOpen(o.id, 'objDecline', $event)"
                                    (confirmed)="decideObjection(o.id, 'decline', $event)"
                                  />
                                </div>
                              </div>
                            }
                            <div>
                              <button
                                type="button"
                                aecButton
                                variant="secondary"
                                compact
                                [attr.aria-expanded]="isOpen(v.id, 'lift')"
                                [attr.aria-controls]="'lift-form-' + v.id"
                                [attr.aria-describedby]="key + '-head'"
                                (click)="
                                  isOpen(v.id, 'lift') ? closeForm() : openForm(v.id, 'lift')
                                "
                                i18n="@@admin.pairRights.lift"
                              >
                                End this removal
                              </button>
                              @if (isOpen(v.id, 'lift')) {
                                <form
                                  [id]="'lift-form-' + v.id"
                                  method="dialog"
                                  novalidate
                                  [class]="formClass"
                                  class="mt-3"
                                  (submit)="$event.preventDefault(); lift(v)"
                                  (keydown.escape)="closeForm()"
                                >
                                  <fieldset class="m-0 max-w-2xl space-y-2 border-0 p-0">
                                    <legend
                                      [class]="labelClass"
                                      i18n="@@admin.pairRights.lift.endReason"
                                    >
                                      Why it ends (required)
                                    </legend>
                                    @for (r of endReasons; track r) {
                                      <label [class]="choiceCardClass">
                                        <input
                                          type="radio"
                                          [class]="choiceInputClass"
                                          [attr.name]="'end-reason-' + v.id"
                                          [value]="r"
                                          [checked]="endReason() === r"
                                          (change)="endReason.set(r)"
                                        />
                                        {{ endReasonLabel(r) }}
                                      </label>
                                    }
                                  </fieldset>
                                  <label
                                    [class]="labelClass"
                                    class="pt-2"
                                    [for]="'lift-note-' + v.id"
                                    i18n="@@admin.pairRights.noteLift"
                                    >Why it ends, shown to the vendors (required)</label
                                  >
                                  <textarea
                                    [id]="'lift-note-' + v.id"
                                    rows="3"
                                    [attr.maxlength]="noteMax"
                                    required
                                    [class]="inputClass"
                                    class="min-h-24 resize-y py-3"
                                    (input)="note.set(valueOf($event))"
                                  ></textarea>
                                  @if (error()) {
                                    <p role="alert" [class]="errorClass">{{ error() }}</p>
                                  }
                                  <div class="mt-2 flex flex-wrap gap-3">
                                    <button
                                      type="submit"
                                      aecButton
                                      variant="danger"
                                      compact
                                      [disabled]="busy()"
                                      i18n="@@admin.pairRights.lift.confirm"
                                    >
                                      End the removal
                                    </button>
                                    <button
                                      type="button"
                                      aecButton
                                      variant="ghost"
                                      compact
                                      [disabled]="busy()"
                                      (click)="closeForm()"
                                      i18n="@@admin.pairRights.cancel"
                                    >
                                      Cancel
                                    </button>
                                  </div>
                                </form>
                              }
                            </div>
                          </div>
                        </div>
                      </div>
                    </td>
                  </tr>
                </tbody>
              }
            </table>
          </div>
        }
      </div>

      @if (error() && !form()) {
        <p role="alert" class="text-sm font-medium text-(--text-primary)">{{ error() }}</p>
      }
      <p class="sr-only" role="status">{{ status() }}</p>
    </section>
  `,
})
export class AdminPairRights {
  private readonly api = inject(AdminContestsApi);
  private readonly locale = inject(LOCALE_ID);

  /** An objection past its five business days is a missed policy clock: critical. */
  protected readonly overdueTone: ConsoleChipTone = adminStatusTone('overdue');
  /** A report AEC Integrations decides, or an objection not yet answered: waits on us. */
  protected readonly openTone: ConsoleChipTone = adminStatusTone('open');
  /** A data flow report on a claimed pair: the owner decides. */
  protected readonly withOwnerTone: ConsoleChipTone = adminStatusTone('withTheOwner');

  /** The console table recipe (AECI-2191) and its flat panel. */
  protected readonly t = CONSOLE_TABLE;
  protected readonly panelClass = CONSOLE_PANEL_CLASS;
  protected readonly captionClass = CONSOLE_CAPTION_CLASS;
  protected readonly detailGridClass = QUEUE_DETAIL_GRID_CLASS;
  /** Column counts, for each detail row's `colspan`. */
  protected readonly reportColumns = 5;
  protected readonly protestColumns = 3;
  protected readonly vetoColumns = 5;
  /** Keys (`rpt-`, `pp-` or `veto-` and the id) of the rows whose detail is open. */
  private readonly openRows = signal<ReadonlySet<string>>(new Set());
  /** The instant the lists were read, for the overdue marker. Set on each load. */
  protected readonly readAt = signal(0);

  protected readonly reports = signal<readonly AdminPairContest[]>([]);
  protected readonly protests = signal<readonly AdminPairContest[]>([]);
  /** AECI-2170: accepted existence reports with an AECi-held listing still live. */
  protected readonly retractions = signal<readonly AdminPairContest[]>([]);
  protected readonly vetoes = signal<readonly AdminVeto[]>([]);
  protected readonly form = signal<Form>(null);
  protected readonly note = signal('');
  protected readonly source = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly status = signal('');

  /** The Label role (AECI-2083 admin recipe) and the shared field recipe. */
  protected readonly labelClass = FIELD_LABEL_CLASS;
  protected readonly inputClass = FIELD_INPUT_CLASS;
  protected readonly hintClass = FIELD_HINT_CLASS;
  protected readonly errorClass = FIELD_ERROR_CLASS;
  /** The console queue's decision form (`reviews/queue-classes.ts`). */
  protected readonly formClass = QUEUE_FORM_CLASS;
  /** Every note the API takes here is capped at 1000 characters. */
  protected readonly noteMax = 1000;

  /** Decline's words (the shared danger form, as on the field contests). */
  protected readonly declineCopy = {
    opener: $localize`:@@admin.pairRights.decline:Decline`,
    label: $localize`:@@admin.pairRights.decline.label:Note shown to the vendor (optional)`,
    confirm: $localize`:@@admin.pairRights.decline.confirm:Confirm decline`,
    busy: $localize`:@@admin.pairRights.declining:Declining…`,
  } as const;

  // ── AECI-2192 (ruling 66): end reasons and objections ─────────────────────

  protected readonly endReasons = REMOVAL_END_REASONS;
  protected readonly endReason = signal<RemovalEndReason | null>(null);
  protected readonly endReasonLabel = removalEndReasonLabel;
  protected readonly groundLabel = objectionGroundLabel;
  protected readonly reasonText = removalReasonText;
  protected readonly choiceCardClass = CHOICE_CARD_CLASS;
  protected readonly choiceInputClass = CHOICE_INPUT_CLASS;

  /** Accept an objection: the shared danger form with a required note. */
  protected readonly objAcceptCopy = {
    opener: $localize`:@@admin.pairRights.objection.accept:Accept and end the removal`,
    label: $localize`:@@admin.pairRights.objection.acceptLabel:Why the ground holds, shown to both vendors (required)`,
    required: $localize`:@@admin.pairRights.err.noteRequired:A note is required.`,
    warning: $localize`:@@admin.pairRights.objection.acceptWarning:This ends the removal now. Every listing of this integration returns to the public site, and both vendors are told why.`,
    confirm: $localize`:@@admin.pairRights.objection.acceptConfirm:End the removal`,
    busy: $localize`:@@admin.pairRights.lifting:Ending…`,
  } as const;

  /** Decline an objection: the removal stands. */
  protected readonly objDeclineCopy = {
    opener: $localize`:@@admin.pairRights.objection.decline:Decline`,
    label: $localize`:@@admin.pairRights.objection.declineLabel:Why the ground does not hold, shown to the Sync Service (required)`,
    required: $localize`:@@admin.pairRights.err.noteRequired:A note is required.`,
    confirm: $localize`:@@admin.pairRights.objection.declineConfirm:Confirm decline`,
    busy: $localize`:@@admin.pairRights.declining:Declining…`,
  } as const;

  protected objectionOutcome(o: VetoObjection): string {
    const ground = objectionGroundLabel(o.ground);
    return o.status === 'declined'
      ? $localize`:@@admin.pairRights.objection.wasDeclined:An objection was declined (${ground}:ground:): ${o.decision_note ?? ''}:note:`
      : $localize`:@@admin.pairRights.objection.wasClosed:An earlier objection (${ground}:ground:) is closed.`;
  }

  protected decideObjection(
    id: string,
    decision: 'accept' | 'decline',
    note: string,
  ): Promise<void> {
    return this.write(async () => {
      await this.api.decideVetoObjection(id, { decision, note });
      this.status.set(
        decision === 'accept'
          ? $localize`:@@admin.pairRights.objection.accepted:Objection accepted. The removal ended and the integration is back on the site.`
          : $localize`:@@admin.pairRights.objection.declined:Objection declined. The removal stands.`,
      );
    });
  }

  constructor() {
    afterNextRender(() => void this.load());
  }

  /** A form control's value, from its event. */
  protected valueOf(event: Event): string {
    return (event.target as HTMLInputElement | HTMLTextAreaElement).value;
  }

  protected pairName(pair: PairRightPair): string {
    const a = pair.product_a?.name ?? '';
    const b = pair.product_b?.name ?? '';
    const via = pair.connector?.name ?? '';
    return (
      pair.name ?? $localize`:@@admin.pairRights.pairName:${a}:a: and ${b}:b: through ${via}:via:`
    );
  }

  /**
   * AECI-2139: an owner-routed data flow report links to the flow correction form on
   * the owner's vendor page, with the row and the flow chosen. `null` when the report
   * names no flow, row or owner.
   */
  protected flowCorrectionLink(
    r: PairContest,
  ): { path: readonly string[]; queryParams: Record<string, string> } | null {
    if (r.kind !== 'data_flow' || r.routed_to !== 'owner') return null;
    const row = r.pair.integration_id;
    const anchor = r.pair.anchor;
    if (!r.flow || !row || !anchor || !r.owner_vendor_id) return null;
    return {
      path: ['/admin/vendors', r.owner_vendor_id],
      queryParams: { flowRow: row, flowAnchor: anchor, flowClaim: r.flow.claim_id },
    };
  }

  protected title(r: PairContest): string {
    const pair = this.pairName(r.pair);
    return r.kind === 'existence'
      ? $localize`:@@admin.pairRights.title.existence:Not offered: ${pair}:pair:`
      : $localize`:@@admin.pairRights.title.flow:Data flow ${r.flow?.data_object_name ?? ''}:flow: on ${pair}:pair:`;
  }

  // ── AECI-2170: an existence accept acts on every listing of the pair ─────

  /** The listings an accept retires now: held by a vendor, and live. */
  protected toRetire(rows: readonly PairKeyRowWire[]): PairKeyRowWire[] {
    return rows.filter((k) => k.held === 'vendor' && !k.retired);
  }

  /** The listings left to retract in the review app: held by AECi, and live. */
  protected toRetract(rows: readonly PairKeyRowWire[]): PairKeyRowWire[] {
    return rows.filter((k) => k.held === 'aeci' && !k.retired);
  }

  /** One listing an accept retires, named with its owner. */
  protected keyRowLabel(r: AdminPairContest, k: PairKeyRowWire): string {
    const name = k.name ?? this.pairName(r.pair);
    return k.owner_name
      ? $localize`:@@admin.pairRights.accept.retireRow:${name}:name:, held by ${k.owner_name}:owner:`
      : $localize`:@@admin.pairRights.accept.retireRowNoOwner:${name}:name:, no owner on file`;
  }

  /** The table the review app looks the listing up in. A table name, not copy. */
  protected tableOf(k: PairKeyRowWire): string {
    return k.anchor === 'evidenced_pair' ? 'connector_evidenced_pairs' : 'integrations';
  }

  /** An accepted report whose retract-by instant has fully passed. */
  protected retractOverdue(r: AdminPairContest): boolean {
    if (!r.retract_by) return false;
    const due = Date.parse(r.retract_by);
    return !Number.isNaN(due) && due < this.readAt();
  }

  protected isRowOpen(key: string): boolean {
    return this.openRows().has(key);
  }

  protected toggleRow(key: string): void {
    this.openRows.update((keys) => {
      const next = new Set(keys);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  /** A row's disclosure name, true open or closed: `aria-expanded` carries the state. */
  protected reportRowLabel(r: PairContest): string {
    const report = this.title(r);
    const vendor = r.submitter_name;
    return vendor
      ? $localize`:@@admin.pairRights.row.report:${report}:report:, filed by ${vendor}:vendor:`
      : report;
  }

  protected protestRowLabel(r: PairContest): string {
    const report = this.title(r);
    return $localize`:@@admin.pairRights.row.protest:Review of the owner's answer to ${report}:report:`;
  }

  protected vetoRowLabel(v: AdminVeto): string {
    const pair = this.pairName(v.pair);
    return $localize`:@@admin.pairRights.row.veto:Removal of ${pair}:pair: by ${v.vendor_name}:vendor:`;
  }

  protected openForm(id: string, kind: NonNullable<Form>['kind']): void {
    if (this.busy()) return;
    this.note.set('');
    this.source.set('');
    this.endReason.set(null);
    this.error.set(null);
    this.form.set({ id, kind });
  }

  protected closeForm(): void {
    if (this.busy()) return;
    this.error.set(null);
    this.form.set(null);
  }

  protected isOpen(id: string, kind: NonNullable<Form>['kind']): boolean {
    const f = this.form();
    return f?.id === id && f.kind === kind;
  }

  /** The danger form's two-way `open`. */
  protected setOpen(id: string, kind: NonNullable<Form>['kind'], open: boolean): void {
    if (open) this.openForm(id, kind);
    else if (this.isOpen(id, kind)) this.closeForm();
  }

  protected accept(r: PairContest): Promise<void> {
    const note = this.note().trim();
    if (!note) {
      this.error.set($localize`:@@admin.pairRights.err.note:A note is required to accept.`);
      return Promise.resolve();
    }
    return this.write(async () => {
      const res = await this.api.decidePairContest(r.id, {
        decision: 'accept',
        note,
        ...(this.source().trim() ? { source_url: this.source().trim() } : {}),
      });
      this.status.set(this.acceptedStatus(res.contest));
    });
  }

  /** What an accept did, read back from the report after the write (AECI-2170). */
  private acceptedStatus(contest: AdminPairContest): string {
    const rows = contest.key_rows;
    if (contest.kind !== 'existence' || !rows) {
      return $localize`:@@admin.pairRights.done:Decided.`;
    }
    const left = this.toRetract(rows);
    if (left.length === 0) {
      return $localize`:@@admin.pairRights.accepted.noneLeft:Accepted. Every listing of this pair is off the site.`;
    }
    const names = left.map((k) => `${this.tableOf(k)} ${k.id}`).join(', ');
    const due = contest.retract_by ? this.dueDay(contest.retract_by) : '';
    return $localize`:@@admin.pairRights.accepted.retract:Accepted. Retract in the review app by ${due}:due:. Listings: ${names}:rows:`;
  }

  protected decline(r: PairContest, reason: string): Promise<void> {
    return this.write(async () => {
      await this.api.decidePairContest(r.id, {
        decision: 'decline',
        ...(reason ? { note: reason } : {}),
      });
      this.status.set($localize`:@@admin.pairRights.done:Decided.`);
    });
  }

  protected decideProtest(r: PairContest): Promise<void> {
    const decision = this.form()?.kind === 'upheld' ? 'upheld' : 'rejected';
    const note = this.note().trim();
    if (!note) {
      this.error.set($localize`:@@admin.pairRights.err.noteRequired:A note is required.`);
      return Promise.resolve();
    }
    return this.write(async () => {
      await this.api.decidePairProtest(r.id, { decision, note });
      this.status.set($localize`:@@admin.pairRights.done:Decided.`);
    });
  }

  protected lift(v: AdminVeto): Promise<void> {
    const endReason = this.endReason();
    const note = this.note().trim();
    if (!endReason) {
      this.error.set($localize`:@@admin.pairRights.err.endReason:Choose why the removal ends.`);
      return Promise.resolve();
    }
    if (!note) {
      this.error.set($localize`:@@admin.pairRights.err.noteRequired:A note is required.`);
      return Promise.resolve();
    }
    return this.write(async () => {
      const res = await this.api.liftVeto(v.id, endReason, note);
      this.status.set(
        res.pair_public
          ? $localize`:@@admin.pairRights.lifted.public:Removal ended. The integration is back on the site.`
          : $localize`:@@admin.pairRights.lifted.hidden:Removal ended. Another removal or a retire still keeps it off the site.`,
      );
    });
  }

  private async write(action: () => Promise<void>): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await action();
      this.form.set(null);
    } catch (e) {
      const field = (e as { error?: { error?: { field?: string } } }).error?.error?.field;
      this.error.set(
        field === 'sourceUrl'
          ? $localize`:@@admin.pairRights.err.source:Add an https proof link to accept.`
          : $localize`:@@admin.pairRights.err.generic:Not saved. It may have changed. The lists are reloaded.`,
      );
    } finally {
      this.busy.set(false);
      await this.load();
    }
  }

  /** An open objection whose answer window has fully passed. */
  protected answerOverdue(v: AdminVeto): boolean {
    if (v.objection?.status !== 'open' || !v.objection_answer_due) return false;
    const due = Date.parse(v.objection_answer_due);
    return !Number.isNaN(due) && due < this.readAt();
  }

  /**
   * The last business day of the answer window, as a date. The server's due instant is
   * the moment the window has fully passed (`businessWindowEnd`), so the day shown is the
   * New York date just before it, as on the value hides.
   */
  protected dueDay(iso: string): string {
    const at = Date.parse(iso);
    if (Number.isNaN(at)) return iso;
    return new Intl.DateTimeFormat(this.locale, {
      dateStyle: 'medium',
      timeZone: 'America/New_York',
    }).format(new Date(at - 1));
  }

  private async load(): Promise<void> {
    try {
      const [reports, protests, retractions, vetoes] = await Promise.all([
        this.api.listPairContests(),
        this.api.listPairContests({ protests: true }),
        this.api.listPairContests({ retractions: true }),
        this.api.listVetoes(),
      ]);
      this.reports.set(reports.data);
      this.protests.set(protests.data);
      this.retractions.set(retractions.data);
      this.vetoes.set(vetoes.data);
      this.readAt.set(Date.now());
    } catch {
      this.error.set(
        $localize`:@@admin.pairRights.err.load:Could not load the Sync Service lists.`,
      );
    }
  }
}
