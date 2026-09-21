/**
 * `?raw` imports. Vite inlines the file's text into the bundle at build time.
 *
 * `src/app.ts` uses this for `public/index.html` (the internal test chat page),
 * which is how that page ends up INSIDE the Worker and therefore behind the
 * `requireAccess()` gate. A Cloudflare `assets` binding would serve it ahead of
 * the Worker instead, which would put an ungated page on a gated Worker.
 *
 * This mirrors the build-time markdown inlining the legal pages use in
 * `apps/web`. TypeScript has no built-in declaration for the `?raw` suffix, so
 * one is declared here rather than each import being cast.
 */
declare module '*.html?raw' {
  const content: string;
  export default content;
}
