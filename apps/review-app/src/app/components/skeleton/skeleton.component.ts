import { Component, computed, input } from '@angular/core';

@Component({
  selector: 'app-skeleton',
  standalone: true,
  template: `
    @switch (variant()) {
      @case ('rows') {
        @for (_ of rowsArray(); track $index) {
          <div class="skeleton-row">
            @for (__ of cellsArray(); track $index) {
              <span class="skeleton skeleton--text skeleton-cell"></span>
            }
          </div>
        }
      }
      @case ('rect') {
        <span class="skeleton skeleton--rect" [style.height.px]="height()"></span>
      }
      @default {
        <span class="skeleton skeleton--text" [style.width]="width()" [style.height.px]="height()"></span>
      }
    }
  `,
  styles: `
    :host { display: block; }

    .skeleton-row {
      display: grid;
      grid-template-columns: 2fr 1.5fr 1fr 1fr 0.6fr 0.8fr 1fr;
      gap: var(--space-3);
      padding: var(--space-3);
      border-bottom: 0.5px solid var(--color-border-default);
    }

    .skeleton-cell {
      height: 12px;
    }
  `,
})
export class SkeletonComponent {
  readonly variant = input<'text' | 'rect' | 'rows'>('text');
  readonly count = input<number>(6);
  readonly cells = input<number>(7);
  readonly width = input<string>('100%');
  readonly height = input<number>(12);

  protected readonly rowsArray = computed(() => Array(this.count()).fill(0));
  protected readonly cellsArray = computed(() => Array(this.cells()).fill(0));
}
