import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../../services/auth.service';

@Component({
  selector: 'app-reset-password',
  imports: [FormsModule, RouterLink],
  templateUrl: './reset-password.component.html',
  styleUrl: './reset-password.component.scss',
})
export class ResetPasswordComponent {
  private auth = inject(AuthService);
  private router = inject(Router);

  password = signal('');
  confirm = signal('');
  submitting = signal(false);
  error = signal<string | null>(null);
  success = signal(false);

  async submit(): Promise<void> {
    const password = this.password();
    const confirm = this.confirm();
    if (!password || password.length < 8) {
      this.error.set('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirm) {
      this.error.set('Passwords do not match.');
      return;
    }
    this.submitting.set(true);
    this.error.set(null);
    try {
      await this.auth.updatePassword(password);
      this.success.set(true);
      setTimeout(() => void this.router.navigateByUrl('/'), 1500);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not update password.';
      this.error.set(message);
    } finally {
      this.submitting.set(false);
    }
  }
}
