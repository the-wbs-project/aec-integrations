/**
 * The page wrap of a band (AECI-1766, PLAN.md §4.3, DESIGN.md §4): 1328px wide,
 * with 24px gutters, 32px from `md` and 48px from `lg`. One constant, so the Forest
 * hero band and the Bone band cannot drift apart.
 *
 * Only the two bands use it. The header, the footer and today's page containers
 * keep their own wrap. Whether they take this one is Chris's call (DESIGN.md §4
 * "Open values", "Page wrap for the shell and the bands"). Whole class names, so
 * Tailwind's scanner sees each one.
 */
export const BAND_WRAP_CLASS = 'mx-auto w-full max-w-[1328px] px-6 md:px-8 lg:px-12';
