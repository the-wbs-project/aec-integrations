import { OverlayModule, type ConnectedPosition } from '@angular/cdk/overlay';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';

import { IM_STYLES } from './im-ui';
import type { Tone } from './integration-manager.fixtures';

let nextId = 0;

/**
 * A rich tooltip for the integration-manager preview, built the way
 * `shared/info-hint/info-hint.ts` is: a real button as the trigger and a
 * `cdkConnectedOverlay` panel that portals out of any clipping container.
 *
 * Three triggers share it:
 * - `info`: a small "i" icon beside a value;
 * - `pill`: a status pill that explains itself;
 * - `flag`: the open-change-request marker. Activating it (click, Enter) jumps to
 *   the request. The panel holds no link (round 3): a link in a portaled overlay
 *   cannot be reached with Tab, so the flag itself is the one way to jump.
 *
 * WCAG 1.4.13: the panel opens on hover, focus and click; it stays open while
 * the pointer is over it (a short grace period covers the gap); Escape closes it
 * from anywhere without moving focus or the pointer. The full text is also an
 * always-present, visually hidden description of the trigger, so assistive tech
 * never depends on the overlay being mounted.
 */
@Component({
  selector: 'aec-im-tip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [OverlayModule],
  styles: [IM_STYLES, ':host { display: inline-flex; vertical-align: middle; }'],
  host: { '(document:keydown.escape)': 'close()' },
  template: `
    <button
      #origin="cdkOverlayOrigin"
      cdkOverlayOrigin
      type="button"
      [class]="triggerClass()"
      [attr.data-tone]="variant() === 'pill' ? tone() : null"
      [attr.aria-label]="variant() === 'pill' ? null : label()"
      [attr.aria-describedby]="descId"
      [attr.aria-expanded]="variant() === 'flag' ? null : open()"
      (click)="onClick()"
      (mouseenter)="show()"
      (mouseleave)="scheduleClose()"
      (focus)="show()"
      (blur)="onBlur()"
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
                class="h-3.5 w-3.5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2.5"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path
                  d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"
                />
                <path d="M12 9v4" />
                <path d="M12 17h.01" />
              </svg>
            }
            @case ('attention') {
              <span
                aria-hidden="true"
                class="h-2 w-2 rounded-full bg-(--accent-secondary-deep)"
              ></span>
            }
            @default {
              <span aria-hidden="true" class="h-2 w-2 rounded-full bg-(--text-tertiary)"></span>
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
      [cdkConnectedOverlayOpen]="open()"
      [cdkConnectedOverlayPositions]="positions"
      (detach)="open.set(false)"
    >
      <div
        role="tooltip"
        aria-hidden="true"
        class="max-w-xs space-y-1.5 rounded-(--radius-md) border border-(--border-default) bg-(--surface-raised) px-3 py-2.5 text-sm leading-relaxed text-(--text-primary) shadow-lg"
        (mouseenter)="show()"
        (mouseleave)="scheduleClose()"
      >
        @if (heading()) {
          <p class="font-semibold">{{ heading() }}</p>
        }
        @for (line of lines(); track $index) {
          <p [class]="heading() ? 'text-(--text-secondary)' : ''">{{ line }}</p>
        }
      </div>
    </ng-template>
  `,
})
export class ImTip {
  readonly variant = input<'info' | 'pill' | 'flag'>('info');
  /** Accessible name for the icon triggers; the visible text of a pill. */
  readonly label = input.required<string>();
  readonly tone = input<Tone>('neutral');
  readonly heading = input<string | null>(null);
  readonly lines = input<readonly string[]>([]);
  /** Emitted when the flag is activated (click or Enter). */
  readonly activate = output<void>();

  private readonly destroyRef = inject(DestroyRef);

  protected readonly descId = `im-tip-${++nextId}`;
  protected readonly open = signal(false);
  protected readonly description = computed(() =>
    [this.heading(), ...this.lines()].filter((v): v is string => !!v).join(' '),
  );

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
        return `im-pill cursor-help ${focus}`;
      case 'flag':
        return `inline-flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-(--radius-sm) text-(--accent-secondary-deep) hover:bg-(--surface-sunken) ${focus}`;
      default:
        return `inline-flex h-6 w-6 shrink-0 cursor-help items-center justify-center rounded-full text-(--text-tertiary) hover:text-(--text-primary) ${focus}`;
    }
  });

  private closeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.destroyRef.onDestroy(() => this.cancelClose());
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

  protected onBlur(): void {
    this.close();
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
