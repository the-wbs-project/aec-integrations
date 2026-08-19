/**
 * `VendorNotificationBaseline` (AECI-631 / `docs/STAGE_2_REALTIME_SPEC.md` §6.2)
 * — what "new" means on the notifications disclosure, and nothing else.
 *
 * ── WHAT IT IS ALLOWED TO CLAIM ─────────────────────────────────────────────
 * §6.2's Rule 2 is binding: the notification rows are a 90-day `audit_log`
 * archive of nudges that were EMAILED, not live state. A three-week-old "Vendors
 * disagree" row rendered as an assertion about now would sit above a lane whose
 * badge reads `confirmed`, and the surface would contradict itself.
 *
 * The one honest claim is therefore about THIS SESSION: "these rows were not
 * here when you opened the portal". That is a fact about the session, verifiable
 * from data the session itself observed, and it survives being wrong about the
 * world because it never describes the world. So the baseline is the set of ids
 * present at the first successful load, held in memory, and a row is "new" when
 * it is not in that set.
 *
 * Expressed as a set rather than "the newest row's timestamp" for one reason:
 * it needs no assumption about ordering or about clocks. Same answer while the
 * list is newest-first (which it is), still the right answer if a later change
 * pages or re-sorts it, and no comparison between a server timestamp and the
 * browser's clock — the two are not the same clock.
 *
 * **No `localStorage`, no cookie, no cross-session claim.** "You have 3 unread"
 * across reloads would be a read-state assertion this system has nowhere to
 * store and no way to keep true; §6.2 asks for a count, and only a count.
 *
 * ── WHY IT IS A ROOT SERVICE AND NOT COMPONENT STATE ────────────────────────
 * The disclosure lives inside the Integrations tab, and the shell's `@switch`
 * destroys that whole subtree whenever the vendor looks at Products. A baseline
 * captured in the component would therefore be re-captured on every tab switch,
 * from a list that by then already includes the rows that arrived while the tab
 * was closed — so the count would silently reset to zero exactly in the case it
 * exists to report. The revalidation loop refreshes notifications regardless of
 * which tab is open, so that case is the normal one, not an edge.
 *
 * Root is safe here in a way {@link VendorPortalStore} deliberately is not: this
 * injects nothing, fetches nothing, and has no `VendorApi` binding that the
 * preview's DI shadow could resolve wrongly. It is also never populated during
 * SSR — capture only happens once a client fetch has reported `loaded` — so
 * nothing about it can reach a cacheable SSR response.
 *
 * ── THE VENDOR KEY ──────────────────────────────────────────────────────────
 * Root state outlives the route. Signing out and back in as a different vendor
 * without a page reload would otherwise measure the new vendor's rows against
 * the old vendor's baseline, and since no id would match, every row would count
 * as new. Capturing against a vendor key makes that a re-capture instead of a
 * false claim.
 */
import { Service, signal } from '@angular/core';

@Service()
export class VendorNotificationBaseline {
  private readonly captured = signal<{ key: string; ids: ReadonlySet<string> } | null>(null);

  /**
   * The ids the vendor already had when their list first loaded this session,
   * or `null` before the first successful load (when "new" is not yet a question
   * that can be answered, and the count must read zero rather than "everything").
   */
  ids(key: string): ReadonlySet<string> | null {
    const current = this.captured();
    return current !== null && current.key === key ? current.ids : null;
  }

  /**
   * Capture the baseline. Idempotent per vendor: the FIRST successful load wins,
   * so a later refetch that brings new rows in cannot quietly re-baseline them
   * away.
   */
  capture(key: string, ids: Iterable<string>): void {
    if (this.captured()?.key === key) return;
    this.captured.set({ key, ids: new Set(ids) });
  }
}
