import { Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../services/api.service';

@Component({
  selector: 'app-tool-create',
  imports: [RouterLink, FormsModule],
  template: `
    <div class="page-container">
      <a routerLink="/tools" class="back-link">
        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <line x1="19" y1="12" x2="5" y2="12" /><polyline points="12 19 5 12 12 5" />
        </svg>
        Back to tools
      </a>

      <h1 class="page-heading">New tool</h1>
      <p class="muted intro">
        New tools start with research status <strong>Pending</strong>.
        You can add categories, vendors, and the rest from the detail page.
      </p>

      <form (ngSubmit)="submit()" #form="ngForm" novalidate>
        <div class="form-row">
          <label class="field-label" for="tool-name">Name <span class="required">*</span></label>
          <input
            id="tool-name"
            class="input"
            name="name"
            [(ngModel)]="name"
            required
            autocomplete="off"
          />
        </div>

        <div class="form-row">
          <label class="field-label" for="tool-description">Description</label>
          <textarea
            id="tool-description"
            class="input form-textarea"
            name="description"
            rows="6"
            [(ngModel)]="description"
          ></textarea>
        </div>

        <div class="form-row">
          <label class="field-label" for="tool-website">Website</label>
          <input
            id="tool-website"
            class="input"
            name="website"
            type="url"
            [(ngModel)]="website"
            placeholder="https://example.com"
            autocomplete="off"
          />
        </div>

        @if (error()) {
          <p class="form-error" role="alert">{{ error() }}</p>
        }

        <div class="form-actions">
          <button
            type="submit"
            class="btn btn--primary"
            [disabled]="saving() || !name().trim()"
          >
            {{ saving() ? 'Creating…' : 'Create tool' }}
          </button>
          <a routerLink="/tools" class="btn btn--ghost">Cancel</a>
        </div>
      </form>
    </div>
  `,
  styles: `
    .back-link {
      display: inline-flex;
      align-items: center;
      gap: var(--space-1);
      font-size: var(--text-sm);
      color: var(--color-text-secondary);
      margin-bottom: var(--space-5);
    }

    .back-link:hover {
      color: var(--color-text-accent);
      text-decoration: none;
    }

    .page-heading {
      font-size: var(--text-xl);
      font-weight: 500;
      color: var(--color-text-primary);
      margin: 0 0 var(--space-2);
    }

    .intro {
      margin-bottom: var(--space-5);
    }

    .muted {
      color: var(--color-text-secondary);
      font-size: var(--text-sm);
    }

    .form-row {
      display: flex;
      flex-direction: column;
      gap: var(--space-1);
      margin-bottom: var(--space-4);
      max-width: 540px;
    }

    .field-label {
      font-size: var(--text-xs);
      font-weight: 500;
      color: var(--color-text-secondary);
    }

    .required {
      color: var(--color-danger);
    }

    .form-textarea {
      height: auto;
      line-height: var(--leading-normal);
      padding: var(--space-2) var(--space-3);
    }

    .form-error {
      max-width: 540px;
      margin-bottom: var(--space-4);
      padding: var(--space-3);
      background: var(--color-danger-bg);
      color: var(--color-danger);
      border-radius: var(--radius-md);
      font-size: var(--text-sm);
    }

    .form-actions {
      display: flex;
      gap: var(--space-2);
    }
  `,
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
