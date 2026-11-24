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

import type { VendorIntegration } from '@aeci/shared';

import { retireErrorMessage } from '../components/vendor-integration-ownership-labels';
import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorApi } from '../vendor-api';
import { VendorPortalStore } from '../vendor-portal-store';

import { formatDay } from './integration-detail-model';
import { AecButton } from '../../shared/button/button';

import { ALERT, ID_STYLES } from './integration-detail-styles';

/** The settings panel: the default edge. "Yes, retire it" is the danger button, because
 *  a retire closes other companies' open requests and row threads and Restore reopens
 *  none (§4.6.1, DESIGN.md §5 Buttons). The opener stays secondary. */
const PANEL = 'rounded-panel border border-(--border-default) p-4 text-sm';

/**
 * Settings (AECI-1149, `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.17.7): retire and
 * restore from §4.6, as one bordered area. No new route or rule.
 *
 * Retire takes an inline confirmation, never `confirm()`: "Retire it now?" with
 * "Yes, retire it" and Cancel. Only that button sends. Focus moves to the confirm
 * button, back to the trigger on Cancel, and to the status line after a retire.
 * A connector-powered row retires and restores like any other: the seat is the whole
 * gate (ruling 14, AECI-1663). Writes are pessimistic and announced through the one
 * live region.
 */
@Component({
  selector: 'aec-integration-settings',
  imports: [AecButton],
  styles: [ID_STYLES],
  template: `
    @switch (view()) {
      @case ('retire') {
        <div [class]="panelClass" data-testid="settings-retire">
          <p class="font-semibold text-(--text-primary)" i18n="@@vendor.im.settings.retireTitle">
            Retire this integration
          </p>
          <p
            class="mt-1 max-w-prose text-(--text-secondary)"
            i18n="@@vendor.im.settings.retireBody"
          >
            Retiring hides it from the public page and from search, and closes any open correction
            requests. You can restore it later.
          </p>
          @if (confirming()) {
            <div class="mt-3 flex flex-wrap items-center gap-3">
              <span class="text-(--text-primary)" i18n="@@vendor.im.settings.retireConfirm"
                >Retire it now?</span
              >
              <button
                aecButton
                variant="danger"
                compact
                #confirm
                type="button"
                [disabled]="busy()"
                (click)="retire()"
                data-testid="retire-confirm"
                i18n="@@vendor.im.settings.retireYes"
              >
                Yes, retire it
              </button>
              <button
                aecButton
                variant="secondary"
                compact
                type="button"
                [disabled]="busy()"
                (click)="cancel()"
                i18n="@@vendor.im.settings.cancel"
              >
                Cancel
              </button>
            </div>
          } @else {
            <button
              aecButton
              variant="secondary"
              compact
              #trigger
              type="button"
              [class]="'mt-3'"
              (click)="openConfirm()"
              data-testid="retire-open"
              i18n="@@vendor.im.settings.retireButton"
            >
              Retire integration
            </button>
          }
        </div>
      }
      @case ('restore') {
        <div [class]="panelClass" data-testid="settings-restore">
          <p
            #status
            tabindex="-1"
            class="font-semibold text-(--text-primary) focus:outline-none"
            i18n="@@vendor.im.settings.retiredTitle"
          >
            This integration is retired
          </p>
          <p class="mt-1 max-w-prose text-(--text-secondary)">{{ retiredLine() }}</p>
          <button
            aecButton
            variant="secondary"
            compact
            #trigger
            type="button"
            [class]="'mt-3'"
            [disabled]="busy()"
            (click)="restore()"
            data-testid="restore"
            i18n="@@vendor.im.settings.restore"
          >
            Restore integration
          </button>
        </div>
      }
      @case ('retired-by-aeci') {
        <div [class]="panelClass" data-testid="settings-retired-aeci">
          <p #status tabindex="-1" class="font-semibold text-(--text-primary) focus:outline-none">
            {{ retiredByAeciLine() }}
          </p>
          <p class="mt-1 max-w-prose text-(--text-secondary)" i18n="@@vendor.im.settings.aeciOnly">
            Only AEC Integrations can restore it.
          </p>
        </div>
      }
      @case ('retired-other') {
        <p class="max-w-prose text-sm text-(--text-secondary)" data-testid="settings-retired-other">
          {{ retiredOtherLine() }}
        </p>
      }
      @case ('unclaimed') {
        <p
          class="max-w-prose text-sm text-(--text-secondary)"
          i18n="@@vendor.im.settings.unclaimed"
        >
          Once you claim this integration, you can retire it here if it is no longer offered.
        </p>
      }
      @default {
        <p
          class="max-w-prose text-sm text-(--text-secondary)"
          data-testid="settings-not-owner"
          i18n="@@vendor.im.settings.notOwner"
        >
          Only the owner can retire an integration. If it is no longer offered, request a correction
          and say so.
        </p>
      }
    }
    @if (notice()) {
      <p role="alert" [class]="alert" class="mt-2">{{ notice() }}</p>
    }
  `,
})
export class IntegrationSettings {
  private readonly api = inject(VendorApi);
  private readonly store = inject(VendorPortalStore);
  private readonly announcer = inject(VendorPortalAnnouncer);
  private readonly injector = inject(Injector);

  readonly integration = input.required<VendorIntegration>();

  private readonly confirmEl = viewChild<ElementRef<HTMLButtonElement>>('confirm');
  private readonly triggerEl = viewChild<ElementRef<HTMLButtonElement>>('trigger');
  private readonly statusEl = viewChild<ElementRef<HTMLElement>>('status');

  protected readonly confirming = signal(false);
  protected readonly busy = signal(false);
  protected readonly notice = signal<string | null>(null);

  protected readonly view = computed(() => {
    const i = this.integration();
    if (i.retired_at) {
      if (i.retired_by === 'aeci') return 'retired-by-aeci';
      return i.is_owner ? 'restore' : 'retired-other';
    }
    if (i.is_owner && i.claimed_at) return 'retire';
    if (i.is_owner) return 'unclaimed';
    return 'other';
  });

  protected readonly retiredLine = computed(() => {
    const date = formatDay(this.integration().retired_at);
    return $localize`:@@vendor.im.settings.retiredOn:You retired it on ${date}:date:. It is hidden from the public page and from search.`;
  });

  protected readonly retiredByAeciLine = computed(() => {
    const date = formatDay(this.integration().retired_at);
    return $localize`:@@vendor.im.settings.retiredByAeci:Retired by AEC Integrations on ${date}:date:`;
  });

  protected readonly retiredOtherLine = computed(() => {
    const i = this.integration();
    const date = formatDay(i.retired_at);
    const owner = i.owner?.name;
    return owner
      ? $localize`:@@vendor.im.settings.retiredOther:${owner}:owner: retired this integration on ${date}:date:. It no longer appears on the public page. You can read it here, but not change it.`
      : $localize`:@@vendor.im.settings.retiredOtherUnnamed:Its owner retired this integration on ${date}:date:. It no longer appears on the public page. You can read it here, but not change it.`;
  });

  protected readonly panelClass = PANEL;

  protected readonly alert = ALERT;

  protected openConfirm(): void {
    this.notice.set(null);
    this.confirming.set(true);
    afterNextRender(() => this.confirmEl()?.nativeElement.focus(), { injector: this.injector });
  }

  protected cancel(): void {
    this.confirming.set(false);
    afterNextRender(() => this.triggerEl()?.nativeElement.focus(), { injector: this.injector });
  }

  protected async retire(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.notice.set(null);
    const id = this.integration().id;
    try {
      const { integration, withdrawn_contest_ids } = await this.api.retireIntegration(id);
      this.spliceRetire(id, integration.retired_at, integration.retired_by);
      this.confirming.set(false);
      this.announcer.announce(
        withdrawn_contest_ids.length > 0
          ? $localize`:@@vendor.im.settings.live.retiredRequests:Integration retired. Its open correction requests were closed.`
          : $localize`:@@vendor.im.settings.live.retired:Integration retired. It no longer appears on the public page.`,
      );
      afterNextRender(() => this.statusEl()?.nativeElement.focus(), { injector: this.injector });
      void this.store.revalidate(['integrations', 'contests']);
    } catch (err) {
      this.notice.set(retireErrorMessage(err));
    } finally {
      this.busy.set(false);
    }
  }

  protected async restore(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.notice.set(null);
    const id = this.integration().id;
    try {
      const { integration } = await this.api.restoreIntegration(id);
      this.spliceRetire(id, integration.retired_at, integration.retired_by);
      this.announcer.announce(
        $localize`:@@vendor.im.settings.live.restored:Integration restored. It is back on the public page.`,
      );
      afterNextRender(() => this.triggerEl()?.nativeElement.focus(), { injector: this.injector });
      void this.store.revalidate(['integrations']);
    } catch (err) {
      this.notice.set(retireErrorMessage(err));
    } finally {
      this.busy.set(false);
    }
  }

  /** The server said 200: the row is in its new state in every entry now, so the
   *  page does not wait for the revalidation to redraw. */
  private spliceRetire(
    id: string,
    retiredAt: string | null,
    retiredBy: VendorIntegration['retired_by'],
  ): void {
    this.store
      .apply('integrations', (list) =>
        list.map((entry) =>
          entry.id === id ? { ...entry, retired_at: retiredAt, retired_by: retiredBy } : entry,
        ),
      )
      .commit();
  }
}
