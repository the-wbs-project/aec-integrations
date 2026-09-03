import { DatePipe } from '@angular/common';
import { Component, afterNextRender, computed, effect, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';

import type {
  AdminAuditRow,
  AdminVendorAuditScope,
  AdminVendorDetail,
  AdminVendorProductRow,
  AdminVendorSeatRow,
  VendorEntitlementResponse,
} from '@aeci/shared';

import { AuditTrail } from '../audit/audit-trail';
import { EntitlementControl } from '../entitlement/entitlement-control';
import { AdminVendorsApi } from './admin-vendors-api';
import { ProvisionSeatControl } from './provision-seat-control';
import { VendorProductsTable } from './vendor-products-table';
import { productRolesLabel } from '../product-roles/product-roles-label';

const AUDIT_PAGE_SIZE = 25;
const PRODUCTS_PAGE_SIZE = 25;

/** The three tabs, and the `?tab=` values that address them. `vendor` is the
 *  default and is written as the ABSENT value, so `/admin/vendors/:id` and
 *  `/admin/vendors/:id?tab=vendor` are the same page with one canonical URL. */
export type AdminVendorTab = 'vendor' | 'products' | 'audit';

/**
 * `/admin/vendors/:id` — the operator's vendor page (AECI-652 /
 * `STAGE_2_PAID_TIERS_SPEC.md` §5.6), rendered in the `AdminShell` layout outlet.
 *
 * ── THREE TABS, ONE COMPONENT, ONE ROUTE ────────────────────────────────────
 * The screen is a horizontal tab row — **Vendor** (basics, entitlement, seats),
 * **Products**, **Audit trail** — over one panel. Basics/entitlement/seats stay
 * on ONE tab because an operator reads them together: the entitlement state
 * explains the seats, and a decision about either needs both on screen. Products
 * and the trail are the two blocks that are long, separately paginated, and
 * scanned rather than read alongside the rest.
 *
 * It is still one component and one route. The tab lives in `?tab=`, not in a
 * child route: a child route per tab would cost two more lazy components and two
 * more resolvers to move nothing but a signal, while a query param keeps the tab
 * linkable, bookmarkable and Back-navigable — the thing an in-page `@switch`
 * silently gives up (the vendor portal learned that the expensive way, see
 * `vendor-dashboard-tabbed.ts`). The default tab is the ABSENT value, so the
 * bare URL stays canonical.
 *
 * Each tab fetches ONCE, lazily, on first visit — a reader who never opens
 * Products never pays for it — and the fetch is browser-only, like the rest of
 * the page. Section headings are `h3` — the shell owns the only `h1` and this
 * screen owns the only `h2`.
 *
 * ── THE PAGE OWNS THE LIVE REGION ────────────────────────────────────────────
 * There is exactly one `role="status"` on this page, at the top, and
 * `EntitlementControl` feeds it through its `announce` output rather than
 * rendering its own. That is why the control renders neither a live region nor a
 * heading: on `/admin/claims` it appears once per row, so an internal live region
 * would multiply.
 *
 * ── WHAT THIS SCREEN DELIBERATELY CANNOT DO ──────────────────────────────────
 * **Ban a person.** Ban/unban lives on `/admin/users/:id` (AECI-524 owns the
 * policy; AECI-692 built the surface) and each seat row links there. Revoking a
 * seat and banning its holder are different actions with different blast radii —
 * a revoke un-grants one vendor's access, a ban locks the human out everywhere —
 * and putting them side-by-side as peer buttons would invite the wrong one.
 *
 * **Edit the catalog record.** There is no admin vendor-edit endpoint, which is
 * also why this page does not close the §5.4 lockout. Catalog data still flows
 * from the review app through `POST /api/promote`.
 *
 * ── IT CAN NOW ADD A SEAT (AECI-740) ─────────────────────────────────────────
 * `ProvisionSeatControl` sits above the roster, and it is the only surface in the
 * product that writes `profiles.role = 'vendor_admin'` STANDALONE — the claim
 * queue's Grant writes it too, and so does redeeming an owner's seat invite, but
 * both need a claim or an invite behind them. It exists because
 * `STAGE_2_SPEC.md` §8.9 gives a pure connector vendor a catalogue-maintenance
 * seat and NOT the Verified badge, while every other path to a seat opens an
 * entitlement on the way — which is why `STAGE_2_VENDOR_PORTAL_SPEC.md` §5.2 told
 * operators to park such a claim rather than grant it. It belongs here rather
 * than on `/admin/claims/:id` or `/admin/users/:id` for the reason the revoke
 * does: this is the only screen showing the blast radius — the other seats and
 * the entitlement state — that makes the decision safe.
 *
 * ── THE AUDIT TRAIL LIVES IN A SHARED COMPONENT (AECI-694) ───────────────
 * `<aec-audit-trail>` owns the table, the collapsed diffs and the paginator.
 * What stays here is the fetching and the SCOPE control, because scope is
 * vendor-specific (four OR'd disjuncts server-side, over this vendor's rows, its
 * requests, its metadata references and its seat roster) and a future
 * user-scoped or product-scoped trail would need a different one, or none.
 */
@Component({
  selector: 'aec-vendor-detail',
  imports: [
    RouterLink,
    AuditTrail,
    EntitlementControl,
    ProvisionSeatControl,
    VendorProductsTable,
    DatePipe,
  ],
  templateUrl: './vendor-detail.html',
})
export class VendorDetail {
  private readonly api = inject(AdminVendorsApi);
  private readonly route = inject(ActivatedRoute);

  protected readonly vendorId = signal(this.route.snapshot.paramMap.get('id') ?? '');

  // ── Tabs ───────────────────────────────────────────────────────────────────

  /** The live query map, not the snapshot: switching tabs re-uses this component
   *  instance, so a snapshot read would freeze the page on whichever tab it was
   *  entered from. */
  private readonly queryParams = toSignal(this.route.queryParamMap, {
    initialValue: this.route.snapshot.queryParamMap,
  });

  /** An unrecognised `?tab=` falls back to `vendor` rather than rendering an
   *  empty panel — a hand-edited or stale URL must still show the vendor. */
  protected readonly tab = computed<AdminVendorTab>(() => {
    const raw = this.queryParams().get('tab');
    return raw === 'products' || raw === 'audit' ? raw : 'vendor';
  });

  protected readonly tabs: ReadonlyArray<{ key: AdminVendorTab; label: string }> = [
    { key: 'vendor', label: $localize`:@@admin.vendors.tab.vendor:Vendor` },
    { key: 'products', label: $localize`:@@admin.vendors.tab.products:Products` },
    { key: 'audit', label: $localize`:@@admin.vendors.tab.audit:Audit Trail` },
  ];

  /** `undefined` clears the param, which is what keeps the default tab's URL
   *  the bare one. */
  protected tabQueryParams(tab: AdminVendorTab): { tab: string | undefined } {
    return { tab: tab === 'vendor' ? undefined : tab };
  }

  protected readonly vendor = signal<AdminVendorDetail | null>(null);
  protected readonly loading = signal(true);
  protected readonly loadFailed = signal(false);
  protected readonly notFound = signal(false);
  protected readonly liveMessage = signal('');

  /** Id of the seat whose revoke is in flight, and the seat awaiting confirmation.
   *  Two signals rather than one: a revoke is irreversible from this screen (only
   *  a fresh grant restores it), so it asks first. */
  protected readonly revokePendingId = signal<string | null>(null);
  protected readonly revokeConfirmId = signal<string | null>(null);
  protected readonly revokeFailedMessage = signal('');

  // ── Products ───────────────────────────────────────────────────────────────
  protected readonly productRows = signal<readonly AdminVendorProductRow[]>([]);
  protected readonly productTotal = signal(0);
  protected readonly productPage = signal(1);
  protected readonly productPerPage = PRODUCTS_PAGE_SIZE;
  protected readonly productsLoading = signal(true);
  protected readonly productsFailed = signal(false);
  /** Whether the Products tab has ever fetched. Guards the lazy first load so a
   *  tab switch back and forth does not refetch, and so an operator who never
   *  opens the tab never issues the request. */
  private productsRequested = false;

  // ── Audit ──────────────────────────────────────────────────────────────────
  protected readonly auditRows = signal<readonly AdminAuditRow[]>([]);
  protected readonly auditTotal = signal(0);
  protected readonly auditPage = signal(1);
  protected readonly auditPerPage = AUDIT_PAGE_SIZE;
  protected readonly auditScope = signal<AdminVendorAuditScope>('all');
  protected readonly auditLoading = signal(true);
  protected readonly auditFailed = signal(false);
  protected readonly auditEmailsAvailable = signal(true);

  protected readonly scopeOptions: ReadonlyArray<{ key: AdminVendorAuditScope; label: string }> = [
    { key: 'all', label: $localize`:@@admin.vendors.audit.scope.all:Everything` },
    { key: 'entity', label: $localize`:@@admin.vendors.audit.scope.entity:Done to this vendor` },
    { key: 'actor', label: $localize`:@@admin.vendors.audit.scope.actor:Done by its people` },
  ];

  protected readonly seats = computed<readonly AdminVendorSeatRow[]>(
    () => this.vendor()?.seats ?? [],
  );
  /** `null` seats means the roster query itself degraded — distinct from `[]`,
   *  which means the vendor genuinely has no seats. */
  protected readonly seatsUnavailable = computed(() => this.vendor()?.seats === null);

  /** The §5.2 payer test as one readable line — shared with `/admin/claims`. */
  protected readonly roleBreakdownLabel = productRolesLabel;

  /** Flipped once the browser has rendered. Every fetch on this page is
   *  browser-only (the shell's resolver is the SSR gate), and the tab-driven
   *  effect below must not fire during SSR. */
  private readonly hydrated = signal(false);

  constructor() {
    afterNextRender(() => {
      this.hydrated.set(true);
      void this.load();
      void this.loadAudit();
    });

    // Lazy per-tab loads. The audit trail is fetched up front because the page
    // reloads it after every write (an entitlement change, a seat revoke) and
    // therefore has to hold it regardless of which tab is open; Products has no
    // such coupling, so it waits until someone asks for it.
    effect(() => {
      if (this.hydrated() && this.tab() === 'products' && !this.productsRequested) {
        void this.loadProducts();
      }
    });
  }

  protected retry(): void {
    void this.load();
  }

  private async load(): Promise<void> {
    const id = this.vendorId();
    if (!id) {
      this.notFound.set(true);
      this.loading.set(false);
      return;
    }
    this.loading.set(true);
    this.loadFailed.set(false);
    this.notFound.set(false);
    try {
      this.vendor.set(await this.api.getVendor(id));
    } catch (err) {
      // A 404 is a different message from "we couldn't load it": one means the
      // id is wrong, the other means retrying might work.
      if (isStatus(err, 404)) this.notFound.set(true);
      else this.loadFailed.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  // ── Entitlement ────────────────────────────────────────────────────────────

  /** The control returns the committed readout, so the section updates with no
   *  refetch — the same reason the claim queue patches in place. */
  protected onEntitlementChanged(entitlement: VendorEntitlementResponse): void {
    this.vendor.update((v) => (v ? { ...v, entitlement, verified: entitlement.verified } : v));
    // The audit trail just gained a row. Reload it rather than leaving a page
    // that visibly disagrees with the action the operator just took.
    void this.loadAudit();
  }

  protected onAnnounce(message: string): void {
    this.liveMessage.set(message);
  }

  // ── Seats ──────────────────────────────────────────────────────────────────

  protected askRevoke(userId: string): void {
    this.revokeFailedMessage.set('');
    this.revokeConfirmId.set(userId);
  }

  protected cancelRevoke(): void {
    this.revokeConfirmId.set(null);
  }

  /**
   * Remove one seat.
   *
   * The row is dropped from the roster on success rather than refetched — the
   * server returns 204 with no body, and the seat is gone by definition. The
   * audit trail IS reloaded, because the revoke wrote a row to it.
   */
  protected async confirmRevoke(seat: AdminVendorSeatRow): Promise<void> {
    const id = this.vendorId();
    if (!id || this.revokePendingId()) return;
    this.revokePendingId.set(seat.user_id);
    this.revokeFailedMessage.set('');
    try {
      await this.api.revokeSeat(id, seat.user_id);
      this.vendor.update((v) =>
        v && v.seats ? { ...v, seats: v.seats.filter((s) => s.user_id !== seat.user_id) } : v,
      );
      this.revokeConfirmId.set(null);
      this.liveMessage.set(
        $localize`:@@admin.vendors.seats.announce.revoked:Seat removed for ${this.seatName(seat)}:NAME:. The vendor's entitlement and badge are unchanged.`,
      );
      void this.loadAudit();
    } catch (err) {
      this.revokeFailedMessage.set(
        isStatus(err, 404)
          ? $localize`:@@admin.vendors.seats.error.gone:That seat is already gone. Reload to see the current roster.`
          : $localize`:@@admin.vendors.seats.error.failed:Something went wrong. Please try again.`,
      );
    } finally {
      this.revokePendingId.set(null);
    }
  }

  /**
   * A seat was provisioned. Refetch the vendor rather than splicing the roster:
   * the response reports the write, not the resulting `AdminVendorSeatRow` (which
   * carries `display_name`, `work_email_verified` and the GoTrue-resolved email
   * this endpoint never looks up). The audit trail reloads too, because the
   * provision wrote a row to it.
   *
   * The `noop` case still refetches — cheap, and the roster on screen may be
   * stale in some other way if the seat already existed without being visible.
   */
  protected async onSeatProvisioned(): Promise<void> {
    await this.load();
    void this.loadAudit();
  }

  protected seatName(seat: AdminVendorSeatRow): string {
    return seat.display_name ?? $localize`:@@admin.vendors.seats.unnamed:Unnamed seat`;
  }

  /**
   * The seat's email, or why there isn't one.
   *
   * Three states, not two — this is the distinction whose absence caused a day of
   * confusion in production. `seat_emails_available === false` means the GoTrue
   * seam could not be reached at all, so a blank says nothing about the account;
   * `true` with no email means that account genuinely has none.
   */
  protected seatEmail(seat: AdminVendorSeatRow): string {
    if (seat.email) return seat.email;
    return this.vendor()?.seat_emails_available === false
      ? $localize`:@@admin.vendors.seats.emailUnavailable:Email unavailable`
      : $localize`:@@admin.vendors.seats.emailNone:No email on file`;
  }

  // ── Products ───────────────────────────────────────────────────────────────

  protected goToProductPage(page: number): void {
    this.productPage.set(page);
    void this.loadProducts();
  }

  protected retryProducts(): void {
    void this.loadProducts();
  }

  private async loadProducts(): Promise<void> {
    const id = this.vendorId();
    if (!id) return;
    this.productsRequested = true;
    this.productsLoading.set(true);
    this.productsFailed.set(false);
    try {
      const response = await this.api.listProducts(id, {
        page: this.productPage(),
        perPage: this.productPerPage,
      });
      this.productRows.set(response.data);
      this.productTotal.set(response.total);
    } catch {
      this.productsFailed.set(true);
      this.productRows.set([]);
      this.productTotal.set(0);
    } finally {
      this.productsLoading.set(false);
    }
  }

  // ── Audit ──────────────────────────────────────────────────────────────────

  protected setScope(scope: AdminVendorAuditScope): void {
    if (this.auditScope() === scope) return;
    this.auditScope.set(scope);
    // Scope change resets to page 1: staying on page 4 of a narrower result set
    // lands on an empty page that reads as "nothing happened".
    this.auditPage.set(1);
    void this.loadAudit();
  }

  protected goToAuditPage(page: number): void {
    this.auditPage.set(page);
    void this.loadAudit();
  }

  protected retryAudit(): void {
    void this.loadAudit();
  }

  private async loadAudit(): Promise<void> {
    const id = this.vendorId();
    if (!id) return;
    this.auditLoading.set(true);
    this.auditFailed.set(false);
    try {
      const response = await this.api.listAudit(id, {
        page: this.auditPage(),
        perPage: this.auditPerPage,
        scope: this.auditScope(),
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
}

/** Structural, not `instanceof`: the admin bundle is lazily split, so an
 *  `HttpErrorResponse` crossing a chunk boundary can fail an identity check. */
function isStatus(err: unknown, status: number): boolean {
  return typeof err === 'object' && err !== null && (err as { status?: unknown }).status === status;
}
