/**
 * The agent's read seam onto the API Worker's PUBLIC endpoints.
 *
 * ── WHY THE ENTITY TOOLS DO NOT TOUCH D1 ─────────────────────────────────────
 * `get_product`, `get_vendor` and `get_pair` call `GET /api/products/:slug`,
 * `GET /api/vendors/:slug` and
 * `GET /api/products/:slug/integrations/:otherSlug` over the `API` service
 * binding rather than querying D1 themselves. That is the whole point: those
 * handlers already run the shipped column allowlists and mappers in
 * `apps/api/src/lib/drizzle-helpers.ts`, including `readerFacingNote()`, so the
 * agent cannot surface a field the public site does not. Reimplementing the
 * mappers here would mean maintaining a second copy of a rule that has already
 * leaked once (AECI-779, `attestations.note`, from two mappers at once).
 *
 * ── THE CONNECTION BUDGET (AECI-666) ─────────────────────────────────────────
 * A Worker invocation may hold only ~6 connections waiting for response headers,
 * and a `fetch` whose body is never consumed keeps holding one. Past the limit
 * the runtime cancels the stalled responses — and **a cancelled `fetch` returns
 * a promise that never settles**, so the caller's own `catch` never fires, the
 * work is lost with no log line, and the invocation is eventually killed as
 * hung. That is how the promote post-commit hooks silently dropped ~8% of their
 * Algolia upserts.
 *
 * So `discardResponseBody(res)` is called on **every** path that does not read
 * the body, INCLUDING the error path that only inspects `res.status`. Everything
 * in this module funnels through {@link apiGetJson} so there is exactly one
 * place that can get it wrong.
 *
 * ── LOCAL DEV, AND THE REGISTRY MISMATCH ─────────────────────────────────────
 * The service binding DOES work under `vite dev`: `@cloudflare/vite-plugin`
 * passes `unsafeDevRegistryPath` to Miniflare, so a `wrangler dev` API Worker
 * registered under the same path resolves.
 *
 * The catch is WHICH path. Miniflare reads `MINIFLARE_REGISTRY_PATH` and falls
 * back to the global `~/.config/.wrangler/registry`. This repo's `dev:bound`
 * sets `WRANGLER_REGISTRY_PATH` to a per-workspace directory so parallel
 * Conductor workspaces do not collide — a variable Miniflare does not read. So
 * against a plain `wrangler dev --env preview` the binding resolves, and against
 * `pnpm dev:agent` / `pnpm dev:bound` it does not, because the two processes are
 * looking at different registries.
 *
 * Two ways out, and the first is better: export `MINIFLARE_REGISTRY_PATH` to the
 * same directory `dev:bound` uses, and the real binding resolves. `API_BASE_URL`
 * is the fallback — set it and the request goes over plain `fetch` to that
 * origin instead. It is declared in NO `wrangler.jsonc` env block, so a deployed
 * Worker always uses the binding.
 */
import { discardResponseBody } from '@aeci/shared/response-drain';

import type { Env } from '../env';

/**
 * Placeholder origin for service-binding requests. The host is never dialed —
 * only the pathname and query select a route — but `new Request()` requires an
 * absolute URL.
 */
const BINDING_ORIGIN = 'https://api.internal';

/** What a tool gets back from the API Worker. */
export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; message: string };

/** The narrow slice of `Env` this module needs, so specs can pass a stub. */
export type ApiCaller = Pick<Env, 'API' | 'API_BASE_URL'>;

/**
 * `GET <path>` against the API Worker, decoded as JSON.
 *
 * `path` is always built by US from an encoded slug — the model supplies the
 * slug value, never the route.
 */
export async function apiGetJson<T>(env: ApiCaller, path: string): Promise<ApiResult<T>> {
  const base = env.API_BASE_URL ?? BINDING_ORIGIN;
  const request = new Request(`${base}${path}`, {
    method: 'GET',
    headers: { accept: 'application/json' },
  });

  const res = env.API_BASE_URL ? await fetch(request) : await env.API.fetch(request);

  if (!res.ok) {
    // AECI-666: this branch reads `status` and NOTHING else, which is exactly
    // the path that historically leaked a connection. Release it explicitly.
    discardResponseBody(res);
    return {
      ok: false,
      status: res.status,
      message: res.status === 404 ? 'Not found.' : `Upstream returned ${res.status}.`,
    };
  }

  try {
    return { ok: true, data: (await res.json()) as T };
  } catch {
    // `res.json()` locks the body; `discardResponseBody` no-ops on a locked
    // stream, so calling it here is safe and keeps the rule unconditional.
    discardResponseBody(res);
    return { ok: false, status: res.status, message: 'Upstream returned a malformed response.' };
  }
}

/**
 * Encode one path segment supplied by the model. Slugs are lowercase ASCII by
 * construction (`@aeci/shared/slug`), so this is belt-and-braces — but a tool
 * argument is model-selected input and is never interpolated raw.
 */
export function pathSegment(value: string): string {
  return encodeURIComponent(value);
}
