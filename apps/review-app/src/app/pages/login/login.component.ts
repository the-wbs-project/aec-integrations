import { Component, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../services/auth.service';

@Component({
  selector: 'app-login',
  imports: [FormsModule],
  templateUrl: './login.component.html',
  styleUrl: './login.component.scss',
})
export class LoginComponent {
  private auth = inject(AuthService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);

  email = signal('');
  password = signal('');
  submitting = signal(false);
  error = signal<string | null>(null);

  async submit(): Promise<void> {
    const email = this.email().trim();
    const password = this.password();
    if (!email || !password) {
      this.error.set('Email and password are required.');
      return;
    }
    this.submitting.set(true);
    this.error.set(null);
    try {
      await this.auth.signIn(email, password);
      const returnUrl = this.route.snapshot.queryParamMap.get('returnUrl') ?? '/';
      await this.router.navigateByUrl(returnUrl);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Sign-in failed.';
      this.error.set(message);
    } finally {
      this.submitting.set(false);
    }
  }
}
