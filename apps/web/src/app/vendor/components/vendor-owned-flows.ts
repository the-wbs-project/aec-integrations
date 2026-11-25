import { Component, computed, inject, input, signal } from '@angular/core';

import type { ContextDirection, DataObjectOption, OwnedFlow, OwnedIntegration } from '@aeci/shared';
import { compareText } from '@aeci/shared/text-sort';

import { isReplayedEvent } from '../../core/event-replay';
import { AecButton } from '../../shared/button/button';
import { FIELD_LABEL_CLASS } from '../../shared/form-field/form-field-classes';
import { ownedFlowRowId } from '../integration-detail/integration-detail-model';
import { ALERT, HELP, ID_STYLES } from '../integration-detail/integration-detail-styles';
import { VendorApi } from '../vendor-api';
import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorPortalStore } from '../vendor-portal-store';

/** The directions in the order every direction picker lists them. */
const DIRECTIONS: readonly ContextDirection[] = ['outbound', 'both', 'inbound'];

/**
 * One direction against the row's endpoint A: "From {A} to {B}", "From {B} to {A}" or
 * "Both ways". Shared with the owned row's detail page (AECI-2045), so the flows and the
 * Overview's Direction row read alike.
 */
export function ownedDirectionText(
  row: Pick<OwnedIntegration, 'product_a' | 'product_b'>,
  direction: ContextDirection,
): string {
  const a = row.product_a.name;
  const b = row.product_b.name;
  switch (direction) {
    case 'outbound':
      return $localize`:@@vendor.ownedFlows.direction.aToB:From ${a}:a: to ${b}:b:`;
    case 'inbound':
      return $localize`:@@vendor.ownedFlows.direction.bToA:From ${b}:b: to ${a}:a:`;
    case 'both':
      return $localize`:@@vendor.im.direction.both:Both ways`;
  }
}

/**
 * What the flow controls read of a row. An owned card passes its `OwnedIntegration`.
 * The integration detail page builds one from `VendorIntegration.owner_flows` for a
 * row whose owner also makes an endpoint (AECI-2039). Directions are framed against
 * `product_a` in both.
 */
export type OwnedFlowsRow = Pick<
  OwnedIntegration,
  'id' | 'flows' | 'flows_editable' | 'retired_at' | 'claimed_at' | 'product_a' | 'product_b'
>;

/**
 * The data flows on a Sync Service pair the caller owns (AECI-2039,
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.15.3). Rendered inside the owned card under
 * "Integrations your company offers", which has no detail page (AECI-2045 builds one).
 *
 * It follows "Data that's shared" (`integration-shared-data.ts`, §6.17.4) rather than
 * reusing that component, which is bound to the endpoint vendor's detail-page state.
 * The same table, the same Yes and No toggles, the same rule: pressing the pressed
 * answer again clears it (the Same-Behavior Rule). What differs is what an answer
 * means. The owner built and runs the integration, so its Yes shows publicly as "Confirmed by
 * {company}, which offers this integration", and its No removes the row from the
 * public page. There is no public "disputed" state: the owner maintains the listing.
 *
 * Directions are framed against `product_a`, as `OwnedFlow.direction` is.
 *
 * AECI-2039: the integration detail page's "Data that's shared" renders this same
 * component for a row the caller owns and also makes an endpoint of, with
 * `labelledBy` set to its own heading. The component then drops its own heading, so
 * the section keeps one. The controls are the same in both places (the Same-Behavior
 * Rule).
 */
@Component({
  selector: 'aec-vendor-owned-flows',
  imports: [AecButton],
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
            method="dialog"
            class="id-well mt-3 space-y-3 p-4 text-sm"
            [attr.aria-label]="addFormLabel"
            data-testid="owned-flow-add-form"
            (submit)="add($event)"
          >
            <div class="flex flex-wrap items-end gap-3">
              <div>
                <label [for]="prefix() + '-add-data'" [class]="label" i18n="@@vendor.im.add.data"
                  >Data</label
                >
                <select
                  [id]="prefix() + '-add-data'"
                  class="id-input mt-1 min-w-[12rem]"
                  (change)="draftData.set(selectValue($event))"
                >
                  @for (option of dataOptions(); track option.slug) {
                    <option [value]="option.slug" [selected]="draftData() === option.slug">
                      {{ option.name }}
                    </option>
                  }
                </select>
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
                  class="id-input mt-1 min-w-[12rem]"
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
            <div class="flex flex-wrap gap-3">
              <button
                type="submit"
                aecButton
                compact
                [disabled]="busy() !== null || dataOptions().length === 0"
                data-testid="owned-flow-add-submit"
              >
                <span i18n="@@vendor.im.add.submit">Add</span>
              </button>
              <button
                type="button"
                aecButton
                variant="secondary"
                compact
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

      @if (r.flows.length === 0) {
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
                  i18n="@@vendor.ownedFlows.col.answer"
                >
                  Your answer
                </th>
              </tr>
            </thead>
            <tbody>
              @for (flow of r.flows; track flow.id) {
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
                      <span class="inline-flex flex-wrap items-center gap-2">
                        <label class="sr-only" [for]="prefix() + '-dir-' + flow.id">{{
                          directionLabel(flow)
                        }}</label>
                        <select
                          [id]="prefix() + '-dir-' + flow.id"
                          class="id-input"
                          (change)="draftChange.set(asDirection($event))"
                          (keydown.escape)="changing.set(null)"
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
                          (click)="changing.set(null)"
                          i18n="@@vendor.im.add.cancel"
                        >
                          Cancel
                        </button>
                      </span>
                    } @else {
                      <span class="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
                        {{ directionText(flow.direction) }}
                        @if (r.flows_editable) {
                          <button
                            type="button"
                            aecButton
                            variant="ghost"
                            compact
                            [attr.aria-label]="directionLabel(flow)"
                            [attr.data-testid]="'owned-flow-change-' + flow.id"
                            (click)="startChange(flow)"
                            i18n="@@vendor.im.answer.change"
                          >
                            Change
                          </button>
                        }
                      </span>
                    }
                  </td>
                  <td class="py-2 pe-4">
                    @if (r.flows_editable) {
                      <div class="id-seg" role="group" [attr.aria-label]="answerLabel(flow)">
                        <button
                          type="button"
                          class="id-seg-btn inline-flex min-h-8 items-center gap-1 px-2.5 py-1 text-sm font-medium text-(--text-primary) hover:bg-(--surface-sunken) disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--accent-primary)"
                          [attr.aria-pressed]="flow.answer === 'yes'"
                          [disabled]="busy() === flow.id"
                          [attr.data-testid]="'owned-flow-yes-' + flow.id"
                          (click)="press(flow, true)"
                        >
                          <span i18n="@@vendor.im.answer.yes">Yes</span>
                        </button>
                        <button
                          type="button"
                          class="id-seg-btn inline-flex min-h-8 items-center gap-1 px-2.5 py-1 text-sm font-medium text-(--text-primary) hover:bg-(--surface-sunken) disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--accent-primary)"
                          [attr.aria-pressed]="flow.answer === 'no'"
                          [disabled]="busy() === flow.id"
                          [attr.data-testid]="'owned-flow-no-' + flow.id"
                          (click)="press(flow, false)"
                        >
                          <span i18n="@@vendor.im.answer.no">No</span>
                        </button>
                      </div>
                    }
                    <p
                      class="m-0 mt-1 text-xs text-(--text-secondary)"
                      [attr.data-testid]="'owned-flow-public-' + flow.id"
                    >
                      {{ publicLine(flow) }}
                    </p>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
    </div>
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

  protected readonly directions = DIRECTIONS;
  protected readonly adding = signal(false);
  protected readonly changing = signal<string | null>(null);
  protected readonly draftChange = signal<ContextDirection | null>(null);
  protected readonly draftData = signal('');
  protected readonly draftDirection = signal<ContextDirection>('outbound');
  protected readonly busy = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);
  private readonly dataObjects = signal<readonly DataObjectOption[]>([]);
  protected readonly vocabularyFailed = signal(false);

  /** The Label role (AECI-2083 portal recipe). */
  protected readonly label = FIELD_LABEL_CLASS;
  protected readonly help = HELP;
  protected readonly alert = ALERT;
  protected readonly addFormLabel = $localize`:@@vendor.ownedFlows.addForm:Add a row of data`;

  protected readonly prefix = computed(() => `owned-flows-${this.row().id}`);
  protected readonly headingId = computed(() => `${this.prefix()}-heading`);

  protected readonly heading = computed(() => {
    const n = this.row().flows.length;
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
    return $localize`:@@vendor.ownedFlows.intro.claimed.runs:Your company offers and runs this integration, so you confirm what it moves. A Yes shows your company as the confirmer on the public page. A No removes the row from it.`;
  });

  /** The data type vocabulary, names A to Z. */
  protected readonly dataOptions = computed(() =>
    [...this.dataObjects()].sort((a, b) => compareText(a.name, b.name)),
  );

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

  protected answerLabel(flow: OwnedFlow): string {
    const data = flow.data_object_name;
    return $localize`:@@vendor.ownedFlows.answerGroup:Is ${data}:data: right?`;
  }

  /** What the public pair page shows for the row. */
  protected publicLine(flow: OwnedFlow): string {
    if (flow.answer === 'no') {
      return $localize`:@@vendor.ownedFlows.public.removed:Not shown on the public page.`;
    }
    if (flow.agreement === 'owner_confirmed') {
      return $localize`:@@vendor.ownedFlows.public.confirmed:Public page: Confirmed by your company.`;
    }
    return $localize`:@@vendor.ownedFlows.public.listed:Public page: Listed by AEC Integrations.`;
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

  protected startChange(flow: OwnedFlow): void {
    this.draftChange.set(flow.direction);
    this.changing.set(flow.id);
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

  /** Pressing the pressed answer again clears it, as on "Data that's shared". */
  protected async press(flow: OwnedFlow, yes: boolean): Promise<void> {
    const pressed = flow.answer === (yes ? 'yes' : 'no');
    await this.run(flow.id, async () => {
      if (pressed) await this.api.clearOwnerFlowAnswer(flow.id);
      else await this.api.setOwnerFlowAnswer(flow.id, yes);
    });
    if (this.error()) return;
    const data = flow.data_object_name;
    this.announcer.announce(
      pressed
        ? $localize`:@@vendor.ownedFlows.live.cleared:Your answer on ${data}:data: is cleared.`
        : yes
          ? $localize`:@@vendor.ownedFlows.live.confirmed:You confirmed ${data}:data:.`
          : $localize`:@@vendor.ownedFlows.live.removed:You removed ${data}:data: from the public page.`,
    );
  }

  protected async saveDirection(flow: OwnedFlow): Promise<void> {
    const direction = this.draftChange() ?? flow.direction;
    await this.run(flow.id, () => this.api.changeOwnerFlow(flow.id, { direction }));
    if (!this.error()) this.changing.set(null);
  }

  protected async add(event: Event): Promise<void> {
    if (isReplayedEvent(event)) return;
    event.preventDefault();
    const data = this.draftData() || this.dataOptions()[0]?.slug;
    if (!data) return;
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

  /** One write at a time, then a refetch of the owned rows. */
  private async run(key: string, write: () => Promise<unknown>): Promise<void> {
    if (this.busy() !== null) return;
    this.busy.set(key);
    this.error.set(null);
    try {
      await write();
      await this.store.revalidate(['integrations']);
    } catch {
      this.error.set(
        $localize`:@@vendor.ownedFlows.error:That change could not be saved. Reload the page and try again.`,
      );
    } finally {
      this.busy.set(null);
    }
  }
}
