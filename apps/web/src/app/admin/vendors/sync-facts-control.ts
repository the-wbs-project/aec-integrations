import { HttpErrorResponse } from '@angular/common/http';
import { Component, computed, inject, input, linkedSignal, output, signal } from '@angular/core';

import {
  HTTPS_URL_MAX_LENGTH,
  SYNC_FACT_MAX_LENGTH,
  type AdminSetSyncFactsInput,
  type SyncFacts,
} from '@aeci/shared';

import { AecButton } from '../../shared/button/button';
import { FIELD_INPUT_CLASS, FIELD_LABEL_CLASS } from '../../shared/form-field/form-field-classes';

import { AdminVendorsApi } from './admin-vendors-api';

/** The four values the form edits. `recorded_at` is the server's stamp. */
type FactKey = keyof AdminSetSyncFactsInput;
type Draft = Record<FactKey, string | null>;

interface FactField {
  readonly key: FactKey;
  readonly label: string;
  readonly max: number;
}

/**
 * The Sync Service facts form on the Products tab of `/admin/vendors/:id` (AECI-2046,
 * ruling 15 on AECI-2035, `ADMIN_PANEL_SPEC.md` §5.7, `STAGE_1_5_SPEC.md` §13.13).
 *
 * Three short text inputs, how often it syncs, who supports it, how setup works, the
 * https link they come from, and one explicit Save, like every other catalog write on
 * this tab. A blank input clears that fact. The link is required while any fact is set:
 * the page marks the facts as ours "with its source and date", as the Terms promise. The table renders it only on a row whose kind is Sync Service, the only product
 * the endpoint accepts. AECi curates these facts. The vendor cannot edit them.
 *
 * Host-owned chrome, the `ConnectorKindControl` contract: no live region here.
 * Announcements go out through {@link announce}, and the page's region speaks them.
 */
@Component({
  selector: 'aec-sync-facts-control',
  imports: [AecButton],
  template: `
    <fieldset class="mt-3 min-w-0 space-y-2 border-0 p-0">
      <legend [class]="labelClass" i18n="@@admin.vendors.products.syncFacts.legend">
        Sync Service facts
      </legend>
      @for (field of fields; track field.key) {
        <div class="space-y-1">
          <label [class]="labelClass" [attr.for]="inputId(field.key)">{{ field.label }}</label>
          <input
            [type]="field.key === 'source_url' ? 'url' : 'text'"
            autocomplete="off"
            [class]="inputClass"
            class="min-w-48"
            [id]="inputId(field.key)"
            [attr.maxlength]="field.max"
            [value]="draft()[field.key] ?? ''"
            (input)="onInput(field.key, $event)"
          />
        </div>
      }
      <button
        aecButton
        variant="secondary"
        compact
        type="button"
        [disabled]="!dirty() || pending()"
        (click)="save()"
      >
        @if (pending()) {
          <span i18n="@@admin.vendors.products.syncFacts.saving">Saving…</span>
        } @else {
          <span i18n="@@admin.vendors.products.syncFacts.save">Save facts</span>
        }
      </button>
      @if (failedMessage()) {
        <p class="text-xs font-medium text-(--text-primary)" role="alert">
          {{ failedMessage() }}
        </p>
      }
    </fieldset>
  `,
})
export class SyncFactsControl {
  /** The Label role (AECI-2083 admin recipe). */
  protected readonly labelClass = FIELD_LABEL_CLASS;
  /** The shared field recipe (`shared/form-field/form-field-classes.ts`). */
  protected readonly inputClass = FIELD_INPUT_CLASS;

  private readonly api = inject(AdminVendorsApi);

  readonly productId = input.required<string>();
  readonly productName = input.required<string>();
  /** The stored facts, each `null` when unset. */
  readonly facts = input.required<SyncFacts>();

  /** The saved facts. The host refetches its rows. */
  readonly saved = output<SyncFacts>();
  readonly announce = output<string>();

  protected readonly fields: readonly FactField[] = [
    {
      key: 'sync_frequency',
      label: $localize`:@@admin.vendors.products.syncFacts.frequency:How often it syncs`,
      max: SYNC_FACT_MAX_LENGTH.sync_frequency,
    },
    {
      key: 'sync_support',
      label: $localize`:@@admin.vendors.products.syncFacts.support:Who supports it`,
      max: SYNC_FACT_MAX_LENGTH.sync_support,
    },
    {
      key: 'sync_setup',
      label: $localize`:@@admin.vendors.products.syncFacts.setup:How setup works`,
      max: SYNC_FACT_MAX_LENGTH.sync_setup,
    },
    {
      key: 'source_url',
      label: $localize`:@@admin.vendors.products.syncFacts.source:Source link (https)`,
      max: HTTPS_URL_MAX_LENGTH,
    },
  ];

  protected readonly draft = linkedSignal<Draft>(() => {
    const f = this.facts();
    return {
      sync_frequency: f.sync_frequency,
      sync_support: f.sync_support,
      sync_setup: f.sync_setup,
      source_url: f.source_url,
    };
  });
  protected readonly pending = signal(false);
  protected readonly failedMessage = signal('');

  /** The draft as the API will store it: trimmed, a blank as `null`. */
  private readonly normalized = computed<Draft>(() => {
    const d = this.draft();
    return {
      sync_frequency: clean(d.sync_frequency),
      sync_support: clean(d.sync_support),
      sync_setup: clean(d.sync_setup),
      source_url: clean(d.source_url),
    };
  });

  protected readonly dirty = computed(() => {
    const now = this.normalized();
    const stored = this.facts();
    return (Object.keys(now) as FactKey[]).some((key) => now[key] !== (stored[key] ?? null));
  });

  protected inputId(key: FactKey): string {
    return `sync-facts-${key}-${this.productId()}`;
  }

  protected onInput(key: FactKey, event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.draft.update((d) => ({ ...d, [key]: value }));
    this.failedMessage.set('');
  }

  protected async save(): Promise<void> {
    if (this.pending() || !this.dirty()) return;
    this.pending.set(true);
    this.failedMessage.set('');
    try {
      const result = await this.api.setSyncFacts(this.productId(), this.normalized());
      const name = this.productName();
      this.announce.emit(
        $localize`:@@admin.vendors.products.syncFacts.announce.saved:Sync Service facts for ${name}:PRODUCT: saved.`,
      );
      this.saved.emit({
        sync_frequency: result.sync_frequency,
        sync_support: result.sync_support,
        sync_setup: result.sync_setup,
        source_url: result.source_url,
        recorded_at: result.recorded_at,
      });
    } catch (err) {
      this.failedMessage.set(messageForError(err));
    } finally {
      this.pending.set(false);
    }
  }
}

function clean(value: string | null): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}

function messageForError(err: unknown): string {
  if (err instanceof HttpErrorResponse) {
    const code = (err.error as { error?: { code?: string } } | null)?.error?.code;
    if (code === 'SYNC_FACTS_NOT_SYNC_SERVICE') {
      return $localize`:@@admin.vendors.products.syncFacts.error.notSyncService:This product is no longer a Sync Service, so it has no sync facts. Reload the page.`;
    }
    if (err.status === 400) {
      return $localize`:@@admin.vendors.products.syncFacts.error.invalid:Check the facts. Each has a length limit, and a set fact needs an https source link.`;
    }
    if (err.status === 404) {
      return $localize`:@@admin.vendors.products.syncFacts.error.gone:This product no longer exists. Reload the page.`;
    }
    if (err.status === 403) {
      return $localize`:@@admin.vendors.products.syncFacts.error.forbidden:Your session no longer has admin access. Sign in again.`;
    }
  }
  return $localize`:@@admin.vendors.products.syncFacts.error.generic:We couldn't save the Sync Service facts. Try again.`;
}
