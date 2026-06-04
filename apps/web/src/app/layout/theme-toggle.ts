import { Component, inject } from '@angular/core';
import { BrnButton } from '@spartan-ng/brain/button';

import { ThemeService } from '../theme.service';

/**
 * Theme cycle button: System → Light → Dark → System.
 *
 * Backed by ThemeService.cycle(); starting from 'system' the cycle visits
 * system → light → dark → system, satisfying AECI-32's "System → Light → Dark"
 * requirement.
 */
@Component({
  selector: 'aec-theme-toggle',
  imports: [BrnButton],
  template: `
    <button
      brnButton
      type="button"
      (click)="theme.cycle()"
      class="inline-flex items-center gap-2 rounded-md border border-(--border-default) bg-(--surface-raised) px-3 py-1.5 text-sm text-(--text-primary) hover:bg-(--surface-sunken) hover:border-(--border-strong) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) transition-colors cursor-pointer"
      i18n-aria-label="@@app.theme.toggle.aria"
      aria-label="Cycle theme"
    >
      <span aria-hidden="true" class="text-(--text-secondary)">
        @switch (theme.mode()) {
          @case ('system') {
            <ng-container i18n="@@app.theme.label.system">System</ng-container>
          }
          @case ('light') {
            <ng-container i18n="@@app.theme.label.light">Light</ng-container>
          }
          @case ('dark') {
            <ng-container i18n="@@app.theme.label.dark">Dark</ng-container>
          }
        }
      </span>
    </button>
  `,
})
export class ThemeToggle {
  protected readonly theme = inject(ThemeService);
}
