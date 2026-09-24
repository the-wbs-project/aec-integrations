import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  InjectionToken,
  Injector,
  afterNextRender,
  computed,
  inject,
  input,
  linkedSignal,
  signal,
  viewChild,
  type OnInit,
} from '@angular/core';

import type { OwnedIntegration } from '@aeci/shared';

import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorApi } from '../vendor-api';
import { vendorHasActiveEntitlement } from '../vendor-capabilities';
import { VendorPortalStore } from '../vendor-portal-store';

import { retireErrorMessage } from './vendor-integration-retire';

/**
 * Render one owned row's retire confirmation open on first paint: the id of the row.
 * Provided ONLY by the dev preview (`/preview/vendor-dashboard/products/<slug>/
 * integrations?retire=<id>`), so `npx impeccable detect`, which reads the first
 * render, can see the open confirmation. Nothing in the product provides it.
 */
export const VENDOR_RETIRE_CONFIRM_START_OPEN = new InjectionToken<string | null>(
  'VENDOR_RETIRE_CONFIRM_START_OPEN',
);

/**
 * Retire and restore on one row of "Integrations your company offers" (AECI-1091 /
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §4.6 and §4.6.3).
 *
 * The owned list (`vendor-owned-integrations.ts`, AECI-1089) is where a third-party
 * owner sees its rows at all: every such row is a `connector_evidenced_pairs` row, and
 * the card list never reads that table. So the owner's retire has to live here too,
 * beside the card's own section (`vendor-integration-retire.ts`). Same route, same
 * rules, same copy where the facts are the same.
 *
 * Four states, decided from the wire:
 *
 * - **Live, claimed, and allowed** — a Retire button. "Allowed" means the row is not
 *   connector-powered, or the vendor holds an active entitlement (AECI-1040 ruling
 *   2). Retiring needs a second, explicit step: the button opens an inline
 *   confirmation that says what will happen, and only its own button sends the
 *   request. No browser `confirm()`.
 * - **Retired by the owner, allowed** — a Restore button. Restore is immediate: it
 *   puts back exactly what was there.
 * - **Retired by AEC Integrations** — a sentence, and no Restore: only an admin
 *   restores an admin retire (AECI-1046).
 * - **Retired, no active plan** — a sentence saying restoring needs a plan.
 *
 * Anything else renders nothing: an unclaimed row has its claim action above, and a
 * claimed row with no plan already says a plan is needed.
 *
 * Writes are pessimistic: the section changes only once the server answers, then
 * revalidates `integrations` (which carries `owned`, and whose freshness cursor the
 * write moves). Outcomes go through the portal's one live region. Focus follows the
 * change: to the confirm button when it opens, back to Retire on cancel, to the
 * status line after a retire, and to Retire after a restore.
 */
@Component({
  selector: 'aec-vendor-owned-retire',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    @switch (state()) {
      @case ('live') {
        <div class="mt-3" data-testid="owned-retire">
          @if (!confirming()) {
            <button
              #trigger
              type="button"
              [class]="secondaryButtonClass"
              (click)="openConfirm()"
              data-testid="owned-retire-trigger"
              i18n="@@vendor.ownedRetire.trigger"
            >
              Retire integration
            </button>
          } @else {
            <div
              role="group"
              [attr.aria-labelledby]="id('title')"
              [attr.aria-describedby]="id('body')"
              class="rounded-(--radius-md) border border-(--border-strong) bg-(--surface-sunken) p-4"
              data-testid="owned-retire-confirm"
            >
              <p
                [id]="id('title')"
                class="text-sm font-semibold text-(--text-primary)"
                i18n="@@vendor.ownedRetire.confirm.title"
              >
                Retire this integration?
              </p>
              <p [id]="id('body')" class="mt-1 max-w-prose text-sm text-(--text-secondary)">
                {{ confirmBody() }}
              </p>
              <div class="mt-3 flex flex-wrap gap-3">
                <button
                  #confirm
                  type="button"
                  [class]="primaryButtonClass"
                  [disabled]="busy()"
                  (click)="onRetire()"
                  data-testid="owned-retire-submit"
                >
                  @if (busy()) {
                    <span i18n="@@vendor.ownedRetire.retiring">Retiring…</span>
                  } @else {
                    <span i18n="@@vendor.ownedRetire.confirm.submit">Retire integration</span>
                  }
                </button>
                <button
                  type="button"
                  [class]="secondaryButtonClass"
                  [disabled]="busy()"
                  (click)="cancelConfirm()"
                  i18n="@@vendor.ownedRetire.confirm.cancel"
                >
                  Keep it live
                </button>
              </div>
            </div>
          }
        </div>
      }
      @case ('restorable') {
        <p
          class="mt-1 max-w-prose text-xs text-(--text-secondary)"
          i18n="@@vendor.ownedRetire.restoreHelp"
        >
          Its data flows and confirmations are kept. Restoring puts it back on the public site as it
          was.
        </p>
        <div class="mt-3">
          <button
            #restoreButton
            type="button"
            [class]="secondaryButtonClass"
            [disabled]="busy()"
            (click)="onRestore()"
            data-testid="owned-restore"
          >
            @if (busy()) {
              <span i18n="@@vendor.ownedRetire.restoring">Restoring…</span>
            } @else {
              <span i18n="@@vendor.ownedRetire.restore">Restore integration</span>
            }
          </button>
        </div>
      }
      @case ('retired-by-aeci') {
        <p
          class="mt-1 max-w-prose text-xs text-(--text-secondary)"
          data-testid="owned-retired-by-aeci"
          i18n="@@vendor.ownedRetire.aeciHelp"
        >
          Its data flows and confirmations are kept. Only AEC Integrations can restore it.
        </p>
      }
      @case ('retired-needs-plan') {
        <p
          class="mt-1 max-w-prose text-xs text-(--text-secondary)"
          data-testid="owned-restore-needs-plan"
          i18n="@@vendor.ownedRetire.restoreNeedsPlan"
        >
          Its data flows and confirmations are kept. Restoring an integration delivered through a
          connector needs an active plan. Contact AEC Integrations to activate or renew it.
        </p>
      }
    }
    @if (notice(); as message) {
      <p role="alert" class="mt-2 text-sm font-medium text-(--text-primary)">{{ message }}</p>
    }
  `,
})
export class VendorOwnedRetire implements OnInit {
  readonly row = input.required<OwnedIntegration>();
  /** Focus target after a retire: the owning row's status line. The list passes it,
   *  because the line lives outside this component. */
  readonly statusLine = input<HTMLElement | null>(null);

  private readonly api = inject(VendorApi);
  private readonly store = inject(VendorPortalStore);
  private readonly announcer = inject(VendorPortalAnnouncer);
  private readonly injector = inject(Injector);

  private readonly entitled = vendorHasActiveEntitlement(this.store);
  private readonly triggerEl = viewChild<ElementRef<HTMLButtonElement>>('trigger');
  private readonly confirmEl = viewChild<ElementRef<HTMLButtonElement>>('confirm');
  private readonly restoreEl = viewChild<ElementRef<HTMLButtonElement>>('restoreButton');

  /** The wire value, overridden by this section's own write until the revalidated
   *  list arrives. `linkedSignal`, so a new `row` input always wins. */
  protected readonly retiredAt = linkedSignal(() => this.row().retired_at);
  protected readonly retiredBy = linkedSignal(() => this.row().retired_by);

  protected readonly confirming = signal(false);

  private readonly startOpenId =
    inject(VENDOR_RETIRE_CONFIRM_START_OPEN, { optional: true }) ?? null;

  /** The dev preview's `?retire=<id>`: open this row's confirmation on first paint.
   *  Once, at init, so a later `row` refresh never reopens or closes it. */
  ngOnInit(): void {
    if (this.startOpenId !== null && this.startOpenId === this.row().id) {
      this.confirming.set(true);
    }
  }
  protected readonly busy = signal(false);
  protected readonly notice = signal<string | null>(null);

  /** Not connector-powered, or entitled: the carve-out's gate (ruling 2). */
  private readonly allowed = computed(() => !this.row().connector_powered || this.entitled());

  protected readonly state = computed<
    'live' | 'restorable' | 'retired-by-aeci' | 'retired-needs-plan' | 'none'
  >(() => {
    const row = this.row();
    if (row.claimed_at === null) return 'none';
    if (this.retiredAt() === null) return this.allowed() ? 'live' : 'none';
    if (this.retiredBy() === 'aeci') return 'retired-by-aeci';
    return this.allowed() ? 'restorable' : 'retired-needs-plan';
  });

  protected readonly confirmBody = computed(() => {
    const row = this.row();
    const a = row.product_a.name;
    const b = row.product_b.name;
    if (row.anchor === 'evidenced_pair' && row.connector) {
      const via = row.connector.name;
      return $localize`:@@vendor.ownedRetire.confirm.bodyPair:It leaves the public site and search, and stops counting on ${a}:a:, ${b}:b: and ${via}:via:. The vendors of ${a}:a: and ${b}:b: are told. Open contests on it close as withdrawn, and restoring it does not reopen them. Its data flows and confirmations are kept, and you can restore it at any time.`;
    }
    return $localize`:@@vendor.ownedRetire.confirm.body:It leaves the public site and search, and stops counting on ${a}:a: and ${b}:b:. Their vendors are told. Open contests on it close as withdrawn, and restoring it does not reopen them. Its data flows and confirmations are kept, and you can restore it at any time.`;
  });

  protected openConfirm(): void {
    this.notice.set(null);
    this.confirming.set(true);
    afterNextRender(() => this.confirmEl()?.nativeElement.focus(), { injector: this.injector });
  }

  protected cancelConfirm(): void {
    this.confirming.set(false);
    this.notice.set(null);
    afterNextRender(() => this.triggerEl()?.nativeElement.focus(), { injector: this.injector });
  }

  protected async onRetire(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.notice.set(null);
    try {
      const { integration } = await this.api.retireIntegration(this.row().id);
      this.busy.set(false);
      this.confirming.set(false);
      this.retiredAt.set(integration.retired_at);
      this.retiredBy.set(integration.retired_by);
      this.announcer.announce(
        $localize`:@@vendor.ownedRetire.live.retired:Integration retired. It no longer appears on the public site.`,
      );
      afterNextRender(() => this.statusLine()?.focus(), { injector: this.injector });
      void this.store.revalidate(['integrations', 'contests']);
    } catch (err) {
      this.busy.set(false);
      this.notice.set(retireErrorMessage(err));
    }
  }

  protected async onRestore(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.notice.set(null);
    try {
      const { integration } = await this.api.restoreIntegration(this.row().id);
      this.busy.set(false);
      this.retiredAt.set(integration.retired_at);
      this.retiredBy.set(integration.retired_by);
      this.announcer.announce(
        $localize`:@@vendor.ownedRetire.live.restored:Integration restored. It is back on the public site.`,
      );
      afterNextRender(() => this.triggerEl()?.nativeElement.focus(), { injector: this.injector });
      void this.store.revalidate(['integrations']);
    } catch (err) {
      this.busy.set(false);
      this.notice.set(retireErrorMessage(err));
      afterNextRender(() => this.restoreEl()?.nativeElement.focus(), { injector: this.injector });
    }
  }

  protected id(key: string): string {
    return `vendor-owned-retire-${this.row().id}-${key}`;
  }

  protected readonly primaryButtonClass =
    'inline-flex items-center justify-center rounded-(--radius-md) border border-(--border-strong) bg-(--accent-primary) px-5 py-2.5 text-sm font-bold text-(--surface-base) transition-colors hover:bg-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) disabled:cursor-not-allowed disabled:opacity-50';
  protected readonly secondaryButtonClass =
    'inline-flex items-center justify-center rounded-(--radius-md) border border-(--border-default) px-4 py-2 text-sm font-medium text-(--text-primary) transition-colors hover:border-(--border-strong) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) disabled:cursor-not-allowed disabled:opacity-50';
}
