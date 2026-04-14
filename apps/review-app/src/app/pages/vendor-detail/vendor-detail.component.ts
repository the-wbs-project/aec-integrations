import { Component, OnInit, inject, signal, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ApiService } from '../../services/api.service';
import { VendorDetail } from '../../types';

@Component({
  selector: 'app-vendor-detail',
  imports: [RouterLink],
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
}
