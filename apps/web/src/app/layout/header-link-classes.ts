/**
 * Class sets for controls on the Forest header (AECI-1771). One place, so the
 * link row, the flyout triggers, the account trigger and Sign in cannot drift.
 * Tokens only: Bone ink, the Bone wash for hover, and the Bone focus ring. A
 * Forest ring on a Forest ground is invisible (DESIGN.md §2 "Forest grounds").
 */

/**
 * Bone ring, 3px at a 3px offset, on every control sitting on Forest. A plain
 * utility works because the global `:focus-visible` colour sits in
 * `@layer base` (AECI-1845). Rings inside white panels stay Forest.
 */
export const ON_FOREST_FOCUS_RING =
  'focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--focus-ring-on-brand)';

/**
 * A text link in the header row. The `after` copy reserves the weight-600
 * width, so the row does not shift when an item turns active. The caller sets
 * `data-label` to the visible text. The active weight comes from
 * `HEADER_LINK_ACTIVE`.
 */
export const HEADER_LINK =
  'inline-flex flex-col items-center rounded-control px-2.5 py-2.5 text-base font-normal whitespace-nowrap text-(--text-on-brand) transition-colors hover:bg-(--surface-on-brand-wash) after:invisible after:block after:h-0 after:overflow-hidden after:font-semibold after:content-[attr(data-label)] ' +
  ON_FOREST_FOCUS_RING;

/** The active route is weight 600 plus `aria-current`, never colour alone. */
export const HEADER_LINK_ACTIVE = 'font-semibold';
