import { OverlayModule, type ConnectedPosition } from '@angular/cdk/overlay';
import { Component, DestroyRef, inject, input, signal } from '@angular/core';

/**
 * A small "i" control that reveals a sentence or two of explanatory text
 * (AECI-915).
 *
 * ── THE ACCESSIBLE NAME IS THE TEXT ──────────────────────────────────────────
 * Lifted wholesale from `shared/relative-time/`, which `DESIGN.md` already
 * documents as the house pattern for this. The control's accessible name IS
 * {@link text}, so assistive tech reads the explanation straight off the button
 * and never depends on a transient overlay being mounted. The panel is therefore
 * `aria-hidden` rather than an `aria-describedby` target — describing a button
 * with a string identical to its own name buys a double announcement and nothing
 * else. Sighted users get the panel on hover, focus, or click; keyboard users
 * reach the same string by tabbing.
 *
 * A `title` attribute would be the cheap version and is deliberately not used:
 * it is not reliably keyboard-reachable, its screen-reader support is
 * inconsistent, and it cannot be styled. `shared/verified-badge/` still uses one
 * because its tooltip is supplemental to a visible label; here the text is the
 * only place the information exists.
 *
 * ── WHY AN OVERLAY AND NOT A CSS TOOLTIP ─────────────────────────────────────
 * Same reason as `relative-time.ts`: the repo's cheap `group-hover` tooltip
 * (`home/home-why.ts`) is an in-flow absolutely-positioned span, and every
 * container this renders in may clip it. A `cdkConnectedOverlay` portals out.
 * An overlay and not a dialog, so revealing it never moves focus.
 *
 * Not merged with `relative-time.ts`: that component's accessible name is a
 * FORMATTED value it computes itself, and it renders a `<time>` element beside
 * the control. Folding the two would mean an input union and a conditional
 * element, to save one `cdkConnectedOverlay` block.
 */
@Component({
  selector: 'aec-info-hint',
  imports: [OverlayModule],
  templateUrl: './info-hint.html',
  host: { class: 'inline-flex' },
})
export class InfoHint {
  /** The explanation. Also the control's accessible name — see the class doc. */
  readonly text = input.required<string>();

  /**
   * Wraps at `max-w-xs` by default. `wide` is for the multi-sentence facet
   * hints, which read as a wall at the narrow width.
   */
  readonly width = input<'default' | 'wide'>('default');

  private readonly destroyRef = inject(DestroyRef);

  protected readonly open = signal(false);

  /**
   * Below the control with a 6px gap, start-aligned first, falling back above
   * and then to the mirrored pair. All four are listed so the CDK can flip on
   * both axes rather than clip — this renders in a two-column card grid where a
   * control can sit near either viewport edge.
   */
  protected readonly positions: ConnectedPosition[] = [
    { originX: 'start', originY: 'bottom', overlayX: 'start', overlayY: 'top', offsetY: 6 },
    { originX: 'start', originY: 'top', overlayX: 'start', overlayY: 'bottom', offsetY: -6 },
    { originX: 'end', originY: 'bottom', overlayX: 'end', overlayY: 'top', offsetY: 6 },
    { originX: 'end', originY: 'top', overlayX: 'end', overlayY: 'bottom', offsetY: -6 },
  ];

  private closeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.destroyRef.onDestroy(() => {
      if (this.closeTimer) clearTimeout(this.closeTimer);
    });
  }

  protected panelClass(): string {
    const base =
      'rounded-(--radius-md) border border-(--border-default) bg-(--surface-raised) px-3 py-2 text-xs leading-relaxed text-(--text-primary) shadow-lg';
    return this.width() === 'wide' ? `${base} max-w-sm` : `${base} max-w-xs`;
  }

  protected toggle(): void {
    this.cancelClose();
    this.open.update((v) => !v);
  }

  protected show(): void {
    this.cancelClose();
    this.open.set(true);
  }

  /** Grace period so the pointer can travel from the control onto the panel
   *  without it flickering shut. */
  protected scheduleClose(): void {
    this.cancelClose();
    this.closeTimer = setTimeout(() => this.open.set(false), 120);
  }

  protected close(): void {
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
