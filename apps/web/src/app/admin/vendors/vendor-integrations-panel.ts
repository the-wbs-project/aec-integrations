import { DatePipe, DOCUMENT } from '@angular/common';
import {
  Component,
  ElementRef,
  InjectionToken,
  Injector,
  afterNextRender,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';

import { ADMIN_RETIRE_REASON_MAX, type AdminVendorIntegrationRow } from '@aeci/shared';

import { NewTabIcon } from '../../shared/new-tab-icon/new-tab-icon';
import { AdminVendorsApi } from './admin-vendors-api';

/** Rows per fetch. The API caps a page at 100; a vendor owning more is told so. */
export const INTEGRATIONS_PAGE_SIZE = 100;

/**
 * Open one row's retire (or restore) form once the list loads: the row's id.
 * Provided ONLY by the dev preview (`/preview/admin-vendor-integrations?retire=<id>`,
 * AECI-1091) so the design detector and the axe pass can see the open form without
 * an admin session. Nothing in the product provides it.
 */
export const ADMIN_RETIRE_FORM_START_OPEN = new InjectionToken<string | null>(
  'ADMIN_RETIRE_FORM_START_OPEN',
);

type Mode = 'retire' | 'restore';

/**
 * The Integrations tab on `/admin/vendors/:id` (AECI-1046 / `ADMIN_PANEL_SPEC.md`
 * §5.7): the vendor-held integrations this vendor owns, and the admin retire and
 * restore of one.
 *
 * Why here: there is no admin integration page, and the vendor page is where an
 * operator already acts on a vendor's account. The list is scoped to rows the admin
 * write accepts (vendor-held), so every action offered is one the API will take.
 *
 * The action is a second, explicit step, as the portal's owner retire is. The button
 * opens an inline form under the row with a required reason, and only its own submit
 * sends the request. No browser dialog. Writes are pessimistic: the row changes when
 * the server answers, and the outcome goes to the page's one live region through
 * `announce`. The write's audit row files under the integration, not the vendor, so
 * this page's Audit Trail tab does not show it.
 *
 * Restore is offered only on an AECi retire. An owner retire is the owner's to undo
 * (ruled 2026-09-22), so that row says so and offers nothing.
 *
 * Since AECI-1091 the list also carries the vendor's vendor-held evidenced pairs
 * (`anchor: 'evidenced_pair'`). A pair row names the connector it is delivered
 * through, and its retire form says the row stops counting on that connector too.
 * The action and the route are the same.
 */
@Component({
  selector: 'aec-vendor-integrations-panel',
  imports: [DatePipe, NewTabIcon],
  templateUrl: './vendor-integrations-panel.html',
})
export class VendorIntegrationsPanel {
  readonly vendorId = input.required<string>();
  readonly announce = output<string>();

  private readonly api = inject(AdminVendorsApi);
  private readonly injector = inject(Injector);
  private readonly document = inject(DOCUMENT);
  private readonly startOpenId = inject(ADMIN_RETIRE_FORM_START_OPEN, { optional: true }) ?? null;

  protected readonly rows = signal<readonly AdminVendorIntegrationRow[]>([]);
  protected readonly total = signal(0);
  protected readonly loading = signal(true);
  protected readonly failed = signal(false);

  /** The row whose form is open, and which action it is for. */
  protected readonly formFor = signal<{ id: string; mode: Mode } | null>(null);
  protected readonly reason = signal('');
  protected readonly pending = signal(false);
  protected readonly formError = signal<string | null>(null);

  protected readonly reasonMax = ADMIN_RETIRE_REASON_MAX;
  protected readonly perPage = INTEGRATIONS_PAGE_SIZE;
  protected readonly truncated = computed(() => this.total() > this.rows().length);

  private readonly reasonEl = viewChild<ElementRef<HTMLTextAreaElement>>('reasonInput');

  constructor() {
    afterNextRender(() => void this.load());
  }

  protected async load(): Promise<void> {
    this.loading.set(true);
    this.failed.set(false);
    try {
      const res = await this.api.listIntegrations(this.vendorId(), {
        page: 1,
        perPage: INTEGRATIONS_PAGE_SIZE,
      });
      this.rows.set(res.data);
      this.total.set(res.total);
      const startOpen = res.data.find((row) => row.id === this.startOpenId);
      if (startOpen && this.formFor() === null) {
        this.formFor.set({ id: startOpen.id, mode: startOpen.retired_at ? 'restore' : 'retire' });
      }
    } catch {
      this.failed.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  protected pairLabel(row: AdminVendorIntegrationRow): string {
    return `${row.source.name} ↔ ${row.target.name}`;
  }

  protected statusLabel(row: AdminVendorIntegrationRow): string {
    if (row.retired_by === 'aeci') {
      return $localize`:@@admin.vendors.integrations.status.aeci:Retired by AEC Integrations`;
    }
    if (row.retired_by === 'owner') {
      return $localize`:@@admin.vendors.integrations.status.owner:Retired by the owner`;
    }
    return $localize`:@@admin.vendors.integrations.status.live:Live`;
  }

  protected openForm(row: AdminVendorIntegrationRow, mode: Mode): void {
    this.formFor.set({ id: row.id, mode });
    this.reason.set('');
    this.formError.set(null);
    afterNextRender(() => this.reasonEl()?.nativeElement.focus(), { injector: this.injector });
  }

  protected closeForm(row: AdminVendorIntegrationRow): void {
    this.formFor.set(null);
    this.formError.set(null);
    afterNextRender(() => this.document.getElementById(this.triggerId(row))?.focus(), {
      injector: this.injector,
    });
  }

  protected onReasonInput(event: Event): void {
    this.reason.set((event.target as HTMLTextAreaElement).value);
  }

  protected async submit(row: AdminVendorIntegrationRow, mode: Mode): Promise<void> {
    if (this.pending()) return;
    const reason = this.reason().trim();
    if (!reason) {
      this.formError.set(
        $localize`:@@admin.vendors.integrations.reason.required:Enter a reason. It is recorded in the audit trail.`,
      );
      this.reasonEl()?.nativeElement.focus();
      return;
    }
    this.pending.set(true);
    this.formError.set(null);
    try {
      const res = await this.api.setIntegrationRetired(row.id, mode, reason);
      this.rows.update((rows) =>
        rows.map((r) =>
          r.id === row.id
            ? {
                ...r,
                retired_at: res.integration.retired_at,
                retired_by: res.integration.retired_by,
                updated_at: res.integration.updated_at,
              }
            : r,
        ),
      );
      this.formFor.set(null);
      this.announce.emit(
        mode === 'retire'
          ? $localize`:@@admin.vendors.integrations.announce.retired:Integration retired. It is off the public site, and the vendors on it were told.`
          : $localize`:@@admin.vendors.integrations.announce.restored:Integration restored. It is back on the public site.`,
      );
      afterNextRender(() => this.document.getElementById(this.triggerId(row))?.focus(), {
        injector: this.injector,
      });
    } catch (err) {
      this.formError.set(adminRetireErrorMessage(err));
      const code = errorCode(err);
      // Someone else changed the row. Reload so the list shows the state that won.
      if (
        code === 'INTEGRATION_RETIRED' ||
        code === 'INTEGRATION_NOT_RETIRED' ||
        code === 'INTEGRATION_RETIRED_BY_OWNER' ||
        code === 'INTEGRATION_NOT_VENDOR_HELD' ||
        code === 'INTEGRATION_CHANGED_WHILE_SAVING'
      ) {
        this.formFor.set(null);
        this.announce.emit(adminRetireErrorMessage(err));
        void this.load();
      }
    } finally {
      this.pending.set(false);
    }
  }

  protected isFormOpen(row: AdminVendorIntegrationRow, mode: Mode): boolean {
    const open = this.formFor();
    return open?.id === row.id && open.mode === mode;
  }

  protected triggerId(row: AdminVendorIntegrationRow): string {
    return `admin-integration-action-${row.id}`;
  }

  protected formId(row: AdminVendorIntegrationRow, key: string): string {
    return `admin-integration-${row.id}-${key}`;
  }
}

/** The `code` from the API's `{ error: { code } }` envelope, read structurally
 *  (see `http-status.ts` for why not `instanceof`). */
function errorCode(err: unknown): string | null {
  const inner = (err as { error?: { error?: { code?: unknown } } } | null)?.error?.error;
  return typeof inner?.code === 'string' ? inner.code : null;
}

/** One message per refusal the two admin routes can answer. */
export function adminRetireErrorMessage(err: unknown): string {
  switch (errorCode(err)) {
    case 'INTEGRATION_RETIRED':
      return $localize`:@@admin.vendors.integrations.error.retired:This integration is already retired. The list has been reloaded.`;
    case 'INTEGRATION_NOT_RETIRED':
      return $localize`:@@admin.vendors.integrations.error.notRetired:This integration is already live. The list has been reloaded.`;
    case 'INTEGRATION_RETIRED_BY_OWNER':
      return $localize`:@@admin.vendors.integrations.error.byOwner:The owner retired this integration, so only the owner can restore it. The list has been reloaded.`;
    case 'INTEGRATION_NOT_VENDOR_HELD':
      return $localize`:@@admin.vendors.integrations.error.notVendorHeld:AEC Integrations maintains this integration now, so change it through the review app, not here. The list has been reloaded.`;
    case 'INTEGRATION_CHANGED_WHILE_SAVING':
      return $localize`:@@admin.vendors.integrations.error.changed:This integration changed while you were saving. The list has been reloaded.`;
    case 'VALIDATION_FAILED':
      return $localize`:@@admin.vendors.integrations.error.validation:Enter a reason of up to 1,000 characters.`;
    case 'RATE_LIMITED':
      return $localize`:@@admin.vendors.integrations.error.rate:Too many requests in a short time. Wait a minute and try again.`;
    default:
      return $localize`:@@admin.vendors.integrations.error.generic:Could not save the change. Try again.`;
  }
}
