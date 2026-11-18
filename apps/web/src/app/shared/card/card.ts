import { isPlatformBrowser } from '@angular/common';
import {
  Directive,
  ElementRef,
  PLATFORM_ID,
  booleanAttribute,
  computed,
  inject,
  input,
  type OnInit,
} from '@angular/core';

import {
  type HostRecipe,
  ServerHostClasses,
  applyHostRecipe,
  dropStaleRecipe,
  hostRecipe,
  staticHostAttribute,
} from '../host-recipe';

/**
 * The card looks (DESIGN.md section 5 "Cards", section 4 "Shadow Vocabulary").
 *
 * - `base`: white fill. The default card that stands on the page ground.
 * - `warm`: Bone fill. For a card that is meant to read as the page's featured one.
 *
 * A card nested inside another card is `nested` instead (clash 14): it takes the
 * Forest-soft tint, the 16px panel radius and no shadow, so a stack shows one
 * elevation.
 */
export type AecCardTone = 'base' | 'warm';

/** The leading-edge score stripe (clash 15). Always paired with a text label. */
export type AecCardStripe = 'forest' | 'clay';

export interface AecCardOptions {
  readonly tone?: AecCardTone;
  /** A card that is one link or one button. It lifts on hover and press. */
  readonly interactive?: boolean;
  /** A card inside another card: tint, 16px radius, no shadow. */
  readonly nested?: boolean;
  readonly stripe?: AecCardStripe | null;
  /** A form card: below `sm` the frame drops and the card spans the page gutter. */
  readonly phoneFlush?: boolean;
}

/**
 * Frame only: radius, fill, edge, shadow and lift. Padding and layout stay with the
 * caller (`p-6`, or `p-4` in a dense list; `flex flex-col gap-4`).
 *
 * EDGE. The 1px border is transparent and comes from the unlayered `.aec-card`
 * rule in `styles.css`, because a `border-(--x)` utility loses to the unlayered
 * `* { border-color }` rule. There is no hairline beside the shadow. Forced-colours
 * mode drops `box-shadow` and paints a transparent border in a system colour, so
 * the card still has an edge there.
 *
 * LIFT. `interactive` moves the card up 4px on hover and 1px on press (clash 37)
 * over the base duration. Both moves are `motion-safe:`, so they are gone under
 * reduced motion, and the title also turns Forest on hover. The shadow does not
 * change. A card that is not interactive never lifts.
 *
 * THE REQUIRED WRAPPER. The hover state sits on a STATIC wrapper named `group/card`,
 * and the card lifts through `group-hover/card:`. If the card lifted itself on its
 * own `:hover`, the pointer near its bottom edge would leave the card as it rose,
 * the card would drop, the pointer would be over it again, and it would flicker.
 * The wrapper is the grid `<li>`, or the component host. Every interactive card
 * must sit in one. A caller writes `class="group/card"` on that wrapper and nothing
 * else.
 *
 * ONE LINK. A card that is one link puts the link on its TITLE and stretches it over
 * the card with `after:absolute after:inset-0 after:rounded-card`. The card is
 * `relative` (this recipe adds it), and the rest of its text stays outside the link
 * name. The ring is drawn around the whole card by `has-focus-visible` and the
 * title link draws none of its own. A card that is itself the link (`<a aecCard>`)
 * gets the ring from `focus-visible`.
 *
 * FOCUS. 3px outline at a 3px offset. An outline is kept by forced-colours mode.
 */
const CARD_BASE = 'aec-card border';

const CARD_TONE: Record<AecCardTone, string> = {
  base: 'rounded-card bg-(--surface-base) shadow-card',
  warm: 'rounded-card bg-(--accent-warm) shadow-card',
};

const CARD_NESTED = 'rounded-panel bg-(--accent-primary-soft)';

const CARD_INTERACTIVE =
  'relative transition-transform duration-base ease-standard focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--accent-primary) has-focus-visible:outline-3 has-focus-visible:outline-offset-3 has-focus-visible:outline-(--accent-primary) motion-safe:group-hover/card:-translate-y-1 motion-safe:group-active/card:-translate-y-px';

const CARD_STRIPE: Record<AecCardStripe, string> = {
  forest: 'aec-card-stripe',
  clay: 'aec-card-stripe aec-card-stripe-clay',
};

/**
 * THE FORM CARD ON A PHONE (AECI-1720 layout pass). A card that holds a form
 * costs its fields the card's padding inside the page gutter: 48px of input
 * width at 390px, against a form with no card. So below `sm` a form card drops
 * its frame (no radius, no edge, no shadow) and pulls out over the page gutter
 * with a negative margin. Its own 24px padding then sits where the gutter was,
 * and the fields are as wide as they were before the card existed. From `sm`
 * the card is the normal card.
 *
 * The pull is 24px, so the card must sit in a 24px gutter below `sm`: the 7xl
 * form canvas (`px-6`), the page wrap (`BAND_WRAP_CLASS`) and the sign-in
 * column all have one. The caller's padding below `sm` must be 24px (`p-6`),
 * so the text lines up with the page edge above and below it.
 */
const CARD_PHONE_FLUSH = 'max-sm:-mx-6 max-sm:rounded-none max-sm:border-0 max-sm:shadow-none';

/**
 * The gap above a form card. Below `sm` the card has no frame, so its own 24px top
 * padding is already blank space: 24px of margin on top of it puts the first field
 * where it sat before the card existed. From `sm` the framed card stands 40px clear.
 */
export const FORM_CARD_GAP_CLASS = 'mt-6 sm:mt-10';

/** The class recipe behind `aecCard`. Use the directive in templates. */
export function cardClass(options: AecCardOptions = {}): string {
  const surface = options.nested ? CARD_NESTED : CARD_TONE[options.tone ?? 'base'];
  const parts = [CARD_BASE, surface];
  if (options.interactive) parts.push(CARD_INTERACTIVE);
  if (options.stripe) parts.push(CARD_STRIPE[options.stripe]);
  if (options.phoneFlush) parts.push(CARD_PHONE_FLUSH);
  return parts.join(' ');
}

/** A grid of cards: one column, two from `md`, three from `lg`, never more (clash 18). */
export const CARD_GRID_CLASS = 'aec-card-grid';

/**
 * `aecCard` (AECI-1765): the one card surface on public and shared pages.
 *
 * `<section aecCard class="p-6">` is a card on the page ground.
 * `<li class="group/card"><div aecCard interactive class="flex flex-col gap-4 p-6">`
 * is a card that is one link, with the link on its title (see ONE LINK above). `<div aecCard nested class="p-4">` sits inside a card.
 *
 * A card that is one link names the product or vendor and nothing more, because
 * only the title is the link (PLAN.md section 10.2).
 *
 * Portal and admin bodies do not use it yet.
 */
@Directive({
  selector: '[aecCard]',
  host: {
    '[class]': 'classes()',
  },
})
export class AecCard implements OnInit {
  readonly tone = input<AecCardTone>('base');
  readonly interactive = input(false, { transform: booleanAttribute });
  readonly nested = input(false, { transform: booleanAttribute });
  readonly stripe = input<AecCardStripe | null>(null);
  /** A form card: frameless and gutter-wide below `sm` (see THE FORM CARD ON A PHONE). */
  readonly phoneFlush = input(false, { transform: booleanAttribute });

  protected readonly classes = computed(() =>
    cardClass({
      tone: this.tone(),
      interactive: this.interactive(),
      nested: this.nested(),
      stripe: this.stripe(),
      phoneFlush: this.phoneFlush(),
    }),
  );

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;

  /**
   * FIRST RENDER (AECI-1937, see `shared/host-recipe.ts`). Inputs are not set
   * yet. A server node gets back the recipe the server wrote. A client-created
   * card gets only the classes every still-possible input value shares. A bound
   * `[nested]` or `[tone]` (`product-integration-card.ts` binds `[nested]`) adds
   * no fill, radius or shadow until its binding does, so a nested card never
   * shows the white base surface.
   */
  private recipeAtCreate = applyHostRecipe(
    this.host,
    cardRecipeAtCreate([
      staticHostAttribute('tone'),
      staticHostAttribute('interactive'),
      staticHostAttribute('nested'),
      staticHostAttribute('stripe'),
      staticHostAttribute('phoneFlush'),
    ]),
    inject(ServerHostClasses),
    isPlatformBrowser(inject(PLATFORM_ID)),
  );

  ngOnInit(): void {
    dropStaleRecipe(this.host, this.recipeAtCreate, this.classes());
    this.recipeAtCreate = [];
  }
}

type CardAttributes = readonly [
  tone: string | null,
  interactive: string | null,
  nested: string | null,
  stripe: string | null,
  phoneFlush: string | null,
];

interface CardChoices {
  readonly tones: readonly AecCardTone[];
  readonly interactive: readonly boolean[];
  readonly nested: readonly boolean[];
  readonly stripes: readonly (AecCardStripe | null)[];
  readonly phoneFlush: readonly boolean[];
}

const TONES: readonly AecCardTone[] = ['base', 'warm'];
const STRIPES: readonly (AecCardStripe | null)[] = [null, 'forest', 'clay'];
const BOTH = [false, true] as const;
const EVERY_CARD: CardChoices = {
  tones: TONES,
  interactive: BOTH,
  nested: BOTH,
  stripes: STRIPES,
  phoneFlush: BOTH,
};
const recipesAtCreate = new Map<string, HostRecipe>();

/**
 * The recipe the static attributes allow before inputs are set, memoised per
 * attribute set. `tone`, `nested` and `stripe` decide the surface, and the app
 * binds `[nested]`, so with no attribute every value is possible and no surface
 * is certain. `interactive` and `phoneFlush` are only ever static, so a missing
 * attribute means `false`.
 */
function cardRecipeAtCreate(attrs: CardAttributes): HostRecipe {
  const key = attrs.join('|');
  let recipe = recipesAtCreate.get(key);
  if (!recipe) {
    const [tone, interactive, nested, stripe, phoneFlush] = attrs;
    const choices: CardChoices = {
      tones: tone === 'base' || tone === 'warm' ? [tone] : TONES,
      interactive: [booleanAttribute(interactive)],
      nested: nested === null ? BOTH : [booleanAttribute(nested)],
      stripes: stripe === 'forest' || stripe === 'clay' ? [stripe] : STRIPES,
      phoneFlush: [booleanAttribute(phoneFlush)],
    };
    recipe = hostRecipe('aec-card', cardRecipes(choices), cardRecipes(EVERY_CARD));
    recipesAtCreate.set(key, recipe);
  }
  return recipe;
}

/** One recipe per combination of the choices. */
function cardRecipes(c: CardChoices): string[] {
  return c.tones.flatMap((tone) =>
    c.interactive.flatMap((interactive) =>
      c.nested.flatMap((nested) =>
        c.stripes.flatMap((stripe) =>
          c.phoneFlush.map((phoneFlush) =>
            cardClass({ tone, interactive, nested, stripe, phoneFlush }),
          ),
        ),
      ),
    ),
  );
}
