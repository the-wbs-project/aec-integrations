import { Component } from '@angular/core';
import { RouterOutlet, RouterLink } from '@angular/router';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, RouterLink],
  template: `
    <header class="topbar">
      <a routerLink="/" class="brand">AECi&nbsp;Workflows</a>
    </header>
    <main class="container">
      <router-outlet />
    </main>
  `,
  styles: [`
    .topbar { padding: 12px 24px; border-bottom: 1px solid #e5e5e5; background: #fff; }
    .brand { font-weight: 600; color: inherit; text-decoration: none; }
    .container { padding: 24px; max-width: 880px; margin: 0 auto; }
  `],
})
export class AppComponent {}
