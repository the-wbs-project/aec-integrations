// ---------------------------------------------------------------------------
// Dashboard — landing page for the merged app. Three at-a-glance cards:
//   • Vendor count (links to /vendors)
//   • Tool count   (links to /tools)
//   • Recent runs preview — latest 5 from RunsService, links to /runs
//
// Counts come from the existing list endpoints with limit=1, which already
// expose `total` in the paginated envelope.
// ---------------------------------------------------------------------------
import { Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { ApiService } from '../../services/api.service';
import { RunsService } from '../../services/runs.service';
import { WORKFLOWS } from '../../workflows';

@Component({
  selector: 'app-dashboard',
  imports: [CommonModule, RouterLink, DatePipe],
  template: `
    <div class="page-container--wide">
      <div class="page-header">
        <h1 class="page-heading">Dashboard</h1>
      </div>

      <section class="card-grid">
        <a routerLink="/vendors" class="stat-card">
          <span class="stat-card__label">Vendors</span>
          <span class="stat-card__value">{{ vendorCount() ?? '—' }}</span>
          <span class="stat-card__hint">Open list</span>
        </a>

        <a routerLink="/tools" class="stat-card">
          <span class="stat-card__label">Tools</span>
          <span class="stat-card__value">{{ toolCount() ?? '—' }}</span>
          <span class="stat-card__hint">Open list</span>
        </a>

        <a routerLink="/runs" class="stat-card">
          <span class="stat-card__label">Runs in flight</span>
          <span class="stat-card__value">{{ runs.inFlightCount() }}</span>
          <span class="stat-card__hint">View history</span>
        </a>
      </section>

      <section class="recent">
        <h2 class="recent__heading">Recent runs</h2>
        @if (runs.runs().length === 0) {
          <p class="recent__empty">No runs yet. Kick off a workflow from a vendor or tool to see it here.</p>
        } @else {
          <ul class="recent__list">
            @for (run of runs.runs().slice(0, 5); track run.runId) {
              <li class="recent__row">
                <div class="recent__row-main">
                  <div class="recent__row-title">{{ workflowTitle(run.workflow) }}</div>
                  <div class="recent__row-sub">{{ run.recordLabel || run.recordId }}</div>
                </div>
                <div class="recent__row-meta">
                  <span class="status-pill" [attr.data-status]="run.status">{{ run.status }}</span>
                  <span class="recent__row-time">{{ run.startedAt | date:'short' }}</span>
                </div>
              </li>
            }
          </ul>
          <a routerLink="/runs" class="recent__more">View all runs →</a>
        }
      </section>
    </div>
  `,
  styles: `
    .page-header {
      margin-bottom: var(--space-5);
    }
    .page-heading {
      font-size: var(--text-xl);
      font-weight: 500;
      color: var(--color-text-primary);
      margin: 0;
    }

    .card-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
      gap: var(--space-3);
      margin-bottom: var(--space-6);
    }

    .stat-card {
      display: flex;
      flex-direction: column;
      gap: var(--space-1);
      padding: var(--space-4);
      background: var(--color-bg-elevated);
      border: 0.5px solid var(--color-border-default);
      border-radius: var(--radius-md, 8px);
      text-decoration: none;
      color: inherit;
      transition: border-color var(--duration-base, 150ms) ease, box-shadow var(--duration-base, 150ms) ease;
    }
    .stat-card:hover {
      border-color: var(--color-border-strong);
      box-shadow: var(--shadow-sm);
    }

    .stat-card__label {
      font-size: var(--text-xs, 12px);
      font-weight: 500;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--color-text-secondary);
    }
    .stat-card__value {
      font-size: 32px;
      font-weight: 500;
      color: var(--color-text-primary);
      font-variant-numeric: tabular-nums;
    }
    .stat-card__hint {
      font-size: var(--text-xs, 12px);
      color: var(--color-text-tertiary);
    }

    .recent {
      background: var(--color-bg-elevated);
      border: 0.5px solid var(--color-border-default);
      border-radius: var(--radius-md, 8px);
      padding: var(--space-4);
    }
    .recent__heading {
      font-size: var(--text-base, 14px);
      font-weight: 600;
      margin: 0 0 var(--space-3);
      color: var(--color-text-primary);
    }
    .recent__empty {
      color: var(--color-text-secondary);
      font-size: var(--text-sm, 13px);
      margin: 0;
    }
    .recent__list { list-style: none; margin: 0; padding: 0; }
    .recent__row {
      display: flex;
      align-items: center;
      gap: var(--space-3);
      padding: var(--space-2) 0;
      border-bottom: 0.5px solid var(--color-border-default);
    }
    .recent__row:last-child { border-bottom: 0; }
    .recent__row-main { flex: 1; min-width: 0; }
    .recent__row-title { font-size: var(--text-sm, 13px); font-weight: 600; color: var(--color-text-primary); }
    .recent__row-sub { font-size: var(--text-xs, 12px); color: var(--color-text-secondary); }
    .recent__row-meta { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
    .recent__row-time { font-size: 10px; color: var(--color-text-tertiary); }
    .recent__more {
      display: inline-block;
      margin-top: var(--space-3);
      font-size: var(--text-sm, 13px);
      color: var(--color-text-accent);
      text-decoration: none;
    }
    .recent__more:hover { text-decoration: underline; }

    .status-pill {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      background: var(--color-bg-recessed);
      color: var(--color-text-secondary);
      border: 0.5px solid var(--color-border-default);
    }
    .status-pill[data-status='complete'] { background: var(--color-success-bg); color: var(--color-success); border-color: transparent; }
    .status-pill[data-status='running'],
    .status-pill[data-status='queued'],
    .status-pill[data-status='waiting'],
    .status-pill[data-status='paused'],
    .status-pill[data-status='waitingForPause'] { background: var(--color-info-bg); color: var(--color-info); border-color: transparent; }
    .status-pill[data-status='errored'],
    .status-pill[data-status='terminated'] { background: var(--color-danger-bg); color: var(--color-danger); border-color: transparent; }
  `,
})
export class DashboardPage implements OnInit {
  private api = inject(ApiService);
  protected runs = inject(RunsService);

  protected readonly vendorCount = signal<number | null>(null);
  protected readonly toolCount = signal<number | null>(null);

  ngOnInit(): void {
    this.runs.start();
    this.api.getVendors({ limit: 1 }).subscribe({
      next: (resp) => this.vendorCount.set(resp.total),
      error: () => this.vendorCount.set(null),
    });
    this.api.getTools({ limit: 1 }).subscribe({
      next: (resp) => this.toolCount.set(resp.total),
      error: () => this.toolCount.set(null),
    });
  }

  protected workflowTitle(slug: string): string {
    return WORKFLOWS.find((w) => w.slug === slug)?.title ?? slug;
  }
}
