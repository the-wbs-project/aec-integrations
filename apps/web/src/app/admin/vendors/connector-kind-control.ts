import { HttpErrorResponse } from '@angular/common/http';
import { Component, computed, inject, input, linkedSignal, output, signal } from '@angular/core';

import { CONNECTOR_KINDS, isConnectorKind, type ConnectorKind } from '@aeci/shared';

import { connectorKindLabel as publicConnectorKindLabel } from '../../products/connector-kind-labels';
import { AecSelect, type AecSelectOption } from '../../shared/aec-select/aec-select';
import { AecButton } from '../../shared/button/button';
import { AdminVendorsApi } from './admin-vendors-api';

/**
 * The operator's words for each stored kind. A set kind reads the public label, from
 * the one helper every surface uses (AECI-2037). Only the blank option is admin copy.
 */
export function connectorKindLabel(kind: ConnectorKind | null): string {
  return kind === null
    ? $localize`:@@admin.vendors.products.connectorKind.unset:Not set (shows as Connector)`
    : publicConnectorKindLabel(kind);
}

/**
 * The connector kind control on the Products tab of `/admin/vendors/:id` (AECI-2036,
 * `ADMIN_PANEL_SPEC.md` §5.7, `STAGE_1_5_SPEC.md` §13.13).
 *
 * Since AECI-2202 it sits in the row's "Set connector type…" dialog, which the table
 * offers only on a `connector` or `hybrid` row, the only roles the endpoint accepts.
 * The three kinds are explained above the select. A pick and an explicit Save, like
 * every other catalog write on this tab: a mis-pick changes nothing until the operator
 * saves, and Cancel asks the host to close the dialog.
 *
 * Host-owned chrome, the `MappingEditControl` contract: no live region here.
 * Announcements go out through {@link announce}, and the page's region speaks them.
 */
@Component({
  selector: 'aec-connector-kind-control',
  imports: [AecButton, AecSelect],
  template: `
    <div class="flex flex-col gap-4">
      <ul class="m-0 list-none space-y-2 p-0 text-sm text-(--text-secondary)">
        <li>
          <span
            class="font-semibold text-(--text-primary)"
            i18n="@@admin.vendors.products.connectorKind.help.platformName"
            >Integration platform:</span
          >
          <span i18n="@@admin.vendors.products.connectorKind.help.platform">
            the customer builds the connection from a catalogue of apps, as on Zapier or
            Workato.</span
          >
        </li>
        <li>
          <span
            class="font-semibold text-(--text-primary)"
            i18n="@@admin.vendors.products.connectorKind.help.syncName"
            >Sync Service:</span
          >
          <span i18n="@@admin.vendors.products.connectorKind.help.sync">
            the vendor sells, runs and supports a fixed list of finished pairs, as Agave or Rivets
            Sync do.</span
          >
        </li>
        <li>
          <span
            class="font-semibold text-(--text-primary)"
            i18n="@@admin.vendors.products.connectorKind.help.unsetName"
            >Not set:</span
          >
          <span i18n="@@admin.vendors.products.connectorKind.help.unset">
            the public site shows it as a plain Connector.</span
          >
        </li>
      </ul>
      <aec-select
        class="block"
        i18n-label="@@admin.vendors.products.connectorKind.label"
        label="Connector type"
        layout="stacked"
        [options]="options"
        [value]="picked()"
        [idPrefix]="'connector-kind-' + productId()"
        (changed)="onPick($event)"
      />
      @if (failedMessage()) {
        <p class="text-sm font-medium text-(--text-primary)" role="alert">
          {{ failedMessage() }}
        </p>
      }
      <div class="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        <button
          aecButton
          variant="secondary"
          type="button"
          [disabled]="pending()"
          (click)="cancelled.emit()"
          i18n="@@admin.vendors.products.connectorKind.cancel"
        >
          Cancel
        </button>
        <button
          aecButton
          type="button"
          [disabled]="!dirty() || pending()"
          [attr.aria-busy]="pending() ? 'true' : null"
          (click)="save()"
        >
          @if (pending()) {
            <span i18n="@@admin.vendors.products.connectorKind.saving">Saving…</span>
          } @else {
            <span i18n="@@admin.vendors.products.connectorKind.save">Save type</span>
          }
        </button>
      </div>
    </div>
  `,
})
export class ConnectorKindControl {
  private readonly api = inject(AdminVendorsApi);

  readonly productId = input.required<string>();
  readonly productName = input.required<string>();
  /** The stored kind, `null` when unclassified. */
  readonly kind = input.required<ConnectorKind | null>();

  /** The saved kind. The host refetches its rows. */
  readonly saved = output<ConnectorKind | null>();
  readonly announce = output<string>();
  /** AECI-2202: a write is in flight. The host dialog will not close until it settles,
   *  so the write's result is never emitted from a destroyed component. */
  readonly busyChange = output<boolean>();
  /** Cancel: the host closes its dialog. */
  readonly cancelled = output<void>();

  protected readonly picked = linkedSignal(() => this.kind());
  protected readonly pending = signal(false);
  protected readonly failedMessage = signal('');
  protected readonly dirty = computed(() => this.picked() !== this.kind());

  protected readonly options: readonly AecSelectOption[] = [
    { value: null, label: connectorKindLabel(null) },
    ...CONNECTOR_KINDS.map((value) => ({ value, label: connectorKindLabel(value) })),
  ];

  protected onPick(value: string | null): void {
    this.picked.set(isConnectorKind(value) ? value : null);
    this.failedMessage.set('');
  }

  protected async save(): Promise<void> {
    if (this.pending() || !this.dirty()) return;
    const next = this.picked();
    this.pending.set(true);
    this.busyChange.emit(true);
    this.failedMessage.set('');
    try {
      const result = await this.api.setConnectorKind(this.productId(), next);
      const name = this.productName();
      const label = connectorKindLabel(result.connector_kind);
      this.announce.emit(
        $localize`:@@admin.vendors.products.connectorKind.announce.saved:Connector type for ${name}:PRODUCT: saved: ${label}:KIND:.`,
      );
      this.saved.emit(result.connector_kind);
    } catch (err) {
      this.failedMessage.set(messageForError(err));
    } finally {
      this.pending.set(false);
      this.busyChange.emit(false);
    }
  }
}

function messageForError(err: unknown): string {
  if (err instanceof HttpErrorResponse) {
    const code = (err.error as { error?: { code?: string } } | null)?.error?.code;
    if (code === 'CONNECTOR_KIND_NOT_CONNECTOR') {
      return $localize`:@@admin.vendors.products.connectorKind.error.notConnector:This product is no longer a connector, so it has no type. Reload the page.`;
    }
    // AECI-2044: only a Sync Service among connectors can hold a subscription.
    if (code === 'CONNECTOR_KIND_SUBSCRIBED') {
      return $localize`:@@admin.vendors.products.connectorKind.error.subscribed:This product holds a live Managed subscription, and that type cannot hold one. Move or end the subscription first.`;
    }
    if (err.status === 404) {
      return $localize`:@@admin.vendors.products.connectorKind.error.gone:This product no longer exists. Reload the page.`;
    }
    if (err.status === 403) {
      return $localize`:@@admin.vendors.products.connectorKind.error.forbidden:Your session no longer has admin access. Sign in again.`;
    }
  }
  return $localize`:@@admin.vendors.products.connectorKind.error.generic:We couldn't save the connector type. Try again.`;
}
