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
  viewChildren,
} from '@angular/core';

import type {
  IntegrationLinkKind,
  IntegrationSideLinks,
  OfferedContestField,
  ProductLink,
  VendorContest,
  VendorIntegration,
} from '@aeci/shared';

import { lockedField, type LockedField } from '@aeci/shared';

import { NewTabIcon } from '../../shared/new-tab-icon/new-tab-icon';
import { VendorLockedNote } from '../components/vendor-locked-note';
import { linkSaveErrorMessage, linkValueProblem } from '../components/vendor-link-labels';
import {
  editSaveErrorMessage,
  editValueMessage,
} from '../components/vendor-integration-ownership-labels';
import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorApi } from '../vendor-api';
import { VendorPortalStore } from '../vendor-portal-store';

import {
  canClaim,
  companyMidSentence,
  companyOrFallback,
  contestItemId,
  contestValue,
  formatDay,
  openRequestOn,
  ownsBoth,
  pageFieldLabel,
  receivedOutcome,
  rowTargetId,
  submittedOutcome,
} from './integration-detail-model';
import { IntegrationDetailState } from './integration-detail-state';
import {
  ALERT,
  BTN_PRIMARY,
  BTN_SECONDARY,
  ICON_BUTTON,
  ID_STYLES,
  ROW_ACTION,
} from './integration-detail-styles';
import { VendorTip } from './vendor-tip';

type RecordField = Extract<OfferedContestField, 'listing_url' | 'docs_url'>;

interface SideGroup {
  readonly product: ProductLink;
  readonly mine: boolean;
  readonly links: IntegrationSideLinks;
}

const PENCIL =
  'M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z';

/**
 * "Integration links" (AECI-1152, `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.17.5): every
 * link the public page shows for this integration, in three groups.
 *
 * - **On the integration**: the record's listing page and documentation. The
 *   claimed owner edits them (`PATCH`, §4.5.6), the recorded owner before its
 *   claim is sent to Claim, and anyone else requests a change or sees the flag.
 * - **One group per product the caller holds**, headed by the product name and
 *   "Your product": where customers get it and the setup guide, edited with
 *   `PUT` / `DELETE …/links/:productId/:kind` (§4.5.7). An empty value removes it.
 * - **The other product's group**, read-only, headed by the product name, a lock
 *   and "Provided by {company}". Groups are labelled by product (AECI-1141).
 *
 * Website and connection link are not shown (ruled 2026-09-28, §6.17.11). A
 * connector-powered row takes no per-side links: its record links come from the
 * connector, and a stranded per-side link keeps §4.5.7's Remove only.
 */
@Component({
  selector: 'aec-integration-links',
  imports: [VendorTip, NewTabIcon, VendorLockedNote],
  styles: [ID_STYLES],
  template: `
    @let i = integration();
    <div class="flex items-center gap-1">
      <h3
        id="links-heading"
        tabindex="-1"
        class="id-h3 text-(--text-primary) focus:outline-none"
        i18n="@@vendor.im.section.links"
      >
        Integration links
      </h3>
      <aec-vendor-tip [label]="aboutSection" [lines]="[sectionTip]" />
    </div>

    <div class="mt-3 space-y-6 text-sm">
      <div>
        <div class="flex items-center gap-1">
          <h4 class="id-h4" i18n="@@vendor.im.links.record">On the integration</h4>
          <aec-vendor-tip [label]="aboutRecord" [lines]="[recordTip()]" />
        </div>
        @if (connector()) {
          <p class="mt-1 text-(--text-secondary)">{{ fromConnectorLine() }}</p>
        }
        <dl class="mt-1 divide-y divide-(--border-default)">
          @for (field of recordFields; track field) {
            @let value = recordValue(field);
            <div
              [id]="rowId(field)"
              tabindex="-1"
              class="grid scroll-mt-20 items-center gap-x-6 gap-y-1 py-2 focus:outline-2 focus:outline-offset-2 focus:outline-(--accent-primary) sm:grid-cols-[11rem_minmax(0,1fr)]"
              [attr.data-testid]="'links-row-' + field"
            >
              <dt class="flex min-h-8 items-center gap-1 text-(--text-secondary)">
                {{ fieldLabel(field) }}
                <aec-vendor-tip
                  [label]="about(fieldLabel(field))"
                  [lines]="recordFieldTip(field)"
                />
              </dt>
              <dd class="flex min-h-8 min-w-0 flex-wrap items-center gap-2">
                @if (editing() === 'record:' + field) {
                  <form
                    class="flex min-w-0 flex-1 flex-wrap items-center gap-2"
                    [attr.aria-label]="editLabel(fieldLabel(field))"
                    (submit)="saveRecord($event, field)"
                  >
                    <input
                      #editField
                      type="url"
                      inputmode="url"
                      placeholder="https://"
                      class="id-input min-w-[14rem] flex-1"
                      [attr.aria-label]="fieldLabel(field)"
                      [attr.aria-invalid]="error() ? 'true' : null"
                      [value]="draft()"
                      (input)="draft.set(inputValue($event))"
                    />
                    <button type="submit" [class]="primary" [disabled]="busy()">
                      <span i18n="@@vendor.im.edit.save">Save</span>
                    </button>
                    <button
                      type="button"
                      [class]="secondary"
                      [disabled]="busy()"
                      (click)="cancel()"
                      i18n="@@vendor.im.edit.cancel"
                    >
                      Cancel
                    </button>
                    @if (error()) {
                      <p role="alert" [class]="alert" class="basis-full">{{ error() }}</p>
                    }
                  </form>
                } @else {
                  @if (value) {
                    <a
                      [href]="value"
                      target="_blank"
                      rel="noopener noreferrer nofollow"
                      [class]="valueLinkClass"
                      [attr.data-testid]="'link-value-' + field"
                    >
                      @if (connector() && field === 'listing_url') {
                        <span>{{ viewOnConnector() }}</span>
                      } @else {
                        <span class="break-all">{{ value }}</span>
                      }
                      <aec-new-tab-icon />
                    </a>
                  } @else {
                    <span class="text-(--text-secondary)" i18n="@@vendor.im.value.notSet"
                      >Not set</span
                    >
                  }
                  @if (lockOf(field); as lock) {
                    <aec-vendor-locked-note
                      class="basis-full"
                      [lock]="lock"
                      [noteId]="'record-' + field + '-locked'"
                    />
                  }
                  @if (flagFor(field); as c) {
                    <aec-vendor-tip
                      variant="flag"
                      [label]="flagLabel(fieldLabel(field))"
                      [lines]="[flagText(c)]"
                      (activate)="state.jumpTo(contestTarget(c), true)"
                    />
                  }
                  <span class="ms-auto flex shrink-0 items-center">
                    @if (live()) {
                      @if (lockOf(field)) {
                        <!-- AECI-1237: AEC Integrations locked it; the note says why. -->
                      } @else if (recordEditable()) {
                        <button
                          #pencil
                          type="button"
                          [class]="iconButton"
                          [attr.data-row]="'record:' + field"
                          [attr.aria-label]="editLabel(fieldLabel(field))"
                          [attr.data-testid]="'edit-' + field"
                          (click)="edit('record:' + field, value)"
                        >
                          <svg
                            aria-hidden="true"
                            class="h-4 w-4"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                          >
                            <path [attr.d]="pencilPath" />
                            <path d="m15 5 4 4" />
                          </svg>
                        </button>
                      } @else if (i.is_owner && !i.claimed_at) {
                        @if (claimAllowed()) {
                          <button
                            type="button"
                            [class]="rowAction"
                            [attr.aria-label]="claimToEditLabel(fieldLabel(field))"
                            (click)="state.jumpTo(ownerRow)"
                            i18n="@@vendor.im.claimToEdit"
                          >
                            Claim to edit
                          </button>
                        }
                      } @else if (!i.is_owner && !flagFor(field)) {
                        <button
                          type="button"
                          [class]="rowAction"
                          [attr.aria-label]="requestLabel(fieldLabel(field))"
                          [attr.data-testid]="'request-' + field"
                          (click)="state.openRequestForm(field)"
                          i18n="@@vendor.im.requestChange"
                        >
                          Request a change
                        </button>
                      }
                    }
                  </span>
                }
              </dd>
            </div>
          }
        </dl>
      </div>

      @if (connector()) {
        <p class="text-(--text-secondary)" data-testid="links-connector-note">
          {{ connectorSidesLine() }}
        </p>
        @if (stranded()) {
          <div data-testid="links-stranded">
            <div class="flex flex-wrap items-center gap-1.5">
              <h4 class="id-h4">{{ i.context_product.name }}</h4>
              <span class="text-(--text-secondary)" i18n="@@vendor.im.links.yourProduct"
                >Your product</span
              >
            </div>
            <p class="mt-1 text-(--text-secondary)" i18n="@@vendor.links.stranded.intro">
              This integration is now delivered through a connector product, so it no longer takes
              your own links and readers no longer see them. You can remove them.
            </p>
            <dl class="mt-1 divide-y divide-(--border-default)">
              @for (kind of sideKinds; track kind.key) {
                @let value = sideValue(i.own_links, kind.key);
                @if (value) {
                  <div
                    class="grid items-center gap-x-6 gap-y-1 py-2 sm:grid-cols-[11rem_minmax(0,1fr)]"
                  >
                    <dt class="text-(--text-secondary)">{{ kind.label }}</dt>
                    <dd class="flex min-w-0 flex-wrap items-center gap-2">
                      <span class="min-w-0 flex-1 break-all text-(--text-primary)">{{
                        value
                      }}</span>
                      <button
                        type="button"
                        [class]="rowAction"
                        [disabled]="busy()"
                        [attr.aria-label]="removeLabel(kind.label, i.context_product.name)"
                        (click)="removeStranded(kind.key)"
                        i18n="@@vendor.im.links.remove"
                      >
                        Remove
                      </button>
                    </dd>
                  </div>
                }
              }
            </dl>
            @if (error() && editing() === null) {
              <p role="alert" [class]="alert">{{ error() }}</p>
            }
          </div>
        }
      } @else {
        @for (group of sideGroups(); track group.product.id) {
          <div [attr.data-testid]="'links-side-' + group.product.slug">
            <div class="flex flex-wrap items-center gap-1.5">
              <h4 class="id-h4">{{ group.product.name }}</h4>
              @if (group.mine) {
                <span class="text-(--text-secondary)" i18n="@@vendor.im.links.yourProduct"
                  >Your product</span
                >
                <aec-vendor-tip
                  [label]="aboutLinksFor(group.product.name)"
                  [lines]="[mineTip(group.product.name)]"
                />
              } @else {
                <svg
                  aria-hidden="true"
                  class="h-3.5 w-3.5 text-(--text-secondary)"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
                <span class="text-(--text-secondary)">{{ providedBy() }}</span>
                <aec-vendor-tip
                  [label]="aboutLinksFor(group.product.name)"
                  [lines]="[otherTip()]"
                />
              }
            </div>
            <dl class="mt-1 divide-y divide-(--border-default)">
              @for (kind of sideKinds; track kind.key) {
                @let value = sideValue(group.links, kind.key);
                @let target = 'side:' + group.product.id + ':' + kind.key;
                <div
                  class="grid items-center gap-x-6 gap-y-1 py-2 sm:grid-cols-[11rem_minmax(0,1fr)]"
                >
                  <dt class="flex min-h-8 items-center gap-1 text-(--text-secondary)">
                    {{ kind.label }}
                    <aec-vendor-tip
                      [label]="about(kind.label)"
                      [lines]="sideKindTip(group, kind.key)"
                    />
                  </dt>
                  <dd class="flex min-h-8 min-w-0 flex-wrap items-center gap-2">
                    @if (editing() === target) {
                      <form
                        class="flex min-w-0 flex-1 flex-wrap items-center gap-2"
                        [attr.aria-label]="editForLabel(kind.label, group.product.name)"
                        (submit)="saveSide($event, group, kind.key)"
                      >
                        <input
                          #editField
                          type="url"
                          inputmode="url"
                          placeholder="https://"
                          class="id-input min-w-[14rem] flex-1"
                          [attr.aria-label]="editForLabel(kind.label, group.product.name)"
                          [attr.aria-invalid]="error() ? 'true' : null"
                          [value]="draft()"
                          (input)="draft.set(inputValue($event))"
                        />
                        <button type="submit" [class]="primary" [disabled]="busy()">
                          <span i18n="@@vendor.im.edit.save">Save</span>
                        </button>
                        <button
                          type="button"
                          [class]="secondary"
                          [disabled]="busy()"
                          (click)="cancel()"
                          i18n="@@vendor.im.edit.cancel"
                        >
                          Cancel
                        </button>
                        <p
                          class="basis-full text-sm text-(--text-secondary)"
                          i18n="@@vendor.im.links.emptyRemoves"
                        >
                          Leave it empty to remove the link.
                        </p>
                        @if (error()) {
                          <p role="alert" [class]="alert" class="basis-full">{{ error() }}</p>
                        }
                      </form>
                    } @else {
                      @if (value) {
                        <a
                          [href]="value"
                          target="_blank"
                          rel="noopener noreferrer nofollow"
                          [class]="valueLinkClass"
                        >
                          <span class="break-all">{{ value }}</span>
                          <aec-new-tab-icon />
                        </a>
                      } @else {
                        <span class="text-(--text-secondary)" i18n="@@vendor.im.links.notAdded"
                          >Not added yet</span
                        >
                      }
                      @if (group.mine && live()) {
                        <button
                          #pencil
                          type="button"
                          class="ms-auto"
                          [class]="iconButton"
                          [attr.data-row]="target"
                          [attr.aria-label]="editForLabel(kind.label, group.product.name)"
                          [attr.data-testid]="'edit-side-' + group.product.slug + '-' + kind.key"
                          (click)="edit(target, value)"
                        >
                          <svg
                            aria-hidden="true"
                            class="h-4 w-4"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                          >
                            <path [attr.d]="pencilPath" />
                            <path d="m15 5 4 4" />
                          </svg>
                        </button>
                      }
                    }
                  </dd>
                </div>
              }
            </dl>
          </div>
        }
      }
    </div>
  `,
})
export class IntegrationLinksSection {
  protected readonly state = inject(IntegrationDetailState);
  private readonly api = inject(VendorApi);
  private readonly store = inject(VendorPortalStore);
  private readonly announcer = inject(VendorPortalAnnouncer);
  private readonly injector = inject(Injector);

  readonly integration = input.required<VendorIntegration>();

  private readonly editField = viewChild<ElementRef<HTMLInputElement>>('editField');
  private readonly pencils = viewChildren<ElementRef<HTMLButtonElement>>('pencil');

  /** "record:<field>" or "side:<productId>:<kind>". */
  protected readonly editing = signal<string | null>(null);
  protected readonly draft = signal('');
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);

  protected readonly recordFields: readonly RecordField[] = ['listing_url', 'docs_url'];

  /** AECI-1237 (§11d.5): AECi's lock on a record link, when it set one. */
  protected lockOf(field: RecordField): LockedField | undefined {
    return lockedField(this.integration().locked_fields, field);
  }
  protected readonly sideKinds: readonly { key: IntegrationLinkKind; label: string }[] = [
    { key: 'listing', label: $localize`:@@vendor.im.links.listing:Where customers get it` },
    { key: 'docs', label: $localize`:@@vendor.im.links.docs:Setup guide` },
  ];
  protected readonly ownerRow = rowTargetId('owner');

  protected readonly live = computed(() => !this.integration().retired_at);
  protected readonly connector = computed(() => !this.integration().attestable);
  protected readonly claimAllowed = computed(() =>
    canClaim(this.integration(), this.state.entitled()),
  );

  /** The claimed owner edits the record links; on a connector-powered row only
   *  with an active plan (§4.5.6, AECI-1090). */
  protected readonly recordEditable = computed(() => {
    const i = this.integration();
    if (!i.is_owner || !i.claimed_at) return false;
    return !this.connector() || this.state.entitled();
  });

  private readonly connectorName = computed(() => {
    const i = this.integration();
    return (
      i.powered_by?.name ??
      i.mechanism_name ??
      $localize`:@@vendor.im.connector.fallback:a connector service`
    );
  });

  protected readonly viewOnConnector = computed(() => {
    const connector = this.connectorName();
    return $localize`:@@vendor.im.links.viewOn:View on ${connector}:connector:`;
  });

  protected readonly fromConnectorLine = computed(() => {
    const connector = this.connectorName();
    return $localize`:@@vendor.im.links.fromConnector:These links come from ${connector}:connector:.`;
  });

  protected readonly connectorSidesLine = computed(() => {
    const connector = this.connectorName();
    return $localize`:@@vendor.im.links.connectorSides:Products cannot add their own links to an integration that runs through ${connector}:connector:.`;
  });

  protected readonly stranded = computed(() => {
    const links = this.integration().own_links;
    return Boolean(links.listing_url || links.docs_url);
  });

  protected readonly sideGroups = computed<readonly SideGroup[]>(() => {
    const i = this.integration();
    return [
      { product: i.context_product, mine: true, links: i.own_links },
      { product: i.other_product, mine: ownsBoth(i), links: i.counterpart_links },
    ];
  });

  protected readonly providedBy = computed(() => {
    const who = companyMidSentence(this.state.company());
    return $localize`:@@vendor.im.links.providedBy:Provided by ${who}:company:`;
  });

  protected readonly aboutSection = $localize`:@@vendor.im.links.about:About integration links`;
  protected readonly sectionTip = $localize`:@@vendor.im.links.tip:Every link the public page shows for this integration, grouped by who provides it: the integration itself, your products, and the other company.`;
  protected readonly aboutRecord = $localize`:@@vendor.im.links.record.about:About the integration's links`;

  protected readonly recordTip = computed(() => {
    const i = this.integration();
    if (this.recordEditable()) {
      return $localize`:@@vendor.im.links.record.tip.owner:You own this integration, so you edit these directly. Changes go live on the public page straight away.`;
    }
    if (i.is_owner && !i.claimed_at) {
      return $localize`:@@vendor.im.links.record.tip.unclaimed:Your company is the recorded owner. Claim the integration to edit these.`;
    }
    if (i.is_owner) {
      return $localize`:@@vendor.im.links.record.tip.noPlan:Editing an integration that runs through a connector service needs an active plan.`;
    }
    if (i.owner) {
      const owner = i.owner.name;
      return $localize`:@@vendor.im.links.record.tip.other:${owner}:owner: owns this integration and keeps these up to date. Request a change if one is wrong.`;
    }
    return $localize`:@@vendor.im.links.record.tip.none:No company has taken over this integration, so AEC Integrations keeps these. Request a change if one is wrong.`;
  });

  protected recordFieldTip(field: RecordField): string[] {
    const listing = field === 'listing_url';
    const connector = this.connector() ? this.connectorName() : null;
    const what = connector
      ? listing
        ? $localize`:@@vendor.im.links.tip.listingConnector:Where customers find the integration on ${connector}:connector:.`
        : $localize`:@@vendor.im.links.tip.docsConnector:The help article for the integration on ${connector}:connector:.`
      : listing
        ? $localize`:@@vendor.im.links.tip.listing:The integration's own listing page.`
        : $localize`:@@vendor.im.links.tip.docs:The integration's own help or setup article.`;
    const where = listing
      ? $localize`:@@vendor.im.links.tip.listingPublic:Shows under the integration's card on the public page as "View listing", unless a company adds its own listing link, which shows instead.`
      : $localize`:@@vendor.im.links.tip.docsPublic:Shows under the integration's card on the public page as "Documentation", unless a company adds its own setup guide, which shows instead.`;
    return [what, where, this.recordTip()];
  }

  protected sideKindTip(group: SideGroup, kind: IntegrationLinkKind): string[] {
    const product = group.product.name;
    const company = group.mine ? this.state.myCompany() : companyOrFallback(this.state.company());
    const companyMid = companyMidSentence(this.state.company());
    const listing = kind === 'listing';
    return [
      listing
        ? $localize`:@@vendor.im.links.tip.sideListing:Where customers get it for ${product}:product:.`
        : $localize`:@@vendor.im.links.tip.sideDocs:How to set it up in ${product}:product:.`,
      listing
        ? $localize`:@@vendor.im.links.tip.sideListingPublic:Shows under the integration's card on the public page as "${company}:company: listing".`
        : $localize`:@@vendor.im.links.tip.sideDocsPublic:Shows under the integration's card on the public page as "${company}:company: documentation".`,
      group.mine
        ? $localize`:@@vendor.im.links.tip.sideMine:Your company changes it.`
        : $localize`:@@vendor.im.links.tip.sideOther:Only ${companyMid}:company: changes it.`,
    ];
  }

  protected mineTip(product: string): string {
    return $localize`:@@vendor.im.links.tip.mine:Your own links for ${product}:product:. Where no company adds a link, the public page shows the integration's own link instead.`;
  }

  protected otherTip(): string {
    const who = companyMidSentence(this.state.company());
    return $localize`:@@vendor.im.links.tip.other:Only ${who}:company: can change these. If one is wrong, tell ${who}:company:.`;
  }

  protected recordValue(field: RecordField): string | null {
    return this.integration().contestable_fields[field] ?? null;
  }

  protected sideValue(links: IntegrationSideLinks, kind: IntegrationLinkKind): string | null {
    return kind === 'listing' ? links.listing_url : links.docs_url;
  }

  protected flagFor(field: RecordField): VendorContest | null {
    return openRequestOn(this.state.contests(), field);
  }

  protected flagText(contest: VendorContest): string {
    const date = formatDay(contest.created_at);
    const from = contestValue(contest, 'current');
    const to = contestValue(contest, 'proposed');
    const received = this.state.contests().received.some((c) => c.id === contest.id);
    const status = received ? receivedOutcome(contest).label : submittedOutcome(contest).label;
    return $localize`:@@vendor.im.flag.text:Change requested ${date}:date:: from ${from}:from: to ${to}:to:. ${status}:status:. Select the flag to see the request.`;
  }

  protected contestTarget(contest: VendorContest): string {
    return contestItemId(contest.id);
  }

  protected rowId(key: string): string {
    return rowTargetId(key);
  }

  protected fieldLabel(field: RecordField): string {
    return pageFieldLabel(field);
  }

  protected about(label: string): string {
    return $localize`:@@vendor.im.tip.about:About ${label}:label:`;
  }
  protected aboutLinksFor(product: string): string {
    return $localize`:@@vendor.im.links.aboutFor:About the links for ${product}:product:`;
  }
  protected editLabel(label: string): string {
    return $localize`:@@vendor.im.edit.label:Edit ${label}:label:`;
  }
  protected editForLabel(label: string, product: string): string {
    return $localize`:@@vendor.im.links.editFor:Edit ${label}:label: for ${product}:product:`;
  }
  protected claimToEditLabel(label: string): string {
    return $localize`:@@vendor.im.claimToEdit.label:Claim to edit ${label}:label:`;
  }
  protected requestLabel(label: string): string {
    return $localize`:@@vendor.im.requestChange.label:Request a change to ${label}:label:`;
  }
  protected flagLabel(label: string): string {
    return $localize`:@@vendor.im.flag.label:Open change request on ${label}:label:`;
  }
  protected removeLabel(label: string, product: string): string {
    return $localize`:@@vendor.im.links.removeFor:Remove ${label}:label: for ${product}:product:`;
  }

  protected inputValue(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected readonly pencilPath = PENCIL;
  protected readonly primary = BTN_PRIMARY;
  protected readonly secondary = BTN_SECONDARY;
  protected readonly iconButton = ICON_BUTTON;
  protected readonly rowAction = ROW_ACTION;
  protected readonly alert = ALERT;
  protected readonly valueLinkClass =
    'inline-flex min-w-0 items-center gap-1.5 rounded-(--radius-sm) text-(--text-primary) underline decoration-(--border-strong) underline-offset-4 hover:text-(--accent-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';

  // ── Edits ──────────────────────────────────────────────────────────────────

  protected edit(target: string, value: string | null): void {
    this.draft.set(value ?? '');
    this.error.set(null);
    this.editing.set(target);
    afterNextRender(() => this.editField()?.nativeElement.focus(), { injector: this.injector });
  }

  protected cancel(): void {
    const target = this.editing();
    this.editing.set(null);
    this.error.set(null);
    if (target) this.focusPencil(target);
  }

  /** The record links: `PATCH`, one field, the shared edit rule first. */
  protected async saveRecord(event: Event, field: RecordField): Promise<void> {
    event.preventDefault();
    if (this.busy()) return;
    const raw = this.draft().trim();
    const value = raw === '' ? null : raw;
    const problem = editValueMessage(field, value);
    if (problem) {
      this.error.set(problem);
      return;
    }
    const i = this.integration();
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.api.updateIntegration(i.id, {
        [field]: value,
        context_product_id: i.context_product.id,
      });
      this.store
        .apply('integrations', (list) =>
          list.map((entry) =>
            entry.id === i.id
              ? {
                  ...entry,
                  maintained_by: 'vendor' as const,
                  contestable_fields: { ...entry.contestable_fields, [field]: value },
                }
              : entry,
          ),
        )
        .commit();
      const label = this.fieldLabel(field);
      this.announcer.announce(
        $localize`:@@vendor.im.edit.saved:${label}:label: saved. It is live on the public page.`,
      );
      const target = `record:${field}`;
      this.editing.set(null);
      this.focusPencil(target);
      void this.store.revalidate(['integrations']);
    } catch (err) {
      this.error.set(editSaveErrorMessage(err));
    } finally {
      this.busy.set(false);
    }
  }

  /** A per-side link: `PUT`, or `DELETE` when emptied (§4.5.7). */
  protected async saveSide(
    event: Event,
    group: SideGroup,
    kind: IntegrationLinkKind,
  ): Promise<void> {
    event.preventDefault();
    if (this.busy()) return;
    const value = this.draft().trim();
    if (value !== '') {
      const problem = linkValueProblem(value);
      if (problem) {
        this.error.set(problem);
        return;
      }
    }
    const i = this.integration();
    const target = `side:${group.product.id}:${kind}`;
    this.busy.set(true);
    this.error.set(null);
    try {
      const res =
        value === ''
          ? await this.api.deleteIntegrationLink(i.id, group.product.id, kind)
          : await this.api.putIntegrationLink(i.id, group.product.id, kind, value);
      this.spliceSide(i.id, group.product.id, res.links);
      const product = group.product.name;
      this.announcer.announce(
        value === ''
          ? $localize`:@@vendor.im.links.removed:Your link for ${product}:product: is removed.`
          : $localize`:@@vendor.im.links.saved:Your link for ${product}:product: is saved and live on the public page.`,
      );
      this.editing.set(null);
      this.focusPencil(target);
    } catch (err) {
      this.error.set(linkSaveErrorMessage(err));
    } finally {
      this.busy.set(false);
    }
  }

  /** §4.5.7's read-only Remove on a connector-powered row. */
  protected async removeStranded(kind: IntegrationLinkKind): Promise<void> {
    if (this.busy()) return;
    const i = this.integration();
    this.busy.set(true);
    this.error.set(null);
    try {
      const res = await this.api.deleteIntegrationLink(i.id, i.context_product.id, kind);
      this.spliceSide(i.id, i.context_product.id, res.links);
      const product = i.context_product.name;
      this.announcer.announce(
        $localize`:@@vendor.im.links.removed:Your link for ${product}:product: is removed.`,
      );
    } catch (err) {
      this.error.set(linkSaveErrorMessage(err));
    } finally {
      this.busy.set(false);
    }
  }

  /** One product's side, as the server now stores it, into every entry that shows
   *  it: `own_links` where it is the context, `counterpart_links` where it is the
   *  other side (an owns-both integration lists both). */
  private spliceSide(integrationId: string, productId: string, links: IntegrationSideLinks): void {
    this.store
      .apply('integrations', (list) =>
        list.map((entry) => {
          if (entry.id !== integrationId) return entry;
          if (entry.context_product.id === productId) return { ...entry, own_links: { ...links } };
          if (entry.other_product.id === productId) {
            return { ...entry, counterpart_links: { ...links } };
          }
          return entry;
        }),
      )
      .commit();
  }

  private focusPencil(target: string): void {
    afterNextRender(
      () => {
        this.pencils()
          .find((p) => p.nativeElement.dataset['row'] === target)
          ?.nativeElement.focus();
      },
      { injector: this.injector },
    );
  }
}
