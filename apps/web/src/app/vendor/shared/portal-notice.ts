import { Directive } from '@angular/core';

/**
 * `aecPortalNotice` (AECI-1809, mock-up 13, `DESIGN.md` §5 "Vendor portal"): the ONE
 * calm notice every portal banner uses. Plan ended, product ended, listing hidden, the
 * optional legal acceptance prompt and its confirmation all take it, and so does any
 * later portal banner.
 *
 * The recipe: the Bone `--accent-warm` fill, a 1px `--border-strong` edge, the 16px
 * panel radius, 24px padding and 24px under it. It is not a card, so it has no shadow.
 * It states the current state, so it is calm: no status colour, no `role="alert"`, no
 * warning glyph and no dismiss button. A banner that needs one of those is not this
 * notice.
 *
 * The heading is the banner's `h2`, written with no classes. `.aec-portal-notice h2` in
 * `styles.css` sets it at `--t-20`, because a size utility on a heading element is dead
 * (the Unlayered-Heading Rule). Body copy takes {@link PORTAL_NOTICE_BODY_CLASS}: 14px,
 * capped near 32rem so a line holds about 80 characters. A two-list banner puts its
 * lists in {@link PORTAL_NOTICE_COLUMNS_CLASS} under `aec-overline` microheadings.
 *
 * `<section aecPortalNotice aria-labelledby="…">` on the host element. A component
 * that is a notice in one mode only (the legal acceptance screen) binds
 * {@link PORTAL_NOTICE_CLASS} instead, because a directive cannot be applied by a
 * condition. Light only.
 */
export const PORTAL_NOTICE_CLASS =
  'aec-portal-notice mb-6 rounded-panel border border-(--border-strong) bg-(--accent-warm) p-6 text-(--text-primary)';

@Directive({
  selector: '[aecPortalNotice]',
  host: { class: PORTAL_NOTICE_CLASS },
})
export class AecPortalNotice {}

/** A notice's body copy: 14px on a 1.6 line, capped near 32rem. */
export const PORTAL_NOTICE_BODY_CLASS = 'max-w-[32rem] text-t-14 leading-[1.6]';

/** Two lists side by side from `md` ("Still works" / "Read-only now"). */
export const PORTAL_NOTICE_COLUMNS_CLASS = 'mt-4 grid gap-x-8 gap-y-4 md:grid-cols-2';

/** A bulleted list inside a notice column. */
export const PORTAL_NOTICE_LIST_CLASS =
  'mt-2 max-w-[32rem] list-disc space-y-1 ps-5 text-t-14 leading-[1.6]';

/** The notice's action row: the button at the start, an optional note after it. */
export const PORTAL_NOTICE_ACTIONS_CLASS =
  'mt-6 flex flex-wrap items-center gap-x-4 gap-y-3 text-t-14 text-(--text-secondary)';
