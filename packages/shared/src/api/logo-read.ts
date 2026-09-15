import { z } from 'zod';

/**
 * The READ half of the logo contract, deliberately in its own module (AECI-955).
 *
 * `LogoReadUrlSchema` is referenced by `common.ts` (`VendorLink` / `ProductLink`),
 * `products.ts`, `vendors.ts` and `algolia-records.ts` — every one of which is in
 * the browser's EAGER graph, because a product card renders on the home page.
 * The write-side schemas in `./logos` are reachable only from the vendor portal
 * and `/admin`, which are lazy routes.
 *
 * Keeping the two halves in one file put the write half in the eager bundle and
 * blew the `initial` budget in `apps/web/angular.json` by 880 bytes. The package
 * is `sideEffects: false` (AECI-221), so esbuild drops an entire unreferenced
 * MODULE — but it cannot drop an unused `const` inside a module it has kept,
 * because a Zod builder chain is a call expression and therefore not provably
 * pure. Module granularity is the only granularity the tree-shaker has here.
 *
 * So: anything an anonymous visitor's page can reach goes here; anything behind
 * a seat or a role stays in `./logos`. `./logos` re-exports both, so importers
 * that want the whole surface are unaffected.
 */

/** A stored object served by `GET /api/logos/:key` — the SHA-256 of its bytes. */
export const LogoPathSchema = z.string().regex(/^\/api\/logos\/[a-f0-9]{64}$/);

/**
 * What a logo column may CONTAIN, as opposed to what a client may WRITE.
 *
 * Broader than `LogoUrlSchema` on purpose: the catalog is full of absolute
 * Brandfetch URLs promoted long before uploads existed, and a read schema that
 * rejected them would 500 every page rendering one. New writes go through the
 * stricter `LogoUrlSchema` in `./logos`.
 */
export const LogoReadUrlSchema = z.union([z.string().url(), LogoPathSchema]);
