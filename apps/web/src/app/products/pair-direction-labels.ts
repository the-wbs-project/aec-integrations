import type { ContextDirection } from '@aeci/shared';

/**
 * Copy for a **context-relative** data-flow direction — "relative to the product
 * you are looking from", never the DB's `a_to_b`/`b_to_a`.
 *
 * Extracted from `products-pair.ts` by AECI-606 so the vendor dashboard's
 * attestation tab renders the same sentences as the public pair page. The
 * `@@pair.direction.*` ids are deliberately unchanged by the move: two surfaces
 * describing the same flow must not drift into two wordings, and reusing the ids
 * means the extraction adds no new translation units (the same reasoning that
 * put `mechanismKindLabel` in `search/mechanism-labels.ts`).
 *
 * `otherName` is always the *counterpart* product's name, so on the vendor tab
 * "Sends to Procore" reads from the vendor's own product outward — which is what
 * §6 means by presenting direction in the vendor's frame.
 */

/** Decorative glyph for a context-relative direction (always paired with text + aria). */
export function directionGlyph(direction: ContextDirection): string {
  return direction === 'outbound' ? '→' : direction === 'inbound' ? '←' : '⇄';
}

/** Visible heading for a direction, relative to the context product. */
export function directionHeading(direction: ContextDirection, otherName: string): string {
  switch (direction) {
    case 'outbound':
      return $localize`:@@pair.direction.outbound:Sends to ${otherName}:other:`;
    case 'inbound':
      return $localize`:@@pair.direction.inbound:Receives from ${otherName}:other:`;
    case 'both':
      return $localize`:@@pair.direction.both:Syncs both ways`;
  }
}

/**
 * Screen-reader label for a direction glyph. Matches the visible heading's plain
 * words (AECI-1142) instead of the old "Outbound to / Inbound from /
 * Bidirectional", so a screen-reader user hears what a sighted reader reads.
 */
export function directionAria(direction: ContextDirection, otherName: string): string {
  switch (direction) {
    case 'outbound':
      return $localize`:@@pair.direction.outbound.aria:Sends to ${otherName}:other:`;
    case 'inbound':
      return $localize`:@@pair.direction.inbound.aria:Receives from ${otherName}:other:`;
    case 'both':
      return $localize`:@@pair.direction.both.aria:Both ways`;
  }
}

/**
 * A direction stated with BOTH products named, for a list read from neither of them
 * (QA pass on AECI-2035, 2026-11-24). On a connector's own page the connector is not one
 * of the pair's two products, so "Sends to {B}" has no product to be read from. These
 * say who sends to whom: "{A} sends to {B}", or "{A} and {B} sync both ways".
 * `direction` is relative to `aName`. Inbound swaps the names into the one-way sentence,
 * so a translator sees two whole sentences.
 */
export function pairFlowSentence(
  direction: ContextDirection,
  aName: string,
  bName: string,
): string {
  switch (direction) {
    case 'outbound':
      return $localize`:@@pair.flow.oneWay:${aName}:from: sends to ${bName}:to:`;
    case 'inbound':
      return $localize`:@@pair.flow.oneWay:${bName}:from: sends to ${aName}:to:`;
    case 'both':
      return $localize`:@@pair.flow.both:${aName}:a: and ${bName}:b: sync both ways`;
  }
}

/** The order the three direction lanes render in within a mechanism (§8). */
export const DIRECTION_ORDER = ['outbound', 'inbound', 'both'] as const;
