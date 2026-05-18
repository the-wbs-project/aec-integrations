import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

import { Mode, ThemeService } from '../theme.service';

// EXPENDABLE: temporary theme toggle for manual QA of AECI-25.
// Remove once the real toggle ships in the layout shell.
@Component({
  selector: 'app-home',
  template: `
    <p i18n="@@home.placeholder">AEC Integrations — coming soon.</p>

    <section
      aria-label="Theme toggle (expendable)"
      style="margin-top: 1.5rem; display: flex; flex-direction: column; gap: 0.5rem;"
    >
      <small style="color: var(--text-secondary);">
        Theme — mode: <strong>{{ theme.mode() }}</strong> · resolved:
        <strong>{{ theme.resolved() }}</strong>
      </small>
      <div role="group" aria-label="Theme mode" style="display: flex; gap: 0.5rem;">
        @for (m of modes; track m) {
          <button
            type="button"
            (click)="theme.setMode(m)"
            [attr.aria-pressed]="theme.mode() === m"
            [style.background]="
              theme.mode() === m ? 'var(--accent-primary)' : 'var(--surface-raised)'
            "
            [style.color]="theme.mode() === m ? 'var(--surface-base)' : 'var(--text-primary)'"
            style="padding: 0.4rem 0.8rem; border: 1px solid var(--border-default); border-radius: var(--radius); cursor: pointer; font: inherit;"
          >
            {{ m }}
          </button>
        }
      </div>
    </section>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Home {
  protected readonly theme = inject(ThemeService);
  protected readonly modes: Mode[] = ['system', 'light', 'dark'];
}
