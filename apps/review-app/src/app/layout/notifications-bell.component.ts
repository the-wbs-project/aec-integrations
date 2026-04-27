// ---------------------------------------------------------------------------
// Notification bell — anchored top-right of the shell header.
//
// Shows the in-flight count as a Syncfusion Badge over a bell icon. Clicking
// the bell opens a dropdown panel of the latest 25 runs (RunsService.runs).
// Clicking a row opens a Syncfusion Dialog with the full status / error /
// output for that run.
// ---------------------------------------------------------------------------
import { Component, computed, inject, signal } from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { ButtonModule } from '@syncfusion/ej2-angular-buttons';
import { DialogModule } from '@syncfusion/ej2-angular-popups';
import { RunsService, type RecentRunRow } from '../services/runs.service';
import { WORKFLOWS } from '../workflows';

@Component({
  selector: 'app-notifications-bell',
  imports: [CommonModule, RouterLink, ButtonModule, DialogModule, DatePipe],
  template: `
    <div class="bell">
      <button
        type="button"
        class="bell__trigger"
        [attr.aria-expanded]="open()"
        [attr.aria-label]="bellLabel()"
        [title]="bellLabel()"
        (click)="toggle()"
      >
        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        @if (inFlight() > 0) {
          <span class="bell__badge">{{ inFlight() }}</span>
        }
      </button>

      @if (open()) {
        <div class="bell__panel" role="dialog" aria-label="Recent workflow runs">
          <div class="bell__panel-header">
            <span class="bell__panel-title">Recent runs</span>
            <a routerLink="/runs" class="bell__panel-link" (click)="close()">View all</a>
          </div>

          @if (runs().length === 0) {
            <div class="bell__empty">No runs yet. Kick off a workflow from a vendor or tool to see it here.</div>
          } @else {
            <ul class="bell__list">
              @for (run of runs().slice(0, 10); track run.runId) {
                <li class="bell__row" (click)="select(run)" tabindex="0" role="button">
                  <div class="bell__row-main">
                    <div class="bell__row-title">{{ workflowTitle(run.workflow) }}</div>
                    <div class="bell__row-sub">{{ run.recordLabel || run.recordId }}</div>
                  </div>
                  <div class="bell__row-meta">
                    <span class="status-pill" [attr.data-status]="run.status">{{ run.status }}</span>
                    <span class="bell__row-time">{{ run.startedAt | date:'short' }}</span>
                  </div>
                </li>
              }
            </ul>
          }
        </div>
      }

      <ejs-dialog
        #dialog
        [visible]="!!selected()"
        [isModal]="true"
        [closeOnEscape]="true"
        header="Run details"
        width="640px"
        (close)="selected.set(null)"
      >
        @if (selected(); as s) {
          <div class="run-detail">
            <dl class="run-detail__grid">
              <dt>Workflow</dt><dd>{{ workflowTitle(s.workflow) }}</dd>
              <dt>Record</dt><dd>{{ s.recordLabel || s.recordId }} <code>({{ s.recordId }})</code></dd>
              <dt>Started</dt><dd>{{ s.startedAt | date:'medium' }}</dd>
              <dt>Status</dt><dd><span class="status-pill" [attr.data-status]="s.status">{{ s.status }}</span></dd>
              <dt>Run ID</dt><dd><code>{{ s.runId }}</code></dd>
            </dl>

            @if (s.error) {
              <h4 class="run-detail__h4">Error</h4>
              <pre class="run-detail__pre">{{ s.error | json }}</pre>
            }
            @if (s.output) {
              <h4 class="run-detail__h4">Output</h4>
              <pre class="run-detail__pre">{{ s.output | json }}</pre>
            }
          </div>
        }
      </ejs-dialog>
    </div>
  `,
  styles: `
    .bell { position: relative; }

    .bell__trigger {
      position: relative;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 32px;
      height: 32px;
      border-radius: var(--radius-md, 6px);
      background: transparent;
      border: 0.5px solid transparent;
      color: var(--color-text-secondary);
    }
    .bell__trigger:hover {
      background: var(--color-bg-recessed);
      border-color: var(--color-border-default);
      color: var(--color-text-primary);
    }
    .bell__trigger .icon { width: 18px; height: 18px; }

    .bell__badge {
      position: absolute;
      top: -2px;
      right: -2px;
      min-width: 16px;
      height: 16px;
      padding: 0 4px;
      border-radius: 8px;
      background: var(--color-accent);
      color: var(--color-text-inverse);
      font-size: 10px;
      font-weight: 600;
      line-height: 16px;
      text-align: center;
    }

    .bell__panel {
      position: absolute;
      top: calc(100% + 8px);
      right: 0;
      width: 360px;
      max-height: 480px;
      overflow: auto;
      background: var(--color-bg-elevated);
      border: 0.5px solid var(--color-border-default);
      border-radius: var(--radius-lg, 8px);
      box-shadow: var(--shadow-lg, 0 8px 24px rgba(0,0,0,0.12));
      z-index: 200;
    }

    .bell__panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 12px;
      border-bottom: 0.5px solid var(--color-border-default);
      background: var(--color-bg-recessed);
    }

    .bell__panel-title {
      font-size: var(--text-xs, 12px);
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--color-text-secondary);
    }

    .bell__panel-link {
      font-size: var(--text-xs, 12px);
      color: var(--color-text-accent);
      text-decoration: none;
    }
    .bell__panel-link:hover { text-decoration: underline; }

    .bell__empty {
      padding: 16px;
      font-size: var(--text-sm, 13px);
      color: var(--color-text-secondary);
    }

    .bell__list {
      list-style: none;
      margin: 0;
      padding: 0;
    }

    .bell__row {
      display: flex;
      gap: 8px;
      padding: 10px 12px;
      border-bottom: 0.5px solid var(--color-border-default);
      cursor: pointer;
    }
    .bell__row:hover { background: var(--color-bg-recessed); }
    .bell__row:last-child { border-bottom: 0; }

    .bell__row-main { flex: 1; min-width: 0; }
    .bell__row-title {
      font-size: var(--text-sm, 13px);
      font-weight: 600;
      color: var(--color-text-primary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .bell__row-sub {
      font-size: var(--text-xs, 12px);
      color: var(--color-text-secondary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .bell__row-meta {
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 4px;
    }
    .bell__row-time {
      font-size: 10px;
      color: var(--color-text-tertiary);
    }

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

    .run-detail__grid {
      display: grid;
      grid-template-columns: 100px 1fr;
      gap: 6px 12px;
      margin: 0 0 16px;
    }
    .run-detail__grid dt { color: var(--color-text-secondary); font-size: var(--text-xs, 12px); }
    .run-detail__grid dd { margin: 0; font-size: var(--text-sm, 13px); }
    .run-detail__h4 { margin: 12px 0 6px; font-size: var(--text-sm, 13px); }
    .run-detail__pre {
      background: var(--color-bg-recessed);
      border: 0.5px solid var(--color-border-default);
      border-radius: 6px;
      padding: 10px;
      font-size: 12px;
      overflow: auto;
      max-height: 220px;
    }
  `,
})
export class NotificationsBellComponent {
  private readonly runsService = inject(RunsService);

  protected readonly runs = this.runsService.runs;
  protected readonly inFlight = this.runsService.inFlightCount;
  protected readonly open = signal(false);
  protected readonly selected = signal<RecentRunRow | null>(null);

  protected readonly bellLabel = computed(() => {
    const n = this.inFlight();
    if (n === 0) return 'Recent runs (none in flight)';
    return `Recent runs (${n} in flight)`;
  });

  constructor() {
    this.runsService.start();
  }

  toggle(): void {
    this.open.update((v) => !v);
    if (this.open()) this.runsService.refresh();
  }

  close(): void {
    this.open.set(false);
  }

  select(run: RecentRunRow): void {
    this.selected.set(run);
    this.open.set(false);
  }

  workflowTitle(slug: string): string {
    return WORKFLOWS.find((w) => w.slug === slug)?.title ?? slug;
  }
}
