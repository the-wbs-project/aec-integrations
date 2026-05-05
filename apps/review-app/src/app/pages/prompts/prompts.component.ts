// ---------------------------------------------------------------------------
// Prompt Library — browse playbooks and copy them to the clipboard for
// pasting into any LLM client. Source of truth lives in /playbooks/*.md and
// is shipped to the Worker via the Wrangler `Text` rule, surfaced through
// GET /api/playbooks.
// ---------------------------------------------------------------------------
import {
  Component,
  DestroyRef,
  OnInit,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ApiService } from '../../services/api.service';
import { PlaybookSummary } from '../../types';

@Component({
  selector: 'app-prompts',
  imports: [CommonModule, FormsModule],
  templateUrl: './prompts.component.html',
  styleUrl: './prompts.component.scss',
})
export class PromptsComponent implements OnInit {
  private api = inject(ApiService);
  private destroyRef = inject(DestroyRef);

  protected readonly playbooks = signal<PlaybookSummary[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);

  /** Per-card scope text, keyed by slug. */
  protected readonly scopeBySlug = signal<Record<string, string>>({});

  /** Slugs whose Copy button should currently flash "Copied". */
  protected readonly copiedSlugs = signal<Set<string>>(new Set());

  /** Slugs with an in-flight Queue request. */
  protected readonly queuingSlugs = signal<Set<string>>(new Set());

  /** Per-slug "Queued as Job …" confirmation toast text, cleared after 3s. */
  protected readonly queuedToast = signal<Record<string, string>>({});

  /** Per-slug enqueue error message, cleared on next attempt. */
  protected readonly queueError = signal<Record<string, string>>({});

  ngOnInit(): void {
    this.api
      .getPlaybooks()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (rows) => {
          this.playbooks.set(rows);
          this.loading.set(false);
        },
        error: (err) => {
          this.error.set(err?.message ?? 'Failed to load playbooks.');
          this.loading.set(false);
        },
      });
  }

  scopeFor(slug: string): string {
    return this.scopeBySlug()[slug] ?? '';
  }

  onScopeInput(slug: string, event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.scopeBySlug.update((m) => ({ ...m, [slug]: value }));
  }

  isCopied(slug: string): boolean {
    return this.copiedSlugs().has(slug);
  }

  /**
   * Build the final string and write to clipboard. We always append the
   * `**This invocation:**` line when the playbook has a scope label, even if
   * the user left the field blank — the playbook itself instructs the LLM to
   * ask for scope when the line is empty.
   */
  async copy(playbook: PlaybookSummary): Promise<void> {
    const scope = this.scopeFor(playbook.slug).trim();
    let text = playbook.body;
    if (playbook.scope_label !== null) {
      text = `${text.trimEnd()}\n\n**${playbook.scope_label}:** ${scope}\n`;
    }
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      this.error.set('Clipboard write failed — your browser may require HTTPS or a permission grant.');
      return;
    }
    this.copiedSlugs.update((s) => new Set(s).add(playbook.slug));
    setTimeout(() => {
      this.copiedSlugs.update((s) => {
        const next = new Set(s);
        next.delete(playbook.slug);
        return next;
      });
    }, 2000);
  }

  isQueuing(slug: string): boolean {
    return this.queuingSlugs().has(slug);
  }

  toastFor(slug: string): string | null {
    return this.queuedToast()[slug] ?? null;
  }

  errorFor(slug: string): string | null {
    return this.queueError()[slug] ?? null;
  }

  /**
   * Push the rendered playbook prompt onto the Airtable queue. The scheduled
   * Sonnet dispatcher (Claude macOS app) picks it up within ~10 minutes.
   */
  queue(playbook: PlaybookSummary): void {
    if (this.isQueuing(playbook.slug)) return;
    const scope = this.scopeFor(playbook.slug).trim();

    this.queueError.update((m) => {
      const { [playbook.slug]: _, ...rest } = m;
      return rest;
    });
    this.queuingSlugs.update((s) => new Set(s).add(playbook.slug));

    this.api
      .enqueuePromptJob({ playbook_slug: playbook.slug, scope })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.queuingSlugs.update((s) => {
            const next = new Set(s);
            next.delete(playbook.slug);
            return next;
          });
          const label = res.recordId.slice(-6);
          this.queuedToast.update((m) => ({
            ...m,
            [playbook.slug]: `Queued (#${label})`,
          }));
          setTimeout(() => {
            this.queuedToast.update((m) => {
              const { [playbook.slug]: _, ...rest } = m;
              return rest;
            });
          }, 3000);
        },
        error: (err) => {
          this.queuingSlugs.update((s) => {
            const next = new Set(s);
            next.delete(playbook.slug);
            return next;
          });
          const message =
            (err?.error?.error as string | undefined) ??
            (err?.message as string | undefined) ??
            'Queue failed.';
          this.queueError.update((m) => ({ ...m, [playbook.slug]: message }));
        },
      });
  }
}
