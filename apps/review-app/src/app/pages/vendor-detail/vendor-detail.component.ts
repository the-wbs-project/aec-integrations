import { Component, OnInit, inject, signal, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CurrencyPipe, DecimalPipe } from '@angular/common';
import { ApiService } from '../../services/api.service';
import { VendorDetail } from '../../types';

@Component({
  selector: 'app-vendor-detail',
  imports: [RouterLink, CurrencyPipe, DecimalPipe],
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
            @if (vendor.logoUrl) {
              <img
                [src]="vendor.logoUrl"
                [alt]="vendor.companyName + ' logo'"
                class="vendor-logo"
              />
            }
            <div>
              <h1 class="detail-title">{{ vendor.companyName }}</h1>
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
        </header>

        <!-- Key facts -->
        <section class="detail-section">
          <h2 class="section-heading">Key facts</h2>
          <div class="facts-grid">
            @if (vendor.headquarters) {
              <div class="fact">
                <span class="fact__label">Headquarters</span>
                <span class="fact__value">{{ vendor.headquarters }}</span>
              </div>
            }
            @if (vendor.foundedYear) {
              <div class="fact">
                <span class="fact__label">Founded</span>
                <span class="fact__value">{{ vendor.foundedYear }}</span>
              </div>
            }
            @if (vendor.companySize) {
              <div class="fact">
                <span class="fact__label">Company size</span>
                <span class="fact__value">{{ vendor.companySize }}</span>
              </div>
            }
            @if (vendor.publicPrivate) {
              <div class="fact">
                <span class="fact__label">Public / private</span>
                <span class="fact__value">{{ vendor.publicPrivate }}</span>
              </div>
            }
            @if (vendor.parentCompany) {
              <div class="fact">
                <span class="fact__label">Parent company</span>
                <span class="fact__value">{{ vendor.parentCompany }}</span>
              </div>
            }
          </div>
        </section>

        <!-- Description -->
        @if (vendor.description) {
          <section class="detail-section">
            <h2 class="section-heading">Description</h2>
            <p class="description-text">{{ vendor.description }}</p>
          </section>
        }

        <!-- GitHub -->
        @if (hasGithub(vendor)) {
          <section class="detail-section">
            <h2 class="section-heading">
              GitHub
              @if (vendor.githubOrgVerified) {
                <span class="badge badge--success badge--sm">verified</span>
              }
            </h2>
            <div class="facts-grid">
              @if (vendor.githubOrg) {
                <div class="fact">
                  <span class="fact__label">Organization</span>
                  <span class="fact__value">
                    <a [href]="'https://github.com/' + vendor.githubOrg" target="_blank" rel="noopener noreferrer">
                      {{ vendor.githubOrg }}
                    </a>
                  </span>
                </div>
              }
              @if (vendor.githubRepoCount !== undefined) {
                <div class="fact">
                  <span class="fact__label">Repos</span>
                  <span class="fact__value">{{ vendor.githubRepoCount | number }}</span>
                </div>
              }
              @if (vendor.githubStarsTotal !== undefined) {
                <div class="fact">
                  <span class="fact__label">Total stars</span>
                  <span class="fact__value">{{ vendor.githubStarsTotal | number }}</span>
                </div>
              }
              @if (vendor.hasSdkRepo !== undefined) {
                <div class="fact">
                  <span class="fact__label">SDK repo</span>
                  <span class="fact__value">{{ vendor.hasSdkRepo ? 'Yes' : 'No' }}</span>
                </div>
              }
              @if (vendor.githubLastCommitDaysAgo !== undefined) {
                <div class="fact">
                  <span class="fact__label">Last commit</span>
                  <span class="fact__value">{{ vendor.githubLastCommitDaysAgo }} days ago</span>
                </div>
              }
            </div>
          </section>
        }

        <!-- Funding -->
        @if (hasFunding(vendor)) {
          <section class="detail-section">
            <h2 class="section-heading">Funding</h2>
            <div class="facts-grid">
              @if (vendor.fundingStage) {
                <div class="fact">
                  <span class="fact__label">Stage</span>
                  <span class="fact__value">{{ vendor.fundingStage }}</span>
                </div>
              }
              @if (vendor.totalFundingUsd !== undefined) {
                <div class="fact">
                  <span class="fact__label">Total raised</span>
                  <span class="fact__value">{{ vendor.totalFundingUsd | currency:'USD':'symbol':'1.0-0' }}</span>
                </div>
              }
              @if (vendor.lastFundingDate) {
                <div class="fact">
                  <span class="fact__label">Last round</span>
                  <span class="fact__value">{{ formatDate(vendor.lastFundingDate) }}</span>
                </div>
              }
              @if (vendor.fundingSourceUrl) {
                <div class="fact">
                  <span class="fact__label">Source</span>
                  <span class="fact__value">
                    <a [href]="vendor.fundingSourceUrl" target="_blank" rel="noopener noreferrer">View</a>
                  </span>
                </div>
              }
            </div>
          </section>
        }

        <!-- Activity -->
        @if (hasActivity(vendor)) {
          <section class="detail-section">
            <h2 class="section-heading">Activity</h2>
            <div class="facts-grid">
              @if (vendor.pressCount12mo !== undefined) {
                <div class="fact">
                  <span class="fact__label">Press (12mo)</span>
                  <span class="fact__value">{{ vendor.pressCount12mo }}</span>
                </div>
              }
              @if (vendor.pressLatestDate) {
                <div class="fact">
                  <span class="fact__label">Latest press</span>
                  <span class="fact__value">{{ formatDate(vendor.pressLatestDate) }}</span>
                </div>
              }
              @if (vendor.blogUrl) {
                <div class="fact">
                  <span class="fact__label">Blog</span>
                  <span class="fact__value">
                    <a [href]="vendor.blogUrl" target="_blank" rel="noopener noreferrer">Visit</a>
                  </span>
                </div>
              }
              @if (vendor.blogLastPostDate) {
                <div class="fact">
                  <span class="fact__label">Latest post</span>
                  <span class="fact__value">
                    {{ formatDate(vendor.blogLastPostDate) }}
                    @if (vendor.blogLastPostDaysAgo !== undefined) {
                      <span class="muted"> ({{ vendor.blogLastPostDaysAgo }} days ago)</span>
                    }
                  </span>
                </div>
              }
              @if (vendor.linkedinFollowers !== undefined) {
                <div class="fact">
                  <span class="fact__label">LinkedIn followers</span>
                  <span class="fact__value">{{ vendor.linkedinFollowers | number }}</span>
                </div>
              }
              @if (vendor.employeeCountExact !== undefined) {
                <div class="fact">
                  <span class="fact__label">Employees</span>
                  <span class="fact__value">
                    {{ vendor.employeeCountExact | number }}
                    @if (vendor.employeeSource) {
                      <span class="muted"> · {{ vendor.employeeSource }}</span>
                    }
                  </span>
                </div>
              }
            </div>
          </section>
        }

        <!-- Enrichment status -->
        @if (vendor.vendorEnrichmentStatus || vendor.vendorDataCompleteness !== undefined) {
          <section class="detail-section">
            <h2 class="section-heading">Enrichment</h2>
            <div class="facts-grid">
              @if (vendor.vendorEnrichmentStatus) {
                <div class="fact">
                  <span class="fact__label">Status</span>
                  <span class="fact__value">
                    <span class="badge badge--neutral">{{ vendor.vendorEnrichmentStatus }}</span>
                  </span>
                </div>
              }
              @if (vendor.vendorDataCompleteness !== undefined) {
                <div class="fact">
                  <span class="fact__label">Data completeness</span>
                  <span class="fact__value">{{ formatPercent(vendor.vendorDataCompleteness) }}</span>
                </div>
              }
            </div>
          </section>
        }

        <!-- External links -->
        @if (vendor.linkedinUrl || vendor.crunchbaseUrl || vendor.sourceUrl) {
          <section class="detail-section">
            <h2 class="section-heading">External links</h2>
            <div class="external-links">
              @if (vendor.linkedinUrl) {
                <a [href]="vendor.linkedinUrl" target="_blank" rel="noopener noreferrer" class="external-link">
                  LinkedIn
                  <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                    <polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" />
                  </svg>
                </a>
              }
              @if (vendor.crunchbaseUrl) {
                <a [href]="vendor.crunchbaseUrl" target="_blank" rel="noopener noreferrer" class="external-link">
                  Crunchbase
                  <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                    <polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" />
                  </svg>
                </a>
              }
              @if (vendor.sourceUrl) {
                <a [href]="vendor.sourceUrl" target="_blank" rel="noopener noreferrer" class="external-link">
                  Source
                  <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                    <polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" />
                  </svg>
                </a>
              }
            </div>
          </section>
        }

        <!-- Tools published -->
        @if (vendor.tools.length) {
          <section class="detail-section">
            <h2 class="section-heading">Tools published</h2>
            <ul class="tools-list">
              @for (tool of vendor.tools; track tool.id) {
                <li>
                  <a [routerLink]="['/tools', tool.id]">{{ tool.name }}</a>
                </li>
              }
            </ul>
          </section>
        }

        <!-- Data freshness -->
        @if (hasFreshness(vendor)) {
          <section class="detail-section freshness">
            @if (vendor.lastEnrichedAt) {
              <span class="freshness__item">Enriched {{ formatDate(vendor.lastEnrichedAt) }}</span>
            }
            @if (vendor.githubCheckedAt) {
              <span class="freshness__item">GitHub {{ formatDate(vendor.githubCheckedAt) }}</span>
            }
            @if (vendor.fundingCheckedAt) {
              <span class="freshness__item">Funding {{ formatDate(vendor.fundingCheckedAt) }}</span>
            }
            @if (vendor.pressCheckedAt) {
              <span class="freshness__item">Press {{ formatDate(vendor.pressCheckedAt) }}</span>
            }
            @if (vendor.blogCheckedAt) {
              <span class="freshness__item">Blog {{ formatDate(vendor.blogCheckedAt) }}</span>
            }
            @if (vendor.linkedinCheckedAt) {
              <span class="freshness__item">LinkedIn {{ formatDate(vendor.linkedinCheckedAt) }}</span>
            }
          </section>
        }
      </div>
    } @else {
      <div class="page-container">
        <p class="loading-text">Loading vendor details...</p>
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

    .vendor-logo {
      width: 48px;
      height: 48px;
      border-radius: var(--radius-md);
      object-fit: contain;
      border: 0.5px solid var(--color-border-default);
      background: var(--color-bg-elevated);
    }

    .detail-title {
      font-size: var(--text-2xl);
      font-weight: 500;
      color: var(--color-text-primary);
      line-height: var(--leading-tight);
      margin-bottom: var(--space-1);
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

    .tools-list {
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
    }

    .tools-list a {
      font-size: var(--text-sm);
      color: var(--color-text-accent);
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
  `,
})
export class VendorDetailComponent implements OnInit {
  id = input.required<string>();

  private api = inject(ApiService);
  vendor = signal<VendorDetail | null>(null);

  ngOnInit(): void {
    this.api.getVendor(this.id()).subscribe((vendor) => {
      this.vendor.set(vendor);
    });
  }

  hasGithub(v: VendorDetail): boolean {
    return (
      !!v.githubOrg ||
      v.githubRepoCount !== undefined ||
      v.githubStarsTotal !== undefined ||
      v.hasSdkRepo !== undefined ||
      v.githubLastCommitDaysAgo !== undefined
    );
  }

  hasFunding(v: VendorDetail): boolean {
    return (
      !!v.fundingStage ||
      v.totalFundingUsd !== undefined ||
      !!v.lastFundingDate ||
      !!v.fundingSourceUrl
    );
  }

  hasActivity(v: VendorDetail): boolean {
    return (
      v.pressCount12mo !== undefined ||
      !!v.pressLatestDate ||
      !!v.blogUrl ||
      !!v.blogLastPostDate ||
      v.linkedinFollowers !== undefined ||
      v.employeeCountExact !== undefined
    );
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
    try {
      return new Date(iso).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });
    } catch {
      return iso;
    }
  }
}
