import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, LOCALE_ID, REQUEST, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { Entity } from './entity';

/**
 * Fetches entity data via the Worker's /api/* endpoints.
 *
 * The active locale (from Angular's LOCALE_ID, set per-build by @angular/localize)
 * is forwarded to the API so the Worker can apply the KV translation overlay for
 * non-default locales. Locale-aware reads are GETs against a stable URL
 * (`/api/data/:id?locale=...`); the cached HTML page itself differs by URL
 * prefix (`/cached/:id` vs `/es/cached/:id`), so the edge cache is naturally
 * segmented by locale — the same lesson as T1b but solved with URL instead of
 * Vary headers.
 */
@Injectable({ providedIn: 'root' })
export class DataService {
  private readonly http = inject(HttpClient);
  private readonly request = inject(REQUEST, { optional: true });
  protected readonly locale = inject(LOCALE_ID);

  private toAbsolute(path: string): string {
    if (this.request) {
      const url = new URL(this.request.url);
      return new URL(path, url.origin).toString();
    }
    return path;
  }

  private localeParams(): HttpParams {
    return new HttpParams().set('locale', this.locale);
  }

  getEntity(id: string): Observable<Entity> {
    const url = this.toAbsolute(`/api/data/${id}`);
    console.log('[ssr-debug] getEntity', { id, url, locale: this.locale });
    return this.http.get<Entity>(url, { params: this.localeParams() });
  }

  listEntities(): Observable<Entity[]> {
    const url = this.toAbsolute('/api/entities');
    console.log('[ssr-debug] listEntities', { url, locale: this.locale });
    return this.http.get<Entity[]>(url, { params: this.localeParams() });
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

  saveTranslation(
    id: string,
    locale: string,
    payload: { title?: string; body?: string },
  ): Observable<{
    kv: string;
    translation: { title?: string; body?: string };
    purge: { status: number; body: unknown };
  }> {
    return this.http.put<{
      kv: string;
      translation: { title?: string; body?: string };
      purge: { status: number; body: unknown };
    }>(this.toAbsolute(`/api/translations/${id}/${locale}`), payload);
  }

  rawPurge(url: string): Observable<{ status: number; body: unknown }> {
    return this.http.post<{ status: number; body: unknown }>(
      this.toAbsolute('/api/purge'),
      { url },
    );
  }
}
