import { Dialog } from '@angular/cdk/dialog';
import {
  ChangeDetectionStrategy,
  Component,
  TemplateRef,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { BrnButton } from '@spartan-ng/brain/button';

import { ThemeService } from '../theme.service';

@Component({
  selector: 'stack-home',
  imports: [FormsModule, BrnButton],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="space-y-8">
      <div>
        <h1 class="text-2xl font-medium tracking-tight text-(--text-primary)" i18n="@@home.title">
          Stack validation probe
        </h1>
        <p class="mt-2 text-sm text-(--text-muted) max-w-prose" i18n="@@home.intro">
          Smoke test for Angular 21 zoneless SSR on Cloudflare Workers, Tailwind v4, and Spartan
          brain primitives (Angular CDK overlay backing the dialog). Toggle the theme in the header
          to verify CSS custom properties switch server-side and client-side without FOUC. See
          <code class="font-mono text-xs">/cached/:id</code> for cache tests and
          <code class="font-mono text-xs">/admin</code> for data-driven invalidation.
        </p>
      </div>

      <div class="rounded-lg border border-(--border) bg-(--surface) p-5 space-y-3 shadow-sm">
        <div
          class="text-xs uppercase tracking-wider text-(--text-muted)"
          i18n="@@home.section.theme"
        >
          theme state
        </div>
        <div class="text-sm grid grid-cols-2 gap-y-1">
          <span class="text-(--text-secondary)">user choice</span>
          <span class="font-mono text-(--text-primary)">{{ theme.choice() }}</span>
          <span class="text-(--text-secondary)">resolved</span>
          <span class="font-mono text-(--text-primary)">{{ theme.resolved() }}</span>
        </div>
        <div class="flex flex-wrap gap-2 pt-2">
          <button
            brnButton
            type="button"
            (click)="theme.set('light')"
            class="text-xs px-3 py-1.5 rounded-md border border-(--border) bg-(--surface-muted) text-(--text-primary) hover:bg-(--accent) hover:text-(--accent-fg) hover:border-(--accent) cursor-pointer"
            i18n="@@home.theme.light"
          >
            Light
          </button>
          <button
            brnButton
            type="button"
            (click)="theme.set('dark')"
            class="text-xs px-3 py-1.5 rounded-md border border-(--border) bg-(--surface-muted) text-(--text-primary) hover:bg-(--accent) hover:text-(--accent-fg) hover:border-(--accent) cursor-pointer"
          >
            Dark
          </button>
          <button
            brnButton
            type="button"
            (click)="theme.set('system')"
            class="text-xs px-3 py-1.5 rounded-md border border-(--border) bg-(--surface-muted) text-(--text-primary) hover:bg-(--accent) hover:text-(--accent-fg) hover:border-(--accent) cursor-pointer"
          >
            System
          </button>
        </div>
      </div>

      <div class="rounded-lg border border-(--border) bg-(--surface) p-5 space-y-4 shadow-sm">
        <div class="text-xs uppercase tracking-wider text-(--text-muted)">form primitives</div>
        <div class="space-y-2">
          <label for="smoke-input" class="block text-sm font-medium text-(--text-secondary)">
            Sample input
          </label>
          <input
            id="smoke-input"
            name="smoke-input"
            type="text"
            [(ngModel)]="inputValue"
            placeholder="Type something"
            class="w-full rounded-md border border-(--border-strong) bg-(--bg) text-(--text-primary) px-3 py-2 text-sm placeholder:text-(--text-muted) focus:outline-none focus:ring-2 focus:ring-(--focus-ring) focus:border-(--accent)"
          />
          <p class="text-xs text-(--text-muted)">
            echo: <span class="font-mono text-(--text-primary)">{{ inputValue() }}</span>
          </p>
        </div>
      </div>

      <div class="rounded-lg border border-(--border) bg-(--surface) p-5 space-y-3 shadow-sm">
        <div class="text-xs uppercase tracking-wider text-(--text-muted)">
          overlay (Angular CDK via Spartan brain dialog)
        </div>
        <p class="text-sm text-(--text-secondary)">
          Tests that CDK overlay hydrates cleanly under zoneless SSR — Section 6 risk.
        </p>
        <button
          brnButton
          type="button"
          (click)="openDialog()"
          class="text-sm px-4 py-2 rounded-md bg-(--accent) text-(--accent-fg) hover:bg-(--accent-hover) cursor-pointer"
        >
          Open dialog
        </button>
      </div>

      <ng-template #dialogTpl let-ref>
        <div
          class="rounded-lg border border-(--border) bg-(--surface) p-6 shadow-xl max-w-sm w-full space-y-4"
        >
          <h2 class="text-lg font-medium text-(--text-primary)">Hello from CDK Dialog</h2>
          <p class="text-sm text-(--text-secondary)">
            Backed by &#64;angular/cdk/dialog. If this opened without hydration warnings and Esc
            closes it, the high-risk overlay scenario passes.
          </p>
          <div class="flex justify-end gap-2">
            <button
              brnButton
              type="button"
              (click)="ref.close()"
              class="text-sm px-3 py-1.5 rounded-md border border-(--border-strong) bg-(--surface-muted) text-(--text-primary) hover:bg-(--surface) cursor-pointer"
            >
              Close
            </button>
          </div>
        </div>
      </ng-template>
    </section>
  `,
})
export class HomeComponent {
  protected readonly theme = inject(ThemeService);
  protected readonly inputValue = signal('');
  private readonly dialog = inject(Dialog);
  private readonly dialogTpl = viewChild.required<TemplateRef<unknown>>('dialogTpl');

  protected openDialog(): void {
    this.dialog.open(this.dialogTpl(), {
      hasBackdrop: true,
      backdropClass: 'bg-black/40',
      panelClass: ['flex', 'items-center', 'justify-center'],
    });
  }
}
