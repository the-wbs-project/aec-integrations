import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { AuthService } from '../../services/auth.service';

@Component({
  selector: 'app-forgot-password',
  imports: [FormsModule, RouterLink],
  templateUrl: './forgot-password.component.html',
  styleUrl: './forgot-password.component.scss',
})
export class ForgotPasswordComponent {
  private auth = inject(AuthService);

  email = signal('');
  submitting = signal(false);
  error = signal<string | null>(null);
  sent = signal(false);

  async submit(): Promise<void> {
    const email = this.email().trim();
    if (!email) {
      this.error.set('Email is required.');
      return;
    }
    this.submitting.set(true);
    this.error.set(null);
    try {
      await this.auth.resetPassword(email);
      this.sent.set(true);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not send reset email.';
      this.error.set(message);
    } finally {
      this.submitting.set(false);
    }
  }
}
