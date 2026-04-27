import { Component, computed, input } from '@angular/core';

@Component({
  selector: 'app-skeleton',
  standalone: true,
  templateUrl: './skeleton.component.html',
  styleUrl: './skeleton.component.scss',
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
