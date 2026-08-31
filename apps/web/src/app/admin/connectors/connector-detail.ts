import { DatePipe } from '@angular/common';
import { Component, afterNextRender, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';

import type {
  AdminAuditRow,
  AdminConnectorCatalogDetail,
  AdminConnectorEvidencedPairRow,
  AdminConnectorReachablePairRow,
  AdminConnectorStubRow,
  AdminNote,
  ConnectorCatalogManagementResponse,
} from '@aeci/shared';

import { AecSelect, type AecSelectOption } from '../../shared/aec-select/aec-select';
import { AdminNotes } from '../admin-notes';
import { AdminPaginator } from '../admin-paginator';
import { AuditTrail } from '../audit/audit-trail';
import { AdminConnectorsApi } from './admin-connectors-api';
import { ManagedByControl } from './managed-by-control';

const STUB_PAGE_SIZE = 25;
const PAIR_PAGE_SIZE = 25;
const AUDIT_PAGE_SIZE = 25;

type StubState =
  | 'any'
  | 'undecided'
  | 'mapped'
  | 'ruled_out'
  | 'out_of_scope'
  | 'no_record'
  | 'ambiguous_parked';

/**
 * `/admin/connectors/:id` — one catalogue, in five sections (AECI-722 /
 * `docs/ADMIN_PANEL_SPEC.md` §5.9).
 *
 * Stacked sections rather than tabs, following `/admin/vendors/:id`: they are
 * read together, so a route per tab would buy nothing but resolvers.
 *
 *  1. **Catalogue** — the connector, the lane, the flip control, the handover.
 *  2. **Surfaces** — where the crawl reads from, and when each last delivered.
 *     Above the fold on purpose: this is the freshness signal `STAGE_2_SPEC.md`
 *     §8.9(4) makes this screen answerable for, and burying it would defeat the
 *     one duty the screen inherited.
 *  3. **Triage** — the listings, filtered. The undecided ones are the backlog.
 *  4. **Pairs** — evidenced and reachable, as two independent tables (§13.3:
 *     one `<table>` per lane, never group-header rows in one `<tbody>`).
 *  5. **Audit** — the shared `<aec-audit-trail>`, which carries both the
 *     handovers and the sync's own run rows.
 *
 * Four independent fetches from one `afterNextRender`, each with its own
 * loading/failed pair, so a slow or broken section costs that section and not the
 * page.
 */
@Component({
  selector: 'aec-connector-detail',
  imports: [
    RouterLink,
    DatePipe,
    AecSelect,
    AdminNotes,
    AdminPaginator,
    AuditTrail,
    ManagedByControl,
  ],
  templateUrl: './connector-detail.html',
})
export class ConnectorDetail {
  private readonly api = inject(AdminConnectorsApi);
  private readonly route = inject(ActivatedRoute);

  protected readonly catalogId = signal(this.route.snapshot.paramMap.get('id') ?? '');

  // ── Catalogue ──────────────────────────────────────────────────────────────
  protected readonly catalog = signal<AdminConnectorCatalogDetail | null>(null);
  protected readonly loading = signal(true);
  protected readonly loadFailed = signal(false);
  protected readonly notFound = signal(false);
  protected readonly liveMessage = signal('');

  // ── Triage ─────────────────────────────────────────────────────────────────
  protected readonly stubs = signal<readonly AdminConnectorStubRow[]>([]);
  protected readonly stubTotal = signal(0);
  protected readonly stubPage = signal(1);
  protected readonly stubPerPage = STUB_PAGE_SIZE;
  protected readonly stubLoading = signal(true);
  protected readonly stubFailed = signal(false);
  protected readonly stubNotes = signal<readonly AdminNote[]>([]);
  protected readonly stubState = signal<StubState>('any');
  protected readonly proposalsOnly = signal(false);
  protected readonly includeRemoved = signal(false);
  protected readonly stubSearch = signal('');
  protected readonly stubSearchDraft = signal('');

  protected readonly stateOptions: readonly AecSelectOption[] = [
    { value: 'any', label: $localize`:@@admin.connectors.stub.state.any:Any state` },
    {
      value: 'undecided',
      label: $localize`:@@admin.connectors.stub.state.undecided:Not yet reviewed`,
    },
    { value: 'mapped', label: $localize`:@@admin.connectors.stub.state.mapped:Matched` },
    { value: 'ruled_out', label: $localize`:@@admin.connectors.stub.state.ruledOut:Ruled out` },
    {
      value: 'out_of_scope',
      label: $localize`:@@admin.connectors.stub.state.outOfScope:Out of scope`,
    },
    { value: 'no_record', label: $localize`:@@admin.connectors.stub.state.noRecord:No record` },
    {
      value: 'ambiguous_parked',
      label: $localize`:@@admin.connectors.stub.state.parked:Parked as ambiguous`,
    },
  ];

  // ── Pairs ──────────────────────────────────────────────────────────────────
  protected readonly reachablePairs = signal<readonly AdminConnectorReachablePairRow[]>([]);
  protected readonly reachableTotal = signal(0);
  protected readonly reachablePage = signal(1);
  protected readonly reachableLoading = signal(true);
  protected readonly reachableFailed = signal(false);
  protected readonly reachableNotes = signal<readonly AdminNote[]>([]);

  protected readonly evidencedPairs = signal<readonly AdminConnectorEvidencedPairRow[]>([]);
  protected readonly evidencedTotal = signal(0);
  protected readonly evidencedPage = signal(1);
  protected readonly evidencedLoading = signal(true);
  protected readonly evidencedFailed = signal(false);
  protected readonly evidencedNotes = signal<readonly AdminNote[]>([]);
  protected readonly pairPerPage = PAIR_PAGE_SIZE;

  // ── Audit ──────────────────────────────────────────────────────────────────
  protected readonly auditRows = signal<readonly AdminAuditRow[]>([]);
  protected readonly auditTotal = signal(0);
  protected readonly auditPage = signal(1);
  protected readonly auditPerPage = AUDIT_PAGE_SIZE;
  protected readonly auditLoading = signal(true);
  protected readonly auditFailed = signal(false);
  protected readonly auditEmailsAvailable = signal(true);

  protected readonly stubsEmpty = computed(() => !this.stubLoading() && this.stubs().length === 0);

  constructor() {
    afterNextRender(() => {
      void this.load();
      void this.loadStubs();
      void this.loadReachable();
      void this.loadEvidenced();
      void this.loadAudit();
    });
  }

  // ── Catalogue ──────────────────────────────────────────────────────────────

  private async load(): Promise<void> {
    const id = this.catalogId();
    if (!id) {
      this.notFound.set(true);
      this.loading.set(false);
      return;
    }
    this.loading.set(true);
    this.loadFailed.set(false);
    this.notFound.set(false);
    try {
      this.catalog.set(await this.api.getCatalog(id));
    } catch (err) {
      // A 404 is a different message from "we couldn't load it": one means the id
      // is wrong, the other means retrying might work.
      if (isStatus(err, 404)) this.notFound.set(true);
      else this.loadFailed.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  protected retry(): void {
    void this.load();
  }

  /**
   * The flip returns the committed readout, so the section updates with no
   * refetch — the same reason `/admin/vendors/:id` patches its entitlement in
   * place. The handover block and the audit trail DO need a refetch: the handover
   * is derived server-side from the audit row this action just wrote, and it is
   * suppressed entirely on the way back to `review`.
   */
  protected onManagementChanged(result: ConnectorCatalogManagementResponse): void {
    this.catalog.update((c) => (c ? { ...c, managed_by: result.managed_by } : c));
    void this.load();
    void this.loadAudit();
  }

  protected onAnnounce(message: string): void {
    this.liveMessage.set(message);
  }

  // ── Triage ─────────────────────────────────────────────────────────────────

  protected onStubSearchInput(event: Event): void {
    this.stubSearchDraft.set((event.target as HTMLInputElement).value);
  }

  protected submitStubSearch(): void {
    this.stubSearch.set(this.stubSearchDraft().trim());
    this.refilterStubs();
  }

  protected onStubStateChange(value: string | null): void {
    this.stubState.set((value as StubState | null) ?? 'any');
    this.refilterStubs();
  }

  protected toggleProposalsOnly(): void {
    this.proposalsOnly.update((v) => !v);
    this.refilterStubs();
  }

  protected toggleIncludeRemoved(): void {
    this.includeRemoved.update((v) => !v);
    this.refilterStubs();
  }

  protected goToStubPage(page: number): void {
    this.stubPage.set(page);
    void this.loadStubs();
  }

  protected retryStubs(): void {
    void this.loadStubs();
  }

  private refilterStubs(): void {
    this.stubPage.set(1);
    void this.loadStubs();
  }

  private async loadStubs(): Promise<void> {
    const id = this.catalogId();
    if (!id) return;
    this.stubLoading.set(true);
    this.stubFailed.set(false);
    try {
      const state = this.stubState();
      const search = this.stubSearch();
      const response = await this.api.listStubs(id, {
        page: this.stubPage(),
        perPage: this.stubPerPage,
        ...(state === 'any' ? {} : { state }),
        ...(this.proposalsOnly() ? { proposals_only: 'true' } : {}),
        ...(this.includeRemoved() ? { include_removed: 'true' } : {}),
        ...(search ? { search } : {}),
      });
      this.stubs.set(response.data);
      this.stubTotal.set(response.total);
      this.stubNotes.set(response.advisories);
    } catch {
      this.stubFailed.set(true);
      this.stubs.set([]);
      this.stubTotal.set(0);
      this.stubNotes.set([]);
    } finally {
      this.stubLoading.set(false);
    }
  }

  // ── Pairs ──────────────────────────────────────────────────────────────────

  protected goToReachablePage(page: number): void {
    this.reachablePage.set(page);
    void this.loadReachable();
  }

  protected goToEvidencedPage(page: number): void {
    this.evidencedPage.set(page);
    void this.loadEvidenced();
  }

  protected retryReachable(): void {
    void this.loadReachable();
  }

  protected retryEvidenced(): void {
    void this.loadEvidenced();
  }

  private async loadReachable(): Promise<void> {
    const id = this.catalogId();
    if (!id) return;
    this.reachableLoading.set(true);
    this.reachableFailed.set(false);
    try {
      const response = await this.api.listPairs(id, {
        lane: 'reachable',
        page: this.reachablePage(),
        perPage: this.pairPerPage,
      });
      // The response is a discriminated union; narrow rather than cast, so a
      // server that answered with the wrong lane cannot render as this one.
      if (response.lane === 'reachable') {
        this.reachablePairs.set(response.data);
        this.reachableTotal.set(response.total);
        this.reachableNotes.set(response.advisories);
      }
    } catch {
      this.reachableFailed.set(true);
      this.reachablePairs.set([]);
      this.reachableTotal.set(0);
      this.reachableNotes.set([]);
    } finally {
      this.reachableLoading.set(false);
    }
  }

  private async loadEvidenced(): Promise<void> {
    const id = this.catalogId();
    if (!id) return;
    this.evidencedLoading.set(true);
    this.evidencedFailed.set(false);
    try {
      const response = await this.api.listPairs(id, {
        lane: 'evidenced',
        page: this.evidencedPage(),
        perPage: this.pairPerPage,
      });
      if (response.lane === 'evidenced') {
        this.evidencedPairs.set(response.data);
        this.evidencedTotal.set(response.total);
        this.evidencedNotes.set(response.advisories);
      }
    } catch {
      this.evidencedFailed.set(true);
      this.evidencedPairs.set([]);
      this.evidencedTotal.set(0);
      this.evidencedNotes.set([]);
    } finally {
      this.evidencedLoading.set(false);
    }
  }

  // ── Audit ──────────────────────────────────────────────────────────────────

  protected goToAuditPage(page: number): void {
    this.auditPage.set(page);
    void this.loadAudit();
  }

  protected retryAudit(): void {
    void this.loadAudit();
  }

  private async loadAudit(): Promise<void> {
    const id = this.catalogId();
    if (!id) return;
    this.auditLoading.set(true);
    this.auditFailed.set(false);
    try {
      const response = await this.api.listAudit(id, {
        page: this.auditPage(),
        perPage: this.auditPerPage,
      });
      this.auditRows.set(response.data);
      this.auditTotal.set(response.total);
      this.auditEmailsAvailable.set(response.actor_emails_available);
    } catch {
      this.auditFailed.set(true);
      this.auditRows.set([]);
      this.auditTotal.set(0);
    } finally {
      this.auditLoading.set(false);
    }
  }

  // ── Labels ─────────────────────────────────────────────────────────────────

  /**
   * Whether the GoTrue seam answered when resolving the handover's actor.
   *
   * `false` means the operator's name is missing because the seam was
   * unreachable, NOT because the row has no actor — the same three-state
   * discipline the vendor audit trail carries, applied to a single row.
   */
  protected actorEmailsAvailableForHandover(): boolean {
    return this.catalog()?.actor_emails_available ?? true;
  }

  protected authorshipLabel(value: string | null): string {
    switch (value) {
      case 'platform':
        return $localize`:@@admin.connectors.authorship.platform:Written by the platform`;
      case 'partner':
        return $localize`:@@admin.connectors.authorship.partner:Written by app vendors`;
      case 'mixed':
        return $localize`:@@admin.connectors.authorship.mixed:Mixed authorship`;
      default:
        return $localize`:@@admin.connectors.authorship.unknown:Not recorded`;
    }
  }

  protected statusLabel(status: string): string {
    switch (status) {
      case 'mapped':
        return $localize`:@@admin.connectors.status.mapped:Matched`;
      case 'ruled_out':
        return $localize`:@@admin.connectors.status.ruledOut:Ruled out`;
      case 'out_of_scope':
        return $localize`:@@admin.connectors.status.outOfScope:Out of scope`;
      case 'no_record':
        return $localize`:@@admin.connectors.status.noRecord:No record`;
      case 'ambiguous_parked':
        return $localize`:@@admin.connectors.status.parked:Parked`;
      default:
        return status;
    }
  }

  protected surfaceLabel(surface: string): string {
    switch (surface) {
      case 'curated':
        return $localize`:@@admin.connectors.surface.curated:Curated`;
      case 'generated':
        return $localize`:@@admin.connectors.surface.generated:Auto-generated`;
      default:
        return $localize`:@@admin.connectors.surface.unknown:Unclassified`;
    }
  }
}

/** Structural, not `instanceof`: the admin bundle is lazily split, so an
 *  `HttpErrorResponse` crossing a chunk boundary can fail an identity check. */
function isStatus(err: unknown, status: number): boolean {
  return typeof err === 'object' && err !== null && (err as { status?: unknown }).status === status;
}
