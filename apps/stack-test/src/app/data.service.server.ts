import { Injectable } from '@angular/core';
import { defer, Observable } from 'rxjs';

import { DataService } from './data.service';
import { Entity } from './entity';

type StackTestEnv = {
	STACK_TEST_KV: KVNamespace;
};

type TranslationOverlay = Partial<Pick<Entity, 'title' | 'body'>>;

const DEFAULT_LOCALE = 'en-US';

/**
 * Dynamic import: keeps `cloudflare:workers` out of the module-eval graph so
 * Angular's Node-based route extractor doesn't try to resolve it. The import
 * only fires at request time, inside the workerd runtime, where the module
 * exists.
 */
async function kv(): Promise<KVNamespace> {
	const workers = (await import('cloudflare:workers')) as unknown as {
		env: StackTestEnv;
	};
	return workers.env.STACK_TEST_KV;
}

async function readEntity(ns: KVNamespace, id: string): Promise<Entity | null> {
	const raw = await ns.get(`entity:${id}`);
	return raw ? (JSON.parse(raw) as Entity) : null;
}

async function readOverlay(
	ns: KVNamespace,
	id: string,
	locale: string,
): Promise<TranslationOverlay | null> {
	if (locale === DEFAULT_LOCALE) return null;
	const raw = await ns.get(`translations:entity:${id}:${locale}`);
	return raw ? (JSON.parse(raw) as TranslationOverlay) : null;
}

function merge(entity: Entity, overlay: TranslationOverlay | null): Entity {
	if (!overlay) return entity;
	// Per-field fallback to canonical (en-US) on missing translation fields.
	return {
		...entity,
		title: overlay.title ?? entity.title,
		body: overlay.body ?? entity.body,
	};
}

@Injectable()
export class ServerDataService extends DataService {
	override getEntity(id: string): Observable<Entity> {
		return defer(async () => {
			console.log('[ssr-debug] ServerDataService.getEntity (direct KV)', {
				id,
				locale: this.locale,
			});
			const ns = await kv();
			const entity = await readEntity(ns, id);
			if (!entity) throw new Error(`entity:${id} not found`);
			const overlay = await readOverlay(ns, id, this.locale);
			return merge(entity, overlay);
		});
	}

	override listEntities(): Observable<Entity[]> {
		return defer(async () => {
			console.log('[ssr-debug] ServerDataService.listEntities (direct KV)', {
				locale: this.locale,
			});
			const ns = await kv();
			const { keys } = await ns.list({ prefix: 'entity:' });
			const raw = await Promise.all(keys.map((k) => ns.get(k.name)));
			const entities = raw
				.filter((r): r is string => r !== null)
				.map((s) => JSON.parse(s) as Entity);
			if (this.locale === DEFAULT_LOCALE) return entities;
			const overlays = await Promise.all(
				entities.map((e) => readOverlay(ns, e.id, this.locale)),
			);
			return entities.map((e, i) => merge(e, overlays[i]));
		});
	}
}
