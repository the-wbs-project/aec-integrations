import { HttpErrorResponse } from '@angular/common/http';
import {
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  input,
  output,
  signal,
  viewChildren,
  type OnInit,
} from '@angular/core';

import type { AdminDeliveredPair, AdminDeliveredPairsResponse } from '@aeci/shared';
import { compareText } from '@aeci/shared/text-sort';

import { AecButton } from '../../shared/button/button';
import { FIELD_INPUT_CLASS, FIELD_LABEL_CLASS } from '../../shared/form-field/form-field-classes';

import { AdminVendorsApi } from './admin-vendors-api';

type LoadState = 'loading' | 'loaded' | 'failed';

/** The select's value for "No owner". Never a UUID. `null` on the wire. */
const NO_OWNER = '__none__';

/**
 * The pairs one connector product delivers, on the Products tab of `/admin/vendors/:id`
 * (AECI-2045, `ADMIN_PANEL_SPEC.md` §5.7). Both tables, live and retired, with the
 * owner and the claim state, from `GET /api/admin/products/:id/delivered-pairs`. It
 * needs no catalogue row, unlike `/admin/connectors`.
 *
 * Each row's **Change owner** sets `built_by_vendor_id` through
 * `PUT /api/admin/integrations/:id/owner`, with a required reason. The server reuses the
 * owner contest accept's writer, so a reassignment of a claimed pair clears its claim.
 * The response's pair replaces the row in place.
 *
 * Host-owned chrome: announcements go out through {@link announce}, and the page's one
 * live region speaks them, as `ConnectorKindControl` does.
 */
@Component({
  selector: 'aec-delivered-pairs-panel',
  imports: [AecButton],
  template: `
    <section [attr.aria-labelledby]="headingId()" class="space-y-3">
      <!-- The global h3 rule sets its type, so it carries no type utility (AECI-2083). -->
      <h3 [id]="headingId()">
        {{ heading() }}
      </h3>
      @switch (state()) {
        @case ('loading') {
          <p class="text-sm text-(--text-secondary)" i18n="@@admin.deliveredPairs.loading">
            Loading the pairs…
          </p>
        }
        @case ('failed') {
          <div class="flex flex-wrap items-center gap-3">
            <p class="text-sm text-(--text-primary)" i18n="@@admin.deliveredPairs.failed">
              Could not load the pairs this product delivers.
            </p>
            <button
              type="button"
              aecButton
              variant="secondary"
              compact
              (click)="load()"
              i18n="@@admin.deliveredPairs.retry"
            >
              Try again
            </button>
          </div>
        }
        @case ('loaded') {
          @if (pairs().length === 0) {
            <p class="text-sm text-(--text-secondary)" i18n="@@admin.deliveredPairs.empty">
              No pairs are recorded as delivered through this product.
            </p>
          } @else {
            <ul class="m-0 list-none divide-y divide-(--border-default) p-0">
              @for (pair of pairs(); track pair.id) {
                <li class="space-y-1 py-3 text-sm" [attr.data-delivered-pair]="pair.id">
                  <p class="font-bold text-(--text-primary)">{{ title(pair) }}</p>
                  <p class="text-(--text-secondary)">{{ endpoints(pair) }}</p>
                  <p class="text-(--text-primary)" data-testid="delivered-pair-state">
                    {{ ownerLine(pair) }}
                    <span aria-hidden="true"> · </span>
                    {{ claimLabel(pair) }}
                    <span aria-hidden="true"> · </span>
                    {{ liveLabel(pair) }}
                  </p>
                  @if (editingId() === pair.id) {
                    <form
                      method="dialog"
                      class="mt-2 max-w-xl space-y-3"
                      [attr.aria-label]="formLabel(pair)"
                      (submit)="save($event, pair)"
                      novalidate
                    >
                      <p
                        class="text-xs text-(--text-secondary)"
                        i18n="@@admin.deliveredPairs.form.help"
                      >
                        A new owner on a claimed pair clears its claim, and promote can write the
                        row again. On an unclaimed pair the next promote may write the owner back,
                        unless the review app records the same owner.
                      </p>
                      <div class="space-y-1">
                        <label
                          [for]="fieldId(pair, 'owner')"
                          [class]="labelClass"
                          i18n="@@admin.deliveredPairs.form.owner"
                          >Owner</label
                        >
                        <select
                          [id]="fieldId(pair, 'owner')"
                          [class]="inputClass"
                          (change)="pickedOwner.set(selectValue($event))"
                        >
                          <option
                            [value]="noOwner"
                            [selected]="pickedOwner() === noOwner"
                            i18n="@@admin.deliveredPairs.form.noOwner"
                          >
                            No owner
                          </option>
                          @for (choice of choicesFor(pair); track choice.id) {
                            <option [value]="choice.id" [selected]="pickedOwner() === choice.id">
                              {{ choice.name }}
                            </option>
                          }
                        </select>
                      </div>
                      <div class="space-y-1">
                        <label
                          [for]="fieldId(pair, 'reason')"
                          [class]="labelClass"
                          i18n="@@admin.deliveredPairs.form.reasonShown"
                          >Reason (required, shown to the current owner of a claimed pair)</label
                        >
                        <textarea
                          #reasonField
                          [id]="fieldId(pair, 'reason')"
                          rows="2"
                          maxlength="1000"
                          [class]="inputClass"
                          [value]="reason()"
                          [attr.aria-invalid]="formError() ? 'true' : null"
                          (input)="reason.set(textValue($event))"
                        ></textarea>
                      </div>
                      @if (formError(); as message) {
                        <p role="alert" class="text-xs font-medium text-(--text-primary)">
                          {{ message }}
                        </p>
                      }
                      <div class="flex flex-wrap gap-2">
                        <button aecButton compact type="submit" [disabled]="saving()">
                          @if (saving()) {
                            <span i18n="@@admin.deliveredPairs.form.saving">Saving…</span>
                          } @else {
                            <span i18n="@@admin.deliveredPairs.form.save">Save owner</span>
                          }
                        </button>
                        <button
                          type="button"
                          aecButton
                          variant="secondary"
                          compact
                          [disabled]="saving()"
                          (click)="cancel(pair)"
                          i18n="@@admin.deliveredPairs.form.cancel"
                        >
                          Cancel
                        </button>
                      </div>
                    </form>
                  } @else {
                    <button
                      #changeTrigger
                      type="button"
                      [attr.data-change-for]="pair.id"
                      [attr.aria-label]="changeLabel(pair)"
                      aecButton
                      variant="secondary"
                      compact
                      (click)="edit(pair)"
                      i18n="@@admin.deliveredPairs.change"
                    >
                      Change owner
                    </button>
                  }
                </li>
              }
            </ul>
          }
        }
      }
    </section>
  `,
})
export class DeliveredPairsPanel implements OnInit {
  private readonly api = inject(AdminVendorsApi);
  private readonly injector = inject(Injector);

  readonly productId = input.required<string>();
  readonly productName = input.required<string>();
  readonly announce = output<string>();

  private readonly reasonFields = viewChildren<ElementRef<HTMLTextAreaElement>>('reasonField');
  private readonly changeTriggers = viewChildren<ElementRef<HTMLButtonElement>>('changeTrigger');

  protected readonly state = signal<LoadState>('loading');
  private readonly data = signal<AdminDeliveredPairsResponse | null>(null);
  protected readonly pairs = computed(() => this.data()?.pairs ?? []);
  protected readonly editingId = signal<string | null>(null);
  protected readonly pickedOwner = signal(NO_OWNER);
  protected readonly reason = signal('');
  protected readonly saving = signal(false);
  protected readonly formError = signal<string | null>(null);
  protected readonly noOwner = NO_OWNER;

  protected readonly headingId = computed(() => `delivered-pairs-heading-${this.productId()}`);
  protected readonly heading = computed(() => {
    const name = this.productName();
    return $localize`:@@admin.deliveredPairs.heading:Pairs ${name}:PRODUCT: delivers`;
  });

  ngOnInit(): void {
    void this.load();
  }

  protected async load(): Promise<void> {
    this.state.set('loading');
    try {
      this.data.set(await this.api.getDeliveredPairs(this.productId()));
      this.state.set('loaded');
    } catch {
      this.state.set('failed');
    }
  }

  protected title(pair: AdminDeliveredPair): string {
    return (
      pair.name ??
      $localize`:@@admin.deliveredPairs.untitled:${pair.product_a.name}:A: and ${pair.product_b.name}:B:`
    );
  }

  protected endpoints(pair: AdminDeliveredPair): string {
    const a = pair.product_a.name;
    const b = pair.product_b.name;
    return $localize`:@@admin.deliveredPairs.endpoints:Connects ${a}:A: and ${b}:B:`;
  }

  protected ownerLine(pair: AdminDeliveredPair): string {
    const owner = pair.owner?.name;
    return owner
      ? $localize`:@@admin.deliveredPairs.owner:Owner: ${owner}:OWNER:`
      : $localize`:@@admin.deliveredPairs.noOwnerOnFile:No owner on file`;
  }

  protected claimLabel(pair: AdminDeliveredPair): string {
    return pair.claimed_at
      ? $localize`:@@admin.deliveredPairs.claimed:Claimed`
      : $localize`:@@admin.deliveredPairs.notClaimed:Not claimed`;
  }

  protected liveLabel(pair: AdminDeliveredPair): string {
    if (!pair.retired_at) return $localize`:@@admin.deliveredPairs.live:Live`;
    return pair.retired_by === 'aeci'
      ? $localize`:@@admin.deliveredPairs.retiredAeci:Retired by AEC Integrations`
      : $localize`:@@admin.deliveredPairs.retiredOwner:Retired by the owner`;
  }

  protected changeLabel(pair: AdminDeliveredPair): string {
    const name = this.title(pair);
    return $localize`:@@admin.deliveredPairs.change.aria:Change owner: ${name}:PAIR:`;
  }

  protected formLabel(pair: AdminDeliveredPair): string {
    const name = this.title(pair);
    return $localize`:@@admin.deliveredPairs.form.aria:Owner of ${name}:PAIR:`;
  }

  /** The connector's vendors, the pair's endpoint vendors and the owner on file, once
   *  each, A to Z. The write accepts any vendor; these are the ones that can offer it. */
  protected choicesFor(pair: AdminDeliveredPair): { id: string; name: string }[] {
    const all = [
      ...(this.data()?.connector_vendors ?? []),
      ...pair.endpoint_vendors,
      ...(pair.owner ? [pair.owner] : []),
    ];
    const byId = new Map(all.map((v) => [v.id, v]));
    return [...byId.values()].sort(
      (x, y) => compareText(x.name, y.name) || compareText(x.id, y.id),
    );
  }

  protected fieldId(pair: AdminDeliveredPair, field: string): string {
    return `delivered-pair-${pair.id}-${field}`;
  }

  protected selectValue(event: Event): string {
    return (event.target as HTMLSelectElement).value;
  }

  protected textValue(event: Event): string {
    return (event.target as HTMLTextAreaElement).value;
  }

  protected edit(pair: AdminDeliveredPair): void {
    this.editingId.set(pair.id);
    this.pickedOwner.set(pair.owner?.id ?? NO_OWNER);
    this.reason.set('');
    this.formError.set(null);
    afterNextRender(() => this.reasonFields()[0]?.nativeElement.focus(), {
      injector: this.injector,
    });
  }

  protected cancel(pair: AdminDeliveredPair): void {
    this.editingId.set(null);
    this.focusTrigger(pair.id);
  }

  protected async save(event: Event, pair: AdminDeliveredPair): Promise<void> {
    event.preventDefault();
    if (this.saving()) return;
    const reason = this.reason().trim();
    if (reason === '') {
      this.formError.set(
        $localize`:@@admin.deliveredPairs.error.reason:Add a reason. It is kept in the audit log.`,
      );
      this.reasonFields()[0]?.nativeElement.focus();
      return;
    }
    const picked = this.pickedOwner();
    this.saving.set(true);
    this.formError.set(null);
    try {
      const result = await this.api.setIntegrationOwner(pair.id, {
        owner_vendor_id: picked === NO_OWNER ? null : picked,
        reason,
      });
      this.data.update((current) =>
        current
          ? {
              ...current,
              pairs: current.pairs.map((p) => (p.id === result.pair.id ? result.pair : p)),
            }
          : current,
      );
      const name = this.title(result.pair);
      const owner = result.pair.owner?.name;
      this.announce.emit(
        !result.changed
          ? $localize`:@@admin.deliveredPairs.announce.unchanged:${name}:PAIR: already had that owner. Nothing changed.`
          : owner
            ? $localize`:@@admin.deliveredPairs.announce.saved:Owner of ${name}:PAIR: saved: ${owner}:OWNER:.`
            : $localize`:@@admin.deliveredPairs.announce.cleared:${name}:PAIR: now has no owner on file.`,
      );
      this.editingId.set(null);
      this.focusTrigger(pair.id);
    } catch (err) {
      const code = errorCode(err);
      if (code === 'INTEGRATION_CHANGED_WHILE_SAVING') {
        this.formError.set(
          $localize`:@@admin.deliveredPairs.error.changed:The pair changed while you were saving. Nothing was written. The list is reloaded.`,
        );
        void this.load();
      } else {
        this.formError.set(messageForError(err));
      }
    } finally {
      this.saving.set(false);
    }
  }

  private focusTrigger(id: string): void {
    afterNextRender(
      () =>
        this.changeTriggers()
          .find((el) => el.nativeElement.dataset['changeFor'] === id)
          ?.nativeElement.focus(),
      { injector: this.injector },
    );
  }

  /** The Label role (AECI-2083 admin recipe). */
  protected readonly labelClass = FIELD_LABEL_CLASS;
  /** The shared field recipe (`shared/form-field/form-field-classes.ts`). */
  protected readonly inputClass = FIELD_INPUT_CLASS;
}

function errorCode(err: unknown): string | null {
  if (!(err instanceof HttpErrorResponse)) return null;
  return (err.error as { error?: { code?: string } } | null)?.error?.code ?? null;
}

function messageForError(err: unknown): string {
  const code = errorCode(err);
  if (code === 'INTEGRATION_NOT_CONNECTOR_DELIVERED') {
    return $localize`:@@admin.deliveredPairs.error.notDelivered:This row is no longer delivered through a connector, so its owner is not set here. Reload the page.`;
  }
  if (err instanceof HttpErrorResponse) {
    if (err.status === 400 || err.status === 422) {
      return $localize`:@@admin.deliveredPairs.error.invalid:That owner or reason was not accepted. Check both and try again.`;
    }
    if (err.status === 404) {
      return $localize`:@@admin.deliveredPairs.error.gone:This pair or vendor no longer exists. Reload the page.`;
    }
    if (err.status === 403) {
      return $localize`:@@admin.deliveredPairs.error.forbidden:Your session no longer has admin access. Sign in again.`;
    }
  }
  return $localize`:@@admin.deliveredPairs.error.generic:We couldn't save the owner. Try again.`;
}
