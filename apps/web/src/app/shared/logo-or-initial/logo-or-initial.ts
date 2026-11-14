import type { ClaimStatus } from '@aeci/shared';
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
 * `alt` is passed in (not generated) because the caller knows which case it is:
 * a logo that identifies an entity on a detail page passes `logoAlt(name)`, and
 * an inline row icon or avatar stays `''` (AECI-1569, Stage 1 §21.1).
 *
 * **The logo rule (AECI-1769, ADR 0056 floor 3, counsel's ruling 9).** An unclaimed
 * listing shows the initial tile everywhere except the one place on its own page
 * where the "not affiliated" note sits beside it. This component decides it:
 *
 * - A list or link payload (`ProductListItem`, `ProductLink`, `VendorLink`, an
 *   Algolia record) carries no claim status. The API already returns `logo_url: null`
 *   for an unclaimed listing there (AECI-1618, ADR 0051 decision 4), so the caller
 *   passes `src` and nothing else.
 * - A page-subject payload (`ProductDetail`, `VendorDetail`, `ProductPairSubject`)
 *   keeps the real logo and says `claim_status`. The caller MUST pass `claimStatus`.
 *   An unclaimed subject then renders the initial tile, unless the caller also sets
 *   `ownPage`, which it may do only where `<aec-unclaimed-note>` sits beside the mark.
 *   `logo-or-initial.callers.spec.ts` fails on a new caller until it is classified.
 *
 * The initial tile must not look lesser (`DESIGN.md` §5 "Logos and initial tiles"): a
 * rounded logo and its tile share the box, the border and the fill, and the tile takes
 * no muted styling.
 */
export type LogoSize = 'lg' | 'sm';

/** The one alt text for a logo that identifies a product or vendor (AECI-1569). */
export function logoAlt(name: string): string {
  return $localize`:@@shared.logo.alt:${name}:name: logo`;
}

/**
 * `rounded` is the catalog default (products, vendors — a logo is a rectangle).
 * `circle` is for a **person**: the account-menu avatar (AECI-850), where the
 * circle is what distinguishes "you" from the rectangular company marks the same
 * page is full of.
 */
export type LogoShape = 'rounded' | 'circle';

@Component({
  selector: 'aec-logo-or-initial',
  imports: [NgOptimizedImage],
  host: { class: 'inline-flex shrink-0' },
  template: `
    @if (showLogo()) {
      <img
        [ngSrc]="src()!"
        [alt]="alt()"
        [width]="dim()"
        [height]="dim()"
        [priority]="priority()"
        [class]="imgClass()"
        [attr.referrerpolicy]="referrerPolicy()"
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
  /** `rounded` for a company logo, `circle` for a person's avatar. */
  readonly shape = input<LogoShape>('rounded');
  /** Hero passes `true` (the logo is the LCP element). */
  readonly priority = input<boolean>(false);
  /**
   * Optional `referrerpolicy` for the `<img>`. The account avatar passes
   * `'no-referrer'` so loading a Google-hosted profile photo does not tell Google
   * which AECi page the signed-in visitor is on (AECI-850). Left unset — and so
   * absent from the DOM — for catalog logos, which are already public URLs on
   * pages a crawler can read anyway.
   */
  readonly referrerPolicy = input<string | null>(null);
  /**
   * The listing's claim status, when the payload carries one (a page subject). `null`
   * for a list or link payload, whose `logo_url` the API already withholds.
   */
  readonly claimStatus = input<ClaimStatus | null>(null);
  /**
   * `true` only at the one slot on the subject's own page where `<aec-unclaimed-note>`
   * sits beside the mark (counsel's ruling 9). It lets an unclaimed subject keep its
   * small sourced logo there. It does nothing for a claimed listing.
   */
  readonly ownPage = input<boolean>(false);

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

  /** The logo rule, in one place (AECI-1769). See the class comment. */
  protected readonly showLogo = computed(
    () => !!this.src() && !this.failed() && (this.claimStatus() !== 'unclaimed' || this.ownPage()),
  );

  protected readonly initial = computed(() => {
    const name = this.name();
    // `Array.from` splits on code points, so a leading emoji / surrogate pair
    // yields a whole glyph instead of half a surrogate (a `charAt(0)` artifact).
    return (Array.from(name)[0] ?? '').toUpperCase() || '·';
  });

  protected readonly dim = computed(() => (this.size() === 'lg' ? 64 : 32));

  /** `circle` overrides the per-size radius; a photo is cropped, not framed, so
   *  it also takes `object-cover` rather than the logo's `object-contain`.
   *  The 32px mark is a small mark, `rounded-mark` (8px, `DESIGN.md` §4 "Radius").
   *  The 64px radius is open (AECI-1750), so it keeps the shipped `--radius-md`. */
  private readonly radiusClass = computed(() => {
    if (this.shape() === 'circle') return 'rounded-full';
    return this.size() === 'lg' ? 'rounded-(--radius-md)' : 'rounded-mark';
  });

  /** The frame a rounded logo and its initial tile share, so the tile never looks
   *  lesser (AECI-1769). The border colour is `--border-default` from the unlayered
   *  `*` rule in `styles.css`, which beats any border-colour utility. A person's photo
   *  stays unframed, as shipped (AECI-850). */
  private readonly frameClass = computed(() =>
    this.shape() === 'circle' ? '' : 'border bg-(--surface-raised)',
  );

  private readonly fitClass = computed(() =>
    this.shape() === 'circle' ? 'object-cover' : 'object-contain',
  );

  protected readonly imgClass = computed(
    () =>
      `${this.size() === 'lg' ? 'h-16 w-16' : 'h-8 w-8'} ${this.radiusClass()} ${this.frameClass()} ${this.fitClass()}`,
  );

  protected readonly spanClass = computed(() =>
    this.size() === 'lg'
      ? `flex h-16 w-16 items-center justify-center ${this.radiusClass()} border bg-(--surface-raised) font-display text-2xl font-semibold text-(--text-primary)`
      : `flex h-8 w-8 items-center justify-center ${this.radiusClass()} border bg-(--surface-raised) font-display text-sm font-semibold text-(--text-primary)`,
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
      if (!this.showLogo()) return;
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
