import { Directive, booleanAttribute, computed, input } from '@angular/core';

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

/** The class recipe behind `aecCard`. Use the directive in templates. */
export function cardClass(options: AecCardOptions = {}): string {
  const surface = options.nested ? CARD_NESTED : CARD_TONE[options.tone ?? 'base'];
  const parts = [CARD_BASE, surface];
  if (options.interactive) parts.push(CARD_INTERACTIVE);
  if (options.stripe) parts.push(CARD_STRIPE[options.stripe]);
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
export class AecCard {
  readonly tone = input<AecCardTone>('base');
  readonly interactive = input(false, { transform: booleanAttribute });
  readonly nested = input(false, { transform: booleanAttribute });
  readonly stripe = input<AecCardStripe | null>(null);

  protected readonly classes = computed(() =>
    cardClass({
      tone: this.tone(),
      interactive: this.interactive(),
      nested: this.nested(),
      stripe: this.stripe(),
    }),
  );
}
