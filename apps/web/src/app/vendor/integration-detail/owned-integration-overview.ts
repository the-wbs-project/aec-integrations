import {
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';

import {
  CONNECTOR_POWERED_EDIT_FIELDS,
  type ContextDirection,
  type IntegrationContestField,
  type IntegrationEditField,
  type OwnedIntegration,
} from '@aeci/shared';

import { AecButton } from '../../shared/button/button';
import {
  VendorIntegrationEditForm,
  type EditFormValues,
} from '../components/vendor-integration-edit-form';
import { claimErrorMessage } from '../components/vendor-integration-ownership-labels';
import { VendorNotOurs, selfDisclaimOn, selfDisclaimStands } from '../components/vendor-not-ours';
import { ownedDirectionText } from '../components/vendor-owned-flows';
import {
  ownedRowClaimedAnnouncement,
  ownedRowState,
  ownedRowStatusLine,
} from '../components/vendor-owned-row-model';
import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorApi } from '../vendor-api';
import { VendorPortalStore } from '../vendor-portal-store';

import { notSetLabel, pageFieldLabel } from './integration-detail-model';
import { ID_STYLES } from './integration-detail-styles';

/** The nine fields an owner edits on a connector-delivered row, in the page's order. */
const DETAIL_FIELDS: readonly IntegrationEditField[] = [
  'name',
  'description',
  'mechanism_name',
  'direction',
  'maturity',
  'pricing_model',
  'pricing_url',
  'listing_url',
  'docs_url',
];

const DIRECTIONS: readonly string[] = ['outbound', 'inbound', 'both'];

/**
 * The Overview of an owned row's detail page (AECI-2045, `STAGE_2_VENDOR_PORTAL_SPEC.md`
 * §6.17.12). An owned row has no endpoint on the caller's side, so the endpoint page's
 * `IntegrationOverview` (bound to `VendorIntegration` and `IntegrationDetailState`) does
 * not fit it. This renders the same two groups, Details and Ownership, as a `<dl>`, and
 * the owner's one action by state, with the owned card's own parts:
 *
 * - unclaimed: the claim hint, **Claim this integration** and "Not ours"
 *   (`VendorNotOurs`), exactly as on the card;
 * - claimed and live: **Edit details**, the card's `VendorIntegrationEditForm`;
 * - retired: read-only.
 *
 * The state words come from `vendor-owned-row-model.ts`, which the card reads too.
 */
@Component({
  selector: 'aec-owned-integration-overview',
  imports: [AecButton, VendorIntegrationEditForm, VendorNotOurs],
  styles: [ID_STYLES],
  template: `
    @let r = row();
    <div class="space-y-6">
      <div>
        <h4 class="aec-overline text-(--text-secondary)" i18n="@@vendor.im.overview.details">
          Details
        </h4>
        <dl class="mt-2 divide-y divide-(--border-default)">
          @for (field of fields(); track field) {
            <div
              class="grid items-start gap-x-6 gap-y-1 py-1 text-sm sm:grid-cols-[11rem_minmax(0,1fr)]"
              [attr.data-testid]="'owned-overview-row-' + field"
            >
              <dt class="flex min-h-11 items-center text-(--text-secondary)">
                {{ label(field) }}
              </dt>
              <dd class="flex min-h-11 min-w-0 items-center break-words text-(--text-primary)">
                {{ value(field) }}
              </dd>
            </div>
          }
        </dl>
      </div>

      <div>
        <h4 class="aec-overline text-(--text-secondary)" i18n="@@vendor.im.overview.ownership">
          Ownership
        </h4>
        <dl class="mt-2 divide-y divide-(--border-default)">
          <div
            class="grid items-start gap-x-6 gap-y-1 py-1 text-sm sm:grid-cols-[11rem_minmax(0,1fr)]"
          >
            <dt
              class="flex min-h-11 items-center text-(--text-secondary)"
              i18n="@@vendor.im.field.owner"
            >
              Owner
            </dt>
            <dd class="flex min-h-11 min-w-0 items-center text-(--text-primary)">
              {{ ownerText() }}
            </dd>
          </div>
          @if (r.connector; as connector) {
            <div
              class="grid items-start gap-x-6 gap-y-1 py-1 text-sm sm:grid-cols-[11rem_minmax(0,1fr)]"
            >
              <dt
                class="flex min-h-11 items-center text-(--text-secondary)"
                i18n="@@vendor.im.owned.deliveredBy"
              >
                Delivered through
              </dt>
              <dd class="flex min-h-11 min-w-0 items-center text-(--text-primary)">
                {{ connector.name }}
              </dd>
            </div>
          }
        </dl>

        <p
          #status
          tabindex="-1"
          class="mt-3 max-w-prose text-sm text-(--text-primary) focus:outline-none"
          data-testid="owned-overview-status"
        >
          {{ statusLine() }}
        </p>

        @switch (state()) {
          @case ('claimed') {
            <div class="mt-3">
              <button
                #editTrigger
                type="button"
                [attr.aria-expanded]="editing()"
                [attr.aria-controls]="formPrefix() + '-form'"
                aecButton
                variant="secondary"
                compact
                (click)="editing.set(!editing())"
                data-testid="owned-overview-edit"
                i18n="@@vendor.ownedIntegrations.edit"
              >
                Edit details
              </button>
            </div>
            @if (editing()) {
              <aec-vendor-integration-edit-form
                [integrationId]="r.id"
                [contextProductId]="r.product_a.id"
                [otherProductName]="r.product_b.name"
                [values]="editValues()"
                [connectorDelivered]="r.connector_powered"
                [idPrefix]="formPrefix()"
                [lockedFields]="r.locked_fields"
                [hiddenFields]="r.hidden_fields"
                (closed)="closeEdit()"
              />
            }
          }
          @case ('claimable') {
            @if (holdsEndpoint()) {
              <p
                class="mt-1 max-w-prose text-xs text-(--text-secondary)"
                data-testid="owned-overview-claim-hint"
                i18n="@@vendor.ownedIntegrations.claimHintOtherSide"
              >
                Claiming takes this integration over from AEC Integrations. Our catalog updates stop
                reaching it. The other product's vendor is told that you claimed it.
              </p>
            } @else {
              <p
                class="mt-1 max-w-prose text-xs text-(--text-secondary)"
                data-testid="owned-overview-claim-hint"
                i18n="@@vendor.ownedIntegrations.claimHint"
              >
                Claiming takes this integration over from AEC Integrations. Our catalog updates stop
                reaching it. The vendors of both products are told that you claimed it.
              </p>
            }
            @if (!notOursStands()) {
              <div class="mt-3">
                <button
                  type="button"
                  aecButton
                  compact
                  [disabled]="claiming()"
                  (click)="claim()"
                  data-testid="owned-overview-claim"
                >
                  @if (claiming()) {
                    <span i18n="@@vendor.ownedIntegrations.claiming">Claiming…</span>
                  } @else {
                    <span i18n="@@vendor.ownedIntegrations.claim">Claim this integration</span>
                  }
                </button>
              </div>
            }
            <aec-vendor-not-ours
              class="mt-3"
              [integrationId]="r.id"
              [anchor]="r.anchor"
              [productA]="r.product_a.name"
              [productB]="r.product_b.name"
            />
          }
        }
        @if (notice(); as message) {
          <p role="alert" class="mt-3 text-sm font-medium text-(--text-primary)">{{ message }}</p>
        }
      </div>
    </div>
  `,
})
export class OwnedIntegrationOverview {
  readonly row = input.required<OwnedIntegration>();

  private readonly api = inject(VendorApi);
  private readonly store = inject(VendorPortalStore);
  private readonly announcer = inject(VendorPortalAnnouncer);
  private readonly injector = inject(Injector);

  private readonly statusEl = viewChild<ElementRef<HTMLElement>>('status');
  private readonly editTrigger = viewChild<ElementRef<HTMLButtonElement>>('editTrigger');

  protected readonly editing = signal(false);
  protected readonly claiming = signal(false);
  protected readonly notice = signal<string | null>(null);

  protected readonly state = computed(() => ownedRowState(this.row()));
  protected readonly statusLine = computed(() => ownedRowStatusLine(this.row()));

  /** The nine fields on a connector-delivered row, plus the type on an ordinary row
   *  the caller owns but holds no endpoint of. The type is frozen on the first. */
  protected readonly fields = computed(() =>
    DETAIL_FIELDS.filter(
      (field) => !this.row().connector_powered || CONNECTOR_POWERED_EDIT_FIELDS.includes(field),
    ),
  );

  protected readonly ownerText = computed(() => {
    const name = this.store.me()?.vendor.company_name ?? '';
    return $localize`:@@vendor.im.owner.you:${name}:company: (you)`;
  });

  protected readonly notOursStands = computed(() =>
    selfDisclaimStands(
      selfDisclaimOn(this.store.contests().submitted, this.row().id, this.row().anchor),
    ),
  );

  /** The caller makes one of the two products, so the claim tells only the other side. */
  protected readonly holdsEndpoint = computed(() => {
    const mine = new Set((this.store.me()?.products ?? []).map((p) => p.id));
    return mine.has(this.row().product_a.id) || mine.has(this.row().product_b.id);
  });

  protected readonly editValues = computed<EditFormValues>(() => ({
    ...this.row().contestable_fields,
    pricing_url: this.row().pricing_url,
  }));

  protected readonly formPrefix = computed(() => `owned-detail-${this.row().id}`);

  protected label(field: IntegrationEditField): string {
    return pageFieldLabel(field);
  }

  protected value(field: IntegrationEditField): string {
    const row = this.row();
    const raw =
      field === 'pricing_url'
        ? row.pricing_url
        : row.contestable_fields[field as IntegrationContestField];
    if (raw === null || raw === undefined || raw === '') return notSetLabel();
    if (field === 'direction' && DIRECTIONS.includes(raw)) {
      return ownedDirectionText(row, raw as ContextDirection);
    }
    return raw;
  }

  protected async claim(): Promise<void> {
    if (this.claiming()) return;
    this.claiming.set(true);
    this.notice.set(null);
    try {
      await this.api.claimIntegration(this.row().id);
      this.announcer.announce(ownedRowClaimedAnnouncement());
      await this.store.revalidate(['integrations']);
      // The button is gone once the row reads as claimed. Move focus to Edit details,
      // or the status line, so a keyboard user stays where they were.
      afterNextRender(() => (this.editTrigger() ?? this.statusEl())?.nativeElement.focus(), {
        injector: this.injector,
      });
    } catch (err) {
      this.notice.set(claimErrorMessage(err));
    } finally {
      this.claiming.set(false);
    }
  }

  protected closeEdit(): void {
    this.editing.set(false);
    afterNextRender(() => this.editTrigger()?.nativeElement.focus(), { injector: this.injector });
  }
}
