import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';

import { ThemeService } from './theme.service';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  template: `
    <header><h1 i18n="@@app.brand">AEC Integrations</h1></header>
    <main><router-outlet /></main>
    <footer><small i18n="@@app.footer.scaffold">AECi Phase 1.6 scaffold</small></footer>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  // Ensures ThemeService instantiates at bootstrap. UI toggle ships separately (AECI layout-shell).
  protected readonly theme = inject(ThemeService);
}
