// ---------------------------------------------------------------------------
// Dashboard — landing page for the merged app. Shows aggregate counts:
//   • Total integrations (links to integration counts)
//   • Vendors: total + breakdown by enrichment status + readiness buckets
//   • Tools:   total + breakdown by research status + priority tier
//
// All numbers come from a single GET /api/stats request.
// ---------------------------------------------------------------------------
import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { ApiService } from '../../services/api.service';
import { StatsResponse } from '../../types';

interface Bucket {
  key: string;
  label: string;
  count: number;
}

@Component({
  selector: 'app-dashboard',
  imports: [CommonModule, RouterLink],
  templateUrl: './dashboard.page.html',
  styleUrl: './dashboard.page.scss',
})
export class DashboardPage implements OnInit {
  private api = inject(ApiService);

  protected readonly stats = signal<StatsResponse | null>(null);
  protected readonly loadError = signal<string | null>(null);

  protected readonly vendorStatusBuckets = computed<Bucket[]>(() =>
    toBuckets(this.stats()?.vendors.byStatus),
  );

  protected readonly vendorReadinessBuckets = computed<Bucket[]>(() => {
    const s = this.stats();
    if (!s) return [];
    return s.vendors.readinessBuckets.map((b) => ({
      key: b.key,
      label: b.label,
      count: s.vendors.byReadiness[b.key] ?? 0,
    }));
  });

  protected readonly toolResearchBuckets = computed<Bucket[]>(() =>
    toBuckets(this.stats()?.tools.byResearchStatus),
  );

  protected readonly toolPriorityBuckets = computed<Bucket[]>(() =>
    toBuckets(this.stats()?.tools.byPriority, sortPriority),
  );

  ngOnInit(): void {
    this.api.getStats().subscribe({
      next: (resp) => this.stats.set(resp),
      error: (err) => this.loadError.set(String(err?.message ?? err)),
    });
  }
}

function toBuckets(
  map: Record<string, number> | undefined,
  sort: (a: Bucket, b: Bucket) => number = (a, b) => a.label.localeCompare(b.label),
): Bucket[] {
  if (!map) return [];
  return Object.entries(map)
    .map(([key, count]) => ({ key, label: key, count }))
    .sort(sort);
}

// Priority tiers commonly look like "1", "2", "3" or "Tier 1" etc.
// Sort numerically when possible, falling back to label.
function sortPriority(a: Bucket, b: Bucket): number {
  const an = Number(a.key);
  const bn = Number(b.key);
  if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
  return a.label.localeCompare(b.label);
}
