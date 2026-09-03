import { Injectable, signal } from '@angular/core';

/**
 * The channel a `/admin` **detail** screen uses to tell the shell's breadcrumb
 * what its entity is called (AECI-777).
 *
 * The trail itself is derived from the route (`admin-breadcrumb.ts`), which is
 * enough for every nav-able screen: the URL names the section and
 * `ADMIN_NAV_GROUPS` names the group and the label. It is NOT enough for the
 * four parameterised routes, where the last crumb wants "Acme Corp" rather than
 * a uuid — and the entity is loaded by the child component, in `afterNextRender`,
 * long after the shell rendered. Hence a store, on the same
 * layout-talks-to-outlet arrangement as `AdminSummaryStore`.
 *
 * ── WHY THE ENTRY CARRIES THE ID ─────────────────────────────────────────────
 * A published label outlives the navigation that produced it: nothing clears it
 * when the operator leaves `/admin/vendors/abc` for `/admin/users/xyz`, and the
 * new screen does not publish until its own fetch resolves. A bare
 * `signal<string>` would therefore show the previous entity's name in the new
 * page's trail for the length of one round trip — the exact stale-label bug this
 * shape exists to make impossible.
 *
 * So the entry carries the **id it describes**, and the breadcrumb uses the
 * label only when that id matches the current URL's last segment. A stale entry
 * cannot match, so it degrades to the section's fallback word rather than
 * lying. That is a structural guarantee rather than a lifecycle one: no
 * clear-on-navigate effect to forget, and no ordering dependency between the
 * outgoing screen's teardown and the incoming screen's fetch.
 *
 * Ids are opaque strings taken straight from the URL, so no entity type needs to
 * be modelled here — two screens can only be confused by publishing the same id,
 * which across four disjoint id spaces does not happen.
 */
@Injectable({ providedIn: 'root' })
export class AdminBreadcrumbStore {
  /** Null until a detail screen publishes. */
  private readonly _entry = signal<{ id: string; label: string } | null>(null);

  /** The published entity label, with the id it describes. */
  readonly entry = this._entry.asReadonly();

  /**
   * Publish the loaded entity's display name. Called by the four detail screens
   * once their fetch resolves; a blank label is ignored so a half-loaded entity
   * cannot blank the crumb.
   */
  publish(id: string, label: string): void {
    const trimmed = label.trim();
    if (!trimmed) return;
    this._entry.set({ id, label: trimmed });
  }
}
