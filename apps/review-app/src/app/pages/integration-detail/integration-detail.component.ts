import {
  Component,
  DestroyRef,
  inject,
  input,
  signal,
  effect,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ApiService } from '../../services/api.service';
import { IntegrationSummary } from '../../types';

@Component({
  selector: 'app-integration-detail',
  imports: [CommonModule, RouterLink],
  templateUrl: './integration-detail.component.html',
  styleUrl: './integration-detail.component.scss',
})
export class IntegrationDetailComponent {
  private api = inject(ApiService);
  private destroyRef = inject(DestroyRef);

  id = input.required<string>();

  protected readonly integration = signal<IntegrationSummary | null>(null);
  protected readonly loading = signal(false);
  protected readonly notFound = signal(false);

  constructor() {
    effect(() => {
      const id = this.id();
      if (!id) return;
      this.loading.set(true);
      this.notFound.set(false);
      this.api
        .getIntegration(id)
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({
          next: (i) => {
            if (this.id() !== id) return;
            this.integration.set(i);
            this.loading.set(false);
          },
          error: () => {
            if (this.id() !== id) return;
            this.notFound.set(true);
            this.loading.set(false);
          },
        });
    });
  }
}
