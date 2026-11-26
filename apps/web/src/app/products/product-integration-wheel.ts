import { OverlayModule, type ConnectedPosition } from '@angular/cdk/overlay';
import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';

import type { ProductDetail } from '@aeci/shared';
import { connectorKindFor } from '@aeci/shared/api/connector-kind';

import { AecIcon } from '../shared/icon/icon';
import { injectInPageHrefFor } from '../shared/in-page-href';
import { LogoOrInitial } from '../shared/logo-or-initial/logo-or-initial';

import { connectorWheelCaption } from './connector-kind-labels';
import {
  WHEEL_BANDS,
  heroWheelModel,
  layoutSlide,
  type WheelLayout,
  type WheelProduct,
  type WheelSlide,
} from './integration-wheel';

/** A layout and the key its CSS custom properties carry: the band's index in `WHEEL_BANDS`. */
interface KeyedLayout {
  readonly key: string;
  readonly layout: WheelLayout;
}

/** The card's estimated size before it is measured, px. */
const CARD_WIDTH = 264;
const CARD_HEIGHT = 88;
/** The gap between a tile and its card, and the card's margin from the screen edge. */
const CARD_GAP = 12;
const SCREEN_MARGIN = 8;
/** Ruling: the card stays open this long after the pointer leaves (ms). */
const CARD_GRACE = 120;
/** A touch held this long opens the card instead of following the link (ms). */
const LONG_PRESS = 450;

/**
 * AECI-2018 - the integrations wheel in the product page hero. It replaces ruling R3
 * decision 1's category hub and pair finder (AECI-1787). Mock-up 9w is the reference
 * (`docs/design/mockups/redesign-2026-11/mockups/9-product-hero-wheel.html`), and
 * `DESIGN.md` §5 "The hero diagram" records the built values.
 *
 * One circle. "All integrations" first, then one slide per category A to Z. Left and
 * right arrows step, wrapping; nothing moves on its own. The title names the slide with a
 * count line and opens a flat A to Z list to jump. Each product is one tile, a link to the
 * pair page, A to Z clockwise from 12 o'clock (`integration-wheel.ts` has the rule and
 * the geometry). A slide too big for tiles shows one dot per integration and the count
 * in the centre instead, and names no product.
 *
 * Rendering. The first slide is in the cached server HTML, the same for every visitor,
 * and reads as a list of links with no script. The server cannot know the width, so it
 * lays the slide out at each of `WHEEL_BANDS` and CSS picks one by container query
 * (`.aec-wheel` in `styles.css`): no layout shift, and a phone with no script never gets
 * a tile under 24px. The browser uses the same bands, so hydration changes nothing on
 * screen, and stepping lays the new slide out at every band too. With no script the
 * arrows and the list are hidden and a static title shows (`@media (scripting: none)`).
 *
 * Keyboard. The ring is one tab stop after hydration (before it every link is a stop, so
 * a reader with no script can reach them all). Left and Up go back, Right and Down go
 * forward, Home and End go to the ends, and it wraps. A slide change is announced in a
 * polite live region: "{name}, {n} products. {i} of {total}."
 *
 * The card. Hover, keyboard focus and a 450ms touch hold open it: the logo, the name, an
 * "Unclaimed" label for an unclaimed listing and "by {vendor}". It opens toward the
 * centre of the wheel, kept inside the stage from top to bottom so it never covers the
 * title or the lines, and inside the screen sideways. It is a CDK overlay, so the hero
 * never clips it. It stays open while hovered, closes 120ms after the pointer leaves, and
 * Escape closes it.
 *
 * A connector's wheel (QA pass on AECI-2035). On a connector the model is the products
 * its pairs reach (`heroWheelModel`, `integration-wheel.ts`). The title says so by kind
 * ("Products it syncs", "Products it connects"), a tile links to that product's page
 * (the connector is not one of the pair's two products, so there is no pair page to
 * link), a dot is one product, and the no-script link points at the section that lists
 * its pairs.
 *
 * Logos (ruling 64). A tile shows the product's logo whenever we hold one, claimed or
 * not, from `ProductDetail.wheel_marks`, and its initial when we hold none. No tile is
 * marked, badged, dimmed or outlined. The centre is the page's own product by the same
 * rule (its own mark), at any claim state. The two lines under a tile slide are always
 * there.
 */
@Component({
  selector: 'aec-product-integration-wheel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AecIcon, LogoOrInitial, OverlayModule, RouterLink],
  host: {
    class: 'block',
    '(document:keydown.escape)': 'onEscape()',
    '(document:click)': 'onDocumentClick($event)',
  },
  template: `
    @let s = slide();
    @let p = product();
    <section
      #root
      class="aec-wheel"
      aria-labelledby="aec-wheel-title"
      data-testid="product-hero-wheel"
      [attr.data-slide]="index()"
      [attr.data-live]="live() ? '' : null"
      [attr.data-settled]="settled() ? '' : null"
      [attr.data-m0]="modeOf('0')"
      [attr.data-m1]="modeOf('1')"
      [attr.data-m2]="modeOf('2')"
      [attr.data-m3]="modeOf('3')"
      [attr.data-m4]="modeOf('4')"
      [attr.data-m5]="modeOf('5')"
      [attr.data-m6]="modeOf('6')"
      [attr.data-m7]="modeOf('7')"
      [attr.data-n0]="namesOf('0')"
      [attr.data-n1]="namesOf('1')"
      [attr.data-n2]="namesOf('2')"
      [attr.data-n3]="namesOf('3')"
      [attr.data-n4]="namesOf('4')"
      [attr.data-n5]="namesOf('5')"
      [attr.data-n6]="namesOf('6')"
      [attr.data-n7]="namesOf('7')"
    >
      <div class="aec-wheel-head" [class.aec-wheel-head-single]="single()">
        @if (!single()) {
          <button
            type="button"
            class="aec-wheel-step"
            data-testid="product-hero-wheel-prev"
            [attr.aria-label]="previousLabel()"
            (click)="step(-1)"
          >
            <aec-icon name="chevron-left" decorative [size]="5" />
          </button>
        }
        <h2 id="aec-wheel-title" class="aec-wheel-title">
          @if (!single()) {
            <button
              #jump
              type="button"
              class="aec-wheel-jump"
              aria-controls="aec-wheel-list"
              data-testid="product-hero-wheel-title"
              [attr.aria-expanded]="listOpen()"
              (click)="toggleList()"
            >
              <span class="aec-wheel-name"
                >{{ slideName(s) }}<aec-icon name="chevron-down" decorative [size]="4"
              /></span>
              <span class="sr-only">, </span>
              <span class="aec-wheel-count">{{ productCount(s.products.length) }}</span>
            </button>
          }
          <span class="aec-wheel-static" data-testid="product-hero-wheel-static-title">
            <span class="aec-wheel-name">{{ slideName(s) }}</span>
            <span class="sr-only">, </span>
            <span class="aec-wheel-count">{{ productCount(s.products.length) }}</span>
          </span>
        </h2>
        @if (!single()) {
          <button
            type="button"
            class="aec-wheel-step"
            data-testid="product-hero-wheel-next"
            [attr.aria-label]="nextLabel()"
            (click)="step(1)"
          >
            <aec-icon name="chevron-right" decorative [size]="5" />
          </button>
          <ul
            #list
            id="aec-wheel-list"
            class="aec-popover aec-wheel-list"
            data-testid="product-hero-wheel-list"
            [attr.aria-label]="listLabel"
            [hidden]="!listOpen()"
          >
            @for (option of model().slides; track option.key; let i = $index) {
              <li>
                <button
                  type="button"
                  class="aec-wheel-option"
                  [attr.aria-current]="i === index() ? 'true' : null"
                  (click)="jumpTo(i)"
                  (keydown)="onListKey($event)"
                >
                  <span>{{ slideName(option) }}</span>
                  <span class="aec-wheel-option-count" aria-hidden="true">{{
                    option.products.length
                  }}</span>
                  <span class="sr-only">, {{ productCount(option.products.length) }}</span>
                </button>
              </li>
            }
          </ul>
        }
      </div>

      <div #stage class="aec-wheel-stage" [attr.style]="stageStyle()">
        <div class="aec-wheel-art" (animationend)="settled.set(true)">
          @for (k of layouts(); track k.key) {
            <svg
              class="aec-wheel-guides"
              viewBox="-50 -50 100 100"
              aria-hidden="true"
              focusable="false"
              [attr.data-band]="k.key"
            >
              <circle class="aec-wheel-frame" [attr.r]="k.layout.frame" />
              <path
                class="aec-wheel-start"
                [attr.d]="'M0 ' + (-k.layout.frame - 1.4) + 'V' + (-k.layout.frame + 2.2)"
              />
              @if (k.layout.mode !== 'dots') {
                <circle class="aec-wheel-orbit" [attr.r]="k.layout.outer" />
                @if (k.layout.inner !== null) {
                  <circle
                    class="aec-wheel-orbit aec-wheel-orbit-inner"
                    [class.is-off]="k.layout.mode !== 'two'"
                    [attr.r]="k.layout.inner"
                  />
                }
              }
            </svg>
            @if (k.layout.mode === 'dots') {
              <svg
                class="aec-wheel-dots"
                viewBox="-50 -50 100 100"
                aria-hidden="true"
                focusable="false"
                data-testid="product-hero-wheel-dots"
                [attr.data-band]="k.key"
              >
                @for (ring of k.layout.dotRings; track $index) {
                  <!-- One dot per integration: a zero-length dash with a round cap, the
                       circle's length set to the dot count. Rotated so the first dot is
                       at 12 o'clock. -->
                  <circle
                    transform="rotate(-90)"
                    stroke-dasharray="0 1"
                    stroke-linecap="round"
                    [attr.r]="ring.r"
                    [attr.stroke-width]="k.layout.dot"
                    [attr.pathLength]="ring.dots"
                    [attr.data-dots]="ring.dots"
                  />
                }
              </svg>
            }
          }
          <ul
            #ring
            class="aec-wheel-ring"
            data-testid="product-hero-wheel-ring"
            aria-describedby="aec-wheel-hint aec-wheel-lines"
            [attr.aria-label]="ringLabel()"
          >
            <!-- A slide that is dots at every width shows no product at all. -->
            @for (t of tiled() ? s.products : []; track t.id; let i = $index) {
              <li [attr.style]="tileStyle(i)">
                <a
                  class="aec-wheel-tile"
                  data-testid="product-hero-wheel-tile"
                  [attr.aria-label]="t.name"
                  [routerLink]="tileLink(t)"
                  [attr.tabindex]="live() ? (i === active() ? 0 : -1) : null"
                  [attr.aria-describedby]="card()?.index === i ? 'aec-wheel-card' : null"
                  [class.is-active]="card()?.index === i"
                  (keydown)="onRingKey($event)"
                  (focus)="onTileFocus(i, $event)"
                  (blur)="hideCardSoon()"
                  (pointerenter)="onTileEnter(i, $event)"
                  (pointerleave)="onTileLeave($event)"
                  (pointerdown)="onTileDown(i, $event)"
                  (pointerup)="cancelHold()"
                  (pointercancel)="cancelHold()"
                  (contextmenu)="onTileContextMenu($event)"
                >
                  <aec-logo-or-initial
                    class="size-full"
                    [src]="t.logoUrl"
                    [name]="t.name"
                    [claimStatus]="'wheel'"
                    size="tile"
                  />
                  <!-- The visible name under the tile. The link's name is its aria-label,
                       so this text is hidden from assistive tech, and not rendered at all
                       where names are off (find-in-page and text-fragment links skip it). -->
                  <span class="aec-wheel-label" aria-hidden="true">{{ t.name }}</span>
                </a>
              </li>
            }
          </ul>
        </div>
        <div class="aec-wheel-hub">
          <div class="aec-wheel-hub-mark" data-testid="product-hero-wheel-centre">
            <!-- The page's own product, by ruling 64's rule: the logo we may show,
                 claimed or not (its mark in wheel_marks), else the initial. -->
            <aec-logo-or-initial
              class="size-full"
              [src]="centreLogo()"
              [name]="p.name"
              [claimStatus]="'wheel'"
              size="hero"
            />
          </div>
          <p class="aec-wheel-hub-count" data-testid="product-hero-wheel-hub-count">
            <span class="aec-wheel-hub-figure">{{ s.integrations }}</span>
            <span class="aec-wheel-hub-words"> {{ hubWords(s) }}</span>
          </p>
        </div>
      </div>

      <p
        id="aec-wheel-lines"
        class="aec-wheel-lines aec-wheel-lines-tiles"
        data-testid="product-hero-wheel-lines"
      >
        <span class="aec-wheel-line" i18n="@@products.detail.hero.wheel.line.order"
          >Shown A to Z. Position is not a ranking.</span
        >&ngsp;<span class="aec-wheel-line" i18n="@@products.detail.hero.wheel.line.logos"
          ><span class="aec-wheel-phrase">Logos identify products only</span>&ngsp;<span
            class="aec-wheel-phrase"
            >and imply no endorsement</span
          >&ngsp;<span class="aec-wheel-phrase">or affiliation.</span>&ngsp;<span
            class="aec-wheel-phrase"
            >Listings may be unclaimed.</span
          ></span
        >
      </p>
      @if (isConnector()) {
        <p
          class="aec-wheel-lines aec-wheel-lines-dots"
          data-testid="product-hero-wheel-dots-line"
          i18n="@@products.detail.hero.wheel.line.dots.connector"
        >
          Too many to show as tiles. Each dot is one product.
        </p>
      } @else {
        <p
          class="aec-wheel-lines aec-wheel-lines-dots"
          data-testid="product-hero-wheel-dots-line"
          i18n="@@products.detail.hero.wheel.line.dots"
        >
          Too many to show as tiles. Each dot is one integration.
        </p>
      }
      <p class="aec-wheel-more">
        <a [href]="seeAllHref()" data-testid="product-hero-wheel-see-all">{{ seeAllLabel(s) }}</a>
      </p>
      <p id="aec-wheel-hint" class="sr-only" i18n="@@products.detail.hero.wheel.hint">
        Arrow keys move between products.
      </p>
      <p class="sr-only" aria-live="polite" data-testid="product-hero-wheel-live">
        {{ announcement() }}
      </p>
    </section>

    <ng-template
      cdkConnectedOverlay
      [cdkConnectedOverlayOrigin]="cardOrigin()"
      [cdkConnectedOverlayOpen]="card() !== null"
      [cdkConnectedOverlayPositions]="cardPositions()"
      [cdkConnectedOverlayPush]="false"
      [cdkConnectedOverlayFlexibleDimensions]="false"
      (attach)="placeCardSoon()"
    >
      @if (card(); as c) {
        <div
          #cardEl
          id="aec-wheel-card"
          role="tooltip"
          class="aec-popover aec-wheel-card"
          data-testid="product-hero-wheel-card"
          (pointerenter)="keepCard()"
          (pointerleave)="hideCardSoon()"
        >
          <aec-logo-or-initial
            [src]="c.product.logoUrl"
            [name]="c.product.name"
            [claimStatus]="'wheel'"
            size="md"
          />
          <div class="min-w-0">
            <p class="aec-wheel-card-name">
              <span>{{ c.product.name }}</span>
              @if (c.product.claimStatus === 'unclaimed') {
                <span class="sr-only">, </span>
                <span
                  class="aec-wheel-card-unclaimed"
                  data-testid="product-hero-wheel-card-unclaimed"
                  i18n="@@products.detail.hero.wheel.card.unclaimed"
                  >Unclaimed</span
                >
              }
            </p>
            @if (c.product.vendorName; as vendor) {
              &ngsp;
              <p class="aec-wheel-card-vendor">{{ byVendor(vendor) }}</p>
            }
          </div>
        </div>
      }
    </ng-template>
  `,
})
export class ProductIntegrationWheel {
  readonly product = input.required<ProductDetail>();

  private readonly destroyRef = inject(DestroyRef);
  private readonly doc = inject(DOCUMENT);
  private readonly stage = viewChild.required<ElementRef<HTMLElement>>('stage');
  private readonly ring = viewChild.required<ElementRef<HTMLUListElement>>('ring');
  private readonly jump = viewChild<ElementRef<HTMLButtonElement>>('jump');
  private readonly list = viewChild<ElementRef<HTMLUListElement>>('list');
  private readonly cardEl = viewChild<ElementRef<HTMLElement>>('cardEl');

  protected readonly listLabel = $localize`:@@products.detail.hero.wheel.list.label:Jump to a category`;

  /** The wheel's set: a connector's reach or the endpoint rows (`heroWheelSource`). */
  protected readonly model = computed(() => heroWheelModel(this.product()));

  /** Whether this is a connector's wheel: products reached, not partners. */
  protected readonly isConnector = computed(() => this.model().source === 'connector');

  /** The centre's logo: the page product's own mark (ruling 64), or none. */
  protected readonly centreLogo = computed(() => {
    const p = this.product();
    return p.wheel_marks?.find((m) => m.product_id === p.id)?.logo_url ?? null;
  });

  /** The slide shown. The server always renders the first. */
  protected readonly index = signal(0);
  protected readonly slide = computed(() => this.model().slides[this.index()]!);
  protected readonly single = computed(() => this.model().slides.length === 1);

  /**
   * Set once the browser has hydrated the wheel. Then the ring is one tab stop. The layout
   * never changes at hydration: the browser picks the same band the server wrote, by
   * container query, so names, ring count and tiles or dots stay as painted.
   */
  private readonly hydrated = signal(false);
  protected readonly live = this.hydrated.asReadonly();
  /** The entrance has run, or the reader stepped: it never plays again. */
  protected readonly settled = signal(false);

  /** The slide laid out at every band (`WHEEL_BANDS`), keyed by the band's index. */
  protected readonly layouts = computed<readonly KeyedLayout[]>(() => {
    const model = this.model();
    const i = this.index();
    return WHEEL_BANDS.map((band, k) => ({ key: String(k), layout: layoutSlide(model, i, band) }));
  });

  /** `{path}#{id}`: a bare fragment resolves against `<base href="/">` (AECI-1839). */
  private readonly hrefFor = injectInPageHrefFor();

  /**
   * The no-script link: `#integrations`, or on a connector's wheel `#powered-integrations`,
   * the section that lists its pairs. A connector whose reach is only Convention-A rows
   * has no pair of its own, so its products are in the Integrations section.
   */
  protected readonly seeAllHref = computed(() => {
    const hrefFor = this.hrefFor();
    if (!this.isConnector()) return hrefFor('integrations');
    const p = this.product();
    const ownPairs = p.integrations_as_connector.some(
      (i) => i.source.slug !== p.slug && i.target.slug !== p.slug,
    );
    return hrefFor(ownPairs ? 'powered-integrations' : 'integrations');
  });

  /** A tile's link: the pair page, or on a connector's wheel the product's own page. */
  protected tileLink(t: WheelProduct): string[] {
    return this.isConnector()
      ? ['/products', t.slug]
      : ['/products', this.product().slug, 'integrations', t.slug];
  }

  /** Whether any layout shows tiles. When none does, the ring holds no product. */
  protected readonly tiled = computed(() => this.layouts().some((k) => k.layout.mode !== 'dots'));

  /** The ring's roving tab stop. */
  protected readonly active = signal(0);
  protected readonly listOpen = signal(false);
  protected readonly announcement = signal('');

  /** The open card: which tile, its element and its product. */
  protected readonly card = signal<{
    readonly index: number;
    readonly tile: HTMLElement;
    readonly product: WheelProduct;
  } | null>(null);
  protected readonly cardOrigin = computed(() => this.card()?.tile ?? this.stage().nativeElement);
  protected readonly cardPositions = signal<ConnectedPosition[]>([
    { originX: 'center', originY: 'center', overlayX: 'center', overlayY: 'center' },
  ]);
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  /** A touch hold opened the card, so its release must not follow the link. */
  private held = false;
  /** The open card came from a touch hold: a tap elsewhere or a scroll closes it. */
  private byTouch = false;

  constructor() {
    afterNextRender(() => {
      this.hydrated.set(true);
      // A touch hold's release must not follow the link. RouterLink listens on the tile
      // itself, so the ring stops the click in the capture phase, before it gets there.
      const ring = this.ring().nativeElement;
      const onClick = (event: MouseEvent) => this.onTileClick(event);
      ring.addEventListener('click', onClick, true);
      this.destroyRef.onDestroy(() => ring.removeEventListener('click', onClick, true));
    });
    this.destroyRef.onDestroy(() => {
      this.clearHide();
      this.cancelHold();
      this.stopListening?.();
    });
  }

  // ─── Words ──────────────────────────────────────────────────────────────────

  protected slideName(s: WheelSlide): string {
    if (s.name !== null) return s.name;
    if (this.isConnector()) {
      const p = this.product();
      return connectorWheelCaption(connectorKindFor(p.product_role, p.connector_kind));
    }
    return $localize`:@@products.detail.hero.wheel.all:All integrations`;
  }

  protected productCount(n: number): string {
    if (n === 1) return $localize`:@@products.detail.hero.wheel.products.one:1 product`;
    return $localize`:@@products.detail.hero.wheel.products.other:${n}:count: products`;
  }

  protected readonly ringLabel = computed(() => {
    const s = this.slide();
    const name = this.slideName(s);
    const products = this.productCount(s.products.length);
    return $localize`:@@products.detail.hero.wheel.ring.label:${name}:NAME:, ${products}:PRODUCTS:, A to Z`;
  });

  private neighbour(delta: number): WheelSlide {
    const slides = this.model().slides;
    return slides[(this.index() + delta + slides.length) % slides.length]!;
  }

  protected readonly previousLabel = computed(() => {
    const name = this.slideName(this.neighbour(-1));
    return $localize`:@@products.detail.hero.wheel.previous:Previous category: ${name}:NAME:`;
  });

  protected readonly nextLabel = computed(() => {
    const name = this.slideName(this.neighbour(1));
    return $localize`:@@products.detail.hero.wheel.next:Next category: ${name}:NAME:`;
  });

  /** The words after the centre's figure: "integrations in 14 categories". */
  protected hubWords(s: WheelSlide): string {
    const one = s.integrations === 1;
    // A connector's dot is one product (`connectorWheelModel`).
    if (this.isConnector()) {
      return one
        ? $localize`:@@products.detail.hero.wheel.hub.connector.one:product`
        : $localize`:@@products.detail.hero.wheel.hub.connector.other:products`;
    }
    if (s.name !== null) {
      const name = s.name;
      return one
        ? $localize`:@@products.detail.hero.wheel.hub.category.one:integration in ${name}:NAME:`
        : $localize`:@@products.detail.hero.wheel.hub.category.other:integrations in ${name}:NAME:`;
    }
    const n = this.model().categoryCount;
    if (n === 0) {
      return one
        ? $localize`:@@products.detail.hero.wheel.hub.all.one.noCategory:integration`
        : $localize`:@@products.detail.hero.wheel.hub.all.other.noCategory:integrations`;
    }
    if (n === 1) {
      return one
        ? $localize`:@@products.detail.hero.wheel.hub.all.one.oneCategory:integration in 1 category`
        : $localize`:@@products.detail.hero.wheel.hub.all.other.oneCategory:integrations in 1 category`;
    }
    return one
      ? $localize`:@@products.detail.hero.wheel.hub.all.one:integration in ${n}:count: categories`
      : $localize`:@@products.detail.hero.wheel.hub.all.other:integrations in ${n}:count: categories`;
  }

  protected seeAllLabel(s: WheelSlide): string {
    if (this.isConnector()) {
      return $localize`:@@products.detail.hero.wheel.seeAll.connector:See its integrations below`;
    }
    const n = s.integrations;
    return $localize`:@@products.detail.hero.wheel.seeAll:See all ${n}:count: in Integrations`;
  }

  protected byVendor(vendor: string): string {
    return $localize`:@@products.detail.hero.wheel.card.vendor:by ${vendor}:VENDOR:`;
  }

  // ─── Layout bindings ────────────────────────────────────────────────────────

  private find(key: string): WheelLayout | null {
    return this.layouts().find((k) => k.key === key)?.layout ?? null;
  }

  protected modeOf(key: string): string | null {
    return this.find(key)?.mode ?? null;
  }

  protected namesOf(key: string): string | null {
    return this.find(key)?.names ? '' : null;
  }

  /** Per layout: the tile size in percent, and the initial's size in px. */
  protected readonly stageStyle = computed(() =>
    this.layouts()
      .map(
        ({ key, layout }) =>
          `--t${key}:${layout.tile};--i${key}:${Math.max(12, Math.round(layout.tilePx * 0.4))}px`,
      )
      .join(';'),
  );

  /** Per layout: where tile `i` sits, in percent from the centre. */
  protected tileStyle(i: number): string {
    return this.layouts()
      .flatMap(({ key, layout }) => {
        const point = layout.points[i];
        return point ? [`--x${key}:${point.x};--y${key}:${point.y}`] : [];
      })
      .join(';');
  }

  // ─── Stepping and the list ──────────────────────────────────────────────────

  protected step(delta: number): void {
    this.listOpen.set(false);
    const total = this.model().slides.length;
    this.show((this.index() + delta + total) % total);
  }

  private show(i: number): void {
    this.hideCard();
    this.settled.set(true);
    this.index.set(i);
    this.active.set(0);
    const s = this.slide();
    const name = this.slideName(s);
    const products = this.productCount(s.products.length);
    const position = i + 1;
    const total = this.model().slides.length;
    this.announcement.set(
      $localize`:@@products.detail.hero.wheel.announce:${name}:NAME:, ${products}:PRODUCTS:. ${position}:INDEX: of ${total}:TOTAL:.`,
    );
  }

  protected toggleList(): void {
    if (this.listOpen()) {
      this.closeList(true);
      return;
    }
    this.listOpen.set(true);
    // Focus the current slide once the list is shown.
    setTimeout(() => {
      const list = this.list()?.nativeElement;
      const target =
        list?.querySelector<HTMLButtonElement>('[aria-current="true"]') ??
        list?.querySelector<HTMLButtonElement>('button');
      target?.focus();
      target?.scrollIntoView?.({ block: 'nearest' });
    });
  }

  private closeList(focusTitle: boolean): void {
    if (!this.listOpen()) return;
    this.listOpen.set(false);
    if (focusTitle) this.jump()?.nativeElement.focus();
  }

  protected jumpTo(i: number): void {
    this.closeList(true);
    this.show(i);
  }

  protected onListKey(event: KeyboardEvent): void {
    const buttons = Array.from(
      this.list()?.nativeElement.querySelectorAll<HTMLButtonElement>('button') ?? [],
    );
    const at = buttons.indexOf(this.doc.activeElement as HTMLButtonElement);
    const go = (k: number) => {
      event.preventDefault();
      buttons[Math.max(0, Math.min(buttons.length - 1, k))]?.focus();
    };
    switch (event.key) {
      case 'ArrowDown':
        return go(at + 1);
      case 'ArrowUp':
        return go(at - 1);
      case 'Home':
        return go(0);
      case 'End':
        return go(buttons.length - 1);
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        return this.closeList(true);
      case 'Tab':
        return this.closeList(false);
    }
  }

  protected onDocumentClick(event: MouseEvent): void {
    if (!this.listOpen()) return;
    const target = event.target as Element | null;
    if (target?.closest('.aec-wheel-title') || target?.closest('.aec-wheel-list')) return;
    this.closeList(false);
  }

  /** Escape closes the card, and the title list (focus returns to the title). */
  protected onEscape(): void {
    if (this.card()) this.hideCard();
    if (this.listOpen()) this.closeList(true);
  }

  // ─── The ring ───────────────────────────────────────────────────────────────

  private tiles(): HTMLElement[] {
    return Array.from(this.ring().nativeElement.querySelectorAll<HTMLElement>('.aec-wheel-tile'));
  }

  protected onRingKey(event: KeyboardEvent): void {
    // A key ends a touch hold: Android often fires no click after a long press, so a
    // later Enter's click must not be swallowed.
    this.held = false;
    const count = this.slide().products.length;
    if (count === 0) return;
    let next: number;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        next = this.active() + 1;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        next = this.active() - 1;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = count - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const i = (next + count) % count;
    this.active.set(i);
    this.tiles()[i]?.focus();
  }

  protected onTileFocus(i: number, event: FocusEvent): void {
    this.active.set(i);
    this.openCard(i, event.currentTarget as HTMLElement);
  }

  protected onTileEnter(i: number, event: PointerEvent): void {
    if (event.pointerType === 'touch') return;
    this.openCard(i, event.currentTarget as HTMLElement);
  }

  protected onTileLeave(event: PointerEvent): void {
    if (event.pointerType === 'touch') return;
    if (event.currentTarget === this.doc.activeElement) return;
    this.hideCardSoon();
  }

  protected onTileDown(i: number, event: PointerEvent): void {
    // Every press starts fresh, so a mouse click after a touch hold is not swallowed.
    this.held = false;
    this.cancelHold();
    if (event.pointerType !== 'touch') return;
    const tile = event.currentTarget as HTMLElement;
    this.holdTimer = setTimeout(() => {
      this.held = true;
      this.openCard(i, tile);
      this.byTouch = true;
    }, LONG_PRESS);
  }

  protected cancelHold(): void {
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.holdTimer = null;
  }

  /** A touch hold showed the card, so its release does not follow the link. */
  private onTileClick(event: MouseEvent): void {
    if (!this.held) return;
    this.held = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  protected onTileContextMenu(event: Event): void {
    if (this.held) event.preventDefault();
  }

  // ─── The card ───────────────────────────────────────────────────────────────

  private openCard(i: number, tile: HTMLElement): void {
    this.clearHide();
    this.byTouch = false;
    const product = this.slide().products[i];
    if (!product) return;
    this.cardPositions.set([this.positionFor(tile, CARD_WIDTH, CARD_HEIGHT)]);
    this.card.set({ index: i, tile, product });
    this.placeCardSoon();
    this.listenWhileOpen();
  }

  /**
   * The dismissal listeners, attached only while a card is open, so a press or a scroll
   * elsewhere on the page costs nothing the rest of the time. Plain DOM listeners: a host
   * listener would run change detection on every scroll event of the page.
   */
  private listenWhileOpen(): void {
    if (this.stopListening) return;
    const view = this.doc.defaultView;
    const press = (event: PointerEvent) => this.onDocumentPointerDown(event);
    const scroll = () => this.onScroll();
    // A resize can change the band, and a card must not sit over a slide now drawn as dots.
    const resize = () => this.hideCard();
    this.doc.addEventListener('pointerdown', press, true);
    view?.addEventListener('scroll', scroll, { passive: true });
    view?.addEventListener('resize', resize);
    this.stopListening = () => {
      this.doc.removeEventListener('pointerdown', press, true);
      view?.removeEventListener('scroll', scroll);
      view?.removeEventListener('resize', resize);
      this.stopListening = null;
    };
  }
  private stopListening: (() => void) | null = null;

  protected keepCard(): void {
    this.clearHide();
  }

  protected hideCardSoon(): void {
    this.clearHide();
    this.hideTimer = setTimeout(() => this.hideCard(), CARD_GRACE);
  }

  private hideCard(): void {
    this.clearHide();
    this.byTouch = false;
    this.stopListening?.();
    this.card.set(null);
  }

  /**
   * WCAG 1.4.13: a card opened by a touch hold has no pointer to leave, so a press
   * anywhere outside the card and its tile closes it. So does any press outside both for
   * a card opened by hover or focus.
   */
  private onDocumentPointerDown(event: PointerEvent): void {
    // A new press anywhere ends a touch hold, so its click is never swallowed later.
    this.held = false;
    const card = this.card();
    if (!card) return;
    const target = event.target as Node | null;
    if (target && (card.tile.contains(target) || this.cardEl()?.nativeElement.contains(target))) {
      return;
    }
    this.hideCard();
  }

  /** A scroll closes a card a touch hold opened: the finger has moved on. */
  private onScroll(): void {
    if (this.byTouch) this.hideCard();
  }

  private clearHide(): void {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = null;
  }

  /** Measure the card once it renders, and place it again at its real size. */
  protected placeCardSoon(): void {
    requestAnimationFrame(() => {
      const card = this.card();
      const el = this.cardEl()?.nativeElement;
      if (!card || !el) return;
      const { width, height } = el.getBoundingClientRect();
      this.cardPositions.set([this.positionFor(card.tile, width, height)]);
    });
  }

  /**
   * Toward the centre (ruling, 2026-11-24). A tile at the side gets the card beside it on
   * the centre's side; a tile at the top or bottom gets it below or above. Then the card
   * is held inside the screen sideways and inside the stage from top to bottom, so it
   * never covers the title or the lines. Returned as an offset from the tile's centre.
   */
  private positionFor(tile: HTMLElement, width: number, height: number): ConnectedPosition {
    const r = tile.getBoundingClientRect();
    const st = this.stage().nativeElement.getBoundingClientRect();
    const screen = this.doc.documentElement.clientWidth;
    const tx = r.left + r.width / 2;
    const ty = r.top + r.height / 2;
    const dx = st.left + st.width / 2 - tx;
    const dy = st.top + st.height / 2 - ty;
    let x: number;
    let y: number;
    if (Math.abs(dx) >= Math.abs(dy) * 0.6) {
      x = dx >= 0 ? r.right + CARD_GAP : r.left - CARD_GAP - width;
      y = ty - height / 2;
    } else {
      x = tx - width / 2;
      y = dy >= 0 ? r.bottom + CARD_GAP : r.top - CARD_GAP - height;
    }
    x = Math.max(SCREEN_MARGIN, Math.min(screen - SCREEN_MARGIN - width, x));
    y = Math.max(st.top, Math.min(st.bottom - height, y));
    return {
      originX: 'center',
      originY: 'center',
      overlayX: 'center',
      overlayY: 'center',
      offsetX: Math.round(x + width / 2 - tx),
      offsetY: Math.round(y + height / 2 - ty),
    };
  }
}
