import {
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  effect,
  inject,
  input,
  signal,
  viewChildren,
} from '@angular/core';

import type { VendorDeliveredPair } from '@aeci/shared';

import { AecButton } from '../../shared/button/button';
import {
  FIELD_ERROR_CLASS,
  FIELD_INPUT_CLASS,
  FIELD_LABEL_CLASS,
} from '../../shared/form-field/form-field-classes';
import { CloseOnEscape } from '../shared/close-on-escape';
import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorApi } from '../vendor-api';
import { readVendorApiError } from '../vendor-api-error';
import { VendorPortalStore } from '../vendor-portal-store';

type LoadState = 'idle' | 'loading' | 'loaded' | 'failed';

/** The reason's limit, as `SubmitIntegrationContestSchema` sets it. */
const REASON_MAX = 2000;

/**
 * "Pairs recorded under another company" on a Sync Service product's Integrations tab
 * (AECI-2045, `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.13a).
 *
 * The live pairs recorded as delivered through this product whose owner is not the
 * caller: nobody, or another company. Read-only, from
 * `GET /api/vendor/products/:id/delivered-pairs`. Each row offers one action, asking
 * AEC Integrations to record the caller as the company that offers it. That is an
 * `owner` contest naming the caller (§11b.2), which always goes to AEC Integrations
 * (§11b.4). A row with an open request says so and offers no second one.
 *
 * Fetched in the browser when the tab mounts and on every product switch, like the
 * Connectors section beside it. Outside the live cursor. Renders nothing when empty.
 * The write is pessimistic and re-reads the list.
 */
@Component({
  selector: 'aec-vendor-delivered-pairs',
  imports: [AecButton, CloseOnEscape],
  host: { class: 'block' },
  template: `
    @if (state() === 'failed') {
      <div class="space-y-2" data-delivered-pairs-failed>
        <p class="text-sm text-(--text-primary)" i18n="@@vendor.deliveredPairs.failed">
          Could not load the pairs recorded under another company.
        </p>
        <button
          type="button"
          aecButton
          variant="secondary"
          (click)="retry()"
          i18n="@@vendor.deliveredPairs.retry"
        >
          Try again
        </button>
      </div>
    } @else if (pairs().length > 0) {
      <section
        class="space-y-4"
        aria-labelledby="vendor-delivered-pairs-heading"
        data-delivered-pairs
      >
        <div class="space-y-2">
          <h2 id="vendor-delivered-pairs-heading" class="m-0">
            <span
              class="block font-display text-xl font-semibold text-(--text-primary)"
              i18n="@@vendor.deliveredPairs.heading"
              >Pairs recorded under another company</span
            >
          </h2>
          <p
            class="max-w-prose text-sm text-(--text-secondary)"
            i18n="@@vendor.deliveredPairs.intro"
          >
            These pairs are recorded as delivered through your Sync Service, but another company, or
            no company, is recorded as the one that offers them. If your company offers one, ask AEC
            Integrations to record you. We check it and tell you what we decided.
          </p>
        </div>
        <ul class="m-0 list-none space-y-4 p-0">
          @for (pair of pairs(); track pair.id) {
            <li
              class="rounded-panel border border-(--border-default) bg-(--surface-raised) px-4 py-3"
              [attr.data-delivered-pair]="pair.id"
            >
              <h3 class="m-0">
                <span class="block font-display text-lg font-semibold text-(--text-primary)">{{
                  title(pair)
                }}</span>
              </h3>
              <p class="mt-1 text-sm text-(--text-secondary)" data-testid="delivered-owner">
                {{ ownerLine(pair) }}
              </p>
              @if (pair.open_request_id) {
                <p
                  #status
                  tabindex="-1"
                  [attr.data-status-for]="pair.id"
                  class="mt-2 max-w-prose text-sm text-(--text-primary) focus:outline-none"
                  data-testid="delivered-pending"
                  i18n="@@vendor.deliveredPairs.pending"
                >
                  Your request is with AEC Integrations. We tell you when we decide.
                </p>
              } @else if (askingId() === pair.id) {
                <form
                  aecCloseOnEscape
                  [escapeBusy]="sending()"
                  (escapeCancel)="cancel(pair)"
                  method="dialog"
                  class="mt-3 max-w-2xl space-y-3"
                  (submit)="send($event, pair)"
                  novalidate
                >
                  <div class="space-y-1">
                    <label
                      [for]="reasonId(pair)"
                      [class]="labelClass"
                      i18n="@@vendor.deliveredPairs.reason.label"
                      >Why your company offers it (required)</label
                    >
                    <p
                      [id]="reasonId(pair) + '-hint'"
                      class="text-xs text-(--text-secondary)"
                      i18n="@@vendor.deliveredPairs.reason.hint"
                    >
                      Only AEC Integrations sees this. A link to your own page for the pair helps us
                      check it.
                    </p>
                    <textarea
                      #reasonField
                      [id]="reasonId(pair)"
                      rows="3"
                      [attr.maxlength]="reasonMax"
                      [value]="reason()"
                      (input)="reason.set(valueOf($event))"
                      [attr.aria-invalid]="reasonError() ? 'true' : null"
                      [attr.aria-describedby]="
                        reasonId(pair) +
                        '-hint' +
                        (reasonError() ? ' ' + reasonId(pair) + '-error' : '')
                      "
                      [class]="inputClass"
                    ></textarea>
                    @if (reasonError(); as message) {
                      <p [id]="reasonId(pair) + '-error'" [class]="errorClass">{{ message }}</p>
                    }
                  </div>
                  <div class="flex flex-wrap items-center gap-2">
                    <button
                      type="submit"
                      aecButton
                      [disabled]="sending()"
                      data-testid="delivered-send"
                    >
                      @if (sending()) {
                        <span i18n="@@vendor.deliveredPairs.sending">Sending…</span>
                      } @else {
                        <span i18n="@@vendor.deliveredPairs.send">Send request</span>
                      }
                    </button>
                    <button
                      type="button"
                      aecButton
                      variant="secondary"
                      [disabled]="sending()"
                      (click)="cancel(pair)"
                      i18n="@@vendor.deliveredPairs.cancel"
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              } @else {
                <div class="mt-3">
                  <button
                    #askTrigger
                    type="button"
                    [attr.data-ask-for]="pair.id"
                    aecButton
                    variant="secondary"
                    (click)="ask(pair)"
                    data-testid="delivered-ask"
                    i18n="@@vendor.deliveredPairs.ask"
                  >
                    Ask AEC Integrations to record us as the company that offers this
                  </button>
                </div>
              }
              @if (notice()?.id === pair.id) {
                <p role="alert" class="mt-3 text-sm font-medium text-(--text-primary)">
                  {{ notice()!.message }}
                </p>
              }
            </li>
          }
        </ul>
      </section>
    }
  `,
})
export class VendorDeliveredPairs {
  /** The Sync Service product whose tab this renders on. Nothing is fetched while empty. */
  readonly productId = input.required<string>();

  private readonly api = inject(VendorApi);
  private readonly store = inject(VendorPortalStore);
  private readonly announcer = inject(VendorPortalAnnouncer);
  private readonly injector = inject(Injector);

  private readonly reasonFields = viewChildren<ElementRef<HTMLTextAreaElement>>('reasonField');
  private readonly askTriggers = viewChildren<ElementRef<HTMLButtonElement>>('askTrigger');
  private readonly statusLines = viewChildren<ElementRef<HTMLElement>>('status');

  protected readonly state = signal<LoadState>('idle');
  protected readonly pairs = signal<readonly VendorDeliveredPair[]>([]);
  protected readonly askingId = signal<string | null>(null);
  protected readonly reason = signal('');
  protected readonly reasonError = signal<string | null>(null);
  protected readonly sending = signal(false);
  protected readonly notice = signal<{ id: string; message: string } | null>(null);
  protected readonly reasonMax = REASON_MAX;

  /** Browser-only: the read carries the session cookie and never runs during SSR. */
  private readonly rendered = signal(false);

  constructor() {
    afterNextRender(() => this.rendered.set(true));
    effect(() => {
      if (!this.rendered()) return;
      const id = this.productId();
      if (!id) return;
      void this.load(id, true);
    });
  }

  protected title(pair: VendorDeliveredPair): string {
    return (
      pair.name ??
      $localize`:@@vendor.deliveredPairs.untitled:${pair.product_a.name}:a: and ${pair.product_b.name}:b:`
    );
  }

  protected ownerLine(pair: VendorDeliveredPair): string {
    const owner = pair.owner?.name;
    return owner
      ? $localize`:@@vendor.deliveredPairs.owner:Recorded owner: ${owner}:owner:`
      : $localize`:@@vendor.deliveredPairs.noOwner:No owner is recorded.`;
  }

  protected reasonId(pair: VendorDeliveredPair): string {
    return `vendor-delivered-reason-${pair.id}`;
  }

  protected valueOf(event: Event): string {
    return (event.target as HTMLTextAreaElement).value;
  }

  protected retry(): void {
    const id = this.productId();
    if (id) void this.load(id, true);
  }

  protected ask(pair: VendorDeliveredPair): void {
    this.notice.set(null);
    this.reason.set('');
    this.reasonError.set(null);
    this.askingId.set(pair.id);
    afterNextRender(() => this.reasonFields()[0]?.nativeElement.focus(), {
      injector: this.injector,
    });
  }

  protected cancel(pair: VendorDeliveredPair): void {
    this.askingId.set(null);
    this.focusAsk(pair.id);
  }

  protected async send(event: Event, pair: VendorDeliveredPair): Promise<void> {
    event.preventDefault();
    if (this.sending()) return;
    const reason = this.reason().trim();
    if (reason === '') {
      this.reasonError.set(
        $localize`:@@vendor.deliveredPairs.reason.required:Say why your company offers this pair.`,
      );
      this.reasonFields()[0]?.nativeElement.focus();
      return;
    }
    const me = this.store.me()?.vendor.id;
    if (!me) return;
    this.sending.set(true);
    this.notice.set(null);
    try {
      await this.api.submitContest(
        pair.id,
        { field: 'owner', proposed_value: me, reason },
        pair.anchor,
      );
      this.announcer.announce(
        $localize`:@@vendor.deliveredPairs.live.sent:Your request is with AEC Integrations. We tell you when we decide.`,
      );
      this.askingId.set(null);
      await Promise.all([this.store.revalidate(['contests']), this.load(this.productId(), false)]);
      afterNextRender(
        () =>
          this.statusLines()
            .find((el) => el.nativeElement.dataset['statusFor'] === pair.id)
            ?.nativeElement.focus(),
        { injector: this.injector },
      );
    } catch (err) {
      this.notice.set({ id: pair.id, message: sendErrorMessage(err) });
      if (readVendorApiError(err)?.code === 'CONTEST_DUPLICATE') {
        this.askingId.set(null);
        await this.load(this.productId(), false);
      }
    } finally {
      this.sending.set(false);
    }
  }

  private focusAsk(id: string): void {
    afterNextRender(
      () =>
        this.askTriggers()
          .find((el) => el.nativeElement.dataset['askFor'] === id)
          ?.nativeElement.focus(),
      { injector: this.injector },
    );
  }

  /** `clear` on a product switch, so the previous product's pairs never show here. */
  private async load(productId: string, clear: boolean): Promise<void> {
    if (clear) {
      this.state.set('loading');
      this.pairs.set([]);
      this.askingId.set(null);
    }
    try {
      const res = await this.api.listDeliveredPairs(productId);
      if (this.productId() !== productId) return;
      this.pairs.set(res.pairs);
      this.state.set('loaded');
    } catch {
      if (this.productId() !== productId) return;
      this.state.set('failed');
    }
  }

  protected readonly errorClass = FIELD_ERROR_CLASS;
  protected readonly labelClass = FIELD_LABEL_CLASS;
  /** The shared field recipe (`shared/form-field/form-field-classes.ts`). */
  protected readonly inputClass = FIELD_INPUT_CLASS;
}

/** One sentence per refusal the request can collect. */
export function sendErrorMessage(err: unknown): string {
  const info = readVendorApiError(err);
  switch (info?.code) {
    case 'CONTEST_DUPLICATE':
      return $localize`:@@vendor.deliveredPairs.error.duplicate:You already asked about this pair. Your request is with AEC Integrations.`;
    case 'CONTEST_CONNECTOR_OWNER_ONLY':
      return $localize`:@@vendor.deliveredPairs.error.ownerOnly:You can only ask to be recorded as the company that offers this pair. Reload and try again.`;
    case 'RATE_LIMITED':
      return $localize`:@@vendor.deliveredPairs.error.rate:Too many requests in a short time. Wait a minute and try again.`;
  }
  if (info?.status === 404) {
    return $localize`:@@vendor.deliveredPairs.error.gone:This pair is no longer listed. Reload to see where it stands.`;
  }
  return $localize`:@@vendor.deliveredPairs.error.generic:Could not send your request. Try again.`;
}
