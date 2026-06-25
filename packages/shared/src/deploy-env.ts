/**
 * Deployment-environment helpers shared by both Workers.
 *
 * The `ENV` var (declared per wrangler env block — `preview`/`staging`/`demo`/
 * `production`; unset → `development`) labels a deployment. Most code keys off the
 * *exact* label (Algolia index prefix, Datadog `env` tag, `/api/version`). A few
 * gates instead care about a coarser question: "is this a publicly-reachable,
 * audience-facing site?" — true for BOTH `production` (`prod.aecintegrations.com`,
 * the eventual home page) AND `demo` (`demo.aecintegrations.com`, the public
 * showcase). Both are public (NOT behind Cloudflare Access) and run the real
 * build; `preview`/`staging` are Access-gated and `development` is local.
 *
 * Use `isPublicSite()` for behavior that must be identical on every public
 * deployment, not just the one literally named `production`: blocking `/preview/*`
 * routes, bounding per-render Datadog log volume, and stripping per-request
 * response validation.
 */

/** Public, non-Access-gated, audience-facing deployment labels (`ENV` var values). */
export const PUBLIC_SITE_ENVS = ['demo', 'production'] as const;

/**
 * Whether `ENV` names a public, non-Access-gated site (`demo` or `production`).
 * Accepts the raw `ENV` value (possibly `undefined` for local `wrangler dev`).
 */
export function isPublicSite(env: string | undefined | null): boolean {
  return env === 'demo' || env === 'production';
}
