import { AdminLogoEditor } from './admin-logo-editor/admin-logo-editor';
import { DOCUMENT, DatePipe, DecimalPipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
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
import {
  BrnDialog,
  BrnDialogClose,
  BrnDialogContent,
  BrnDialogDescription,
  BrnDialogTitle,
} from '@spartan-ng/brain/dialog';
import { BrnPopover, BrnPopoverContent, BrnPopoverTrigger } from '@spartan-ng/brain/popover';

import type { AdminVendorProductRow, SyncFacts } from '@aeci/shared';
import { roleTakesConnectorKind } from '@aeci/shared/api/connector-kind';

import { AecButton } from '../../shared/button/button';
import { Chip, type ConsoleChipTone } from '../../shared/chip/chip';
import { AecIcon } from '../../shared/icon/icon';
import { NewTabIcon } from '../../shared/new-tab-icon/new-tab-icon';
import { AdminPaginator } from '../admin-paginator';
import { CONSOLE_CAPTION_CLASS, CONSOLE_TABLE } from '../console/console-table';
import { adminStatusTone, type AdminStatusKey } from '../console/status-tones';
import { ConnectorKindControl, connectorKindLabel } from './connector-kind-control';
import { SyncFactsControl } from './sync-facts-control';
import { DeliveredPairsPanel } from './delivered-pairs-panel';
import { ListingHideForm, type ListingHideMode } from './listing-hide-form';
import {
  CONSOLE_FAILED_TEXT_CLASS,
  CONSOLE_LOAD_FAILED_CLASS,
  CONSOLE_STATUS_LINE_CLASS,
} from '../console/console-detail';

type DialogKind = 'logo' | 'kind' | 'facts' | 'pairs' | 'hide' | 'restore';

interface OpenDialog {
  readonly row: AdminVendorProductRow;
  readonly kind: DialogKind;
}

/**
 * The Products tab on `/admin/vendors/:id` — the vendor's catalogue as a table
 * (`ADMIN_PANEL_SPEC.md` §5.7).
 *
 * ── PRESENTATION ONLY ────────────────────────────────────────────────────────
 * Same contract as `<aec-audit-trail>`: rows, page state and the paginator in
 * here; the fetch, the page number and the retry in the page that owns them.
 * That is what lets the tab render its loading, failed and empty states without
 * the parent branching on them.
 *
 * ── WHY A TABLE ──────────────────────────────────────────────────────────────
 * Every field is short and every row has the same fields, and the operator's
 * question is comparative — which of these products is unpromoted, which one
 * carries the integrations, is this vendor a connector shop. Cards would make
 * each row a paragraph and defeat the scan.
 *
 * ── THE COLUMNS ARE A FIRST CUT ──────────────────────────────────────────────
 * Name (+ slug), role, ownership, promotion status, integrations, reviews and
 * record age, plus a link to the public page. Role and promotion status are
 * here because they are the two fields that decide what the operator may do
 * next: role is the §5.2 payer test per product (the Basics block shows only the
 * vendor-level roll-up, which cannot say WHICH product is the connector), and
 * promotion status is the one field that explains a product missing from the
 * public site. There is no admin product detail page to link to, so the name
 * points at the public page in a new tab — same rule as View page in Basics: an
 * operator opens it to CHECK something, so navigating away is the wrong outcome.
 *
 * AECI-955 adds the narrow logo-only content edit exception (Stage 2.5 §11).
 *
 * AECI-1238 adds the per-product listing hide (§11d.6): {@link ListingHideForm}, and a
 * "Hidden from public site" badge on a hidden row. A product hidden with its company is
 * restored only by the company's restore, so its menu offers no Restore and says so.
 * The write is the form's; the table emits {@link listingChanged} and the page refetches.
 *
 * AECI-2036 adds the connector kind, on `connector` and `hybrid` rows only
 * ({@link takesConnectorKind}).
 *
 * ── THE ACTIONS MENU (AECI-2202) ─────────────────────────────────────────────
 * Each row has one "Actions" menu (the vendor portal's `BrnPopover` menu recipe):
 * View public page, Change logo…, Set connector type… and Integrations through this
 * connector… (connector rows), Edit Sync Service facts… (Sync Service rows), and Hide
 * from public site… or Restore to public site…. Every item but View opens the one
 * dialog, with a title naming the product and a line saying what the action does. The
 * Role column shows the connector type as text. A save closes the dialog, announces
 * through the page's region on close, and asks the page for a quiet refetch
 * ({@link edited} or {@link listingChanged}), so focus goes back to the row's Actions.
 *
 * Light theme only (Stage 1 / AECI-226).
 */
@Component({
  selector: 'aec-vendor-products-table',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AdminLogoEditor,
    AdminPaginator,
    AecButton,
    AecIcon,
    BrnDialog,
    BrnDialogClose,
    BrnDialogContent,
    BrnDialogDescription,
    BrnDialogTitle,
    BrnPopover,
    BrnPopoverContent,
    BrnPopoverTrigger,
    Chip,
    ConnectorKindControl,
    DatePipe,
    DecimalPipe,
    DeliveredPairsPanel,
    ListingHideForm,
    NewTabIcon,
    SyncFactsControl,
  ],
  templateUrl: './vendor-products-table.html',
})
export class VendorProductsTable {
  readonly rows = input.required<readonly AdminVendorProductRow[]>();
  readonly page = input.required<number>();
  readonly perPage = input.required<number>();
  readonly total = input.required<number>();
  readonly loading = input.required<boolean>();
  readonly failed = input.required<boolean>();

  readonly announce = output<string>();
  readonly pageChange = output<number>();
  readonly retry = output<void>();
  /** A product hide or restore committed, or the product moved under the operator. */
  readonly listingChanged = output<void>();
  /** A logo, connector type or Sync Service facts save committed. The page refetches
   *  quietly, so the table stays on screen and focus stays on the row's Actions. */
  readonly edited = output<void>();

  // AECI-2112: the console table recipe (mock-up 14).
  protected readonly t = CONSOLE_TABLE;
  protected readonly captionClass = CONSOLE_CAPTION_CLASS;
  protected readonly statusLineClass = CONSOLE_STATUS_LINE_CLASS;
  protected readonly loadFailedClass = CONSOLE_LOAD_FAILED_CLASS;
  protected readonly failedTextClass = CONSOLE_FAILED_TEXT_CLASS;
  /** The open trigger keeps the sunken fill, as the vendor portal's menu does. */
  protected readonly triggerClass = 'gap-1 aria-expanded:bg-(--surface-sunken)';
  /** A menu item: the header account menu's item recipe (`layout/user-menu.ts`). */
  protected readonly itemClass =
    'flex min-h-11 w-full cursor-pointer items-center gap-1 rounded-mark px-3 py-2 text-start text-t-14 text-(--text-primary) no-underline hover:bg-(--surface-sunken) hover:text-(--accent-primary) focus:bg-(--surface-sunken) focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--accent-primary)';

  private readonly injector = inject(Injector);
  private readonly document = inject(DOCUMENT);
  /** By ref: `BrnPopover` extends `BrnDialog`, so a type query would find a row menu. */
  private readonly dialog = viewChild<BrnDialog>('actionDialog');

  /** The row and action the dialog is showing. Kept until `(closed)`, so a child's
   *  last announcement still lands in the dialog's region while it closes. */
  protected readonly dialogFor = signal<OpenDialog | null>(null);
  /** The dialog's own live region (the app root is `aria-hidden` while it is open). */
  protected readonly dialogMessage = signal('');
  /** The open logo editor is saving or removing. Close waits for it (AECI-2112). */
  protected readonly logoSaving = signal(false);
  /** The open type, facts, pairs or listing form has a write in flight. */
  protected readonly childBusy = signal(false);
  /** Any write in the dialog is in flight: Escape and Close wait for it. */
  protected readonly busy = computed(() => this.logoSaving() || this.childBusy());
  /** A save closed the dialog: `(closed)` hands its message to the page's region. */
  private announceOnClose = false;
  /** The row whose save asked for a refetch. Its Actions takes focus back once the
   *  refetched rows land, in case the refetch re-rendered it. */
  private refocusRowId: string | null = null;

  constructor() {
    effect(() => {
      const rows = this.rows();
      const id = this.refocusRowId;
      if (!id || !rows.some((r) => r.id === id)) return;
      this.refocusRowId = null;
      afterNextRender(
        () => {
          // Only when the operator has not moved on: no dialog is open, and focus is
          // still on this row's Actions or was dropped to the body by a re-render.
          if (this.dialogFor()) return;
          const triggerId = this.actionsTriggerId(id);
          const active = this.document.activeElement;
          if (active && active !== this.document.body && active.id !== triggerId) return;
          this.document.getElementById(triggerId)?.focus();
        },
        { injector: this.injector },
      );
    });
  }

  protected readonly isEmpty = computed(() => this.rows().length === 0);

  /** AECI-2046: what the facts form starts from when a row carries none. */
  protected readonly noSyncFacts: SyncFacts = {
    sync_frequency: null,
    sync_support: null,
    sync_setup: null,
    source_url: null,
    recorded_at: null,
  };

  /** A console chip tone, by the console's word for the status. */
  protected tone(key: AdminStatusKey): ConsoleChipTone {
    return adminStatusTone(key);
  }

  protected actionsTriggerId(rowOrId: AdminVendorProductRow | string): string {
    const id = typeof rowOrId === 'string' ? rowOrId : rowOrId.id;
    return `product-actions-${id}`;
  }

  protected actionsLabel(row: AdminVendorProductRow): string {
    const name = row.name;
    return $localize`:@@admin.vendors.products.actions.label:Actions for ${name}:PRODUCT:`;
  }

  /**
   * A menu item's click: an event, so opening the dialog here is safe. Focus moves to
   * the row's Actions before the menu closes, because the dialog returns focus to
   * whatever held it at open, and the menu item is about to be destroyed.
   */
  protected openDialog(row: AdminVendorProductRow, kind: DialogKind, menu: BrnPopover): void {
    this.document.getElementById(this.actionsTriggerId(row))?.focus();
    menu.close();
    this.logoSaving.set(false);
    this.childBusy.set(false);
    this.dialogMessage.set('');
    this.announceOnClose = false;
    this.refocusRowId = null;
    this.dialogFor.set({ row, kind });
    this.dialog()?.open();
  }

  /** Cancel, or the logo editor's Escape. Never mid-save. */
  protected closeDialog(): void {
    if (this.busy()) return;
    this.dialog()?.close();
  }

  /** The CDK closes on Escape from a listener on the document. Stopping the event at
   *  the panel while a write is in flight keeps the form, and its result, alive. */
  protected onDialogEscape(event: Event): void {
    if (!this.busy()) return;
    event.stopPropagation();
    event.preventDefault();
  }

  /** While the dialog is open its region speaks. A late message after close goes to
   *  the page's region. */
  protected onChildAnnounce(message: string): void {
    if (this.dialogFor()) this.dialogMessage.set(message);
    else this.announce.emit(message);
  }

  /** A logo, type or facts save committed. The child announces before it emits
   *  `saved`, except the logo editor, whose "Logo saved." arrives while closing. */
  protected onSaved(): void {
    const open = this.dialogFor();
    if (open) this.refocusRowId = open.row.id;
    this.announceOnClose = true;
    this.logoSaving.set(false);
    this.dialog()?.close();
    this.edited.emit();
  }

  protected onListingDone(mode: ListingHideMode): void {
    this.dialogMessage.set(
      mode === 'hide'
        ? $localize`:@@admin.vendors.products.listing.announce.hidden:Product hidden. It is off the public site, and the vendor was told.`
        : $localize`:@@admin.vendors.products.listing.announce.restored:Product restored. It is back on the public site, and the vendor was told.`,
    );
    this.closeForListing();
  }

  protected onListingStale(message: string): void {
    this.dialogMessage.set(message);
    this.closeForListing();
  }

  private closeForListing(): void {
    const open = this.dialogFor();
    if (open) this.refocusRowId = open.row.id;
    this.announceOnClose = true;
    this.dialog()?.close();
    this.listingChanged.emit();
  }

  protected onDialogClosed(): void {
    if (this.announceOnClose && this.dialogMessage()) this.announce.emit(this.dialogMessage());
    this.announceOnClose = false;
    this.dialogMessage.set('');
    this.logoSaving.set(false);
    this.childBusy.set(false);
    this.dialogFor.set(null);
  }

  protected dialogTitle(d: OpenDialog): string {
    const name = d.row.name;
    switch (d.kind) {
      case 'logo':
        return $localize`:@@admin.vendors.products.dialog.logo.title:Logo for ${name}:PRODUCT:`;
      case 'kind':
        return $localize`:@@admin.vendors.products.dialog.kind.title:Connector type for ${name}:PRODUCT:`;
      case 'facts':
        return $localize`:@@admin.vendors.products.dialog.facts.title:Sync Service facts for ${name}:PRODUCT:`;
      case 'pairs':
        return $localize`:@@admin.vendors.products.dialog.pairs.title:Integrations through ${name}:PRODUCT:`;
      case 'hide':
        return $localize`:@@admin.vendors.products.dialog.hide.title:Hide ${name}:PRODUCT: from the public site`;
      case 'restore':
        return $localize`:@@admin.vendors.products.dialog.restore.title:Restore ${name}:PRODUCT: to the public site`;
    }
  }

  /** The line under the title that says what the action does. The facts form and the
   *  type form explain themselves, so they take none here. */
  protected dialogIntro(d: OpenDialog): string | null {
    const name = d.row.name;
    switch (d.kind) {
      case 'logo':
        return $localize`:@@admin.vendors.products.dialog.logo.intro:The logo shows wherever this product appears on the public site.`;
      case 'pairs':
        return $localize`:@@admin.vendors.products.dialog.pairs.intro:Each integration below connects two other products and runs through ${name}:PRODUCT:. The owner is the vendor who maintains it. Changing the owner clears any claim on the integration.`;
      // Never a count: `integration_count` leaves out the integrations a connector
      // powers without being an endpoint, and those leave the site too.
      case 'hide':
        return this.takesConnectorKind(d.row)
          ? $localize`:@@admin.vendors.products.dialog.hide.intro.connector:Its product page, its search entry, its integrations and every integration it powers leave the public site. Nothing is deleted. You can restore it from the Actions menu.`
          : $localize`:@@admin.vendors.products.dialog.hide.intro:Its product page, its search entry and its integrations leave the public site. Nothing is deleted. You can restore it from the Actions menu.`;
      case 'restore':
        return $localize`:@@admin.vendors.products.dialog.restore.intro:Its product page and its integrations come back to the public site as they were.`;
      default:
        return null;
    }
  }

  /** AECI-2036: only a connector or hybrid product carries a kind. */
  protected takesConnectorKind(row: AdminVendorProductRow): boolean {
    return roleTakesConnectorKind(row.product_role);
  }

  /** The connector type as a line under the role. */
  protected kindLine(row: AdminVendorProductRow): string {
    if (row.connector_kind === null) {
      return $localize`:@@admin.vendors.products.kindLine.unset:Type: not set`;
    }
    const label = connectorKindLabel(row.connector_kind);
    return $localize`:@@admin.vendors.products.kindLine:Type: ${label}:KIND:`;
  }

  /**
   * The role, in the operator's words rather than the column's.
   *
   * The raw values (`application` / `connector` / `hybrid`) are the §8.8 payer
   * vocabulary and mean something specific: an endpoint product is one AECi can
   * sell verification to, and `hybrid` counts as an endpoint. Printing the bare
   * enum would make the reader carry that mapping in their head on the one
   * screen where the decision is taken.
   */
  protected roleLabel(row: AdminVendorProductRow): string {
    switch (row.product_role) {
      case 'connector':
        return $localize`:@@admin.vendors.products.role.connector:Connector`;
      case 'hybrid':
        return $localize`:@@admin.vendors.products.role.hybrid:Hybrid (counts as an endpoint)`;
      default:
        return $localize`:@@admin.vendors.products.role.application:Application`;
    }
  }
}
