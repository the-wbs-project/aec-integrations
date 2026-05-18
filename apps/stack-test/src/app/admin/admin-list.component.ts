import { Component, inject } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { map } from 'rxjs';

import { Entity } from '../entity';

@Component({
  selector: 'stack-admin-list',
  imports: [RouterLink],
  template: `
    <section class="space-y-6">
      <div>
        <h1 class="text-2xl font-medium tracking-tight text-(--text-primary)">Admin · entities</h1>
        <p class="mt-2 text-sm text-(--text-muted) max-w-prose">
          KV-backed entities seeded on first request. Edit an entity to trigger an automatic purge
          of its
          <code class="font-mono text-xs">/cached/:id</code> page.
        </p>
        <p class="mt-2 text-sm">
          <a routerLink="/admin/purge" class="text-(--accent) underline underline-offset-2"
            >→ raw URL purge form</a
          >
        </p>
      </div>

      <ul
        class="divide-y divide-(--border) rounded-lg border border-(--border) bg-(--surface) shadow-sm"
      >
        @for (e of entities(); track e.id) {
          <li class="p-4 flex items-center justify-between gap-4">
            <div class="min-w-0">
              <div class="text-xs uppercase tracking-wider text-(--text-muted)">
                entity:{{ e.id }}
              </div>
              <div class="font-medium text-(--text-primary) truncate">{{ e.title }}</div>
              <div class="text-xs text-(--text-muted) font-mono">updated {{ e.updatedAt }}</div>
            </div>
            <div class="flex gap-3 shrink-0">
              <a
                [routerLink]="['/cached', e.id]"
                class="text-sm text-(--text-secondary) hover:text-(--accent) underline underline-offset-2"
              >
                view cached
              </a>
              <a
                [routerLink]="['/admin', e.id]"
                class="text-sm text-(--accent) hover:text-(--accent-hover) underline underline-offset-2"
              >
                edit →
              </a>
            </div>
          </li>
        } @empty {
          <li class="p-6 text-sm text-(--text-muted)">No entities yet.</li>
        }
      </ul>
    </section>
  `,
})
export class AdminListComponent {
  private readonly route = inject(ActivatedRoute);
  protected readonly entities = toSignal<Entity[], Entity[]>(
    this.route.data.pipe(map((d) => (d['entities'] ?? []) as Entity[])),
    { initialValue: (this.route.snapshot.data['entities'] ?? []) as Entity[] },
  );
}
