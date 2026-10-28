import { Component, computed, inject, signal } from '@angular/core';

import { AppUpdateService } from './app-update.service';

/**
 * "A new version is available" notice (AECI-1493).
 *
 * Shown once `AppUpdateService` finds that a deploy has replaced this tab's
 * build. Most visitors never see it, because their next in-app click already
 * becomes a full page load. It is for the visitor who stays on one page, and
 * for a failed `@defer` block, which cannot recover on its own.
 *
 * Rendered once in the app shell (`app.ts`). SSR renders only the empty live
 * region, so cached HTML stays visitor-neutral. The region is always present so
 * a screen reader announces the message when it appears. Non-modal: it takes no
 * focus and traps nothing. It sits top-right, under the header, so it never
 * covers the consent card at the bottom of the screen.
 */
@Component({
  selector: 'aec-update-banner',
  template: `
    <div role="status" aria-live="polite">
      @if (show()) {
        <div
          class="pointer-events-none fixed inset-x-0 top-16 z-60 p-4
            sm:left-auto sm:top-20 sm:max-w-sm"
        >
          <div
            class="pointer-events-auto flex items-start gap-3 rounded-(--radius-lg) border
              border-(--border-default) bg-(--surface-raised) p-4 shadow-lg"
          >
            <div class="min-w-0 flex-1">
              <p
                class="text-sm font-semibold text-(--text-primary)"
                i18n="@@appUpdate.banner.title"
              >
                A new version of AEC Integrations is available
              </p>
              <p class="mt-1 text-sm/6 text-(--text-secondary)" i18n="@@appUpdate.banner.body">
                Refresh the page to keep browsing.
              </p>
              <button
                id="app-update-refresh"
                type="button"
                (click)="refresh()"
                class="mt-3 inline-flex items-center justify-center rounded-(--radius-md) border
                  border-(--border-strong) bg-(--accent-primary) px-4 py-2 text-sm font-bold
                  text-(--surface-base) transition-colors hover:bg-(--accent-primary-hover)
                  focus-visible:outline-none focus-visible:ring-2
                  focus-visible:ring-(--accent-primary) focus-visible:ring-offset-2
                  focus-visible:ring-offset-(--surface-raised)"
                i18n="@@appUpdate.banner.refresh"
              >
                Refresh
              </button>
            </div>
            <button
              id="app-update-dismiss"
              type="button"
              (click)="dismiss()"
              aria-label="Dismiss"
              i18n-aria-label="@@appUpdate.banner.dismiss"
              class="-m-1 inline-flex size-8 shrink-0 items-center justify-center
                rounded-(--radius-md) text-(--text-secondary) transition-colors
                hover:bg-(--surface-sunken) hover:text-(--text-primary)
                focus-visible:outline-none focus-visible:ring-2
                focus-visible:ring-(--accent-primary)"
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 16 16"
                class="size-4"
                fill="none"
                stroke="currentColor"
                stroke-width="1.75"
                stroke-linecap="round"
              >
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
          </div>
        </div>
      }
    </div>
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
