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
 * The table renders it only on a `connector` or `hybrid` row, the only roles the
 * endpoint accepts. A pick and an explicit Save, like every other catalog write on this
 * tab: a mis-pick on the select changes nothing until the operator saves.
 *
 * Host-owned chrome, the `MappingEditControl` contract: no live region here.
 * Announcements go out through {@link announce}, and the page's region speaks them.
 */
@Component({
  selector: 'aec-connector-kind-control',
  imports: [AecButton, AecSelect],
  template: `
    <div class="mt-2 flex flex-wrap items-end gap-2">
      <aec-select
        i18n-label="@@admin.vendors.products.connectorKind.label"
        label="Connector kind"
        layout="inline"
        [options]="options"
        [value]="picked()"
        [idPrefix]="'connector-kind-' + productId()"
        (changed)="onPick($event)"
      />
      <button
        aecButton
        variant="secondary"
        compact
        type="button"
        [disabled]="!dirty() || pending()"
        (click)="save()"
      >
        @if (pending()) {
          <span i18n="@@admin.vendors.products.connectorKind.saving">Saving…</span>
        } @else {
          <span i18n="@@admin.vendors.products.connectorKind.save">Save kind</span>
        }
      </button>
    </div>
    @if (failedMessage()) {
      <p class="mt-1 text-xs font-medium text-(--text-primary)" role="alert">
        {{ failedMessage() }}
      </p>
    }
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
    this.failedMessage.set('');
    try {
      const result = await this.api.setConnectorKind(this.productId(), next);
      const name = this.productName();
      const label = connectorKindLabel(result.connector_kind);
      this.announce.emit(
        $localize`:@@admin.vendors.products.connectorKind.announce.saved:Connector kind for ${name}:PRODUCT: saved: ${label}:KIND:.`,
      );
      this.saved.emit(result.connector_kind);
    } catch (err) {
      this.failedMessage.set(messageForError(err));
    } finally {
      this.pending.set(false);
    }
  }
}

function messageForError(err: unknown): string {
  if (err instanceof HttpErrorResponse) {
    const code = (err.error as { error?: { code?: string } } | null)?.error?.code;
    if (code === 'CONNECTOR_KIND_NOT_CONNECTOR') {
      return $localize`:@@admin.vendors.products.connectorKind.error.notConnector:This product is no longer a connector, so it has no kind. Reload the page.`;
    }
    // AECI-2044: only a Sync Service among connectors can hold a subscription.
    if (code === 'CONNECTOR_KIND_SUBSCRIBED') {
      return $localize`:@@admin.vendors.products.connectorKind.error.subscribed:This product holds a live Managed subscription, and that kind cannot hold one. Move or end the subscription first.`;
    }
    if (err.status === 404) {
      return $localize`:@@admin.vendors.products.connectorKind.error.gone:This product no longer exists. Reload the page.`;
    }
    if (err.status === 403) {
      return $localize`:@@admin.vendors.products.connectorKind.error.forbidden:Your session no longer has admin access. Sign in again.`;
    }
  }
  return $localize`:@@admin.vendors.products.connectorKind.error.generic:We couldn't save the connector kind. Try again.`;
}
