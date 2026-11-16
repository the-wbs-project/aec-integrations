/**
 * The page wrap (AECI-1766, PLAN.md §4.3, DESIGN.md §4): 1328px wide, with 24px
 * gutters, 32px from `md` and 48px from `lg`. One constant, so nothing that sits
 * on it can drift apart.
 *
 * It holds the Forest hero band, the Bone band, and since ruling A2 (2026-11-16)
 * the site header, its Browse and mobile menu panels, and the footer. Since
 * ruling 3 of 2026-11-16 it also holds `BrowseLayout` (AECI-1793), and since
 * AECI-1799 and AECI-1800 the mailing list band, `/about` and `/methodology`. Other page bodies
 * not yet rebuilt keep the 7xl canvas until their own issue moves them, so they
 * sit 8 to 16px off this edge for now (DESIGN.md §4 "Open values"). Whole class
 * names, so Tailwind's scanner sees each one.
 */
export const BAND_WRAP_CLASS = 'mx-auto w-full max-w-[1328px] px-6 md:px-8 lg:px-12';
