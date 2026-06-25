/**
 * Review-seeder core — pure, runtime-agnostic. Imported by the seed-reviews CLI
 * (`apps/api/scripts/seed-reviews.ts`) and the datatool Worker (`apps/datatool`).
 *
 * Subpath-only export (`@aeci/shared/seed-reviews`) — deliberately NOT re-exported
 * from the package barrel (`src/index.ts`) so the large REVIEW_FRAGMENTS bank stays
 * out of the Angular/browser graph (same posture as `./algolia`).
 */
export * from './data';
export * from './generator';
export * from './sql';
