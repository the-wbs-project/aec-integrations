import { HttpClient } from '@angular/common/http';
import { Injectable, REQUEST, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { Entity } from './entity';

/**
 * Fetches entity data via the Worker's /api/* endpoints.
 *
 * During SSR, Angular's `withFetch()` adapter calls global fetch, which in the
 * Workers runtime makes a real HTTP request. We build an absolute URL from the
 * incoming request so SSR-side fetches don't fail with relative-URL errors.
 *
 * `provideClientHydration(withHttpTransferCache())` (configured in app.config)
 * captures these responses into TransferState so the client doesn't refetch.
 */
@Injectable({ providedIn: 'root' })
export class DataService {
  private readonly http = inject(HttpClient);
  private readonly request = inject(REQUEST, { optional: true });

  private toAbsolute(path: string): string {
    if (this.request) {
      const url = new URL(this.request.url);
      return new URL(path, url.origin).toString();
    }
    return path;
  }

  getEntity(id: string): Observable<Entity> {
    const url = this.toAbsolute(`/api/data/${id}`);
    console.log('[ssr-debug] getEntity', { id, url, hasRequest: !!this.request });
    return this.http.get<Entity>(url);
  }

  listEntities(): Observable<Entity[]> {
    const url = this.toAbsolute('/api/entities');
    console.log('[ssr-debug] listEntities', { url, hasRequest: !!this.request });
    return this.http.get<Entity[]>(url);
  }

  saveEntity(id: string, payload: { title: string; body: string }): Observable<{
    kv: string;
    entity: Entity;
    purge: { status: number; body: unknown };
  }> {
    return this.http.put<{
      kv: string;
      entity: Entity;
      purge: { status: number; body: unknown };
    }>(this.toAbsolute(`/api/data/${id}`), payload);
  }

  rawPurge(url: string): Observable<{ status: number; body: unknown }> {
    return this.http.post<{ status: number; body: unknown }>(
      this.toAbsolute('/api/purge'),
      { url },
    );
  }
}
