/**
 * Classes the claim, request and thread screens share (AECI-2111), beside the
 * console recipe (`admin/console/`) and the queues' detail-row classes
 * (`admin/reviews/queue-classes.ts`). Each names one look the recipe does not.
 */

/**
 * A link inside a detail row or a panel: primary ink, underlined at rest so it
 * reads as a link outside a table cell, Forest on hover. The table's own `link`
 * part is for the identity cell, where the row already says "this is a record".
 */
export const CLAIM_INLINE_LINK_CLASS =
  'inline-flex items-center gap-1 rounded-mark font-semibold text-(--text-primary) underline decoration-(--border-strong) underline-offset-3 hover:text-(--accent-primary) hover:decoration-(--accent-primary) focus-visible:outline-3 focus-visible:outline-offset-3';

/**
 * A neutral flag box: a fact the operator should see before acting that is not a
 * caution (the connector-vendor flag, the in-review explainer). Sunken, hairline,
 * control radius. A caution takes the Bone notice (`QUEUE_NOTICE_CLASS`) instead.
 */
export const CLAIM_NEUTRAL_BOX_CLASS =
  'rounded-control border border-(--border-default) bg-(--surface-sunken) p-4 text-t-14 text-(--text-primary)';
