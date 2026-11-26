import { formatDate } from '@angular/common';
import {
  Component,
  ElementRef,
  Injector,
  LOCALE_ID,
  afterNextRender,
  computed,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import {
  BrnDialog,
  BrnDialogClose,
  BrnDialogContent,
  BrnDialogDescription,
  BrnDialogTitle,
} from '@spartan-ng/brain/dialog';

import {
  isHttpsUrl,
  type ContextDirection,
  type DataObjectOption,
  type OwnedFlow,
} from '@aeci/shared';
import { compareText } from '@aeci/shared/text-sort';

import { isReplayedEvent } from '../../core/event-replay';
import { AecButton } from '../../shared/button/button';
import { FIELD_LABEL_CLASS } from '../../shared/form-field/form-field-classes';
import { NewTabIcon } from '../../shared/new-tab-icon/new-tab-icon';
import { ownedFlowRowId } from '../integration-detail/integration-detail-model';
import {
  ALERT,
  FORM_PANEL,
  HELP,
  ID_STYLES,
  INPUT,
} from '../integration-detail/integration-detail-styles';
import { KeepClearOfSaveBar } from '../shared/keep-clear-of-save-bar';
import { CloseOnEscape } from '../shared/close-on-escape';
import {
  PORTAL_FORM_GRID_CLASS,
  PORTAL_NESTED_SAVE_BAR_CLASS,
  PORTAL_SAVE_BUTTON_CLASS,
} from '../shared/portal-form';
import { RowActionsMenu, type RowAction } from '../shared/row-actions-menu';
import { VendorApi } from '../vendor-api';
import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorPortalStore } from '../vendor-portal-store';

import { OwnedFlowHistoryDialog } from './owned-flow-history-dialog';
import { ownedDirectionText, type OwnedFlowsRow } from './vendor-owned-flows-direction';

export { ownedDirectionText, type OwnedFlowsRow } from './vendor-owned-flows-direction';

/** The directions in the order every direction picker lists them. */
const DIRECTIONS: readonly ContextDirection[] = ['outbound', 'both', 'inbound'];

/** The ids of a row's Actions menu items. */
type FlowAction = 'confirm' | 'change' | 'history' | 'remove';

/**
 * The data flows on a Sync Service pair the caller owns (AECI-2039,
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.15.3). Rendered inside the owned card under
 * "Integrations your company offers", and on the integration detail page.
 *
 * ── WHAT IT SHOWS (AECI-2213) ──────────────────────────────────────────────
 * One row per data type, and only what is true now. A flow the owner removed
 * (`answer = 'no'`) leaves the table; its events stay in the surviving row's history.
 * Two live directions of one data type (two AECi seeds) are two real rows, both shown.
 * The heading count counts shown rows.
 *
 * There are no Yes and No toggles. Adding a row confirms it (the API already did).
 * Each row has an Actions menu (`vendor/shared/row-actions-menu.ts`):
 *
 *   - **Confirm**, only while the owner has not answered;
 *   - **Change direction**, the inline picker, `PATCH /owned-flows/:claimId`;
 *   - **View history**, `owned-flow-history-dialog.ts`;
 *   - **Remove row**, after a dialog, `PUT …/answer { asserted: false }`.
 *
 * A row whose `flows_editable` is false (unclaimed or retired) offers View history
 * only. A removed flow comes back through Add a row: the form blocks a data type and
 * direction already shown, and a new direction of a data type already shown (that is
 * Change direction), but never a removed flow, even beside a surviving direction of
 * the same type. The API confirms the existing claim (`200`). The portal no longer
 * calls `DELETE …/answer`.
 *
 * AECI-2139: a flow AEC Integrations corrected on a public source (`aeci_correction`)
 * stays as a locked row, even under the owner's No: the cell says AECi removed it, with
 * the date, the reason and the source, and the row has no Actions menu. Add a row refuses
 * its identity. The API refuses every owner write on it (`409 FLOW_CORRECTED_BY_AECI`).
 *
 * The "On the public page" cell reads the server's `public` (AECI-2213, the pair
 * read's `isClaimPubliclyBacked`) and, for a public unanswered flow, mirrors the pair
 * page badge for its `agreement` (`products/agreement-badge.ts`).
 *
 * ── THE SAME-BEHAVIOR EXCEPTION ────────────────────────────────────────────
 * The endpoint vendor's "Data that's shared" (`integration-shared-data.ts`, §6.17.4)
 * keeps Yes and No, because there a No is a dispute sent with a reason. Here the owner
 * runs the integration, so it states what the integration moves. Ruling 4 on
 * AECI-2213 records the exception.
 *
 * AECI-2039: the integration detail page's "Data that's shared" renders this same
 * component for a row the caller owns and also makes an endpoint of, with
 * `labelledBy` set to its own heading. The component then drops its own heading, so
 * the section keeps one. The controls are the same in both places.
 *
 * The dialogs open from the menu's `picked` output, inside a click, never from an
 * `effect()` (NG0602).
 */
@Component({
  selector: 'aec-vendor-owned-flows',
  imports: [
    AecButton,
    BrnDialog,
    BrnDialogClose,
    BrnDialogContent,
    BrnDialogDescription,
    BrnDialogTitle,
    CloseOnEscape,
    KeepClearOfSaveBar,
    NewTabIcon,
    OwnedFlowHistoryDialog,
    RowActionsMenu,
  ],
  styles: [ID_STYLES],
  host: { class: 'block' },
  template: `
    @let r = row();
    <div class="mt-4" [attr.data-owned-flows]="r.id">
      <div class="flex flex-wrap items-center gap-3">
        @if (!labelledBy()) {
          <h4 class="m-0 text-base font-semibold text-(--text-primary)" [id]="headingId()">
            {{ heading() }}
          </h4>
        }
        @if (r.flows_editable) {
          <button
            #addToggle
            type="button"
            class="ms-auto"
            aecButton
            variant="secondary"
            compact
            [attr.aria-expanded]="adding()"
            [attr.aria-controls]="prefix() + '-add'"
            data-testid="owned-flow-add-toggle"
            (click)="toggleAdd()"
            i18n="@@vendor.ownedFlows.addToggle"
          >
            Add a row
          </button>
        }
      </div>
      <p [class]="help" class="max-w-prose">{{ intro() }}</p>

      <div [id]="prefix() + '-add'">
        @if (adding() && r.flows_editable) {
          <form
            aecKeepClearOfSaveBar
            aecCloseOnEscape
            [escapeBusy]="busy() !== null"
            (escapeCancel)="adding.set(false)"
            method="dialog"
            [class]="panel"
            class="mt-4 space-y-6 text-sm"
            [attr.aria-label]="addFormLabel"
            data-testid="owned-flow-add-form"
            (submit)="add($event)"
          >
            <div [class]="grid">
              <div>
                <label [for]="prefix() + '-add-data'" [class]="label" i18n="@@vendor.im.add.data"
                  >Data</label
                >
                <select
                  #addData
                  [id]="prefix() + '-add-data'"
                  [class]="input"
                  class="mt-2"
                  [attr.aria-describedby]="duplicate() ? prefix() + '-add-duplicate' : null"
                  [attr.aria-invalid]="duplicate() ? 'true' : null"
                  (change)="draftData.set(selectValue($event))"
                >
                  @for (option of dataOptions(); track option.slug) {
                    <option [value]="option.slug" [selected]="draftData() === option.slug">
                      {{ option.name }}
                    </option>
                  }
                </select>
                @if (duplicate(); as dup) {
                  <p
                    [id]="prefix() + '-add-duplicate'"
                    [class]="alert"
                    class="mt-2"
                    role="status"
                    data-testid="owned-flow-add-duplicate"
                  >
                    {{ duplicateText(dup) }}
                  </p>
                }
              </div>
              <div>
                <label
                  [for]="prefix() + '-add-dir'"
                  [class]="label"
                  i18n="@@vendor.im.add.direction"
                  >Direction</label
                >
                <select
                  [id]="prefix() + '-add-dir'"
                  [class]="input"
                  class="mt-2"
                  [attr.aria-describedby]="duplicate() ? prefix() + '-add-duplicate' : null"
                  (change)="draftDirection.set(asDirection($event))"
                >
                  @for (d of directions; track d) {
                    <option [value]="d" [selected]="draftDirection() === d">
                      {{ directionText(d) }}
                    </option>
                  }
                </select>
              </div>
            </div>
            @if (vocabularyFailed()) {
              <p [class]="alert" role="alert" i18n="@@vendor.im.add.vocabularyFailed">
                The list of data types could not be loaded, so a row cannot be added right now.
              </p>
            }
            <div [class]="saveBar">
              <button
                type="submit"
                aecButton
                [class]="saveButton"
                [disabled]="busy() !== null || dataOptions().length === 0"
                data-testid="owned-flow-add-submit"
              >
                <span i18n="@@vendor.im.add.submit">Add</span>
              </button>
              <button
                type="button"
                aecButton
                variant="secondary"
                [class]="saveButton"
                [disabled]="busy() !== null"
                (click)="adding.set(false)"
                i18n="@@vendor.im.add.cancel"
              >
                Cancel
              </button>
            </div>
          </form>
        }
      </div>

      @if (error()) {
        <p [class]="alert" class="mt-3" role="alert">{{ error() }}</p>
      }

      @if (shownFlows().length === 0) {
        <p class="mt-3 text-sm text-(--text-secondary)" i18n="@@vendor.im.data.empty">
          No data is listed as shared yet.
        </p>
      } @else {
        <div
          class="mt-3 overflow-x-auto focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
          tabindex="0"
          role="region"
          [attr.aria-labelledby]="labelledBy() ?? headingId()"
        >
          <table class="w-full min-w-[36rem] border-collapse text-sm">
            <caption class="sr-only">
              {{
                heading()
              }}
            </caption>
            <thead>
              <tr class="border-b border-(--border-default)">
                <th
                  scope="col"
                  class="py-2 pe-4 text-start font-semibold text-(--text-secondary)"
                  i18n="@@vendor.im.data.col.data"
                >
                  Data
                </th>
                <th
                  scope="col"
                  class="py-2 pe-4 text-start font-semibold text-(--text-secondary)"
                  i18n="@@vendor.ownedFlows.col.direction"
                >
                  Direction
                </th>
                <th
                  scope="col"
                  class="py-2 pe-4 text-start font-semibold text-(--text-secondary)"
                  i18n="@@vendor.ownedFlows.col.public"
                >
                  On the public page
                </th>
                <th
                  scope="col"
                  class="w-px py-2 text-end font-semibold text-(--text-secondary)"
                  i18n="@@vendor.ownedFlows.col.actions"
                >
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              @for (flow of shownFlows(); track flow.id) {
                <tr
                  class="border-b border-(--border-default)"
                  [attr.data-testid]="'owned-flow-' + flow.data_object_slug + '-' + flow.direction"
                >
                  <th
                    scope="row"
                    tabindex="-1"
                    [id]="rowId(flow.id)"
                    class="scroll-mt-24 py-2 pe-4 text-start font-semibold text-(--text-primary) focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                  >
                    {{ flow.data_object_name }}
                  </th>
                  <td class="py-2 pe-4 text-(--text-primary)">
                    @if (changing() === flow.id) {
                      <span
                        aecCloseOnEscape
                        (escapeCancel)="cancelChange(flow)"
                        class="inline-flex flex-wrap items-center gap-2"
                      >
                        <label class="sr-only" [for]="prefix() + '-dir-' + flow.id">{{
                          directionLabel(flow)
                        }}</label>
                        <select
                          [id]="prefix() + '-dir-' + flow.id"
                          [class]="input"
                          [attr.data-testid]="'owned-flow-direction-' + flow.id"
                          (change)="draftChange.set(asDirection($event))"
                        >
                          @for (d of directions; track d) {
                            <option
                              [value]="d"
                              [selected]="(draftChange() ?? flow.direction) === d"
                            >
                              {{ directionText(d) }}
                            </option>
                          }
                        </select>
                        <button
                          type="button"
                          aecButton
                          variant="ghost"
                          compact
                          [disabled]="busy() !== null"
                          [attr.data-testid]="'owned-flow-direction-save-' + flow.id"
                          (click)="saveDirection(flow)"
                          i18n="@@vendor.ownedFlows.saveDirection"
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          aecButton
                          variant="ghost"
                          compact
                          (click)="cancelChange(flow)"
                          i18n="@@vendor.im.add.cancel"
                        >
                          Cancel
                        </button>
                      </span>
                    } @else {
                      {{ directionText(flow.direction) }}
                    }
                  </td>
                  <td
                    class="py-2 pe-4 text-(--text-secondary)"
                    [attr.data-testid]="'owned-flow-public-' + flow.id"
                  >
                    @if (flow.aeci_correction; as correction) {
                      <!-- AECI-2139: AECi corrected this flow on a public source. The owner
                           reads why and where, and the row offers no actions. -->
                      <span class="block font-semibold text-(--text-primary)">{{
                        correctedLine(correction.created_at)
                      }}</span>
                      <span class="mt-1 block max-w-prose">{{
                        reasonLine(correction.reason)
                      }}</span>
                      @if (sourceHref(correction.source_url); as href) {
                        <a
                          [href]="href"
                          target="_blank"
                          rel="noopener nofollow"
                          [class]="sourceLink"
                          [attr.data-testid]="'owned-flow-source-' + flow.id"
                          ><span i18n="@@vendor.ownedFlows.corrected.source">Read the source</span
                          ><aec-new-tab-icon
                        /></a>
                      }
                    } @else {
                      {{ publicLine(flow) }}
                    }
                  </td>
                  <td class="py-1 text-end">
                    @if (flow.aeci_correction) {
                      <span
                        class="text-t-13 text-(--text-secondary)"
                        [attr.data-testid]="'owned-flow-locked-' + flow.id"
                        i18n="@@vendor.ownedFlows.corrected.noActions"
                        >No actions</span
                      >
                    } @else {
                      <aec-row-actions-menu
                        [label]="actionsLabel(flow)"
                        [actions]="actionsFor(flow)"
                        [testId]="'owned-flow-actions-' + flow.id"
                        (picked)="onPick(flow, $event)"
                      />
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
    </div>

    <aec-owned-flow-history-dialog [row]="r" />

    <brn-dialog [role]="'alertdialog'" [autoFocus]="'first-heading'" #removeDialog="brnDialog">
      <ng-template brnDialogContent>
        <div
          class="aec-dialog max-h-[85vh] w-[min(92vw,32rem)] overflow-y-auto p-6 text-start md:p-8"
          data-testid="owned-flow-remove-dialog"
        >
          <h2
            brnDialogTitle
            tabindex="-1"
            class="rounded-mark focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--accent-primary)"
          >
            {{ removeTitle() }}
          </h2>
          <p
            brnDialogDescription
            class="mt-2 text-sm leading-relaxed text-(--text-secondary)"
            i18n="@@vendor.ownedFlows.remove.body"
          >
            It leaves this table and the public page. You can add it again with Add a row.
          </p>
          @if (removeError(); as message) {
            <p [class]="alert" class="mt-4" role="alert" data-testid="owned-flow-remove-error">
              {{ message }}
            </p>
          }
          <div class="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <button
              aecButton
              variant="secondary"
              brnDialogClose
              type="button"
              [disabled]="busy() !== null"
              data-testid="owned-flow-remove-keep"
              i18n="@@vendor.ownedFlows.remove.keep"
            >
              Keep it
            </button>
            <button
              aecButton
              variant="danger"
              type="button"
              [disabled]="busy() !== null"
              [attr.aria-busy]="busy() !== null ? 'true' : null"
              data-testid="owned-flow-remove-submit"
              (click)="confirmRemove()"
              i18n="@@vendor.ownedFlows.remove.submit"
            >
              Yes, remove it
            </button>
          </div>
        </div>
      </ng-template>
    </brn-dialog>
  `,
})
export class VendorOwnedFlows {
  readonly row = input.required<OwnedFlowsRow>();
  /** The id of a heading outside the component that names this table. When set, the
   *  component renders no heading of its own (AECI-2039, the detail page). */
  readonly labelledBy = input<string | null>(null);

  private readonly api = inject(VendorApi);
  private readonly store = inject(VendorPortalStore);
  private readonly announcer = inject(VendorPortalAnnouncer);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  private readonly locale = inject(LOCALE_ID);

  /** By ref: `BrnPopover` extends `BrnDialog`, so a type query could find a menu. */
  private readonly removeDialog = viewChild<BrnDialog>('removeDialog');
  private readonly historyDialog = viewChild(OwnedFlowHistoryDialog);
  private readonly addToggle = viewChild<ElementRef<HTMLButtonElement>>('addToggle');
  private readonly addData = viewChild<ElementRef<HTMLSelectElement>>('addData');

  protected readonly directions = DIRECTIONS;
  protected readonly adding = signal(false);
  protected readonly changing = signal<string | null>(null);
  protected readonly draftChange = signal<ContextDirection | null>(null);
  protected readonly draftData = signal('');
  protected readonly draftDirection = signal<ContextDirection>('outbound');
  protected readonly busy = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);
  /** The flow the remove dialog asks about. */
  protected readonly removing = signal<OwnedFlow | null>(null);
  protected readonly removeError = signal<string | null>(null);
  private readonly dataObjects = signal<readonly DataObjectOption[]>([]);
  protected readonly vocabularyFailed = signal(false);

  /** The Label role (AECI-2083 portal recipe). */
  protected readonly label = FIELD_LABEL_CLASS;
  protected readonly help = HELP;
  protected readonly alert = ALERT;
  protected readonly input = INPUT;
  protected readonly panel = FORM_PANEL;
  protected readonly grid = PORTAL_FORM_GRID_CLASS;
  protected readonly saveBar = PORTAL_NESTED_SAVE_BAR_CLASS;
  protected readonly saveButton = PORTAL_SAVE_BUTTON_CLASS;
  /** The citation role (DESIGN.md, "The Link Treatment Rule"). */
  protected readonly sourceLink =
    'mt-1 inline-flex items-center gap-1 rounded-mark text-t-13 font-semibold text-(--text-secondary) underline decoration-(--border-strong) underline-offset-4 hover:text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';
  protected readonly addFormLabel = $localize`:@@vendor.ownedFlows.addForm:Add a row of data`;

  protected readonly prefix = computed(() => `owned-flows-${this.row().id}`);
  protected readonly headingId = computed(() => `${this.prefix()}-heading`);

  /**
   * What is true now: every flow the owner has not removed, and every flow AECi
   * corrected (AECI-2139). A corrected flow stays as a locked row, so the owner reads why.
   */
  protected readonly shownFlows = computed(() =>
    this.row().flows.filter((f) => f.answer !== 'no' || !!f.aeci_correction),
  );

  protected readonly heading = computed(() => {
    const n = this.shownFlows().length;
    return $localize`:@@vendor.im.data.heading:Data that's shared (${n}:count:)`;
  });

  protected readonly intro = computed(() => {
    const r = this.row();
    if (r.retired_at) {
      return $localize`:@@vendor.ownedFlows.intro.retired:This integration is retired. Restore it to change its data rows.`;
    }
    if (!r.claimed_at) {
      return $localize`:@@vendor.ownedFlows.intro.unclaimed:AEC Integrations listed these. Claim this integration to confirm, change or remove them. Until then AEC Integrations keeps them.`;
    }
    return $localize`:@@vendor.ownedFlows.intro.claimed.actions:Your company offers and runs this integration, so you confirm what it moves. Each row says what the public page shows. Add a row to list more data. Use a row's Actions to confirm, change or remove it.`;
  });

  /** The data type vocabulary, names A to Z. */
  protected readonly dataOptions = computed(() =>
    [...this.dataObjects()].sort((a, b) => compareText(a.name, b.name)),
  );

  /**
   * Why the add form will not send the picked data type and direction, or `null`.
   *
   * - `exact`: that data type is already shown in that direction.
   * - `other`: it is shown in another direction, and the picked flow is new. A new
   *   direction of a shown type is Change direction on its row, not a second row.
   *
   * A picked flow the owner removed (`answer = 'no'` on this row) is a restore, so it
   * sends even while another direction of the type is shown. The API's add route
   * confirms the existing claim (`200`).
   */
  protected readonly duplicate = computed<{ flow: OwnedFlow; exact: boolean } | null>(() => {
    const slug = this.draftData();
    if (!slug) return null;
    const direction = this.draftDirection();
    // AECI-2139: AECi corrected this flow. Adding it again would undo that, so the API
    // refuses it. Say so before the request.
    const corrected = this.row().flows.find(
      (f) => f.data_object_slug === slug && f.direction === direction && !!f.aeci_correction,
    );
    if (corrected) return { flow: corrected, exact: true };
    const shown = this.shownFlows().filter((f) => f.data_object_slug === slug);
    if (shown.length === 0) return null;
    const exact = shown.find((f) => f.direction === direction);
    if (exact) return { flow: exact, exact: true };
    const restore = this.row().flows.some(
      (f) => f.data_object_slug === slug && f.direction === direction && f.answer === 'no',
    );
    return restore ? null : { flow: shown[0]!, exact: false };
  });

  protected readonly removeTitle = computed(() => {
    const data = this.removing()?.data_object_name ?? '';
    return $localize`:@@vendor.ownedFlows.remove.title:Remove ${data}:data: from the public page?`;
  });

  /** The row's id, the target of "Things that need you" (AECI-2045). */
  protected rowId(flowId: string): string {
    return ownedFlowRowId(flowId);
  }

  protected directionText(direction: ContextDirection): string {
    return ownedDirectionText(this.row(), direction);
  }

  protected directionLabel(flow: OwnedFlow): string {
    const data = flow.data_object_name;
    return $localize`:@@vendor.ownedFlows.changeDirection:Change the direction of ${data}:data:`;
  }

  protected actionsLabel(flow: OwnedFlow): string {
    const data = flow.data_object_name;
    return $localize`:@@vendor.ownedFlows.actions:Actions for ${data}:data:`;
  }

  protected duplicateText(dup: { flow: OwnedFlow; exact: boolean }): string {
    const data = dup.flow.data_object_name;
    if (dup.flow.aeci_correction) {
      return $localize`:@@vendor.ownedFlows.add.corrected:AEC Integrations removed ${data}:data: in this direction. You cannot add it back.`;
    }
    return dup.exact
      ? $localize`:@@vendor.ownedFlows.add.duplicateExact:${data}:data: is already listed in this direction.`
      : $localize`:@@vendor.ownedFlows.add.duplicate:${data}:data: is already listed. Use Change direction on its row.`;
  }

  /** The menu of one row. A row the owner cannot edit offers its history only. */
  protected actionsFor(flow: OwnedFlow): readonly RowAction[] {
    const history: RowAction = {
      id: 'history',
      label: $localize`:@@vendor.ownedFlows.action.history:View history`,
    };
    if (!this.row().flows_editable) return [history];
    return [
      ...(flow.answer === null
        ? [{ id: 'confirm', label: $localize`:@@vendor.ownedFlows.action.confirm:Confirm` }]
        : []),
      {
        id: 'change',
        label: $localize`:@@vendor.ownedFlows.action.change:Change direction`,
      },
      history,
      {
        id: 'remove',
        label: $localize`:@@vendor.ownedFlows.action.remove:Remove row`,
        destructive: true,
      },
    ];
  }

  /**
   * What the public pair page shows for a shown row. A Yes is the owner's. Whether
   * the page shows an unanswered flow at all is the server's `public` (AECI-2213): a
   * vendor-made flow can be public on a live AECi attestation or an endpoint vendor's
   * Yes. A public unanswered flow reads what the pair page's badge reads for its
   * `agreement` (`products/agreement-badge.ts`). The single-source badge names the
   * vendor, which `OwnedFlow` does not carry, so the cell uses the badge's own
   * unattributed form. An older API sends `public: null`: the origin rule stands in.
   */
  protected publicLine(flow: OwnedFlow): string {
    if (flow.answer === 'yes') {
      return $localize`:@@vendor.ownedFlows.publicCell.confirmed:Confirmed by your company`;
    }
    const shown = flow.public ?? flow.origin !== 'vendor';
    if (!shown) {
      return $localize`:@@vendor.ownedFlows.publicCell.hidden:Not shown on the public page`;
    }
    switch (flow.agreement) {
      case 'confirmed':
        return $localize`:@@vendor.ownedFlows.publicCell.bothConfirmed:Confirmed by both companies`;
      case 'single_source':
        return $localize`:@@vendor.ownedFlows.publicCell.oneConfirmed:Confirmed by one company`;
      case 'conflict':
        return $localize`:@@vendor.ownedFlows.publicCell.conflict:Companies disagree`;
      case 'owner_confirmed':
        // Only the owner's Yes gives this state, handled above.
        return $localize`:@@vendor.ownedFlows.publicCell.confirmed:Confirmed by your company`;
      default:
        return $localize`:@@vendor.ownedFlows.publicCell.listed:Listed by AEC Integrations`;
    }
  }

  /** AECI-2139: the locked row's first line, dated in UTC like every public caption. */
  protected correctedLine(at: string): string {
    const parsed = new Date(at);
    const date = Number.isNaN(parsed.getTime())
      ? null
      : formatDate(parsed, 'MMMM d, y', this.locale, 'UTC');
    return date
      ? $localize`:@@vendor.ownedFlows.corrected.dated:AEC Integrations removed this data flow on ${date}:date:`
      : $localize`:@@vendor.ownedFlows.corrected:AEC Integrations removed this data flow`;
  }

  protected reasonLine(reason: string): string {
    return $localize`:@@vendor.ownedFlows.corrected.reason:Reason: ${reason}:reason:`;
  }

  /** https only. A stored value that is anything else renders no link. */
  protected sourceHref(url: string | null | undefined): string | null {
    return url && isHttpsUrl(url) ? url : null;
  }

  protected selectValue(event: Event): string {
    return (event.target as HTMLSelectElement).value;
  }

  protected asDirection(event: Event): ContextDirection {
    const value = (event.target as HTMLSelectElement).value;
    return (DIRECTIONS as readonly string[]).includes(value) ? (value as ContextDirection) : 'both';
  }

  protected toggleAdd(): void {
    this.adding.update((open) => !open);
    if (this.adding()) void this.loadVocabulary();
  }

  /** A menu item's click. The menu has focused its trigger and closed. */
  protected onPick(flow: OwnedFlow, picked: string): void {
    const action = picked as FlowAction;
    if (action === 'history') {
      this.historyDialog()?.open(flow.data_object_slug, flow.data_object_name);
      return;
    }
    if (this.busy() !== null) return;
    if (action === 'confirm') void this.confirm(flow);
    else if (action === 'change') this.startChange(flow);
    else if (action === 'remove') this.openRemove(flow);
  }

  private startChange(flow: OwnedFlow): void {
    this.draftChange.set(flow.direction);
    this.changing.set(flow.id);
    afterNextRender(() => this.focusTestId(`owned-flow-direction-${flow.id}`), {
      injector: this.injector,
    });
  }

  protected cancelChange(flow: OwnedFlow): void {
    this.changing.set(null);
    afterNextRender(() => this.focusMenuOf(flow.data_object_slug, flow.id), {
      injector: this.injector,
    });
  }

  private openRemove(flow: OwnedFlow): void {
    this.removing.set(flow);
    this.removeError.set(null);
    this.removeDialog()?.open();
  }

  private async confirm(flow: OwnedFlow): Promise<void> {
    await this.run(flow.id, () => this.api.setOwnerFlowAnswer(flow.id, true));
    if (this.error()) return;
    const data = flow.data_object_name;
    this.announcer.announce(
      $localize`:@@vendor.ownedFlows.live.confirmed:You confirmed ${data}:data:.`,
    );
  }

  /** "Yes, remove it": pessimistic. A failure stays in the dialog. */
  protected async confirmRemove(): Promise<void> {
    const flow = this.removing();
    if (!flow || this.busy() !== null) return;
    this.removeError.set(null);
    await this.run(flow.id, () => this.api.setOwnerFlowAnswer(flow.id, false));
    const failed = this.error();
    if (failed) {
      this.error.set(null);
      this.removeError.set(failed);
      return;
    }
    this.removeDialog()?.close();
    this.removing.set(null);
    const data = flow.data_object_name;
    this.announcer.announce(
      $localize`:@@vendor.ownedFlows.live.removed:You removed ${data}:data: from the public page.`,
    );
    // The row and its menu are gone. Focus lands on Add a row, the way it comes back.
    afterNextRender(() => this.addToggle()?.nativeElement.focus(), { injector: this.injector });
  }

  protected async saveDirection(flow: OwnedFlow): Promise<void> {
    const direction = this.draftChange() ?? flow.direction;
    await this.run(flow.id, () => this.api.changeOwnerFlow(flow.id, { direction }));
    if (this.error()) return;
    this.changing.set(null);
    const data = flow.data_object_name;
    this.announcer.announce(
      $localize`:@@vendor.ownedFlows.live.changed:The direction of ${data}:data: is changed.`,
    );
    // A new direction is a new flow with a new id: focus the data type's menu.
    afterNextRender(() => this.focusMenuOf(flow.data_object_slug, null), {
      injector: this.injector,
    });
  }

  private async loadVocabulary(): Promise<void> {
    if (this.dataObjects().length > 0) return;
    try {
      const res = await this.api.getDataObjects();
      this.dataObjects.set(res.data_objects);
      this.vocabularyFailed.set(res.data_objects.length === 0);
      if (!this.draftData() && this.dataOptions().length > 0) {
        this.draftData.set(this.dataOptions()[0].slug);
      }
    } catch {
      this.vocabularyFailed.set(true);
    }
  }

  protected async add(event: Event): Promise<void> {
    if (isReplayedEvent(event)) return;
    event.preventDefault();
    const data = this.draftData() || this.dataOptions()[0]?.slug;
    if (!data) return;
    // A shown flow, or a new direction of a shown data type, goes through its row. A
    // removed flow is a restore and sends (see `duplicate`).
    if (this.duplicate()) {
      this.addData()?.nativeElement.focus();
      return;
    }
    await this.run('add', () =>
      this.api.addOwnerFlow(this.row().id, {
        data_object: data,
        direction: this.draftDirection(),
      }),
    );
    if (!this.error()) {
      this.adding.set(false);
      this.announcer.announce(
        $localize`:@@vendor.ownedFlows.live.added:The row is added and confirmed.`,
      );
    }
  }

  /** Focus the Actions trigger of a flow: by id, else the data type's first shown row. */
  private focusMenuOf(slug: string, flowId: string | null): void {
    const target =
      (flowId ? this.shownFlows().find((f) => f.id === flowId) : undefined) ??
      this.shownFlows().find((f) => f.data_object_slug === slug);
    if (target) this.focusTestId(`owned-flow-actions-${target.id}-trigger`);
  }

  private focusTestId(testId: string): void {
    this.host.nativeElement.querySelector<HTMLElement>(`[data-testid="${testId}"]`)?.focus();
  }

  /** One write at a time, then a refetch of the owned rows. */
  private async run(key: string, write: () => Promise<unknown>): Promise<void> {
    if (this.busy() !== null) return;
    this.busy.set(key);
    this.error.set(null);
    try {
      await write();
      await this.store.revalidate(['integrations']);
    } catch (err) {
      const code = (err as { error?: { error?: { code?: unknown } } } | null)?.error?.error?.code;
      this.error.set(
        code === 'FLOW_CORRECTED_BY_AECI'
          ? $localize`:@@vendor.ownedFlows.error.corrected:AEC Integrations corrected this data flow on a public source, so it cannot be changed here. Contact AEC Integrations if the correction is wrong.`
          : $localize`:@@vendor.ownedFlows.error:That change could not be saved. Reload the page and try again.`,
      );
      // The list now shows the correction.
      if (code === 'FLOW_CORRECTED_BY_AECI') void this.store.revalidate(['integrations']);
    } finally {
      this.busy.set(null);
    }
  }
}
