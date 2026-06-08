import { isPlatformBrowser, NgOptimizedImage } from '@angular/common';
import {
  afterNextRender,
  Component,
  computed,
  ElementRef,
  inject,
  input,
  linkedSignal,
  PLATFORM_ID,
} from '@angular/core';

/**
 * AECI-152 — `LogoOrInitial`. Renders a logo via `NgOptimizedImage` and falls
 * back to a code-point-safe initial letter when the source is null **or the
 * image fails to load** (e.g. a Brandfetch CDN logo that 404s at runtime —
 * `logo_url` is Zod-validated as a URL at the API boundary but can still die
 * later). Without this, a dead `logo_url` shows the browser's broken-image
 * glyph instead of the initial-letter fallback we already render for a null url.
 *
 * Single owner of the logo-with-initial-fallback pattern, used by the product /
 * vendor detail heroes (`size="lg"`) and the product-detail vendor card
 * (`size="sm"`). Replaces three byte-identical inline `@if/@else` blocks and two
 * duplicate `initial()` computeds.
 *
 * No layout shift (Phase 2 §12 image budget, CLS ≤ 0.1): the rendered child
 * (img or span) carries the same `h-* w-*` box in both branches and the img has
 * static `width`/`height`, so the box is reserved before load and the img↔span
 * swap happens inside an identically-sized box. Both themes via tokens
 * (`--surface-raised`, `--border-default`, `--text-primary`); §11.4 no color
 * literals.
 *
 * `alt` is passed in (not generated) so the existing call-site strings — and the
 * un-wrapped `' logo'` suffix — are preserved verbatim, introducing no new
 * `$localize`/`.xlf` churn.
 */
export type LogoSize = 'lg' | 'sm';

@Component({
  selector: 'aec-logo-or-initial',
  imports: [NgOptimizedImage],
  host: { class: 'inline-flex shrink-0' },
  template: `
    @if (src() && !failed()) {
      <img
        [ngSrc]="src()!"
        [alt]="alt()"
        [width]="dim()"
        [height]="dim()"
        [priority]="priority()"
        [class]="imgClass()"
        (error)="failed.set(true)"
      />
    } @else {
      <span [class]="spanClass()" aria-hidden="true">{{ initial() }}</span>
    }
  `,
})
export class LogoOrInitial {
  private readonly platformId = inject(PLATFORM_ID);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  /** `logo_url`, may be null — null (or a load error) renders the initial. */
  readonly src = input<string | null>(null);
  /** Drives the initial letter; the real name lives in adjacent visible text. */
  readonly name = input.required<string>();
  /** Passed through verbatim — `''` is decorative, meaningful for heroes. */
  readonly alt = input<string>('');
  /** `lg` = 64px framed hero, `sm` = 32px inline avatar. */
  readonly size = input<LogoSize>('lg');
  /** Hero passes `true` (the logo is the LCP element). */
  readonly priority = input<boolean>(false);

  // Flipped by the `(error)` handler or the pre-hydration net below. Seeded from
  // `src` so a reused instance (the detail pages share one `LogoOrInitial` across
  // client-side navigation between `/products/:slug` or `/vendors/:slug` — default
  // `RouteReuseStrategy` + `toSignal(route.data)`) resets the failure when the
  // logo changes; otherwise a prior 404 would keep hiding the next entity's valid
  // logo. `linkedSignal` stays writable, so `failed.set(true)` still works.
  protected readonly failed = linkedSignal<string | null, boolean>({
    source: this.src,
    computation: () => false,
  });

  protected readonly initial = computed(() => {
    const name = this.name();
    // `Array.from` splits on code points, so a leading emoji / surrogate pair
    // yields a whole glyph instead of half a surrogate (a `charAt(0)` artifact).
    return (Array.from(name)[0] ?? '').toUpperCase() || '·';
  });

  protected readonly dim = computed(() => (this.size() === 'lg' ? 64 : 32));

  protected readonly imgClass = computed(() =>
    this.size() === 'lg'
      ? 'h-16 w-16 rounded-(--radius-md) border border-(--border-default) bg-(--surface-raised) object-contain'
      : 'h-8 w-8 rounded-(--radius-sm) object-contain',
  );

  protected readonly spanClass = computed(() =>
    this.size() === 'lg'
      ? 'flex h-16 w-16 items-center justify-center rounded-(--radius-md) border border-(--border-default) bg-(--surface-raised) font-display text-2xl font-semibold text-(--text-primary)'
      : 'flex h-8 w-8 items-center justify-center rounded-(--radius-sm) border border-(--border-default) bg-(--surface-raised) font-display text-sm font-semibold text-(--text-primary)',
  );

  constructor() {
    // Belt-and-suspenders for the pre-hydration race: an SSR-streamed <img> can
    // 404 and fire its `error` event BEFORE hydration attaches the (error)
    // listener. That event does not bubble and can fire before the event-replay
    // bootstrap installs its global handler, so event replay won't reliably
    // catch it. After the first browser render, probe the already-resolved
    // <img>: a broken image reports `complete === true && naturalWidth === 0`.
    //
    // Test-safety (load-bearing): in jsdom EVERY <img> reports
    // `complete === true` / `naturalWidth === 0` (images never load), which
    // would false-positive this check and break the "valid url renders img"
    // test. The `img.currentSrc` clause is the hard guard — jsdom never
    // populates `currentSrc` for an unloaded img — and `afterNextRender` + the
    // inner `requestAnimationFrame` are never flushed under the house
    // `fixture.detectChanges()` flow. So in tests this net stays inert and the
    // failure path is driven exclusively by an explicitly dispatched `error`
    // event. Do NOT remove the `img.currentSrc` clause.
    afterNextRender(() => {
      if (!isPlatformBrowser(this.platformId)) return;
      if (this.failed() || !this.src()) return;
      const img = this.host.nativeElement.querySelector('img');
      if (!img) return;
      requestAnimationFrame(() => {
        if (img.complete && img.naturalWidth === 0 && img.currentSrc) {
          this.failed.set(true);
        }
      });
    });
  }
}
