import { Component, computed, inject } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { map } from 'rxjs';

import { Entity } from '../entity';

/**
 * /cached/:id
 *
 * Reads the entity from KV at SSR time via DataService → /api/data/:id.
 * provideClientHydration(withHttpTransferCache) captures the response into
 * TransferState, so the client doesn't re-fetch on hydration.
 *
 * Worker sets Cache-Control: public, s-maxage=300, max-age=60 on this route,
 * so the entire rendered HTML — including the bake-in render timestamp and
 * the KV-backed entity content — is cached at the Cloudflare edge.
 */
@Component({
  selector: 'stack-cached',
  imports: [RouterLink],
  template: `
    @let e = entity();
    <section class="space-y-6">
      <div>
        <h1 class="text-2xl font-medium tracking-tight text-(--text-primary)">
          /cached/{{ id() }}
        </h1>
        <p class="mt-2 text-sm text-(--text-muted) max-w-prose" i18n="@@cached.intro">
          Server-rendered from KV. This response is cached at the edge for 5 minutes. Edit the
          entity at
          <a [routerLink]="['/admin', id()]" class="text-(--accent) underline underline-offset-2"
            >/admin/{{ id() }}</a
          >
          to trigger an automatic purge.
        </p>
      </div>

      @if (e) {
        <div class="rounded-lg border border-(--border) bg-(--surface) p-6 space-y-3 shadow-sm">
          <div class="text-xs uppercase tracking-wider text-(--text-muted)">entity:{{ e.id }}</div>
          <h2 class="text-lg font-medium text-(--text-primary)">{{ e.title }}</h2>
          <p class="text-sm text-(--text-secondary) whitespace-pre-wrap">{{ e.body }}</p>
          <div class="text-xs text-(--text-muted) pt-2 border-t border-(--border)">
            entity updatedAt: <span class="font-mono">{{ e.updatedAt }}</span>
          </div>
        </div>
      } @else {
        <div
          class="rounded-lg border border-(--danger) bg-(--surface) p-6 text-sm text-(--danger)"
          i18n="@@cached.notFound"
        >
          Entity not found. Try
          <a routerLink="/cached/abc" class="underline">/cached/abc</a> or
          <a routerLink="/cached/xyz" class="underline">/cached/xyz</a>.
        </div>
      }

      <div
        class="rounded-lg border border-(--border) bg-(--surface-muted) p-4 text-xs text-(--text-muted) space-y-1"
      >
        <div>
          render timestamp (baked into HTML):
          <span class="font-mono text-(--text-secondary)">{{ renderedAt }}</span>
        </div>
        <div>
          On a cache HIT this timestamp stays the same as the original render. On a purge + miss it
          will change.
        </div>
      </div>
    </section>
  `,
})
export class CachedComponent {
  private readonly route = inject(ActivatedRoute);

  private readonly params = toSignal(this.route.params, {
    initialValue: { id: '' } as { id: string },
  });
  protected readonly id = computed(() => (this.params() as { id: string }).id ?? '');
  protected readonly renderedAt = new Date().toISOString();

  protected readonly entity = toSignal<Entity | null, Entity | null>(
    this.route.data.pipe(map((d) => (d['entity'] ?? null) as Entity | null)),
    { initialValue: (this.route.snapshot.data['entity'] ?? null) as Entity | null },
  );
}
