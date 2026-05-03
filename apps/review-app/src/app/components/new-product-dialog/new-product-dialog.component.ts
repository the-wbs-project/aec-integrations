import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DialogModule } from '@syncfusion/ej2-angular-popups';
import { ApiService } from '../../services/api.service';

@Component({
  selector: 'app-new-product-dialog',
  standalone: true,
  imports: [FormsModule, DialogModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './new-product-dialog.component.html',
  styleUrl: './new-product-dialog.component.scss',
})
export class NewProductDialogComponent {
  private readonly api = inject(ApiService);

  readonly open = input<boolean>(false);

  readonly closed = output<void>();
  readonly created = output<{ id: string }>();

  protected readonly name = signal('');
  protected readonly website = signal('');
  protected readonly saving = signal(false);
  protected readonly errorMsg = signal<string | null>(null);

  constructor() {
    // Reset form whenever the dialog transitions from closed → open so the user
    // doesn't see leftover state from a previous attempt.
    effect(() => {
      if (this.open()) {
        this.resetForm();
      }
    });
  }

  protected onClose(): void {
    if (this.saving()) return;
    this.closed.emit();
  }

  protected submit(): void {
    if (this.saving()) return;
    const name = this.name().trim();
    if (!name) {
      this.errorMsg.set('Name is required.');
      return;
    }
    this.saving.set(true);
    this.errorMsg.set(null);
    this.api
      .createProduct({
        name,
        website: this.website().trim() || undefined,
      })
      .subscribe({
        next: (product) => {
          this.saving.set(false);
          this.created.emit({ id: product.id });
        },
        error: (err) => {
          this.saving.set(false);
          this.errorMsg.set(
            err?.error?.error ?? err?.message ?? 'Failed to create product.',
          );
        },
      });
  }

  private resetForm(): void {
    this.name.set('');
    this.website.set('');
    this.errorMsg.set(null);
    this.saving.set(false);
  }
}
