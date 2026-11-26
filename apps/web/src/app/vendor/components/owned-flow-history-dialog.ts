import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import {
  BrnDialog,
  BrnDialogClose,
  BrnDialogContent,
  BrnDialogTitle,
} from '@spartan-ng/brain/dialog';

import type {
  ContextDirection,
  OwnerFlowHistory,
  OwnerFlowHistoryActor,
  OwnerFlowHistoryEvent,
} from '@aeci/shared';

import { AecButton } from '../../shared/button/button';
import { AecIcon } from '../../shared/icon/icon';
import { VendorApi } from '../vendor-api';

import { ownedDirectionText, type OwnedFlowsRow } from './vendor-owned-flows-direction';

/**
 * "History of {data}" on the owner's data flows table (AECI-2213,
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.15.3): one data type's events on one owned row,
 * newest first, from `GET …/flows/history`. The actor is a company, never a person.
 *
 * `open()` runs from the row menu's `picked` output, inside a click, never from an
 * `effect()` (NG0602). The dialog opens at once on its title and fills when the read
 * answers, so a slow read shows "Loading" rather than nothing.
 */
@Component({
  selector: 'aec-owned-flow-history-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AecButton,
    AecIcon,
    BrnDialog,
    BrnDialogClose,
    BrnDialogContent,
    BrnDialogTitle,
    DatePipe,
  ],
  template: `
    <brn-dialog [role]="'alertdialog'" [autoFocus]="'first-heading'" #historyDialog="brnDialog">
      <ng-template brnDialogContent>
        <div
          class="aec-dialog max-h-[85vh] w-[min(92vw,40rem)] overflow-y-auto p-6 text-start md:p-8"
          data-testid="owned-flow-history"
        >
          <div class="flex items-start justify-between gap-4">
            <h2
              brnDialogTitle
              tabindex="-1"
              class="rounded-mark focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--accent-primary)"
            >
              {{ title() }}
            </h2>
            <button
              aecButton
              variant="ghost"
              iconOnly
              brnDialogClose
              type="button"
              [class]="'-me-2 -mt-2'"
              i18n-aria-label="@@vendor.ownedFlows.history.close"
              aria-label="Close"
            >
              <aec-icon name="x" decorative />
            </button>
          </div>

          @if (failed()) {
            <p
              role="alert"
              class="mt-4 text-sm text-(--status-error)"
              data-testid="owned-flow-history-error"
              i18n="@@vendor.ownedFlows.history.error"
            >
              The history could not be loaded. Close this and try again.
            </p>
          } @else if (history(); as h) {
            @if (h.events.length === 0) {
              <p
                class="mt-4 text-sm text-(--text-secondary)"
                i18n="@@vendor.ownedFlows.history.empty"
              >
                Nothing has happened to this data yet.
              </p>
            } @else {
              <table class="mt-4 w-full border-collapse text-sm">
                <caption class="sr-only">
                  {{
                    title()
                  }}
                </caption>
                <thead>
                  <tr class="border-b border-(--border-default)">
                    <th
                      scope="col"
                      class="py-2 pe-4 text-start font-semibold text-(--text-secondary)"
                      i18n="@@vendor.ownedFlows.history.col.date"
                    >
                      Date
                    </th>
                    <th
                      scope="col"
                      class="py-2 pe-4 text-start font-semibold text-(--text-secondary)"
                      i18n="@@vendor.ownedFlows.history.col.event"
                    >
                      What happened
                    </th>
                    <th
                      scope="col"
                      class="py-2 text-start font-semibold text-(--text-secondary)"
                      i18n="@@vendor.ownedFlows.history.col.direction"
                    >
                      Direction
                    </th>
                  </tr>
                </thead>
                <tbody>
                  @for (event of h.events; track $index) {
                    <tr
                      class="border-b border-(--border-default) align-top"
                      [attr.data-testid]="'owned-flow-history-' + event.kind"
                    >
                      <td class="py-2 pe-4 whitespace-nowrap text-(--text-secondary)">
                        <time [attr.datetime]="event.at">{{ event.at | date: 'mediumDate' }}</time>
                      </td>
                      <td class="py-2 pe-4 text-(--text-primary)">{{ eventText(event) }}</td>
                      <td class="py-2 text-(--text-primary)">
                        {{ directionText(event.direction) }}
                        @if (event.previous_direction; as before) {
                          <span class="mt-1 block text-xs text-(--text-secondary)">
                            {{ beforeText(before) }}
                          </span>
                        }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            }
          } @else {
            <p
              class="mt-4 text-sm text-(--text-secondary)"
              aria-live="polite"
              i18n="@@vendor.ownedFlows.history.loading"
            >
              Loading the history…
            </p>
          }
        </div>
      </ng-template>
    </brn-dialog>
  `,
})
export class OwnedFlowHistoryDialog {
  /** The owned row: its id for the read, its endpoints for the direction text. */
  readonly row = input.required<OwnedFlowsRow>();

  private readonly api = inject(VendorApi);
  private readonly dialog = viewChild<BrnDialog>('historyDialog');

  protected readonly dataName = signal('');
  protected readonly history = signal<OwnerFlowHistory | null>(null);
  protected readonly failed = signal(false);
  /** The read in flight, so a late answer for an earlier open is dropped. */
  private request = 0;

  protected title(): string {
    const data = this.dataName();
    return $localize`:@@vendor.ownedFlows.history.title:History of ${data}:data:`;
  }

  /** Open on one data type. Call from a click handler only. */
  open(dataSlug: string, dataName: string): void {
    const request = ++this.request;
    this.dataName.set(dataName);
    this.history.set(null);
    this.failed.set(false);
    this.dialog()?.open();
    this.api.getOwnerFlowHistory(this.row().id, dataSlug).then(
      (history) => {
        if (request === this.request) this.history.set(history);
      },
      () => {
        if (request === this.request) this.failed.set(true);
      },
    );
  }

  protected directionText(direction: ContextDirection): string {
    return ownedDirectionText(this.row(), direction);
  }

  protected beforeText(direction: ContextDirection): string {
    const before = this.directionText(direction);
    return $localize`:@@vendor.ownedFlows.history.before:Before: ${before}:direction:`;
  }

  protected eventText(event: OwnerFlowHistoryEvent): string {
    const by = actorText(event.actor);
    switch (event.kind) {
      case 'listed':
        return $localize`:@@vendor.ownedFlows.history.listed:Listed by AEC Integrations`;
      case 'added':
        return $localize`:@@vendor.ownedFlows.history.added:Added by ${by}:company:`;
      case 'confirmed':
        return $localize`:@@vendor.ownedFlows.history.confirmed:Confirmed by ${by}:company:`;
      case 'removed':
        return $localize`:@@vendor.ownedFlows.history.removed:Removed by ${by}:company:`;
      case 'direction_changed':
        return $localize`:@@vendor.ownedFlows.history.changed:Direction changed by ${by}:company:`;
      case 'cleared':
        return $localize`:@@vendor.ownedFlows.history.cleared:Answer cleared by ${by}:company:`;
    }
  }
}

/** The company behind an event, as the sentence names it. */
function actorText(actor: OwnerFlowHistoryActor): string {
  switch (actor) {
    case 'you':
      return $localize`:@@vendor.ownedFlows.history.actor.you:your company`;
    case 'aeci':
      return $localize`:@@vendor.ownedFlows.history.actor.aeci:AEC Integrations`;
    case 'other_company':
      return $localize`:@@vendor.ownedFlows.history.actor.other:another company`;
  }
}
