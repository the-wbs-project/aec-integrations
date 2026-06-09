import { Component, inject } from '@angular/core';

import { ThemeService } from '../theme.service';

/**
 * Theme button group: System / Light / Dark as a segmented control.
 *
 * Used inside the small-screen nav overlay (`nav-menu.ts`), where there is room
 * to surface all three modes as direct, single-tap targets — unlike the compact
 * cycle button (`aec-theme-toggle`) the desktop header bar keeps.
 *
 * Each segment is a real `<button>` inside a labelled `role="group"`, with
 * `aria-pressed` reflecting the active mode (one active segment, immediate
 * effect via `ThemeService.setMode`). Active styling keys off `aria-pressed`, so
 * every class stays static (no conditional class strings, no new dependency);
 * the active fill reuses the same accent / on-accent token pair as the Sign-in
 * CTA, which is AA-clean in both themes. `not-aria-pressed:` scopes the hover
 * affordance to the inactive segments so it never fights the active fill.
 *
 * Overlay-only, so it never server-renders — no SSR cache-neutrality concern
 * (the overlay mounts client-side on click; see `nav-menu.ts`). The per-mode
 * labels reuse the cycle button's i18n ids (`@@app.theme.label.*`), so no new
 * per-mode strings are introduced.
 */
@Component({
  selector: 'aec-theme-toggle-group',
  template: `
    <div
      role="group"
      class="flex rounded-md border border-(--border-default) bg-(--surface-raised) p-0.5"
      i18n-aria-label="@@app.theme.group.aria"
      aria-label="Theme"
    >
      <button
        type="button"
        (click)="theme.setMode('system')"
        [attr.aria-pressed]="theme.mode() === 'system'"
        class="flex-1 cursor-pointer rounded-sm px-2.5 py-1 text-center text-sm text-(--text-secondary) transition-colors not-aria-pressed:hover:bg-(--surface-sunken) not-aria-pressed:hover:text-(--text-primary) aria-pressed:bg-(--accent-primary) aria-pressed:font-medium aria-pressed:text-(--surface-base) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
        i18n="@@app.theme.label.system"
      >
        System
      </button>
      <button
        type="button"
        (click)="theme.setMode('light')"
        [attr.aria-pressed]="theme.mode() === 'light'"
        class="flex-1 cursor-pointer rounded-sm px-2.5 py-1 text-center text-sm text-(--text-secondary) transition-colors not-aria-pressed:hover:bg-(--surface-sunken) not-aria-pressed:hover:text-(--text-primary) aria-pressed:bg-(--accent-primary) aria-pressed:font-medium aria-pressed:text-(--surface-base) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
        i18n="@@app.theme.label.light"
      >
        Light
      </button>
      <button
        type="button"
        (click)="theme.setMode('dark')"
        [attr.aria-pressed]="theme.mode() === 'dark'"
        class="flex-1 cursor-pointer rounded-sm px-2.5 py-1 text-center text-sm text-(--text-secondary) transition-colors not-aria-pressed:hover:bg-(--surface-sunken) not-aria-pressed:hover:text-(--text-primary) aria-pressed:bg-(--accent-primary) aria-pressed:font-medium aria-pressed:text-(--surface-base) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
        i18n="@@app.theme.label.dark"
      >
        Dark
      </button>
    </div>
  `,
})
export class ThemeToggleGroup {
  protected readonly theme = inject(ThemeService);
}
