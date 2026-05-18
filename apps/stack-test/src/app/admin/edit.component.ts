import { Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { BrnButton } from '@spartan-ng/brain/button';
import { map } from 'rxjs';

import { DataService } from '../data.service';
import { Entity } from '../entity';

type SaveResult = {
  kv: string;
  entity: Entity;
  purge: { status: number; body: unknown };
};

/**
 * /admin/:id
 *
 * Edit the entity in KV. On submit, PUT /api/data/:id which (a) writes KV and
 * (b) calls Cloudflare purge_cache for the corresponding /cached/:id URL. The
 * result of both operations is displayed so we can verify partial-failure modes.
 */
@Component({
  selector: 'stack-admin-edit',
  imports: [FormsModule, RouterLink, BrnButton],
  template: `
    <section class="space-y-6">
      <div>
        <h1 class="text-2xl font-medium tracking-tight text-(--text-primary)">
          Edit entity:{{ id() }}
        </h1>
        <p class="mt-2 text-sm text-(--text-muted)">
          Save writes to KV, then purges
          <code class="font-mono text-xs">/cached/{{ id() }}</code> at the edge.
        </p>
      </div>

      <form
        (ngSubmit)="save()"
        class="space-y-4 rounded-lg border border-(--border) bg-(--surface) p-6 shadow-sm"
      >
        <div class="space-y-2">
          <label for="edit-title" class="block text-sm font-medium text-(--text-secondary)">
            Title
          </label>
          <input
            id="edit-title"
            name="title"
            type="text"
            [ngModel]="titleInput()"
            (ngModelChange)="titleInput.set($event)"
            required
            class="w-full rounded-md border border-(--border-strong) bg-(--bg) text-(--text-primary) px-3 py-2 text-sm placeholder:text-(--text-muted) focus:outline-none focus:ring-2 focus:ring-(--focus-ring) focus:border-(--accent)"
          />
        </div>

        <div class="space-y-2">
          <label for="edit-body" class="block text-sm font-medium text-(--text-secondary)">
            Body
          </label>
          <textarea
            id="edit-body"
            name="body"
            rows="5"
            [ngModel]="bodyInput()"
            (ngModelChange)="bodyInput.set($event)"
            required
            class="w-full rounded-md border border-(--border-strong) bg-(--bg) text-(--text-primary) px-3 py-2 text-sm placeholder:text-(--text-muted) focus:outline-none focus:ring-2 focus:ring-(--focus-ring) focus:border-(--accent) font-mono"
          ></textarea>
        </div>

        <div class="flex items-center gap-3">
          <button
            brnButton
            type="submit"
            [disabled]="saving()"
            class="text-sm px-4 py-2 rounded-md bg-(--accent) text-(--accent-fg) hover:bg-(--accent-hover) disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
          >
            {{ saving() ? 'Saving…' : 'Save & purge' }}
          </button>
          <a
            [routerLink]="['/cached', id()]"
            target="_blank"
            rel="noopener"
            class="text-sm text-(--text-secondary) hover:text-(--accent) underline underline-offset-2"
          >
            open /cached/{{ id() }} ↗
          </a>
          <a
            routerLink="/admin"
            class="text-sm text-(--text-muted) hover:text-(--text-primary) ml-auto"
          >
            ← back to list
          </a>
        </div>
      </form>

      @if (result(); as r) {
        <div class="rounded-lg border border-(--border) bg-(--surface) p-5 space-y-3 shadow-sm">
          <div class="text-xs uppercase tracking-wider text-(--text-muted)">last save result</div>
          <div class="grid grid-cols-[8rem_1fr] gap-y-2 text-sm">
            <span class="text-(--text-secondary)">KV write</span>
            <span class="font-mono text-(--text-primary)">{{ r.kv }}</span>

            <span class="text-(--text-secondary)">new updatedAt</span>
            <span class="font-mono text-(--text-primary)">{{ r.entity.updatedAt }}</span>

            <span class="text-(--text-secondary)">purge status</span>
            <span
              class="font-mono"
              [class.text-danger]="r.purge.status >= 400"
              [class.text-text-primary]="r.purge.status < 400"
            >
              HTTP {{ r.purge.status }}
            </span>

            <span class="text-(--text-secondary)">purge response</span>
            <pre
              class="font-mono text-xs bg-(--surface-muted) text-(--text-secondary) rounded p-3 overflow-x-auto"
              >{{ purgeJson(r) }}</pre
            >
          </div>
        </div>
      }

      @if (error()) {
        <div class="rounded-lg border border-(--danger) bg-(--surface) p-4 text-sm text-(--danger)">
          {{ error() }}
        </div>
      }
    </section>
  `,
})
export class EditComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly data = inject(DataService);

  private readonly params = toSignal(this.route.params, {
    initialValue: { id: '' } as { id: string },
  });
  protected readonly id = computed(() => (this.params() as { id: string }).id ?? '');

  protected readonly titleInput = signal('');
  protected readonly bodyInput = signal('');
  protected readonly saving = signal(false);
  protected readonly result = signal<SaveResult | null>(null);
  protected readonly error = signal<string | null>(null);

  protected readonly entity = toSignal<Entity | null, Entity | null>(
    this.route.data.pipe(map((d) => (d['entity'] ?? null) as Entity | null)),
    { initialValue: (this.route.snapshot.data['entity'] ?? null) as Entity | null },
  );

  constructor() {
    effect(() => {
      const e = this.entity();
      if (e) {
        this.titleInput.set(e.title);
        this.bodyInput.set(e.body);
      }
    });
  }

  protected save(): void {
    if (this.saving()) return;
    this.saving.set(true);
    this.error.set(null);
    this.data
      .saveEntity(this.id(), { title: this.titleInput(), body: this.bodyInput() })
      .subscribe({
        next: (r) => {
          this.result.set(r);
          this.saving.set(false);
        },
        error: (err) => {
          this.error.set(err?.message ?? String(err));
          this.saving.set(false);
        },
      });
  }

  protected purgeJson(r: SaveResult): string {
    return JSON.stringify(r.purge.body, null, 2);
  }
}
