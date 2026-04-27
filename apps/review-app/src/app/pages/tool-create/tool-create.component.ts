import { Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../services/api.service';

@Component({
  selector: 'app-tool-create',
  imports: [RouterLink, FormsModule],
  templateUrl: './tool-create.component.html',
  styleUrl: './tool-create.component.scss',
})
export class ToolCreateComponent {
  private api = inject(ApiService);
  private router = inject(Router);

  name = signal('');
  description = signal('');
  website = signal('');
  saving = signal(false);
  error = signal<string | null>(null);

  submit(): void {
    const name = this.name().trim();
    if (!name) {
      this.error.set('Name is required.');
      return;
    }
    this.saving.set(true);
    this.error.set(null);
    this.api
      .createTool({
        name,
        description: this.description().trim() || undefined,
        website: this.website().trim() || undefined,
      })
      .subscribe({
        next: (tool) => {
          this.saving.set(false);
          this.router.navigate(['/tools', tool.id]);
        },
        error: (err) => {
          this.saving.set(false);
          this.error.set(err?.error?.error ?? err?.message ?? 'Create failed');
        },
      });
  }
}
