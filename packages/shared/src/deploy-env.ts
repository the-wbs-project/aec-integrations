/**
 * Deployment-environment helpers shared by both Workers.
 *
 * The `ENV` var (declared per wrangler env block — `preview`/`staging`/`demo`/
 * `production`; unset → `development`) labels a deployment. Most code keys off the
 * *exact* label (Algolia index prefix, observability `env` tag, `/api/version`). A few
 * gates instead care about a coarser question: "is this an audience-facing,
 * real-build site?" — true for BOTH `production` (`prod.aecintegrations.com`,
 * the eventual home page) AND `demo` (`demo.aecintegrations.com`, the public
 * showcase). Both run the real build at audience scale; `preview`/`staging` are
 * lower-volume Access-gated test tiers and `development` is local. (Network
 * visibility is orthogonal: demo is public, while `production` stays behind
 * Cloudflare Access until launch per ADR 0017 — but both behave as the real
 * site for the gates below.)
 *
 * Use `isPublicSite()` for behavior that must be identical on every audience-facing
 * deployment, not just the one literally named `production`: blocking `/preview/*`
 * routes, bounding per-render log volume, and stripping per-request
 * response validation.
 */

/** Audience-facing, real-build deployment labels (`ENV` var values). */
export const PUBLIC_SITE_ENVS = ['demo', 'production'] as const;

/**
 * Whether `ENV` names an audience-facing, real-build site (`demo` or `production`).
 * Accepts the raw `ENV` value (possibly `undefined` for local `wrangler dev`).
 */
export function isPublicSite(env: string | undefined | null): boolean {
  return env === 'demo' || env === 'production';
}
