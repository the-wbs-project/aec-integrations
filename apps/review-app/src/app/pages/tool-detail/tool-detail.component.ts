import { Component, OnInit, inject, signal, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ApiService } from '../../services/api.service';
import { ToolDetail, IntegrationSummary } from '../../types';

@Component({
  selector: 'app-tool-detail',
  imports: [RouterLink],
  template: `
    @if (tool(); as tool) {
      <div class="page-container">
        <!-- Back link -->
        <a routerLink="/tools" class="back-link">
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <line x1="19" y1="12" x2="5" y2="12" /><polyline points="12 19 5 12 12 5" />
          </svg>
          Back to tools
        </a>

        <!-- Header -->
        <header class="detail-header">
          <h1 class="detail-title">{{ tool.name }}</h1>
          <div class="detail-meta">
            @for (v of tool.vendors; track v.id) {
              <a [routerLink]="['/vendors', v.id]" class="badge badge--accent">{{ v.name }}</a>
            }
            @if (tool.website) {
              <a [href]="tool.website" target="_blank" rel="noopener noreferrer" class="external-link">
                {{ tool.website }}
                <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                  <polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" />
                </svg>
              </a>
            }
          </div>
        </header>

        <!-- Description -->
        @if (tool.description) {
          <section class="detail-section">
            <h2 class="section-heading">Description</h2>
            <p class="description-text">{{ tool.description }}</p>
          </section>
        }

        <!-- Taxonomy -->
        @if (tool.categories.length || tool.disciplines.length || tool.phases.length) {
          <section class="detail-section">
            <h2 class="section-heading">Taxonomy</h2>
            <div class="taxonomy-grid">
              @if (tool.categories.length) {
                <div class="taxonomy-group">
                  <span class="taxonomy-label">Categories</span>
                  <div class="chip-list">
                    @for (c of tool.categories; track c.id) {
                      <span class="badge badge--neutral">{{ c.name }}</span>
                    }
                  </div>
                </div>
              }
              @if (tool.disciplines.length) {
                <div class="taxonomy-group">
                  <span class="taxonomy-label">Disciplines</span>
                  <div class="chip-list">
                    @for (d of tool.disciplines; track d.id) {
                      <span class="badge badge--neutral">{{ d.name }}</span>
                    }
                  </div>
                </div>
              }
              @if (tool.phases.length) {
                <div class="taxonomy-group">
                  <span class="taxonomy-label">Phases</span>
                  <div class="chip-list">
                    @for (p of tool.phases; track p.id) {
                      <span class="badge badge--neutral">{{ p.name }}</span>
                    }
                  </div>
                </div>
              }
            </div>
          </section>
        }

        <!-- Research -->
        @if (tool.researchStatus || tool.researchNotes) {
          <section class="detail-section">
            <h2 class="section-heading">Research</h2>
            @if (tool.researchStatus) {
              <span class="badge" [class]="statusBadgeClass(tool.researchStatus)">
                {{ tool.researchStatus }}
              </span>
            }
            @if (tool.researchNotes) {
              <details class="research-notes" [attr.open]="notesOpen() ? '' : null">
                <summary class="research-notes__toggle" (click)="toggleNotes($event)">
                  {{ notesOpen() ? 'Hide notes' : 'Show notes' }}
                </summary>
                <div class="research-notes__body">{{ tool.researchNotes }}</div>
              </details>
            }
          </section>
        }

        <!-- Integrations as source -->
        @if (tool.integrationsAsSource.length) {
          <section class="detail-section">
            <h2 class="section-heading">Integrations as source</h2>
            <div class="table-wrapper">
              <table class="table" aria-label="Integrations where this tool is the source">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Target tool</th>
                    <th>Type</th>
                    <th>Description</th>
                  </tr>
                </thead>
                <tbody>
                  @for (i of tool.integrationsAsSource; track i.id) {
                    <tr>
                      <td>{{ i.name }}</td>
                      <td>
                        @if (i.targetTool) {
                          <a [routerLink]="['/tools', i.targetTool.id]">{{ i.targetTool.name }}</a>
                        }
                      </td>
                      <td>
                        @if (i.integrationType) {
                          <span class="badge badge--neutral">{{ i.integrationType }}</span>
                        }
                      </td>
                      <td class="description-cell">{{ i.description }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </section>
        }

        <!-- Integrations as target -->
        @if (tool.integrationsAsTarget.length) {
          <section class="detail-section">
            <h2 class="section-heading">Integrations as target</h2>
            <div class="table-wrapper">
              <table class="table" aria-label="Integrations where this tool is the target">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Source tool</th>
                    <th>Type</th>
                    <th>Description</th>
                  </tr>
                </thead>
                <tbody>
                  @for (i of tool.integrationsAsTarget; track i.id) {
                    <tr>
                      <td>{{ i.name }}</td>
                      <td>
                        @if (i.sourceTool) {
                          <a [routerLink]="['/tools', i.sourceTool.id]">{{ i.sourceTool.name }}</a>
                        }
                      </td>
                      <td>
                        @if (i.integrationType) {
                          <span class="badge badge--neutral">{{ i.integrationType }}</span>
                        }
                      </td>
                      <td class="description-cell">{{ i.description }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </section>
        }
      </div>
    } @else {
      <div class="page-container">
        <p class="loading-text">Loading tool details...</p>
      </div>
    }
  `,
  styles: `
    .back-link {
      display: inline-flex;
      align-items: center;
      gap: var(--space-1);
      font-size: var(--text-sm);
      color: var(--color-text-secondary);
      margin-bottom: var(--space-5);
    }

    .back-link:hover {
      color: var(--color-text-accent);
      text-decoration: none;
    }

    .detail-header {
      margin-bottom: var(--space-6);
    }

    .detail-title {
      font-size: var(--text-2xl);
      font-weight: 500;
      color: var(--color-text-primary);
      line-height: var(--leading-tight);
      margin-bottom: var(--space-3);
    }

    .detail-meta {
      display: flex;
      align-items: center;
      gap: var(--space-3);
      flex-wrap: wrap;
    }

    .external-link {
      display: inline-flex;
      align-items: center;
      gap: var(--space-1);
      font-size: var(--text-sm);
      color: var(--color-text-accent);
    }

    .detail-section {
      margin-bottom: var(--space-6);
    }

    .section-heading {
      font-size: var(--text-md);
      font-weight: 500;
      color: var(--color-text-primary);
      margin-bottom: var(--space-3);
    }

    .description-text {
      white-space: pre-line;
      color: var(--color-text-body);
      line-height: var(--leading-normal);
    }

    .taxonomy-grid {
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
    }

    .taxonomy-group {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
    }

    .taxonomy-label {
      font-size: var(--text-xs);
      font-weight: 500;
      color: var(--color-text-secondary);
    }

    .chip-list {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-1);
    }

    .research-notes {
      margin-top: var(--space-3);
    }

    .research-notes__toggle {
      font-size: var(--text-sm);
      color: var(--color-text-accent);
      cursor: pointer;
      list-style: none;
    }

    .research-notes__toggle::-webkit-details-marker {
      display: none;
    }

    .research-notes__toggle:hover {
      text-decoration: underline;
    }

    .research-notes__body {
      margin-top: var(--space-3);
      padding: var(--space-4);
      background: var(--color-bg-recessed);
      border-radius: var(--radius-md);
      font-size: var(--text-sm);
      white-space: pre-line;
      color: var(--color-text-body);
      line-height: var(--leading-normal);
    }

    .table-wrapper {
      overflow-x: auto;
      border: 0.5px solid var(--color-border-default);
      border-radius: var(--radius-lg);
      background: var(--color-bg-elevated);
    }

    .description-cell {
      max-width: 320px;
      font-size: var(--text-xs);
      color: var(--color-text-secondary);
    }

    .loading-text {
      color: var(--color-text-secondary);
      padding: var(--space-10) 0;
      text-align: center;
    }
  `,
})
export class ToolDetailComponent implements OnInit {
  id = input.required<string>();

  private api = inject(ApiService);
  tool = signal<ToolDetail | null>(null);
  notesOpen = signal(false);

  ngOnInit(): void {
    this.api.getTool(this.id()).subscribe((tool) => {
      this.tool.set(tool);
    });
  }

  toggleNotes(event: Event): void {
    event.preventDefault();
    this.notesOpen.set(!this.notesOpen());
  }

  statusBadgeClass(status: string): string {
    const lower = status.toLowerCase();
    if (lower.includes('complete') || lower.includes('done'))
      return 'badge--success';
    if (lower.includes('progress') || lower.includes('review'))
      return 'badge--warning';
    if (lower.includes('not started') || lower.includes('todo'))
      return 'badge--neutral';
    return 'badge--info';
  }
}
