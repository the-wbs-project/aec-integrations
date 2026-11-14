import { Component, computed, inject, signal } from '@angular/core';

import { AppUpdateService } from './app-update.service';
import { AecIcon } from '../../shared/icon/icon';
import { AecButton } from '../../shared/button/button';

/**
 * "A new version is available" notice (AECI-1493).
 *
 * Shown once `AppUpdateService` finds that a deploy has replaced this tab's
 * build. Most visitors never see it, because their next in-app click already
 * becomes a full page load. It is for the visitor who stays on one page, and
 * for a failed `@defer` block, which cannot recover on its own.
 *
 * Rendered once in the app shell (`app.ts`). SSR renders nothing, so cached HTML
 * stays visitor-neutral. The card itself is the `role="status"` region and
 * exists only while shown: an always-present empty region would be a second
 * live region on every page, beside the ones search results and the vendor
 * portal own. Non-modal: it takes no
 * focus and traps nothing. It sits top-right, under the header, so it never
 * covers the consent card at the bottom of the screen.
 */
@Component({
  selector: 'aec-update-banner',
  imports: [AecButton, AecIcon],
  template: `
    @if (show()) {
      <div
        class="pointer-events-none fixed inset-x-0 top-16 z-60 p-4
            sm:left-auto sm:top-20 sm:max-w-sm"
      >
        <div
          role="status"
          aria-live="polite"
          class="pointer-events-auto flex items-start gap-3 rounded-(--radius-lg) border
              border-(--border-default) bg-(--surface-raised) p-4 shadow-lg"
        >
          <div class="min-w-0 flex-1">
            <p class="text-sm font-semibold text-(--text-primary)" i18n="@@appUpdate.banner.title">
              A new version of AEC Integrations is available
            </p>
            <p class="mt-1 text-sm/6 text-(--text-secondary)" i18n="@@appUpdate.banner.body">
              Refresh the page to keep browsing.
            </p>
            <button
              aecButton
              id="app-update-refresh"
              type="button"
              (click)="refresh()"
              class="mt-3"
              i18n="@@appUpdate.banner.refresh"
            >
              Refresh
            </button>
          </div>
          <button
            aecButton
            variant="ghost"
            iconOnly
            id="app-update-dismiss"
            type="button"
            (click)="dismiss()"
            aria-label="Dismiss"
            i18n-aria-label="@@appUpdate.banner.dismiss"
            class="-m-2"
          >
            <aec-icon name="x" decorative [size]="5" />
          </button>
        </div>
      </div>
    }
  `,
})
export class UpdateBanner {
  private readonly updates = inject(AppUpdateService);
  private readonly dismissed = signal(false);

  protected readonly show = computed(() => this.updates.updateAvailable() && !this.dismissed());

  protected refresh(): void {
    this.updates.reload();
  }

  protected dismiss(): void {
    this.dismissed.set(true);
  }
}
