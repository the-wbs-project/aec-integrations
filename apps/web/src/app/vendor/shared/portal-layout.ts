import { BAND_WRAP_CLASS } from '../../shared/band-wrap';

/**
 * The vendor portal's page shell pieces (AECI-1809, mock-up 13, `DESIGN.md` §5 "Vendor
 * portal"). The later portal slices (AECI-1810 to AECI-1812) build on these, so the
 * portal keeps one width, one notice and one form layout.
 *
 * THE PAGE BODY. The shell (`vendor-dashboard-tabbed.ts`) wraps the portal header, the
 * banner slot, the tab row and the routed section in ONE `PORTAL_WRAP_CLASS` box: the
 * site's page wrap (`BAND_WRAP_CLASS`, 1328px with 24, 32 and 48px gutters) plus 96px
 * of room under the page. A routed section is already inside it, so a section never
 * adds a width, a gutter or a `max-w-7xl` canvas of its own. A section that wants a
 * narrower reading column caps its own text (`max-w-[32rem]` for notice copy, the
 * form helper's grid for fields), never the page. A section header's description
 * (the paragraph under a tab, card or form heading) takes no cap: it runs the full
 * width of the content below it (Chris, 2026-11-26).
 *
 * Whole class names, so Tailwind's scanner sees each one.
 */
export const PORTAL_WRAP_CLASS = `${BAND_WRAP_CLASS} pb-24`;

/** The portal header's padding: 32px over the breadcrumb and 24px under the title
 *  row, 48px and 32px from `md` (the mock-up's 40px snapped up to the scale). */
export const PORTAL_HEADER_CLASS = 'pt-8 pb-6 md:pt-12 md:pb-8';
