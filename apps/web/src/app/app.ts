import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  template: `
    <header><h1 i18n="@@app.brand">AEC Integrations</h1></header>
    <main><router-outlet /></main>
    <footer><small i18n="@@app.footer.scaffold">AECi Phase 1.6 scaffold</small></footer>
  `,
})
export class App {}
