import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ShellComponent } from './layout/shell.component';
import { AuthService } from './services/auth.service';

@Component({
  selector: 'app-root',
  imports: [ShellComponent, RouterOutlet],
  template: `
    @if (auth.isAuthenticated()) {
      <app-shell />
    } @else {
      <router-outlet />
    }
  `,
})
export class AppComponent {
  protected readonly auth = inject(AuthService);
}
