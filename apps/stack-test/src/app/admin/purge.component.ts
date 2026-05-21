import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { BrnButton } from '@spartan-ng/brain/button';

import { DataService } from '../data.service';

/**
 * /admin/purge
 *
 * Raw URL purge — kept as an escape hatch for testing token scoping and
 * direct API behavior in isolation, as Section 6 of the spec flags
 * misscoped tokens as a high risk that "fails silently or with a confusing error".
 */
@Component({
  selector: 'stack-admin-purge',
  imports: [FormsModule, RouterLink, BrnButton],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="space-y-6">
      <div>
        <h1 class="text-2xl font-medium tracking-tight text-(--text-primary)">Raw URL purge</h1>
        <p class="mt-2 text-sm text-(--text-muted) max-w-prose">
          Hits Cloudflare's
          <code class="font-mono text-xs">purge_cache</code> REST endpoint directly with the URL you
          supply. Use this to verify token scoping and propagation independently of the KV → purge
          data flow.
        </p>
      </div>

      <form
        (ngSubmit)="purge()"
        class="space-y-4 rounded-lg border border-(--border) bg-(--surface) p-6 shadow-sm"
      >
        <div class="space-y-2">
          <label for="purge-url" class="block text-sm font-medium text-(--text-secondary)">
            URL to purge
          </label>
          <input
            id="purge-url"
            name="url"
            type="url"
            [ngModel]="urlInput()"
            (ngModelChange)="urlInput.set($event)"
            placeholder="https://stack-test.aecintegrations.com/cached/abc"
            required
            class="w-full rounded-md border border-(--border-strong) bg-(--bg) text-(--text-primary) px-3 py-2 text-sm placeholder:text-(--text-muted) focus:outline-none focus:ring-2 focus:ring-(--focus-ring) focus:border-(--accent) font-mono"
          />
        </div>

        <div class="flex items-center gap-3">
          <button
            brnButton
            type="submit"
            [disabled]="busy()"
            class="text-sm px-4 py-2 rounded-md bg-(--accent) text-(--accent-fg) hover:bg-(--accent-hover) disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
          >
            {{ busy() ? 'Purging…' : 'Purge' }}
          </button>
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
          <div class="text-xs uppercase tracking-wider text-(--text-muted)">api response</div>
          <div class="text-sm text-(--text-secondary)">
            HTTP <span class="font-mono">{{ r.status }}</span>
          </div>
          <pre
            class="font-mono text-xs bg-(--surface-muted) text-(--text-secondary) rounded p-3 overflow-x-auto"
            >{{ pretty(r.body) }}</pre
          >
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
export class PurgeComponent {
  private readonly data = inject(DataService);

  protected readonly urlInput = signal('');
  protected readonly busy = signal(false);
  protected readonly result = signal<{ status: number; body: unknown } | null>(null);
  protected readonly error = signal<string | null>(null);

  protected purge(): void {
    if (this.busy() || !this.urlInput()) return;
    this.busy.set(true);
    this.error.set(null);
    this.data.rawPurge(this.urlInput()).subscribe({
      next: (r) => {
        this.result.set(r);
        this.busy.set(false);
      },
      error: (err) => {
        this.error.set(err?.message ?? String(err));
        this.busy.set(false);
      },
    });
  }

  protected pretty(body: unknown): string {
    return JSON.stringify(body, null, 2);
  }
}
