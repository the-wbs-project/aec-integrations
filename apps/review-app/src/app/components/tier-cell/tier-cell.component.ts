// In-grid VQS cell with a hover/focus popover summarising the tier and a
// "Click for details" affordance. The popover uses position:fixed and
// computes its coordinates from the trigger's bounding rect so it can
// escape the grid cell's overflow:hidden clipping.
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  HostListener,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  confidenceVariant,
  tierMetaFor,
  type TierVariant,
} from '../tier-info/tier-info';

const LEAVE_DELAY_MS = 120; // Grace period for the cursor to bridge the gap.

interface PopoverPos {
  top: number;
  left: number;
}

@Component({
  selector: 'app-tier-cell',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './tier-cell.component.html',
  styleUrl: './tier-cell.component.scss',
})
export class TierCellComponent {
  private readonly destroyRef = inject(DestroyRef);
  private leaveTimer: ReturnType<typeof setTimeout> | null = null;

  readonly vqsScore = input<number | null | undefined>(undefined);
  readonly vqsTier = input<string | null | undefined>(undefined);
  readonly vqsConfidence = input<string | null | undefined>(undefined);
  readonly vendorId = input.required<string>();
  readonly vendorName = input.required<string>();
  /** 'sm' (default) for grid cells, 'lg' for headlines like the detail page header. */
  readonly size = input<'sm' | 'lg'>('sm');

  readonly openDetails = output<string>();

  protected readonly trigger =
    viewChild<ElementRef<HTMLButtonElement>>('trigger');

  protected readonly open = signal(false);
  protected readonly pos = signal<PopoverPos>({ top: 0, left: 0 });

  protected readonly tierMeta = computed(() => tierMetaFor(this.vqsTier()));
  protected readonly confidenceVariant = computed<TierVariant>(() =>
    confidenceVariant(this.vqsConfidence()),
  );

  protected readonly hasScore = computed(
    () => this.vqsScore() !== undefined && this.vqsScore() !== null,
  );

  /** Width of the popover — kept in sync with the SCSS so we can clamp horizontally. */
  private static readonly POPOVER_WIDTH = 280;
  private static readonly POPOVER_GAP = 8;

  constructor() {
    this.destroyRef.onDestroy(() => this.clearLeaveTimer());
  }

  protected onEnter(): void {
    this.clearLeaveTimer();
    this.recomputePosition();
    this.open.set(true);
  }

  /** Delay close so the cursor can bridge the trigger→popover gap. */
  protected onLeave(): void {
    this.clearLeaveTimer();
    this.leaveTimer = setTimeout(() => {
      this.open.set(false);
      this.leaveTimer = null;
    }, LEAVE_DELAY_MS);
  }

  protected onTriggerClick(): void {
    // Clicking the cell itself opens the modal — same outcome as the popover button.
    this.openDetails.emit(this.vendorId());
  }

  protected onDetailsClick(event: MouseEvent): void {
    event.stopPropagation();
    this.clearLeaveTimer();
    this.open.set(false);
    this.openDetails.emit(this.vendorId());
  }

  private clearLeaveTimer(): void {
    if (this.leaveTimer !== null) {
      clearTimeout(this.leaveTimer);
      this.leaveTimer = null;
    }
  }

  /** Close on Escape when the trigger or popover is focused. */
  @HostListener('keydown.escape')
  protected onEscape(): void {
    this.open.set(false);
    this.trigger()?.nativeElement.blur();
  }

  /** Reposition on scroll/resize while open — grid scrolling moves the trigger. */
  @HostListener('window:scroll')
  @HostListener('window:resize')
  protected onWindowChange(): void {
    if (this.open()) this.recomputePosition();
  }

  private recomputePosition(): void {
    const el = this.trigger()?.nativeElement;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const width = TierCellComponent.POPOVER_WIDTH;
    const gap = TierCellComponent.POPOVER_GAP;

    // Default: appear above the trigger, right-aligned. Clamp into viewport.
    let left = rect.right - width;
    if (left < 8) left = 8;
    if (left + width > window.innerWidth - 8) {
      left = window.innerWidth - 8 - width;
    }

    // Prefer above, but flip below if there isn't enough room (rough heuristic).
    const estimatedHeight = 180;
    const flip = rect.top < estimatedHeight + gap;
    const top = flip ? rect.bottom + gap : rect.top - estimatedHeight - gap;

    this.pos.set({ top, left });
  }
}
