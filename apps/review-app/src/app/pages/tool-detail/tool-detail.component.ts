import { Component, OnInit, inject, signal, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../services/api.service';
import { TagInputComponent } from '../../components/tag-input/tag-input.component';
import { formatDate, formatDateWithRelative } from '../../utils/date';
import {
  LinkRef,
  MetaResponse,
  ToolDetail,
  UpdateToolRequest,
} from '../../types';

type SectionKey =
  | 'header'
  | 'description'
  | 'taxonomy'
  | 'research'
  | 'integrationLinks'
  | 'researchNotes'
  | 'integrationCheckNotes';

interface DraftState {
  // header
  name: string;
  website: string;
  vendorIds: string[];
  // description
  description: string;
  // taxonomy
  categoryIds: string[];
  disciplineIds: string[];
  phaseIds: string[];
  // research
  researchStatus: string;
  // integration links
  toolIntegrationsUrl: string;
  apiDocsUrl: string;
  hasApiDocs: boolean;
  // notes
  researchNotes: string;
  toolIntegrationCheckNotes: string;
}

@Component({
  selector: 'app-tool-detail',
  imports: [RouterLink, DecimalPipe, FormsModule, TagInputComponent],
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
          @if (editingSection() === 'header') {
            <div class="edit-stack">
              <input class="input edit-title" [(ngModel)]="draft.name" name="name" placeholder="Name" />
              <input class="input" [(ngModel)]="draft.website" name="website" placeholder="https://example.com" />
              <label class="field-label">Vendors</label>
              <app-tag-input
                [options]="meta()?.vendors ?? []"
                [selectedIds]="draft.vendorIds"
                placeholder="Search vendors…"
                (selectedIdsChange)="draft.vendorIds = $event"
              />

              <div class="edit-actions">
                <button class="btn btn--primary btn--sm" (click)="saveSection('header')" [disabled]="saving()">Save</button>
                <button class="btn btn--ghost btn--sm" (click)="cancelEdit()" [disabled]="saving()">Cancel</button>
              </div>
            </div>
          } @else {
            <div class="header-row">
              <h1 class="detail-title">{{ tool.name }}</h1>
              <button class="btn btn--ghost btn--sm" (click)="startEdit('header', tool)">Edit</button>
            </div>
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
          }
        </header>

        <!-- Tabs -->
        <nav class="nav tab-strip">
          <button
            type="button"
            class="nav__item"
            [class.nav__item--active]="activeTab() === 'details'"
            (click)="activeTab.set('details')"
          >Details</button>
          <button
            type="button"
            class="nav__item"
            [class.nav__item--active]="activeTab() === 'notes'"
            (click)="activeTab.set('notes')"
          >Notes</button>
        </nav>

        @if (activeTab() === 'details') {
          <!-- Description -->
          <section class="detail-section">
            <div class="section-row">
              <h2 class="section-heading">Description</h2>
              @if (editingSection() !== 'description') {
                <button class="btn btn--ghost btn--sm" (click)="startEdit('description', tool)">Edit</button>
              }
            </div>
            @if (editingSection() === 'description') {
              <textarea class="input edit-textarea" rows="6" [(ngModel)]="draft.description" name="description"></textarea>
              <div class="edit-actions">
                <button class="btn btn--primary btn--sm" (click)="saveSection('description')" [disabled]="saving()">Save</button>
                <button class="btn btn--ghost btn--sm" (click)="cancelEdit()" [disabled]="saving()">Cancel</button>
              </div>
            } @else {
              @if (tool.description) {
                <p class="description-text">{{ tool.description }}</p>
              } @else {
                <p class="muted">No description.</p>
              }
            }
          </section>

          <!-- Taxonomy -->
          <section class="detail-section">
            <div class="section-row">
              <h2 class="section-heading">Taxonomy</h2>
              @if (editingSection() !== 'taxonomy') {
                <button class="btn btn--ghost btn--sm" (click)="startEdit('taxonomy', tool)">Edit</button>
              }
            </div>
            @if (editingSection() === 'taxonomy') {
              <div class="taxonomy-grid">
                <div class="taxonomy-group">
                  <label class="field-label">Categories</label>
                  <app-tag-input
                    [options]="meta()?.categories ?? []"
                    [selectedIds]="draft.categoryIds"
                    placeholder="Search categories…"
                    (selectedIdsChange)="draft.categoryIds = $event"
                  />
                </div>
                <div class="taxonomy-group">
                  <label class="field-label">Disciplines</label>
                  <app-tag-input
                    [options]="meta()?.disciplines ?? []"
                    [selectedIds]="draft.disciplineIds"
                    placeholder="Search disciplines…"
                    (selectedIdsChange)="draft.disciplineIds = $event"
                  />
                </div>
                <div class="taxonomy-group">
                  <label class="field-label">Phases</label>
                  <app-tag-input
                    [options]="meta()?.phases ?? []"
                    [selectedIds]="draft.phaseIds"
                    placeholder="Search phases…"
                    (selectedIdsChange)="draft.phaseIds = $event"
                  />
                </div>
              </div>
              <div class="edit-actions">
                <button class="btn btn--primary btn--sm" (click)="saveSection('taxonomy')" [disabled]="saving()">Save</button>
                <button class="btn btn--ghost btn--sm" (click)="cancelEdit()" [disabled]="saving()">Cancel</button>
              </div>
            } @else {
              @if (tool.categories.length || tool.disciplines.length || tool.phases.length) {
                <div class="taxonomy-grid">
                  <div class="taxonomy-group">
                    <span class="taxonomy-label">Categories</span>
                    <div class="chip-list">
                      @for (c of visibleRefs(tool.categories); track c.id) {
                        <span class="badge badge--neutral">{{ c.name }}</span>
                      }
                      @if (overflowRefs(tool.categories); as extra) {
                        <span class="badge badge--neutral pill-overflow" tabindex="0">
                          +{{ extra.length }}
                          <span class="pill-overflow__menu">
                            @for (c of extra; track c.id) {
                              <span class="pill-overflow__item">{{ c.name }}</span>
                            }
                          </span>
                        </span>
                      }
                    </div>
                  </div>
                  <div class="taxonomy-group">
                    <span class="taxonomy-label">Disciplines</span>
                    <div class="chip-list">
                      @for (d of visibleRefs(tool.disciplines); track d.id) {
                        <span class="badge badge--neutral">{{ d.name }}</span>
                      }
                      @if (overflowRefs(tool.disciplines); as extra) {
                        <span class="badge badge--neutral pill-overflow" tabindex="0">
                          +{{ extra.length }}
                          <span class="pill-overflow__menu">
                            @for (d of extra; track d.id) {
                              <span class="pill-overflow__item">{{ d.name }}</span>
                            }
                          </span>
                        </span>
                      }
                    </div>
                  </div>
                  <div class="taxonomy-group">
                    <span class="taxonomy-label">Phases</span>
                    <div class="chip-list">
                      @for (p of visibleRefs(tool.phases); track p.id) {
                        <span class="badge badge--neutral">{{ p.name }}</span>
                      }
                      @if (overflowRefs(tool.phases); as extra) {
                        <span class="badge badge--neutral pill-overflow" tabindex="0">
                          +{{ extra.length }}
                          <span class="pill-overflow__menu">
                            @for (p of extra; track p.id) {
                              <span class="pill-overflow__item">{{ p.name }}</span>
                            }
                          </span>
                        </span>
                      }
                    </div>
                  </div>
                </div>
              } @else {
                <p class="muted">No taxonomy assigned.</p>
              }
            }
          </section>

          <!-- Research status -->
          <section class="detail-section">
            <div class="section-row">
              <h2 class="section-heading">Research status</h2>
              @if (editingSection() !== 'research') {
                <button class="btn btn--ghost btn--sm" (click)="startEdit('research', tool)">Edit</button>
              }
            </div>
            @if (editingSection() === 'research') {
              <select class="input" [(ngModel)]="draft.researchStatus" name="researchStatus">
                <option value="">—</option>
                @for (s of meta()?.researchStatuses ?? []; track s) {
                  <option [value]="s">{{ s }}</option>
                }
              </select>
              <div class="edit-actions">
                <button class="btn btn--primary btn--sm" (click)="saveSection('research')" [disabled]="saving()">Save</button>
                <button class="btn btn--ghost btn--sm" (click)="cancelEdit()" [disabled]="saving()">Cancel</button>
              </div>
            } @else {
              @if (tool.researchStatus) {
                <span class="badge" [class]="statusBadgeClass(tool.researchStatus)">
                  {{ tool.researchStatus }}
                </span>
              } @else {
                <span class="muted">Not set.</span>
              }
            }
          </section>

          <!-- Integration links -->
          <section class="detail-section">
            <div class="section-row">
              <h2 class="section-heading">Integration links</h2>
              @if (editingSection() !== 'integrationLinks') {
                <button class="btn btn--ghost btn--sm" (click)="startEdit('integrationLinks', tool)">Edit</button>
              }
            </div>
            @if (editingSection() === 'integrationLinks') {
              <div class="edit-stack">
                <label class="field-label" for="int-url">Tool integrations page URL</label>
                <input id="int-url" class="input" [(ngModel)]="draft.toolIntegrationsUrl" name="toolIntegrationsUrl" placeholder="https://..." />
                <label class="field-label" for="api-url">API docs URL</label>
                <input id="api-url" class="input" [(ngModel)]="draft.apiDocsUrl" name="apiDocsUrl" placeholder="https://..." />
                <label class="checkbox-row">
                  <input type="checkbox" [(ngModel)]="draft.hasApiDocs" name="hasApiDocs" />
                  Has API docs
                </label>
              </div>
              <div class="edit-actions">
                <button class="btn btn--primary btn--sm" (click)="saveSection('integrationLinks')" [disabled]="saving()">Save</button>
                <button class="btn btn--ghost btn--sm" (click)="cancelEdit()" [disabled]="saving()">Cancel</button>
              </div>
            } @else {
              <dl class="metric-grid">
                <div class="metric">
                  <dt class="metric__label">Integrations page</dt>
                  <dd class="metric__value">
                    @if (tool.toolIntegrationsUrl) {
                      <a [href]="tool.toolIntegrationsUrl" target="_blank" rel="noopener noreferrer">{{ tool.toolIntegrationsUrl }}</a>
                    } @else {
                      <span class="muted">—</span>
                    }
                  </dd>
                </div>
                <div class="metric">
                  <dt class="metric__label">API docs</dt>
                  <dd class="metric__value">
                    @if (tool.apiDocsUrl) {
                      <a [href]="tool.apiDocsUrl" target="_blank" rel="noopener noreferrer">{{ tool.apiDocsUrl }}</a>
                    } @else if (tool.hasApiDocs) {
                      <span>Yes (no URL)</span>
                    } @else {
                      <span class="muted">—</span>
                    }
                  </dd>
                </div>
              </dl>
            }
          </section>

          <!-- Scoring -->
          @if (hasScoring(tool)) {
            <section class="detail-section">
              <h2 class="section-heading">Scoring</h2>
              <dl class="metric-grid">
                @if (tool.priorityTier) {
                  <div class="metric">
                    <dt class="metric__label">Priority tier</dt>
                    <dd class="metric__value">
                      <span class="badge" [class]="tierBadgeClass(tool.priorityTier)">Tier {{ tool.priorityTier }}</span>
                    </dd>
                  </div>
                }
                @if (tool.priorityScore !== undefined) {
                  <div class="metric">
                    <dt class="metric__label">Priority score</dt>
                    <dd class="metric__value metric__value--emphasis">{{ tool.priorityScore | number:'1.0-1' }}</dd>
                  </div>
                }
                @if (tool.integrationScore !== undefined) {
                  <div class="metric">
                    <dt class="metric__label">Integration</dt>
                    <dd class="metric__value">{{ tool.integrationScore | number:'1.0-1' }}</dd>
                  </div>
                }
                @if (tool.demandScore !== undefined) {
                  <div class="metric">
                    <dt class="metric__label">Demand</dt>
                    <dd class="metric__value">{{ tool.demandScore | number:'1.0-1' }}</dd>
                  </div>
                }
                @if (tool.outreachScore !== undefined) {
                  <div class="metric">
                    <dt class="metric__label">Outreach</dt>
                    <dd class="metric__value">{{ tool.outreachScore | number:'1.0-1' }}</dd>
                  </div>
                }
                @if (tool.toolDataCompleteness !== undefined) {
                  <div class="metric">
                    <dt class="metric__label">Data completeness</dt>
                    <dd class="metric__value">{{ formatPercent(tool.toolDataCompleteness) }}</dd>
                  </div>
                }
                @if (tool.emergingFlag) {
                  <div class="metric">
                    <dt class="metric__label">Emerging</dt>
                    <dd class="metric__value">
                      <span class="badge badge--info">Emerging</span>
                    </dd>
                  </div>
                }
                @if (tool.toolEnrichmentStatus) {
                  <div class="metric">
                    <dt class="metric__label">Enrichment</dt>
                    <dd class="metric__value">
                      <span class="badge badge--neutral">{{ tool.toolEnrichmentStatus }}</span>
                    </dd>
                  </div>
                }
              </dl>
            </section>
          }

          <!-- Integration signals -->
          @if (hasIntegrationSignals(tool)) {
            <section class="detail-section">
              <h2 class="section-heading">Integration signals</h2>
              <dl class="metric-grid">
                @if (tool.marketplaceCount !== undefined) {
                  <div class="metric">
                    <dt class="metric__label">Marketplaces</dt>
                    <dd class="metric__value">
                      <span>{{ tool.marketplaceCount | number:'1.0-0' }}</span>
                      @if (tool.sourceMarketplaces?.length) {
                        <div class="chip-list chip-list--inline">
                          @for (m of tool.sourceMarketplaces; track m) {
                            <span class="badge badge--neutral">{{ m }}</span>
                          }
                        </div>
                      }
                    </dd>
                  </div>
                }
                @if (tool.ipaasCount !== undefined) {
                  <div class="metric">
                    <dt class="metric__label">iPaaS</dt>
                    <dd class="metric__value">
                      <span>{{ tool.ipaasCount | number:'1.0-0' }}</span>
                      @if (tool.ipaasPlatforms?.length) {
                        <div class="chip-list chip-list--inline">
                          @for (p of tool.ipaasPlatforms; track p) {
                            <span class="badge badge--neutral">{{ p }}</span>
                          }
                        </div>
                      }
                    </dd>
                  </div>
                }
                @if (tool.zapierTriggerCount !== undefined) {
                  <div class="metric">
                    <dt class="metric__label">Zapier triggers/actions</dt>
                    <dd class="metric__value">{{ tool.zapierTriggerCount | number:'1.0-0' }}</dd>
                  </div>
                }
                @if (tool.integrationCount) {
                  <div class="metric">
                    <dt class="metric__label">Integration records</dt>
                    <dd class="metric__value">{{ tool.integrationCount | number:'1.0-0' }}</dd>
                  </div>
                }
              </dl>
            </section>
          }

          <!-- Market signals -->
          @if (hasMarketSignals(tool)) {
            <section class="detail-section">
              <h2 class="section-heading">Market signals</h2>
              <dl class="metric-grid">
                @if (tool.g2Rating !== undefined || tool.g2ReviewCount !== undefined) {
                  <div class="metric">
                    <dt class="metric__label">G2</dt>
                    <dd class="metric__value">
                      @if (tool.g2Rating !== undefined) {
                        <strong>{{ tool.g2Rating | number:'1.1-1' }}</strong><span class="muted"> / 5</span>
                      }
                      @if (tool.g2ReviewCount !== undefined) {
                        <span class="muted"> · {{ tool.g2ReviewCount | number:'1.0-0' }} reviews</span>
                      }
                      @if (tool.g2Url) {
                        <a [href]="tool.g2Url" target="_blank" rel="noopener noreferrer" class="muted"> · View</a>
                      }
                    </dd>
                  </div>
                }
                @if (tool.capterraRating !== undefined || tool.capterraReviewCount !== undefined) {
                  <div class="metric">
                    <dt class="metric__label">Capterra</dt>
                    <dd class="metric__value">
                      @if (tool.capterraRating !== undefined) {
                        <strong>{{ tool.capterraRating | number:'1.1-1' }}</strong><span class="muted"> / 5</span>
                      }
                      @if (tool.capterraReviewCount !== undefined) {
                        <span class="muted"> · {{ tool.capterraReviewCount | number:'1.0-0' }} reviews</span>
                      }
                      @if (tool.capterraUrl) {
                        <a [href]="tool.capterraUrl" target="_blank" rel="noopener noreferrer" class="muted"> · View</a>
                      }
                    </dd>
                  </div>
                }
                @if (tool.searchVolumeMonthly !== undefined) {
                  <div class="metric">
                    <dt class="metric__label">Monthly search</dt>
                    <dd class="metric__value">{{ tool.searchVolumeMonthly | number:'1.0-0' }}</dd>
                  </div>
                }
                @if (tool.googleTrendsIndex !== undefined) {
                  <div class="metric">
                    <dt class="metric__label">Google Trends</dt>
                    <dd class="metric__value">{{ tool.googleTrendsIndex | number:'1.0-0' }}</dd>
                  </div>
                }
                @if (tool.redditMentions24mo !== undefined) {
                  <div class="metric">
                    <dt class="metric__label">Reddit mentions (24mo)</dt>
                    <dd class="metric__value">{{ tool.redditMentions24mo | number:'1.0-0' }}</dd>
                  </div>
                }
              </dl>
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

          <!-- Data freshness -->
          @if (tool.lastScoredAt || tool.lastToolEnrichedAt || tool.toolIntegrationCheckedAt) {
            <section class="detail-section freshness">
              @if (tool.lastScoredAt) {
                <span class="freshness__item">Scored {{ formatDateWithRelative(tool.lastScoredAt) }}</span>
              }
              @if (tool.lastToolEnrichedAt) {
                <span class="freshness__item">Enriched {{ formatDateWithRelative(tool.lastToolEnrichedAt) }}</span>
              }
              @if (tool.toolIntegrationCheckedAt) {
                <span class="freshness__item">Integrations checked {{ formatDateWithRelative(tool.toolIntegrationCheckedAt) }}</span>
              }
            </section>
          }
        }

        @if (activeTab() === 'notes') {
          <section class="detail-section">
            <div class="section-row">
              <h2 class="section-heading">Research notes</h2>
              @if (editingSection() !== 'researchNotes') {
                <button class="btn btn--ghost btn--sm" (click)="startEdit('researchNotes', tool)">Edit</button>
              }
            </div>
            @if (editingSection() === 'researchNotes') {
              <textarea class="input edit-textarea" rows="10" [(ngModel)]="draft.researchNotes" name="researchNotes"></textarea>
              <div class="edit-actions">
                <button class="btn btn--primary btn--sm" (click)="saveSection('researchNotes')" [disabled]="saving()">Save</button>
                <button class="btn btn--ghost btn--sm" (click)="cancelEdit()" [disabled]="saving()">Cancel</button>
              </div>
            } @else {
              @if (tool.researchNotes) {
                <div class="notes-body">{{ tool.researchNotes }}</div>
              } @else {
                <p class="muted">No research notes.</p>
              }
            }
          </section>

          <section class="detail-section">
            <div class="section-row">
              <h2 class="section-heading">Integration check notes</h2>
              @if (editingSection() !== 'integrationCheckNotes') {
                <button class="btn btn--ghost btn--sm" (click)="startEdit('integrationCheckNotes', tool)">Edit</button>
              }
            </div>
            @if (editingSection() === 'integrationCheckNotes') {
              <textarea class="input edit-textarea" rows="10" [(ngModel)]="draft.toolIntegrationCheckNotes" name="toolIntegrationCheckNotes"></textarea>
              <div class="edit-actions">
                <button class="btn btn--primary btn--sm" (click)="saveSection('integrationCheckNotes')" [disabled]="saving()">Save</button>
                <button class="btn btn--ghost btn--sm" (click)="cancelEdit()" [disabled]="saving()">Cancel</button>
              </div>
            } @else {
              @if (tool.toolIntegrationCheckNotes) {
                <div class="notes-body">{{ tool.toolIntegrationCheckNotes }}</div>
              } @else {
                <p class="muted">No integration-check notes.</p>
              }
            }
          </section>
        }

        @if (saveError()) {
          <p class="save-error" role="alert">{{ saveError() }}</p>
        }
      </div>
    } @else {
      <div class="page-container detail-skeleton">
        <span class="skeleton skeleton--text" style="width: 80px; height: 14px;"></span>
        <span class="skeleton skeleton--text" style="width: 280px; height: 28px; margin-top: 24px;"></span>
        <span class="skeleton skeleton--text" style="width: 100%; height: 14px; margin-top: 16px;"></span>
        <span class="skeleton skeleton--text" style="width: 80%; height: 14px; margin-top: 8px;"></span>
        <span class="skeleton skeleton--text" style="width: 60%; height: 14px; margin-top: 8px;"></span>
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
      margin-bottom: var(--space-5);
    }

    .header-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-3);
      margin-bottom: var(--space-3);
    }

    .detail-title {
      font-size: var(--text-2xl);
      font-weight: 500;
      color: var(--color-text-primary);
      line-height: var(--leading-tight);
      margin: 0;
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

    .tab-strip {
      margin-bottom: var(--space-5);
      border-bottom: 0.5px solid var(--color-border-default);
      padding-bottom: var(--space-1);
    }

    .nav__item {
      cursor: pointer;
      background: none;
      border: 0;
      font: inherit;
    }

    .detail-section {
      margin-bottom: var(--space-6);
    }

    .section-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-3);
      margin-bottom: var(--space-3);
    }

    .section-heading {
      font-size: var(--text-md);
      font-weight: 500;
      color: var(--color-text-primary);
      margin: 0;
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

    .field-label {
      font-size: var(--text-xs);
      font-weight: 500;
      color: var(--color-text-secondary);
    }

    .chip-list {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-1);
    }

    .pill-overflow {
      position: relative;
      cursor: default;
    }

    .pill-overflow__menu {
      display: none;
      position: absolute;
      top: calc(100% + var(--space-1));
      left: 0;
      z-index: 10;
      min-width: 160px;
      max-width: 280px;
      padding: var(--space-2);
      background: var(--color-bg-elevated);
      border: 0.5px solid var(--color-border-default);
      border-radius: var(--radius-md);
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.08);
    }

    .pill-overflow:hover .pill-overflow__menu,
    .pill-overflow:focus-within .pill-overflow__menu {
      display: flex;
      flex-direction: column;
      gap: var(--space-1);
    }

    .pill-overflow__item {
      font-size: var(--text-xs);
      color: var(--color-text-body);
      white-space: normal;
      line-height: 1.4;
    }

    .notes-body {
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

    .metric-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
      gap: var(--space-3) var(--space-4);
      margin: 0;
    }

    .metric {
      display: flex;
      flex-direction: column;
      gap: var(--space-1);
    }

    .metric__label {
      font-size: var(--text-xs);
      color: var(--color-text-secondary);
    }

    .metric__value {
      margin: 0;
      font-size: var(--text-sm);
      color: var(--color-text-primary);
    }

    .metric__value--emphasis {
      font-size: var(--text-lg);
      font-weight: 500;
    }

    .chip-list--inline {
      margin-top: var(--space-1);
    }

    .muted {
      color: var(--color-text-secondary);
    }

    .freshness {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-3);
      font-size: var(--text-xs);
      color: var(--color-text-secondary);
    }

    .freshness__item::after {
      content: '·';
      margin-left: var(--space-3);
      color: var(--color-text-tertiary);
    }

    .freshness__item:last-child::after {
      content: '';
      margin-left: 0;
    }

    .loading-text {
      color: var(--color-text-secondary);
      padding: var(--space-10) 0;
      text-align: center;
    }

    .edit-stack {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
    }

    .edit-title {
      font-size: var(--text-lg);
      font-weight: 500;
    }

    .edit-textarea {
      height: auto;
      line-height: var(--leading-normal);
      padding: var(--space-2) var(--space-3);
    }

    .edit-actions {
      display: flex;
      gap: var(--space-2);
      margin-top: var(--space-3);
    }

    .checkbox-row {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      font-size: var(--text-sm);
      color: var(--color-text-body);
    }

    .save-error {
      margin-top: var(--space-3);
      padding: var(--space-3);
      background: var(--color-danger-bg);
      color: var(--color-danger);
      border-radius: var(--radius-md);
      font-size: var(--text-sm);
    }

    .detail-skeleton {
      display: flex;
      flex-direction: column;
      gap: 0;
    }

    .metric__value {
      font-variant-numeric: tabular-nums;
    }
  `,
})
export class ToolDetailComponent implements OnInit {
  id = input.required<string>();

  private api = inject(ApiService);
  tool = signal<ToolDetail | null>(null);
  meta = signal<MetaResponse | null>(null);

  activeTab = signal<'details' | 'notes'>('details');
  editingSection = signal<SectionKey | null>(null);
  saving = signal(false);
  saveError = signal<string | null>(null);

  // Mutable draft used by [(ngModel)] — replaced via Object.assign on each edit start.
  draft: DraftState = this.emptyDraft();

  ngOnInit(): void {
    this.api.getTool(this.id()).subscribe((tool) => {
      this.tool.set(tool);
    });
    this.api.getMeta().subscribe((meta) => {
      this.meta.set(meta);
    });
  }

  // ------------------------------------------------------------------- edit
  startEdit(section: SectionKey, tool: ToolDetail): void {
    this.saveError.set(null);
    Object.assign(this.draft, this.toDraft(tool));
    this.editingSection.set(section);
  }

  cancelEdit(): void {
    this.editingSection.set(null);
    this.saveError.set(null);
  }

  saveSection(section: SectionKey): void {
    const id = this.id();
    const patch = this.buildPatch(section);
    if (Object.keys(patch).length === 0) {
      this.editingSection.set(null);
      return;
    }
    this.saving.set(true);
    this.saveError.set(null);
    this.api.updateTool(id, patch).subscribe({
      next: (updated) => {
        this.tool.set(updated);
        this.saving.set(false);
        this.editingSection.set(null);
      },
      error: (err) => {
        this.saving.set(false);
        this.saveError.set(err?.error?.error ?? err?.message ?? 'Save failed');
      },
    });
  }

  // ---- helpers ------------------------------------------------------------
  private emptyDraft(): DraftState {
    return {
      name: '',
      website: '',
      vendorIds: [],
      description: '',
      categoryIds: [],
      disciplineIds: [],
      phaseIds: [],
      researchStatus: '',
      toolIntegrationsUrl: '',
      apiDocsUrl: '',
      hasApiDocs: false,
      researchNotes: '',
      toolIntegrationCheckNotes: '',
    };
  }

  private toDraft(tool: ToolDetail): DraftState {
    return {
      name: tool.name,
      website: tool.website ?? '',
      vendorIds: tool.vendors.map((v) => v.id),
      description: tool.description ?? '',
      categoryIds: tool.categories.map((c) => c.id),
      disciplineIds: tool.disciplines.map((d) => d.id),
      phaseIds: tool.phases.map((p) => p.id),
      researchStatus: tool.researchStatus ?? '',
      toolIntegrationsUrl: tool.toolIntegrationsUrl ?? '',
      apiDocsUrl: tool.apiDocsUrl ?? '',
      hasApiDocs: tool.hasApiDocs ?? false,
      researchNotes: tool.researchNotes ?? '',
      toolIntegrationCheckNotes: tool.toolIntegrationCheckNotes ?? '',
    };
  }

  private buildPatch(section: SectionKey): UpdateToolRequest {
    const d = this.draft;
    switch (section) {
      case 'header':
        return { name: d.name, website: d.website, vendors: d.vendorIds };
      case 'description':
        return { description: d.description };
      case 'taxonomy':
        return {
          categories: d.categoryIds,
          disciplines: d.disciplineIds,
          phases: d.phaseIds,
        };
      case 'research':
        return { researchStatus: d.researchStatus };
      case 'integrationLinks':
        return {
          toolIntegrationsUrl: d.toolIntegrationsUrl,
          apiDocsUrl: d.apiDocsUrl,
          hasApiDocs: d.hasApiDocs,
        };
      case 'researchNotes':
        return { researchNotes: d.researchNotes };
      case 'integrationCheckNotes':
        return { toolIntegrationCheckNotes: d.toolIntegrationCheckNotes };
    }
  }

  // ---- pill overflow ------------------------------------------------------
  static readonly PILL_LIMIT = 3;
  visibleRefs(refs: LinkRef[]): LinkRef[] {
    return refs.slice(0, ToolDetailComponent.PILL_LIMIT);
  }
  overflowRefs(refs: LinkRef[]): LinkRef[] | null {
    if (refs.length <= ToolDetailComponent.PILL_LIMIT) return null;
    return refs.slice(ToolDetailComponent.PILL_LIMIT);
  }

  // ---- formatters / classes ----------------------------------------------
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

  tierBadgeClass(tier: string): string {
    switch (tier) {
      case '1':
        return 'badge--success';
      case '2':
        return 'badge--info';
      case '3':
        return 'badge--warning';
      default:
        return 'badge--neutral';
    }
  }

  hasScoring(tool: ToolDetail): boolean {
    return (
      tool.priorityTier !== undefined ||
      tool.priorityScore !== undefined ||
      tool.integrationScore !== undefined ||
      tool.demandScore !== undefined ||
      tool.outreachScore !== undefined ||
      tool.toolDataCompleteness !== undefined ||
      tool.emergingFlag === true ||
      tool.toolEnrichmentStatus !== undefined
    );
  }

  hasIntegrationSignals(tool: ToolDetail): boolean {
    return (
      tool.marketplaceCount !== undefined ||
      tool.ipaasCount !== undefined ||
      tool.zapierTriggerCount !== undefined ||
      !!tool.integrationCount
    );
  }

  hasMarketSignals(tool: ToolDetail): boolean {
    return (
      tool.g2Rating !== undefined ||
      tool.g2ReviewCount !== undefined ||
      tool.capterraRating !== undefined ||
      tool.capterraReviewCount !== undefined ||
      tool.searchVolumeMonthly !== undefined ||
      tool.googleTrendsIndex !== undefined ||
      tool.redditMentions24mo !== undefined
    );
  }

  formatPercent(v: number): string {
    const pct = v <= 1 ? v * 100 : v;
    return `${Math.round(pct)}%`;
  }

  formatDate(iso: string): string {
    return formatDate(iso);
  }

  formatDateWithRelative(iso: string): string {
    return formatDateWithRelative(iso);
  }
}
