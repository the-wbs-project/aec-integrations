/**
 * Cloudflare Worker entry for the AECi Review stack-validation app.
 *
 * Responsibilities:
 *   1. PUT /api/data/:id  → write entity to KV, then purge /cached/:id at the edge.
 *   2. GET /api/data/:id  → read entity from KV (used by the admin list page).
 *   3. POST /api/purge    → raw URL purge (escape hatch for direct API testing).
 *   4. Everything else    → delegate to Angular SSR. Override Cache-Control on
 *                          /cached/:id so the edge cache treats it as cacheable.
 *
 * Bindings (see wrangler.jsonc):
 *   - STACK_TEST_KV: KV namespace, key shape `entity:<id>`.
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

async function ensureSeeded(kv: KVNamespace): Promise<void> {
	for (const [id, base] of Object.entries(SEED_ENTITIES)) {
		const key = `entity:${id}`;
		const existing = await kv.get(key);
		if (existing) continue;
		const entity: Entity = { id, ...base, updatedAt: new Date().toISOString() };
		await kv.put(key, JSON.stringify(entity));
	}
}

async function readEntity(kv: KVNamespace, id: string): Promise<Entity | null> {
	const raw = await kv.get(`entity:${id}`);
	return raw ? (JSON.parse(raw) as Entity) : null;
}

async function writeEntity(kv: KVNamespace, id: string, title: string, body: string): Promise<Entity> {
	const entity: Entity = { id, title, body, updatedAt: new Date().toISOString() };
	await kv.put(`entity:${id}`, JSON.stringify(entity));
	return entity;
}

async function listEntities(kv: KVNamespace): Promise<Entity[]> {
	const { keys } = await kv.list({ prefix: 'entity:' });
	const results = await Promise.all(keys.map((k) => kv.get(k.name)));
	return results
		.filter((r: string | null): r is string => r !== null)
		.map((raw: string) => JSON.parse(raw) as Entity);
}

async function purgeUrls(
	env: Env,
	urls: string[],
): Promise<{ status: number; body: unknown }> {
	if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ZONE_ID) {
		return {
			status: 500,
			body: {
				error: 'Missing CLOUDFLARE_API_TOKEN or CLOUDFLARE_ZONE_ID secret. Set via `wrangler secret put`.',
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
	// Cache by absolute URL only. Do not include request headers, because this
	// probe needs purge-by-URL to invalidate the same key every time.
	return new Request(url.toString(), { method: 'GET' });
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

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		const isCachedPage =
			request.method === 'GET' &&
			url.pathname.startsWith('/cached/') &&
			!url.pathname.slice('/cached/'.length).includes('/');

		if (isCachedPage) {
			const cached = await edgeCache().match(cachedPageRequest(url));
			if (cached) {
				const headers = new Headers(cached.headers);
				headers.set('Cache-Control', 'public, max-age=300, s-maxage=300');
				headers.set('CF-Cache-Status', 'HIT');
				headers.set('X-Stack-Test-Cache', 'HIT');
				return new Response(cached.body, {
					status: cached.status,
					statusText: cached.statusText,
					headers,
				});
			}
		}

		// Ensure first-touch SSR/API reads cannot race the seed writes.
		await ensureSeeded(env.STACK_TEST_KV);

		// --- API endpoints ---

		if (url.pathname.startsWith('/api/data/')) {
			const id = url.pathname.slice('/api/data/'.length);
			if (!id || id.includes('/')) {
				return jsonResponse({ error: 'invalid id' }, 400);
			}

			if (request.method === 'GET') {
				const entity = await readEntity(env.STACK_TEST_KV, id);
				if (!entity) return jsonResponse({ error: 'not found' }, 404);
				return jsonResponse(entity);
			}

			if (request.method === 'PUT') {
				const payload = (await request.json().catch(() => null)) as
					| { title?: string; body?: string }
					| null;
				if (!payload || typeof payload.title !== 'string' || typeof payload.body !== 'string') {
					return jsonResponse({ error: 'expected { title: string, body: string }' }, 400);
				}
				const entity = await writeEntity(env.STACK_TEST_KV, id, payload.title, payload.body);
				const origin = `${url.protocol}//${url.host}`;
				const cachedUrl = `${origin}/cached/${id}`;
				const purge = await purgeUrls(env, [cachedUrl]);
				ctx.waitUntil(edgeCache().delete(cachedPageRequest(new URL(cachedUrl))));
				return jsonResponse({ kv: 'ok', entity, purge });
			}

			return jsonResponse({ error: 'method not allowed' }, 405);
		}

		if (url.pathname === '/api/entities' && request.method === 'GET') {
			const entities = await listEntities(env.STACK_TEST_KV);
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
		// the runtime exposes globally inside the request scope.
		const res = (await reqHandler(request)) ?? new Response('Page not found.', { status: 404 });

		// Override Cache-Control on /cached/:id so the edge cache treats it as cacheable.
		if (isCachedPage) {
			const headers = new Headers(res.headers);
			headers.set('Cache-Control', 'public, max-age=300, s-maxage=300');
			headers.set('CF-Cache-Status', 'MISS');
			headers.set('X-Stack-Test-Cache', 'MISS');
			const response = new Response(res.body, {
				status: res.status,
				statusText: res.statusText,
				headers,
			});
			if (response.status === 200) {
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
