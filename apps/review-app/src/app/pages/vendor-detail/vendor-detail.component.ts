import { Component, OnInit, inject, signal, input, computed } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CurrencyPipe, DecimalPipe } from '@angular/common';
import { ApiService } from '../../services/api.service';
import { formatDate, formatDateWithRelative } from '../../utils/date';
import { VendorDetail } from '../../types';
import { EnrichSplitButtonComponent } from '../../components/enrich-split-button/enrich-split-button.component';
import { InfoTooltipComponent } from '../../components/info-tooltip/info-tooltip.component';
import { enrichmentVariant } from '../../utils/enrichment';

@Component({
  selector: 'app-vendor-detail',
  imports: [RouterLink, CurrencyPipe, DecimalPipe, EnrichSplitButtonComponent, InfoTooltipComponent],
  template: `
    @if (vendor(); as vendor) {
      <div class="page-container">
        <!-- Back link -->
        <a routerLink="/vendors" class="back-link">
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <line x1="19" y1="12" x2="5" y2="12" /><polyline points="12 19 5 12 12 5" />
          </svg>
          Back to vendors
        </a>

        <!-- Header -->
        <header class="detail-header">
          <div class="detail-header__top">
            <span class="avatar" aria-hidden="true">
              @if (vendor.logoUrl && !logoFailed()) {
                <img
                  [src]="vendor.logoUrl"
                  [alt]="vendor.companyName + ' logo'"
                  (error)="logoFailed.set(true)"
                />
              } @else {
                <span>{{ vendorInitials(vendor.companyName) }}</span>
              }
            </span>
            <div class="detail-header__title-block">
              <div class="detail-header__title-row">
                <h1 class="detail-title">{{ vendor.companyName }}</h1>
                <app-enrich-split-button
                  family="vendor"
                  [recordIds]="recordIds()"
                />
              </div>
              @if (vendor.website) {
                <a [href]="vendor.website" target="_blank" rel="noopener noreferrer" class="external-link">
                  {{ vendor.website }}
                  <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                    <polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" />
                  </svg>
                </a>
              }
            </div>
          </div>

          @if (vendor.linkedinUrl || vendor.crunchbaseUrl || vendor.sourceUrl) {
            <div class="detail-header__links">
              @if (vendor.linkedinUrl) {
                <a [href]="vendor.linkedinUrl" target="_blank" rel="noopener noreferrer" class="external-link external-link--pill">LinkedIn</a>
              }
              @if (vendor.crunchbaseUrl) {
                <a [href]="vendor.crunchbaseUrl" target="_blank" rel="noopener noreferrer" class="external-link external-link--pill">Crunchbase</a>
              }
              @if (vendor.githubOrg) {
                <a [href]="'https://github.com/' + vendor.githubOrg" target="_blank" rel="noopener noreferrer" class="external-link external-link--pill">GitHub</a>
              }
              @if (vendor.sourceUrl) {
                <a [href]="vendor.sourceUrl" target="_blank" rel="noopener noreferrer" class="external-link external-link--pill">Source</a>
              }
            </div>
          }
        </header>

        <!-- Key facts -->
        <section class="detail-section">
          <h2 class="section-heading">Key facts</h2>
          <div class="facts-grid">
            <div class="fact">
              <span class="fact__label">Headquarters</span>
              <span class="fact__value">
                @if (vendor.headquarters) {
                  {{ vendor.headquarters }}
                } @else {
                  <span class="na">N/A</span>
                }
              </span>
            </div>
            <div class="fact">
              <span class="fact__label">Founded</span>
              <span class="fact__value">
                @if (vendor.foundedYear) {
                  {{ vendor.foundedYear }}
                } @else {
                  <span class="na">N/A</span>
                }
              </span>
            </div>
            <div class="fact">
              <span class="fact__label">Company size</span>
              <span class="fact__value">
                @if (vendor.companySize) {
                  {{ vendor.companySize }}
                } @else {
                  <span class="na">N/A</span>
                }
              </span>
            </div>
            <div class="fact">
              <span class="fact__label">Public / private</span>
              <span class="fact__value">
                @if (vendor.publicPrivate) {
                  {{ vendor.publicPrivate }}
                } @else {
                  <span class="na">N/A</span>
                }
              </span>
            </div>
            <div class="fact">
              <span class="fact__label">Parent company</span>
              <span class="fact__value">
                @if (vendor.parentCompany) {
                  {{ vendor.parentCompany }}
                } @else {
                  <span class="na">N/A</span>
                }
              </span>
            </div>
          </div>
        </section>

        <!-- Description -->
        <section class="detail-section">
          <h2 class="section-heading">Description</h2>
          @if (vendor.description) {
            <p class="description-text">{{ vendor.description }}</p>
          } @else {
            <p class="description-text na">N/A</p>
          }
        </section>

        <!-- GitHub -->
        <section class="detail-section">
          <h2 class="section-heading">
            GitHub
            @if (vendor.githubOrgVerified) {
              <span class="badge badge--success badge--sm">verified</span>
            }
            @if (vendor.githubCheckedAt) {
              <app-info-tooltip [tooltip]="freshnessTooltip(vendor.githubCheckedAt)" />
            }
          </h2>
          <div class="facts-grid">
            <div class="fact">
              <span class="fact__label">Organization</span>
              <span class="fact__value">
                @if (vendor.githubOrg) {
                  <a [href]="'https://github.com/' + vendor.githubOrg" target="_blank" rel="noopener noreferrer">
                    {{ vendor.githubOrg }}
                  </a>
                } @else {
                  <span class="na">N/A</span>
                }
              </span>
            </div>
            <div class="fact">
              <span class="fact__label">Repos</span>
              <span class="fact__value">
                @if (vendor.githubRepoCount !== undefined) {
                  {{ vendor.githubRepoCount | number }}
                } @else {
                  <span class="na">N/A</span>
                }
              </span>
            </div>
            <div class="fact">
              <span class="fact__label">Total stars</span>
              <span class="fact__value">
                @if (vendor.githubStarsTotal !== undefined) {
                  {{ vendor.githubStarsTotal | number }}
                } @else {
                  <span class="na">N/A</span>
                }
              </span>
            </div>
            <div class="fact">
              <span class="fact__label">SDK repo</span>
              <span class="fact__value">
                @if (vendor.hasSdkRepo !== undefined) {
                  {{ vendor.hasSdkRepo ? 'Yes' : 'No' }}
                } @else {
                  <span class="na">N/A</span>
                }
              </span>
            </div>
            <div class="fact">
              <span class="fact__label">Last commit</span>
              <span class="fact__value">
                @if (vendor.githubLastCommitDaysAgo !== undefined) {
                  {{ vendor.githubLastCommitDaysAgo }} days ago
                } @else {
                  <span class="na">N/A</span>
                }
              </span>
            </div>
          </div>
        </section>

        <!-- Funding -->
        <section class="detail-section">
          <h2 class="section-heading">
            Funding
            @if (vendor.fundingCheckedAt) {
              <app-info-tooltip [tooltip]="freshnessTooltip(vendor.fundingCheckedAt)" />
            }
          </h2>
          <div class="facts-grid">
            <div class="fact">
              <span class="fact__label">Stage</span>
              <span class="fact__value">
                @if (vendor.fundingStage) {
                  {{ vendor.fundingStage }}
                } @else {
                  <span class="na">N/A</span>
                }
              </span>
            </div>
            <div class="fact">
              <span class="fact__label">Total raised</span>
              <span class="fact__value">
                @if (vendor.totalFundingUsd !== undefined) {
                  {{ vendor.totalFundingUsd | currency:'USD':'symbol':'1.0-0' }}
                } @else {
                  <span class="na">N/A</span>
                }
              </span>
            </div>
            <div class="fact">
              <span class="fact__label">Last round</span>
              <span class="fact__value">
                @if (vendor.lastFundingDate) {
                  {{ formatDateWithRelative(vendor.lastFundingDate) }}
                } @else {
                  <span class="na">N/A</span>
                }
              </span>
            </div>
            <div class="fact">
              <span class="fact__label">Source</span>
              <span class="fact__value">
                @if (vendor.fundingSourceUrl) {
                  <a [href]="vendor.fundingSourceUrl" target="_blank" rel="noopener noreferrer">View</a>
                } @else {
                  <span class="na">N/A</span>
                }
              </span>
            </div>
          </div>
        </section>

        <!-- Activity -->
        <section class="detail-section">
          <h2 class="section-heading">Activity</h2>
          <div class="facts-grid">
            <div class="fact">
              <span class="fact__label">
                Press (12mo)
                @if (vendor.pressCheckedAt) {
                  <app-info-tooltip [tooltip]="freshnessTooltip(vendor.pressCheckedAt)" />
                }
              </span>
              <span class="fact__value">
                @if (vendor.pressCount12mo !== undefined) {
                  {{ vendor.pressCount12mo }}
                } @else {
                  <span class="na">N/A</span>
                }
              </span>
            </div>
            <div class="fact">
              <span class="fact__label">
                Latest press
                @if (vendor.pressCheckedAt) {
                  <app-info-tooltip [tooltip]="freshnessTooltip(vendor.pressCheckedAt)" />
                }
              </span>
              <span class="fact__value">
                @if (vendor.pressLatestDate) {
                  {{ formatDateWithRelative(vendor.pressLatestDate) }}
                } @else {
                  <span class="na">N/A</span>
                }
              </span>
            </div>
            <div class="fact">
              <span class="fact__label">
                Blog
                @if (vendor.blogCheckedAt) {
                  <app-info-tooltip [tooltip]="freshnessTooltip(vendor.blogCheckedAt)" />
                }
              </span>
              <span class="fact__value">
                @if (vendor.blogUrl) {
                  <a [href]="vendor.blogUrl" target="_blank" rel="noopener noreferrer">Visit</a>
                } @else {
                  <span class="na">N/A</span>
                }
              </span>
            </div>
            <div class="fact">
              <span class="fact__label">
                Latest post
                @if (vendor.blogCheckedAt) {
                  <app-info-tooltip [tooltip]="freshnessTooltip(vendor.blogCheckedAt)" />
                }
              </span>
              <span class="fact__value">
                @if (vendor.blogLastPostDate) {
                  {{ formatDate(vendor.blogLastPostDate) }}
                  @if (vendor.blogLastPostDaysAgo !== undefined) {
                    <span class="muted"> ({{ vendor.blogLastPostDaysAgo }} days ago)</span>
                  }
                } @else {
                  <span class="na">N/A</span>
                }
              </span>
            </div>
            <div class="fact">
              <span class="fact__label">
                LinkedIn followers
                @if (vendor.linkedinCheckedAt) {
                  <app-info-tooltip [tooltip]="freshnessTooltip(vendor.linkedinCheckedAt)" />
                }
              </span>
              <span class="fact__value">
                @if (vendor.linkedinFollowers !== undefined) {
                  {{ vendor.linkedinFollowers | number }}
                } @else {
                  <span class="na">N/A</span>
                }
              </span>
            </div>
            <div class="fact">
              <span class="fact__label">
                Employees
                @if (vendor.employeeCheckedAt) {
                  <app-info-tooltip [tooltip]="freshnessTooltip(vendor.employeeCheckedAt)" />
                }
              </span>
              <span class="fact__value">
                @if (vendor.employeeCountExact !== undefined) {
                  {{ vendor.employeeCountExact | number }}
                  @if (vendor.employeeSource) {
                    <!--
                      Note: this Airtable singleSelect is currently polluted with
                      long-form sentences as choice values (some 200+ chars).
                      Truncate visually but expose the full value in a tooltip
                      until upstream cleanup happens.
                    -->
                    <span class="muted truncate employee-source" [title]="vendor.employeeSource">
                      · {{ truncate(vendor.employeeSource, 60) }}
                    </span>
                  }
                } @else {
                  <span class="na">N/A</span>
                }
              </span>
            </div>
          </div>
        </section>

        <!-- Enrichment status -->
        <section class="detail-section">
          <h2 class="section-heading">
            Enrichment
            @if (vendor.lastEnrichedAt) {
              <app-info-tooltip [tooltip]="freshnessTooltip(vendor.lastEnrichedAt)" />
            }
          </h2>
          <div class="facts-grid">
            <div class="fact">
              <span class="fact__label">Status</span>
              <span class="fact__value">
                @if (vendor.vendorEnrichmentStatus) {
                  <span class="badge" [class]="'badge badge--' + enrichmentVariant(vendor.vendorEnrichmentStatus)">{{ vendor.vendorEnrichmentStatus }}</span>
                } @else {
                  <span class="na">N/A</span>
                }
              </span>
            </div>
            <div class="fact">
              <span class="fact__label">Data completeness</span>
              <span class="fact__value">
                @if (vendor.vendorDataCompleteness !== undefined) {
                  {{ formatPercent(vendor.vendorDataCompleteness) }}
                } @else {
                  <span class="na">N/A</span>
                }
              </span>
            </div>
          </div>
        </section>

        <!-- Tools -->
        @if (vendor.tools.length) {
          <section class="detail-section">
            <h2 class="section-heading">
              Tools
              <span class="section-count">({{ vendor.tools.length }})</span>
            </h2>
            <div class="table-wrapper">
              <table class="table" aria-label="Tools">
                <thead>
                  <tr>
                    <th>Tool</th>
                  </tr>
                </thead>
                <tbody>
                  @for (tool of vendor.tools; track tool.id) {
                    <tr>
                      <td>
                        <a [routerLink]="['/tools', tool.id]">{{ tool.name }}</a>
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </section>
        }

        <!-- Data freshness -->
        @if (hasFreshness(vendor)) {
          <section class="detail-section freshness">
            @if (vendor.lastEnrichedAt) {
              <span class="freshness__item">Enriched {{ formatDateWithRelative(vendor.lastEnrichedAt) }}</span>
            }
            @if (vendor.githubCheckedAt) {
              <span class="freshness__item">GitHub {{ formatDateWithRelative(vendor.githubCheckedAt) }}</span>
            }
            @if (vendor.fundingCheckedAt) {
              <span class="freshness__item">Funding {{ formatDateWithRelative(vendor.fundingCheckedAt) }}</span>
            }
            @if (vendor.pressCheckedAt) {
              <span class="freshness__item">Press {{ formatDateWithRelative(vendor.pressCheckedAt) }}</span>
            }
            @if (vendor.blogCheckedAt) {
              <span class="freshness__item">Blog {{ formatDateWithRelative(vendor.blogCheckedAt) }}</span>
            }
            @if (vendor.linkedinCheckedAt) {
              <span class="freshness__item">LinkedIn {{ formatDateWithRelative(vendor.linkedinCheckedAt) }}</span>
            }
          </section>
        }
      </div>
    } @else {
      <div class="page-container detail-skeleton">
        <span class="skeleton skeleton--text" style="width: 80px; height: 14px;"></span>
        <span class="skeleton skeleton--rect" style="width: 48px; height: 48px; margin-top: 24px; border-radius: 8px;"></span>
        <span class="skeleton skeleton--text" style="width: 280px; height: 28px; margin-top: 16px;"></span>
        <span class="skeleton skeleton--text" style="width: 100%; height: 14px; margin-top: 24px;"></span>
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
      margin-bottom: var(--space-6);
    }

    .detail-header__top {
      display: flex;
      align-items: flex-start;
      gap: var(--space-4);
    }

    .detail-header__links {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
      margin-top: var(--space-3);
    }

    .external-link--pill {
      padding: 2px var(--space-2);
      border: 0.5px solid var(--color-border-default);
      border-radius: var(--radius-sm);
      font-size: var(--text-xs);
      color: var(--color-text-secondary);
      text-decoration: none;
    }

    .external-link--pill:hover {
      color: var(--color-text-accent);
      border-color: var(--color-border-strong);
      text-decoration: none;
    }

    .employee-source {
      max-width: 240px;
      vertical-align: bottom;
    }

    .detail-header__title-block { flex: 1; min-width: 0; }
    .detail-header__title-row {
      display: flex;
      align-items: center;
      gap: var(--space-3);
      flex-wrap: wrap;
    }

    .detail-title {
      font-size: var(--text-2xl);
      font-weight: 500;
      color: var(--color-text-primary);
      line-height: var(--leading-tight);
      margin: 0 0 var(--space-1);
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

    .facts-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
      gap: var(--space-4);
    }

    .fact {
      display: flex;
      flex-direction: column;
      gap: var(--space-1);
    }

    .fact__label {
      font-size: var(--text-xs);
      font-weight: 500;
      color: var(--color-text-secondary);
    }

    .fact__value {
      font-size: var(--text-base);
      color: var(--color-text-body);
    }

    .description-text {
      white-space: pre-line;
      color: var(--color-text-body);
      line-height: var(--leading-normal);
    }

    .external-links {
      display: flex;
      gap: var(--space-5);
      flex-wrap: wrap;
    }

    .table-wrapper {
      overflow-x: auto;
      border: 0.5px solid var(--color-border-default);
      border-radius: var(--radius-lg);
      background: var(--color-bg-elevated);
    }

    .section-count {
      margin-left: var(--space-1);
      font-size: var(--text-sm);
      font-weight: 400;
      color: var(--color-text-secondary);
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

    .detail-skeleton {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
    }

    .fact__value {
      font-variant-numeric: tabular-nums;
    }

    .na {
      color: var(--color-text-tertiary);
    }
  `,
})
export class VendorDetailComponent implements OnInit {
  id = input.required<string>();

  private api = inject(ApiService);
  vendor = signal<VendorDetail | null>(null);
  logoFailed = signal(false);
  recordIds = computed(() => (this.vendor() ? [this.id()] : []));
  enrichmentVariant = enrichmentVariant;

  ngOnInit(): void {
    this.api.getVendor(this.id()).subscribe((vendor) => {
      this.vendor.set(vendor);
      this.logoFailed.set(false);
    });
  }

  vendorInitials(name: string): string {
    return name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map(w => w[0]?.toUpperCase() ?? '')
      .join('');
  }

  truncate(value: string, max: number): string {
    if (!value) return '';
    return value.length <= max ? value : value.slice(0, max - 1).trimEnd() + '…';
  }

  hasFreshness(v: VendorDetail): boolean {
    return !!(
      v.lastEnrichedAt ||
      v.githubCheckedAt ||
      v.fundingCheckedAt ||
      v.pressCheckedAt ||
      v.blogCheckedAt ||
      v.linkedinCheckedAt
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

  freshnessTooltip(iso: string): string {
    return `Updated ${formatDateWithRelative(iso)}`;
  }
}
