import { Injectable } from '@angular/core';
import { defer, Observable } from 'rxjs';

import { DataService } from './data.service';
import { Entity } from './entity';

type StackTestEnv = {
	STACK_TEST_KV: KVNamespace;
};

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

@Injectable()
export class ServerDataService extends DataService {
	override getEntity(id: string): Observable<Entity> {
		return defer(async () => {
			console.log('[ssr-debug] ServerDataService.getEntity (direct KV)', id);
			const ns = await kv();
			const raw = await ns.get(`entity:${id}`);
			if (!raw) throw new Error(`entity:${id} not found`);
			return JSON.parse(raw) as Entity;
		});
	}

	override listEntities(): Observable<Entity[]> {
		return defer(async () => {
			console.log('[ssr-debug] ServerDataService.listEntities (direct KV)');
			const ns = await kv();
			const { keys } = await ns.list({ prefix: 'entity:' });
			const results = await Promise.all(keys.map((k) => ns.get(k.name)));
			return results
				.filter((r): r is string => r !== null)
				.map((raw) => JSON.parse(raw) as Entity);
		});
	}
}
