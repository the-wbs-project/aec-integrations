/**
 * Cloudflare Worker entry for the AECi Review stack-validation app.
 *
 * Responsibilities:
 *   1. PUT /api/data/:id                   → write canonical entity to KV,
 *                                            purge every locale variant of
 *                                            /cached/:id (canonical is the
 *                                            fallback source for all locales).
 *   2. PUT /api/translations/:id/:locale   → write KV translation overlay,
 *                                            purge only that locale's
 *                                            /<locale-prefix>/cached/:id.
 *   3. GET /api/data/:id?locale=…          → read entity merged with the
 *                                            optional translation overlay for
 *                                            the requested locale.
 *   4. GET /api/entities?locale=…          → list entities, merged.
 *   5. POST /api/purge                     → raw URL purge (escape hatch).
 *   6. Everything else                     → delegate to Angular SSR. The
 *                                            multi-locale build outputs a
 *                                            single server.mjs that dispatches
 *                                            by URL prefix (/es/...).
 *                                            /cached/:id and /es/cached/:id
 *                                            get Cache-Control overridden so
 *                                            the edge cache stores them. The
 *                                            URL prefix is the cache key, so
 *                                            locales never cross-pollute
 *                                            (the T1b lesson, applied to
 *                                            locale via URL instead of Vary).
 *
 * Bindings (see wrangler.jsonc):
 *   - STACK_TEST_KV: KV namespace.
 *     Key shapes:
 *       entity:<id>                            → canonical (en-US) entity JSON.
 *       translations:entity:<id>:<locale>      → { title?, body? } overlay.
 *   - CLOUDFLARE_API_TOKEN, CLOUDFLARE_ZONE_ID: secrets used for purge_cache.
 */

import { AngularAppEngine, createRequestHandler } from '@angular/ssr';

const angularApp = new AngularAppEngine({
  allowedHosts: ['localhost', '127.0.0.1', 'stack-test.aecintegrations.com'],
});

const reqHandler = createRequestHandler(async (req) => {
  const res = await angularApp.handle(req);
  return res ?? new Response('Page not found.', { status: 404 });
});

export interface Env {
  STACK_TEST_KV: KVNamespace;
  ASSETS: Fetcher;
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ZONE_ID?: string;
}

export type Entity = {
  id: string;
  title: string;
  body: string;
  updatedAt: string;
};

export type TranslationOverlay = Partial<Pick<Entity, 'title' | 'body'>>;

/**
 * Mirror of angular.json `i18n.locales`. Keep in sync — the canonical-entity
 * purge fans out to every locale variant in this list. The default locale
 * has no URL prefix; additional locales have a single-segment prefix
 * matching their `baseHref`.
 */
const DEFAULT_LOCALE = 'en-US';
const LOCALES: readonly { locale: string; prefix: string }[] = [
  { locale: 'en-US', prefix: '' },
  { locale: 'es-ES', prefix: '/es' },
];

const SEED_ENTITIES: Record<string, Omit<Entity, 'id' | 'updatedAt'>> = {
  abc: {
    title: 'Hello from entity:abc',
    body: 'This is the seeded body for entity abc. Edit me at /admin/abc and the cache will purge.',
  },
  xyz: {
    title: 'Hello from entity:xyz',
    body: 'Independent entity. Editing abc should NOT invalidate /cached/xyz.',
  },
};

const SEED_TRANSLATIONS: Record<string, Record<string, TranslationOverlay>> = {
  abc: {
    'es-ES': {
      title: 'Hola desde entity:abc',
      body: 'Cuerpo en español sembrado para entity abc. Edítame en /admin/abc/translations/es-ES y la caché de /es/cached/abc se purgará.',
    },
  },
};

async function ensureSeeded(kv: KVNamespace): Promise<void> {
  for (const [id, base] of Object.entries(SEED_ENTITIES)) {
    const key = `entity:${id}`;
    const existing = await kv.get(key);
    if (!existing) {
      const entity: Entity = { id, ...base, updatedAt: new Date().toISOString() };
      await kv.put(key, JSON.stringify(entity));
    }
    const overlays = SEED_TRANSLATIONS[id] ?? {};
    for (const [locale, overlay] of Object.entries(overlays)) {
      const overlayKey = `translations:entity:${id}:${locale}`;
      const overlayExisting = await kv.get(overlayKey);
      if (overlayExisting) continue;
      await kv.put(overlayKey, JSON.stringify(overlay));
    }
  }
}

async function readEntity(kv: KVNamespace, id: string): Promise<Entity | null> {
  const raw = await kv.get(`entity:${id}`);
  return raw ? (JSON.parse(raw) as Entity) : null;
}

async function readOverlay(
  kv: KVNamespace,
  id: string,
  locale: string,
): Promise<TranslationOverlay | null> {
  if (locale === DEFAULT_LOCALE) return null;
  const raw = await kv.get(`translations:entity:${id}:${locale}`);
  return raw ? (JSON.parse(raw) as TranslationOverlay) : null;
}

function mergeOverlay(entity: Entity, overlay: TranslationOverlay | null): Entity {
  if (!overlay) return entity;
  return {
    ...entity,
    title: overlay.title ?? entity.title,
    body: overlay.body ?? entity.body,
  };
}

async function writeEntity(
  kv: KVNamespace,
  id: string,
  title: string,
  body: string,
): Promise<Entity> {
  const entity: Entity = { id, title, body, updatedAt: new Date().toISOString() };
  await kv.put(`entity:${id}`, JSON.stringify(entity));
  return entity;
}

async function writeTranslation(
  kv: KVNamespace,
  id: string,
  locale: string,
  overlay: TranslationOverlay,
): Promise<TranslationOverlay> {
  const clean: TranslationOverlay = {};
  if (typeof overlay.title === 'string') clean.title = overlay.title;
  if (typeof overlay.body === 'string') clean.body = overlay.body;
  await kv.put(`translations:entity:${id}:${locale}`, JSON.stringify(clean));
  return clean;
}

async function listEntities(kv: KVNamespace, locale: string): Promise<Entity[]> {
  const { keys } = await kv.list({ prefix: 'entity:' });
  const results = await Promise.all(keys.map((k) => kv.get(k.name)));
  const entities = results
    .filter((r: string | null): r is string => r !== null)
    .map((raw: string) => JSON.parse(raw) as Entity);
  if (locale === DEFAULT_LOCALE) return entities;
  const overlays = await Promise.all(entities.map((e) => readOverlay(kv, e.id, locale)));
  return entities.map((e, i) => mergeOverlay(e, overlays[i]));
}

async function purgeUrls(env: Env, urls: string[]): Promise<{ status: number; body: unknown }> {
  if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ZONE_ID) {
    return {
      status: 500,
      body: {
        error:
          'Missing CLOUDFLARE_API_TOKEN or CLOUDFLARE_ZONE_ID secret. Set via `wrangler secret put`.',
      },
    };
  }
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${env.CLOUDFLARE_ZONE_ID}/purge_cache`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ files: urls }),
    },
  );
  const body = await res.json().catch(() => ({ error: 'non-JSON response' }));
  return { status: res.status, body };
}

function cachedPageRequest(url: URL): Request {
  // Cache by absolute URL only. The locale prefix is part of the URL, so the
  // cache is naturally segmented per locale — purge-by-URL stays the source
  // of truth for invalidation.
  return new Request(url.toString(), { method: 'GET' });
}

/**
 * Strip the `theme` cookie before forwarding a cached-page request to SSR.
 * The edge cache is keyed by URL only, so any cookie that influences the
 * rendered HTML (data-theme bake-in) would pollute the cache for other
 * visitors. The client re-applies the theme post-hydration via localStorage
 * and matchMedia, so SSR doesn't need it.
 */
function stripThemeCookie(request: Request): Request {
  const cookie = request.headers.get('cookie');
  if (!cookie || !/(^|;\s*)theme=/.test(cookie)) return request;
  const filtered = cookie
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p && !/^theme=/.test(p))
    .join('; ');
  const headers = new Headers(request.headers);
  if (filtered) headers.set('cookie', filtered);
  else headers.delete('cookie');
  return new Request(request.url, {
    method: request.method,
    headers,
    body: request.body,
    redirect: request.redirect,
  });
}

function edgeCache(): Cache {
  return (caches as unknown as { default: Cache }).default;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Maps a URL to the (locale, idSegment) it represents if it's a cached entity
 * page, or null otherwise. Recognises both `/cached/:id` (default locale) and
 * `/<prefix>/cached/:id` (any non-default locale from LOCALES).
 */
function matchCachedPage(url: URL): { locale: string; id: string } | null {
  const path = url.pathname;
  for (const { locale, prefix } of LOCALES) {
    const expectedPrefix = `${prefix}/cached/`;
    if (!path.startsWith(expectedPrefix)) continue;
    const id = path.slice(expectedPrefix.length);
    if (!id || id.includes('/')) return null;
    return { locale, id };
  }
  return null;
}

/**
 * Every locale variant of /cached/:id — used when the canonical entity is
 * updated, since every locale falls back to canonical on missing fields.
 */
function cachedUrlsForEntity(origin: string, id: string): string[] {
  return LOCALES.map(({ prefix }) => `${origin}${prefix}/cached/${id}`);
}

function cachedUrlForLocale(origin: string, id: string, locale: string): string | null {
  const match = LOCALES.find((l) => l.locale === locale);
  if (!match) return null;
  return `${origin}${match.prefix}/cached/${id}`;
}

function validLocale(locale: string): boolean {
  return LOCALES.some((l) => l.locale === locale);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const origin = `${url.protocol}//${url.host}`;
    const cachedPage = request.method === 'GET' ? matchCachedPage(url) : null;

    if (cachedPage) {
      // Seed before the KV-miss probe so first-touch reads see the seeded
      // entities rather than 404-ing.
      await ensureSeeded(env.STACK_TEST_KV);

      // KV-miss short-circuit. Runs before the edge-cache lookup so a stale
      // 200 left in the cache from a prior bad deploy cannot keep serving
      // the "not found" body as a success. Evict any stale entry too.
      const exists = await env.STACK_TEST_KV.get(`entity:${cachedPage.id}`);
      if (!exists) {
        ctx.waitUntil(edgeCache().delete(cachedPageRequest(url)));
        return new Response('Entity not found.', {
          status: 404,
          headers: {
            'Cache-Control': 'private, no-store',
            'Content-Type': 'text/plain; charset=utf-8',
            'X-Stack-Test-Cache': 'BYPASS',
            'X-Stack-Test-Locale': cachedPage.locale,
          },
        });
      }

      const cached = await edgeCache().match(cachedPageRequest(url));
      if (cached) {
        const headers = new Headers(cached.headers);
        headers.set('Cache-Control', 'public, max-age=300, s-maxage=300');
        headers.set('CF-Cache-Status', 'HIT');
        headers.set('X-Stack-Test-Cache', 'HIT');
        headers.set('X-Stack-Test-Locale', cachedPage.locale);
        return new Response(cached.body, {
          status: cached.status,
          statusText: cached.statusText,
          headers,
        });
      }
    } else {
      // Ensure first-touch SSR/API reads cannot race the seed writes.
      await ensureSeeded(env.STACK_TEST_KV);
    }

    // --- API endpoints ---

    if (url.pathname.startsWith('/api/translations/')) {
      const rest = url.pathname.slice('/api/translations/'.length);
      const [id, locale, ...extra] = rest.split('/');
      if (!id || !locale || extra.length > 0) {
        return jsonResponse({ error: 'expected /api/translations/:id/:locale' }, 400);
      }
      if (!validLocale(locale)) {
        return jsonResponse({ error: `unknown locale: ${locale}` }, 400);
      }
      if (locale === DEFAULT_LOCALE) {
        return jsonResponse(
          { error: 'default locale lives on the canonical entity; PUT /api/data/:id instead' },
          400,
        );
      }

      if (request.method === 'PUT') {
        const payload = (await request.json().catch(() => null)) as TranslationOverlay | null;
        if (
          !payload ||
          (payload.title !== undefined && typeof payload.title !== 'string') ||
          (payload.body !== undefined && typeof payload.body !== 'string')
        ) {
          return jsonResponse({ error: 'expected { title?: string, body?: string }' }, 400);
        }
        const translation = await writeTranslation(env.STACK_TEST_KV, id, locale, payload);
        const target = cachedUrlForLocale(origin, id, locale);
        // Translation-only edits are locale-scoped: purge just this locale's URL.
        const purge = target
          ? await purgeUrls(env, [target])
          : { status: 500, body: { error: 'no cached URL resolved for locale' } };
        if (target) {
          ctx.waitUntil(edgeCache().delete(cachedPageRequest(new URL(target))));
        }
        return jsonResponse({ kv: 'ok', translation, purge });
      }

      return jsonResponse({ error: 'method not allowed' }, 405);
    }

    if (url.pathname.startsWith('/api/data/')) {
      const id = url.pathname.slice('/api/data/'.length);
      if (!id || id.includes('/')) {
        return jsonResponse({ error: 'invalid id' }, 400);
      }

      if (request.method === 'GET') {
        const requestedLocale = url.searchParams.get('locale') ?? DEFAULT_LOCALE;
        if (!validLocale(requestedLocale)) {
          return jsonResponse({ error: `unknown locale: ${requestedLocale}` }, 400);
        }
        const entity = await readEntity(env.STACK_TEST_KV, id);
        if (!entity) return jsonResponse({ error: 'not found' }, 404);
        const overlay = await readOverlay(env.STACK_TEST_KV, id, requestedLocale);
        return jsonResponse(mergeOverlay(entity, overlay));
      }

      if (request.method === 'PUT') {
        const payload = (await request.json().catch(() => null)) as {
          title?: string;
          body?: string;
        } | null;
        if (!payload || typeof payload.title !== 'string' || typeof payload.body !== 'string') {
          return jsonResponse({ error: 'expected { title: string, body: string }' }, 400);
        }
        const entity = await writeEntity(env.STACK_TEST_KV, id, payload.title, payload.body);
        // Canonical edit cascades to every locale (canonical is fallback source).
        const urls = cachedUrlsForEntity(origin, id);
        const purge = await purgeUrls(env, urls);
        for (const u of urls) {
          ctx.waitUntil(edgeCache().delete(cachedPageRequest(new URL(u))));
        }
        return jsonResponse({ kv: 'ok', entity, purge });
      }

      return jsonResponse({ error: 'method not allowed' }, 405);
    }

    if (url.pathname === '/api/entities' && request.method === 'GET') {
      const requestedLocale = url.searchParams.get('locale') ?? DEFAULT_LOCALE;
      if (!validLocale(requestedLocale)) {
        return jsonResponse({ error: `unknown locale: ${requestedLocale}` }, 400);
      }
      const entities = await listEntities(env.STACK_TEST_KV, requestedLocale);
      return jsonResponse(entities);
    }

    if (url.pathname === '/api/purge' && request.method === 'POST') {
      const payload = (await request.json().catch(() => null)) as { url?: string } | null;
      if (!payload || typeof payload.url !== 'string') {
        return jsonResponse({ error: 'expected { url: string }' }, 400);
      }
      ctx.waitUntil(edgeCache().delete(cachedPageRequest(new URL(payload.url))));
      const result = await purgeUrls(env, [payload.url]);
      return jsonResponse(result, result.status >= 400 ? result.status : 200);
    }

    // --- Angular SSR for everything else ---

    // SSR resolvers read the KV binding via `cloudflare:workers` `env`, which
    // the runtime exposes globally inside the request scope. The multi-locale
    // build dispatches by URL prefix automatically.
    // For cached pages, strip the theme cookie so the rendered HTML is
    // theme-neutral and safe to share across visitors via the URL-keyed cache.
    const ssrRequest = cachedPage ? stripThemeCookie(request) : request;
    const res = (await reqHandler(ssrRequest)) ?? new Response('Page not found.', { status: 404 });

    // Override Cache-Control on cached entity pages (any locale) so the edge
    // cache treats them as cacheable. URL prefix segments the cache per locale.
    if (cachedPage) {
      const headers = new Headers(res.headers);
      const cacheable = res.status === 200;
      headers.set(
        'Cache-Control',
        cacheable ? 'public, max-age=300, s-maxage=300' : 'private, no-store',
      );
      headers.set('CF-Cache-Status', cacheable ? 'MISS' : 'BYPASS');
      headers.set('X-Stack-Test-Cache', cacheable ? 'MISS' : 'BYPASS');
      headers.set('X-Stack-Test-Locale', cachedPage.locale);
      const response = new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers,
      });
      if (cacheable) {
        ctx.waitUntil(edgeCache().put(cachedPageRequest(url), response.clone()));
      }
      return response;
    }

    // Everything else: don't cache dynamic content.
    const headers = new Headers(res.headers);
    if (!headers.has('Cache-Control')) {
      headers.set('Cache-Control', 'private, no-store');
    }
    return new Response(res.body, { status: res.status, headers });
  },
};
