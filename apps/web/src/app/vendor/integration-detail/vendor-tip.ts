import { OverlayModule, type ConnectedPosition } from '@angular/cdk/overlay';
import {
  Component,
  DestroyRef,
  ElementRef,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';

import type { Tone } from './integration-detail-model';
import { ID_STYLES } from './integration-detail-styles';

let nextId = 0;

/**
 * A tooltip for the integration detail page (§6.17.9), built the way
 * `shared/info-hint/info-hint.ts` is: a real `<button>` trigger and a
 * `cdkConnectedOverlay` panel that portals out of any clipping container.
 *
 * Not `aec-info-hint` itself, because the page needs three triggers and the panel
 * holds up to three lines:
 *
 * - `info`: the small "i" beside a label. Its accessible name is "About {label}",
 *   and the explanation is its `aria-describedby`;
 * - `pill`: a status pill that explains itself. Its visible text is its name;
 * - `flag`: an open change request or disagreement on a row. Activating it jumps
 *   to the item (`activate`). The panel holds no link, because a link in a
 *   portaled overlay cannot be reached with Tab.
 *
 * ── WCAG 1.4.13 ─────────────────────────────────────────────────────────────
 * The panel opens on hover, focus and click. It stays open while the pointer is
 * over it, with a short grace period across the gap (hoverable). Escape closes it
 * from anywhere, without moving focus or the pointer (dismissible). It stays until
 * the pointer leaves, focus leaves or Escape (persistent). The full text is also
 * the trigger's `aria-describedby` target, always in the DOM and visually hidden,
 * so assistive tech never depends on the overlay. The panel itself is
 * `aria-hidden`, so its text is not read twice.
 *
 * Every trigger is at least 24 by 24 CSS pixels (WCAG 2.5.8).
 */
@Component({
  selector: 'aec-vendor-tip',
  imports: [OverlayModule],
  styles: [ID_STYLES, ':host { display: inline-flex; vertical-align: middle; }'],
  host: { '(document:keydown.escape)': 'close()' },
  template: `
    <button
      #origin="cdkOverlayOrigin"
      #trigger
      cdkOverlayOrigin
      type="button"
      [class]="triggerClass()"
      [attr.data-tone]="variant() === 'pill' ? tone() : null"
      [attr.aria-label]="variant() === 'pill' ? null : label()"
      [attr.aria-describedby]="descId"
      [attr.aria-expanded]="variant() === 'flag' ? null : open()"
      [attr.data-testid]="testId()"
      (click)="onClick()"
      (mouseenter)="show()"
      (mouseleave)="scheduleClose()"
      (focus)="show()"
      (blur)="close()"
    >
      @switch (variant()) {
        @case ('pill') {
          @switch (tone()) {
            @case ('ok') {
              <svg
                aria-hidden="true"
                class="h-3 w-3"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="3"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M20 6 9 17l-5-5" />
              </svg>
            }
            @case ('conflict') {
              <svg
                aria-hidden="true"
                class="h-3 w-3"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="3"
                stroke-linecap="round"
              >
                <path d="M7 7l10 10M17 7L7 17" />
              </svg>
            }
            @case ('attention') {
              <span
                aria-hidden="true"
                class="h-2 w-2 rounded-full bg-(--accent-secondary-deep)"
              ></span>
            }
            @default {
              <span aria-hidden="true" class="h-2 w-2 rounded-full bg-(--text-secondary)"></span>
            }
          }
          {{ label() }}
        }
        @case ('flag') {
          <svg
            aria-hidden="true"
            class="h-4 w-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path
              d="M4 22V4a1 1 0 0 1 .4-.8A6 6 0 0 1 8 2c3 0 5 2 7.33 2q2 0 3.67-.8a1 1 0 0 1 1.6.8v11a1 1 0 0 1-.4.8A6 6 0 0 1 16 16c-3 0-5-2-8-2a6 6 0 0 0-4 1.528"
            />
          </svg>
        }
        @default {
          <svg
            aria-hidden="true"
            class="h-4 w-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <circle cx="12" cy="12" r="10" />
            <path d="M12 16v-4" />
            <path d="M12 8h.01" />
          </svg>
        }
      }
    </button>
    <span [id]="descId" class="sr-only">{{ description() }}</span>

    <ng-template
      cdkConnectedOverlay
      [cdkConnectedOverlayOrigin]="origin"
      [cdkConnectedOverlayOpen]="open() && lines().length > 0"
      [cdkConnectedOverlayPositions]="positions"
      (detach)="open.set(false)"
    >
      <div
        aria-hidden="true"
        data-testid="vendor-tip-panel"
        class="max-w-xs space-y-1.5 rounded-(--radius-md) border border-(--border-default) bg-(--surface-raised) px-3 py-2.5 text-sm leading-relaxed text-(--text-primary) shadow-[0_8px_24px_-4px_rgb(0_0_0/0.12),0_2px_8px_-1px_rgb(0_0_0/0.06)]"
        (mouseenter)="show()"
        (mouseleave)="scheduleClose()"
      >
        @for (line of lines(); track $index) {
          <p>{{ line }}</p>
        }
      </div>
    </ng-template>
  `,
})
export class VendorTip {
  readonly variant = input<'info' | 'pill' | 'flag'>('info');
  /** Accessible name of the icon triggers; the visible text of a pill. */
  readonly label = input.required<string>();
  readonly tone = input<Tone>('neutral');
  /** One to three short lines: what it means, where it shows publicly, who changes it. */
  readonly lines = input<readonly string[]>([]);
  readonly testId = input<string | null>(null);
  /** The flag was activated (click or Enter). */
  readonly activate = output<void>();

  private readonly destroyRef = inject(DestroyRef);
  private readonly trigger = viewChild<ElementRef<HTMLButtonElement>>('trigger');

  protected readonly descId = `vendor-tip-${++nextId}`;
  protected readonly open = signal(false);
  protected readonly description = computed(() => this.lines().join(' '));

  protected readonly positions: ConnectedPosition[] = [
    { originX: 'start', originY: 'bottom', overlayX: 'start', overlayY: 'top', offsetY: 6 },
    { originX: 'start', originY: 'top', overlayX: 'start', overlayY: 'bottom', offsetY: -6 },
    { originX: 'end', originY: 'bottom', overlayX: 'end', overlayY: 'top', offsetY: 6 },
    { originX: 'end', originY: 'top', overlayX: 'end', overlayY: 'bottom', offsetY: -6 },
  ];

  protected readonly triggerClass = computed(() => {
    const focus =
      'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';
    switch (this.variant()) {
      case 'pill':
        return `id-pill min-h-6 cursor-help ${focus}`;
      case 'flag':
        return `inline-flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-(--radius-sm) text-(--accent-secondary-deep) hover:bg-(--surface-sunken) ${focus}`;
      default:
        return `inline-flex h-6 w-6 shrink-0 cursor-help items-center justify-center rounded-full text-(--text-secondary) hover:text-(--text-primary) ${focus}`;
    }
  });

  private closeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.destroyRef.onDestroy(() => this.cancelClose());
  }

  /** Focus the trigger. A flag's jump returns here when the page wants it. */
  focus(): void {
    this.trigger()?.nativeElement.focus();
  }

  protected onClick(): void {
    if (this.variant() === 'flag') {
      this.close();
      this.activate.emit();
      return;
    }
    this.cancelClose();
    this.open.update((v) => !v);
  }

  protected show(): void {
    this.cancelClose();
    this.open.set(true);
  }

  /** Grace period so the pointer can travel from the trigger onto the panel. */
  protected scheduleClose(): void {
    this.cancelClose();
    this.closeTimer = setTimeout(() => this.open.set(false), 150);
  }

  close(): void {
    this.cancelClose();
    this.open.set(false);
  }

  private cancelClose(): void {
    if (this.closeTimer) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
  }
}
