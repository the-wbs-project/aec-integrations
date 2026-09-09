# Build-time Markdown content

Long-form page copy that is authored as Markdown and **inlined into the bundle at build time**, not
fetched at runtime. Two families live here:

| Content | Registry | Route(s) | Governed by |
| --- | --- | --- | --- |
| `legal/*.md` (4 files) | `src/app/legal/legal-content.ts` | `/legal/terms`, `/legal/privacy`, `/legal/review-guidelines`, `/legal/listing-accuracy` | `STAGE_1_SPEC.md` §13 + §27 |
| `methodology.md` | `src/app/methodology/methodology-content.ts` | `/methodology` | `STAGE_2_5_SPEC.md` §7.1 |

The legal set has its own stricter workflow (versioning, counsel sign-off, frontmatter schema) in
`legal/README.md`. **Read that one before touching anything under `legal/`.** This file covers the
mechanism both families share.

## How the inlining works

1. `apps/web/angular.json` sets `"loader": { ".md": "text" }` on the build target, so esbuild turns any
   `.md` import into a raw string. There is no custom Vite plugin.
2. `src/markdown.d.ts` declares the ambient `declare module '*.md'`. It must stay a **script** (no
   top-level `import`/`export`) or the wildcard stops resolving, and it is listed explicitly in
   `tsconfig.component-spec.json` because nothing imports it.
3. A registry module imports the string, splits the frontmatter with `parseFrontmatter`
   (`src/app/legal/legal-frontmatter.ts` — a scalar-only splitter, deliberately not a YAML library,
   because `js-yaml`/`gray-matter` pull `Buffer` and that is unsafe on the `platform: neutral` SSR
   build), and renders the body with `marked` using `{ async: false, gfm: true }`.
4. The result is built **once at module init** and memoised per isolate. That is not an optimisation:
   SSR and the client must emit byte-identical HTML or hydration breaks, and these routes are
   edge-cached.

## Three things that bite

- **A stale `dist/` serves old copy.** These files are compiled in, so editing one changes nothing
  until the bundle rebuilds. `pnpm dev:agent` and `pnpm dev:conductor` rebuild first; bare
  `pnpm dev` / `pnpm dev:bound` do not. Set `DEV_SKIP_BUILD=1` only when you know the bundle is current.
- **The body is content, not UI strings.** It is deliberately **not** extracted into `messages.xlf`,
  so it is exempt from the "no hardcoded English in templates" rule. Page *chrome* (eyebrow, metadata
  labels, title/description) is a UI string and stays `i18n`/`$localize`-wrapped. Localisation later
  means per-locale files (`methodology.es-ES.md`) selected by the active locale, not catalogue entries.
- **Specs that touch a registry must be `*.component.spec.ts`.** Plain Vitest has no `.md` loader, so
  only the Angular `ng test` tier can import one. Pure helpers (like `parseFrontmatter`) are kept
  `.md`-free on purpose so they *can* be covered by plain Vitest.

## Rendering and styling

Bodies render through `[innerHTML]` into `<article class="aec-prose max-w-[70ch]">`. Angular's
sanitizer runs (no `bypassSecurityTrust` anywhere), which also strips authored classes — which is why
the prose styling is global, keyed off `.aec-prose` in `src/styles.css`, rather than authored inline.
GFM tables work; they are what the methodology page's agreement-state table renders through.

Internal links are plain `<a href="/...">`, so they are full document loads rather than router
navigations. That is the accepted trade for authoring in Markdown and is how `/legal/*` already behaves.

## Adding a page

A new Markdown-backed route is not just a file. It needs, in the same change: the `.md`, a registry, a
page component, a route in `src/app/app.routes.ts`, a `ROUTE_CACHE_PATTERNS` entry in
`src/server-runtime.ts` **and** the matching `cacheTagInputsForPath` branch in `src/server/cache-tags.ts`
(those two mirror each other exactly), a sitemap decision in `src/server/sitemap.ts`, a nav link, and
the doc updates listed in `docs/CACHE_STRATEGY.md` §3/§4a/§7.2 plus the `STAGE_1_SPEC.md` §3.1 route
table. Miss the cache pair and the route fails closed to `private, no-store`.
