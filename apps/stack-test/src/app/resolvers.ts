import { inject } from '@angular/core';
import { ResolveFn } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { DataService } from './data.service';
import { Entity } from './entity';

/**
 * Route resolvers — the SSR-safe data-loading pattern.
 *
 * The router awaits these promises before activating the component, and
 * Angular SSR awaits route activation before rendering. This is what makes
 * `toSignal(observable, { initialValue })` reliably work on the server:
 * by the time the component reads `route.snapshot.data`, the data is there.
 */

export const entityResolver: ResolveFn<Entity | null> = async (route) => {
	const data = inject(DataService);
	const id = route.paramMap.get('id') ?? '';
	console.log('[ssr-debug] entityResolver', id);
	try {
		return await firstValueFrom(data.getEntity(id));
	} catch (err) {
		console.log('[ssr-debug] entityResolver error', String(err));
		return null;
	}
};

export const entitiesResolver: ResolveFn<Entity[]> = async () => {
	const data = inject(DataService);
	console.log('[ssr-debug] entitiesResolver');
	try {
		return await firstValueFrom(data.listEntities());
	} catch (err) {
		console.log('[ssr-debug] entitiesResolver error', String(err));
		return [];
	}
};
