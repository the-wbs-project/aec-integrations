/**
 * `VendorPortalStore` (AECI-628 / RT-3) — the single owner of vendor-portal
 * state, and the seam every later Real-Time sub-issue writes through.
 *
 * ── WHY A STORE AT ALL ──────────────────────────────────────────────────────
 * Before this, three sections each fetched their own endpoint in
 * `afterNextRender` and kept the answer in a private signal
 * (`vendor-seat-roster.ts`, `vendor-integrations-section.ts`,
 * `vendor-notifications-list.ts`). That is fine for a page that loads once and
 * never changes underneath the reader. AECI-516 makes the portal revalidate on a
 * cadence (RT-4) and mutate optimistically (RT-5), and both need ONE owner: a
 * poll cannot "refresh the integrations tab" if the integrations tab is the only
 * thing that has ever seen the list, and an optimistic patch cannot be rolled
 * back to an exact prior value if the prior value lives in a component that the
 * tab switch already destroyed.
 *
 * ── WHY IT IS NOT `providedIn: 'root'` ──────────────────────────────────────
 * The dev-only preview (`preview/vendor-dashboard/`) shadows {@link VendorApi}
 * with `PreviewVendorApi` in a COMPONENT `providers` array, so the fixture-backed
 * fake is only visible from the element injector down. A root-provided store
 * would resolve `VendorApi` from the root environment injector instead, walk
 * straight past the shadow, and fire real network calls from a preview route that
 * has no vendor session. So the store is provided by the two surface owners that
 * also own the API binding: `VendorPage` (the real gated route) and
 * `VendorDashboardPreview`. That also keeps portal state out of the app-wide
 * injector, which matters because `/vendor` is the one never-edge-cached surface
 * and none of this may leak into a cacheable SSR component.
 *
 * ── SSR ─────────────────────────────────────────────────────────────────────
 * The store NEVER fetches on its own. `seed()` is a synchronous signal write fed
 * by `vendorMeResolver`'s already-resolved payload, and every network path
 * (`ensure` / `revalidate` / `reload`) is only reachable from `afterNextRender`
 * or a user event. Nothing here touches `window` or `document`.
 *
 * ── THE RULE THAT IS EASY TO GET WRONG ──────────────────────────────────────
 * A revalidation must never clobber an in-flight edit. A section with unsaved
 * changes registers itself with {@link markDirty}; while it is registered, a
 * refetch of the resource behind it is STASHED rather than applied, the section
 * is reported by {@link isStale}, and the user gets an explicit
 * {@link reload} to take the server's copy. Silently replacing a half-typed form
 * with server state is worse than being stale.
 *
 * Deferral is necessarily per RESOURCE, not per section: `profile`, `products`
 * and `requests` are three sections of ONE `GET /api/vendor/me` payload, so
 * holding one holds all three. `reload(section)` therefore discards the unsaved
 * edits of that whole section. Under the §8.1 concierge onboarding model that is
 * roughly one actively-editing seat per vendor, so two sections dirty at once is
 * not a launch scenario; a section that keeps its edits anyway (the form-local
 * guard in `vendor-profile-form.ts` / `vendor-product-form.ts`) re-registers as
 * dirty on its next change.
 */
import {
  Injectable,
  computed,
  inject,
  signal,
  type Signal,
  type WritableSignal,
} from '@angular/core';

import type {
  VendorIntegration,
  VendorMeResponse,
  VendorNotification,
  VendorSeat,
  VendorSeatInvite,
} from '@aeci/shared';

import { VendorApi } from './vendor-api';

/**
 * The client scope vocabulary from `docs/STAGE_2_REALTIME_SPEC.md` §3 — the same
 * six keys `GET /api/vendor/updates` reports a cursor for (AECI-627), so a caller
 * can hand the store exactly the scopes the cursor said moved.
 */
export type VendorPortalScope =
  | 'profile'
  | 'entitlement'
  | 'products'
  | 'integrations'
  | 'notifications'
  | 'requests';

/** What the store actually holds, one per endpoint. Four scopes collapse onto
 *  `me` because they are four views of one payload. */
export type VendorPortalResource = 'me' | 'integrations' | 'notifications' | 'seats';

/** A user-facing section: the granularity at which unsaved edits are registered
 *  and at which a "reload this section" affordance is offered. */
export type VendorPortalSection =
  | 'profile'
  | 'products'
  | 'integrations'
  | 'notifications'
  | 'seats';

/**
 * Per-resource load state. Each resource gets its own because each has its own
 * endpoint and its own failure mode: an outage on `GET /api/vendor/seats` must
 * not make the integrations tab look broken.
 *
 * `refreshing` is deliberately distinct from `loading`: a background
 * revalidation of data we already hold must not blank the surface.
 */
export type VendorPortalStatus = 'idle' | 'loading' | 'refreshing' | 'loaded' | 'failed';

/** The shape behind each resource key, so {@link VendorPortalStore.apply} can be
 *  generic without any caller reaching for a cast. */
export interface VendorPortalData {
  me: VendorMeResponse | null;
  integrations: readonly VendorIntegration[];
  notifications: readonly VendorNotification[];
  seats: readonly VendorSeat[];
}

/**
 * The handle {@link VendorPortalStore.apply} returns. An optimistic write ends
 * exactly one of three ways, and saying which is not optional — an unsettled
 * handle is a patch nobody ever confirmed.
 *
 * Shaped for AECI-630's attestation toggles: apply the local patch, then either
 * `reconcile()` against the `PUT` echo (which carries the recomputed
 * `agreement`, so the echo is the truth) or `rollback()` to the exact prior
 * value with a visible error.
 */
export interface VendorPortalMutation<T> {
  /** The server answered. Take its value (or splice it in) and settle. */
  reconcile(next: T | ((current: T) => T)): void;
  /**
   * The write failed. Restore the value captured before the patch.
   *
   * If anything else wrote the same resource in the meantime, the snapshot is no
   * longer a safe thing to restore (it would silently undo the other write), so
   * this falls back to re-reading the resource from the server instead of
   * guessing.
   */
  rollback(): void;
  /** The patch stands as applied. Settle without another write. */
  commit(): void;
}

/** Scope → the one endpoint that answers it. Four-to-one on `me` is the dedupe
 *  the §3 refetch map asks for. */
const SCOPE_RESOURCE: Readonly<Record<VendorPortalScope, VendorPortalResource>> = {
  profile: 'me',
  entitlement: 'me',
  products: 'me',
  requests: 'me',
  integrations: 'integrations',
  notifications: 'notifications',
};

/** Section → the resource whose refetch would replace what that section renders. */
const SECTION_RESOURCE: Readonly<Record<VendorPortalSection, VendorPortalResource>> = {
  profile: 'me',
  products: 'me',
  integrations: 'integrations',
  notifications: 'notifications',
  seats: 'seats',
};

const SECTIONS = Object.keys(SECTION_RESOURCE) as readonly VendorPortalSection[];

// Intentionally NOT `providedIn: 'root'`: see the "WHY IT IS NOT root" note in
// the header. The store is provided by `VendorPage` and `VendorDashboardPreview`
// so it resolves the same `VendorApi` binding its surface does.
// eslint-disable-next-line @angular-eslint/use-injectable-provided-in -- surface-scoped so the preview's VendorApi shadow applies
@Injectable()
export class VendorPortalStore {
  private readonly api = inject(VendorApi);

  // ── State ────────────────────────────────────────────────────────────────
  private readonly state = {
    me: signal<VendorMeResponse | null>(null),
    integrations: signal<readonly VendorIntegration[]>([]),
    notifications: signal<readonly VendorNotification[]>([]),
    seats: signal<readonly VendorSeat[]>([]),
  };

  private readonly statuses: Readonly<
    Record<VendorPortalResource, WritableSignal<VendorPortalStatus>>
  > = {
    me: signal<VendorPortalStatus>('idle'),
    integrations: signal<VendorPortalStatus>('idle'),
    notifications: signal<VendorPortalStatus>('idle'),
    seats: signal<VendorPortalStatus>('idle'),
  };

  /**
   * Bumped on EVERY write to a resource, from any path. It is what lets
   * {@link VendorPortalMutation.rollback} tell "nothing happened since my patch,
   * the snapshot is safe" from "someone else wrote, unwinding would corrupt".
   */
  private readonly versions: Record<VendorPortalResource, number> = {
    me: 0,
    integrations: 0,
    notifications: 0,
    seats: 0,
  };

  /** Fresh server payloads held back because a dirty section is rendering the
   *  resource they would replace. Values are read back through {@link adoptStash}. */
  private readonly stashed = signal<ReadonlyMap<VendorPortalResource, unknown>>(new Map());

  /**
   * Sections with unsaved edits, keyed by section then by an owner token.
   *
   * The owner token exists because "products" is not one form: the section
   * renders one `VendorProductForm` per owned product, and a bare
   * `clearDirty('products')` from a clean sibling would drop a dirty form's
   * registration and let the next poll overwrite it. Callers with one instance
   * per section (the profile form) let it default to the section name.
   */
  private readonly dirty = signal<ReadonlyMap<VendorPortalSection, ReadonlySet<string>>>(new Map());

  /** Resources that have completed at least one successful read, so a later
   *  refetch reports `refreshing` rather than blanking the surface. */
  private readonly loadedOnce = new Set<VendorPortalResource>();

  /** One in-flight request per resource. Two overlapping `revalidate` calls for
   *  the same endpoint share this promise instead of racing two round trips. */
  private readonly inFlight = new Map<VendorPortalResource, Promise<void>>();

  // ── Public reads ─────────────────────────────────────────────────────────

  /** `GET /api/vendor/me`: vendor + entitlement + owned products + request
   *  status. `null` until {@link seed} runs (a non-vendor never gets this far). */
  readonly me: Signal<VendorMeResponse | null> = this.state.me.asReadonly();
  readonly integrations: Signal<readonly VendorIntegration[]> =
    this.state.integrations.asReadonly();
  readonly notifications: Signal<readonly VendorNotification[]> =
    this.state.notifications.asReadonly();
  readonly seats: Signal<readonly VendorSeat[]> = this.state.seats.asReadonly();

  /**
   * The two other halves of `GET /api/vendor/seats` (AECI-664 / §11a).
   *
   * Plain signals rather than entries in `state`, deliberately: they arrive on
   * the SAME fetch as the roster, so they already share its status, its version
   * counter and its dirty-section deferral. Giving them their own resource keys
   * would add three kinds of bookkeeping to express one thing that cannot load
   * separately.
   *
   * `canManageSeats` is the SERVER's verdict on the caller's `profiles.seat_owner`
   * — never re-derived here from the roster. The UI's enabled state and the 403
   * its write would get have to come from one source, the same rule
   * `vendor-capabilities.ts` follows for entitlement capabilities.
   */
  private readonly invites = signal<readonly VendorSeatInvite[]>([]);
  private readonly manageSeats = signal(false);
  readonly seatInvites: Signal<readonly VendorSeatInvite[]> = this.invites.asReadonly();
  readonly canManageSeats: Signal<boolean> = this.manageSeats.asReadonly();

  readonly meStatus: Signal<VendorPortalStatus> = this.statuses.me.asReadonly();
  readonly integrationsStatus: Signal<VendorPortalStatus> = this.statuses.integrations.asReadonly();
  readonly notificationsStatus: Signal<VendorPortalStatus> =
    this.statuses.notifications.asReadonly();
  readonly seatsStatus: Signal<VendorPortalStatus> = this.statuses.seats.asReadonly();

  /** "Nothing to show yet". `idle` counts: a lazy section paints its loading
   *  state during SSR, before `afterNextRender` has asked for anything. */
  readonly integrationsLoading = computed(() => isPending(this.integrationsStatus()));
  readonly notificationsLoading = computed(() => isPending(this.notificationsStatus()));
  readonly seatsLoading = computed(() => isPending(this.seatsStatus()));

  readonly meFailed = computed(() => this.meStatus() === 'failed');
  readonly integrationsFailed = computed(() => this.integrationsStatus() === 'failed');
  readonly notificationsFailed = computed(() => this.notificationsStatus() === 'failed');
  readonly seatsFailed = computed(() => this.seatsStatus() === 'failed');

  // ── Seeding ──────────────────────────────────────────────────────────────

  /**
   * Adopt the payload `vendorMeResolver` already fetched (SSR, or TransferState
   * on hydration). The store never re-fetches `me` on load: doing so would spend
   * a second round trip on data that is in the HTML.
   *
   * A re-seed is a fresh navigation, not a background poll, so it applies even
   * over a dirty section. Handed the identical object it already holds, it is a
   * no-op, which is what keeps the resolver re-emitting on hydration from
   * resetting anything.
   */
  seed(me: VendorMeResponse): void {
    if (this.state.me() === me) return;
    this.write('me', me);
    this.loadedOnce.add('me');
    this.statuses.me.set('loaded');
    this.dropStash('me');
  }

  // ── Loading ──────────────────────────────────────────────────────────────

  /**
   * Load a resource if it has never been asked for. This is what the lazy
   * sections call from `afterNextRender`: the seat roster and the integrations
   * list are only mounted when their tab is open, and re-opening a tab should not
   * re-fetch what the store already holds.
   */
  ensure(resource: VendorPortalResource): Promise<void> {
    if (this.statuses[resource]() !== 'idle') {
      return this.inFlight.get(resource) ?? Promise.resolve();
    }
    return this.fetch(resource);
  }

  /**
   * Refetch whatever the given scopes map onto. `profile`, `entitlement`,
   * `products` and `requests` collapse to a single `GET /api/vendor/me`, and two
   * overlapping calls for the same endpoint share one request.
   *
   * Resolves once every affected request has settled. It never rejects: a failed
   * resource reports `failed` on its own status and leaves the last good value in
   * place, because a poll that empties the screen on one bad response is worse
   * than a poll that misses a beat.
   */
  revalidate(scopes: readonly VendorPortalScope[]): Promise<void> {
    const resources = new Set(scopes.map((scope) => SCOPE_RESOURCE[scope]));
    return Promise.all([...resources].map((resource) => this.fetch(resource))).then(
      () => undefined,
    );
  }

  /**
   * The user-triggered "give me the current state of this section": the retry
   * beside a failed read, and the "reload this section" affordance beside a
   * deferred one.
   *
   * Discards the section's unsaved-edit registration first (that is what the
   * affordance promises), then takes the stashed payload if there is one — the
   * stash IS the fresh server state, so re-requesting it would only add latency
   * and a second chance to fail.
   */
  async reload(section: VendorPortalSection): Promise<void> {
    this.clearSectionDirty(section);
    const resource = SECTION_RESOURCE[section];
    if (this.isHeld(resource)) return; // another dirty section still holds it
    if (this.adoptStash(resource)) return;
    await this.fetch(resource);
  }

  // ── Optimistic mutation ──────────────────────────────────────────────────

  /**
   * Apply a local patch to a resource and hand back the handle that either
   * reconciles it against the server's echo or unwinds it.
   *
   * Also the plain "write this echo into the store" primitive: apply the splice
   * and `commit()` it, for a write whose response IS the truth.
   */
  apply<R extends VendorPortalResource>(
    resource: R,
    patch: (current: VendorPortalData[R]) => VendorPortalData[R],
  ): VendorPortalMutation<VendorPortalData[R]> {
    const snapshot = this.read(resource);
    this.write(resource, patch(snapshot));
    const versionAtApply = this.versions[resource];
    let settled = false;
    const settle = (): boolean => {
      if (settled) return false;
      settled = true;
      return true;
    };

    return {
      reconcile: (next) => {
        if (!settle()) return;
        const value =
          typeof next === 'function'
            ? (next as (current: VendorPortalData[R]) => VendorPortalData[R])(this.read(resource))
            : next;
        this.write(resource, value);
      },
      rollback: () => {
        if (!settle()) return;
        if (this.versions[resource] === versionAtApply) {
          this.write(resource, snapshot);
          return;
        }
        // Something else wrote this resource after the patch landed, so the
        // snapshot would undo their write too. Ask the server instead of guessing.
        void this.fetch(resource);
      },
      commit: () => {
        settle();
      },
    };
  }

  // ── Unsaved-edit registration ────────────────────────────────────────────

  /** Register unsaved edits. While registered, a refetch of the resource behind
   *  this section is stashed instead of applied. */
  markDirty(section: VendorPortalSection, owner: string = section): void {
    this.dirty.update((current) => {
      const owners = current.get(section);
      if (owners?.has(owner)) return current;
      const next = new Map(current);
      next.set(section, new Set([...(owners ?? []), owner]));
      return next;
    });
  }

  /** Drop one owner's registration (a save landed, or the edits were reverted). */
  clearDirty(section: VendorPortalSection, owner: string = section): void {
    this.dirty.update((current) => {
      const owners = current.get(section);
      if (!owners?.has(owner)) return current;
      const remaining = new Set(owners);
      remaining.delete(owner);
      const next = new Map(current);
      if (remaining.size === 0) next.delete(section);
      else next.set(section, remaining);
      return next;
    });
  }

  /** Whether the section (or one specific owner within it) has unsaved edits. */
  isDirty(section: VendorPortalSection, owner?: string): boolean {
    const owners = this.dirty().get(section);
    if (!owners) return false;
    return owner === undefined ? owners.size > 0 : owners.has(owner);
  }

  /**
   * Sections holding unsaved edits over data the server has since changed — the
   * "Updated elsewhere, reload this section" affordance.
   *
   * Scoped to the dirty owner on purpose. A stash on `me` makes the profile AND
   * products data stale, but only the editor that caused the deferral can act on
   * it, and offering a button to someone whose click cannot do anything (because
   * a sibling still holds the resource) is worse than saying nothing.
   */
  isStale(section: VendorPortalSection, owner: string = section): boolean {
    return this.stashed().has(SECTION_RESOURCE[section]) && this.isDirty(section, owner);
  }

  /** Every section currently reporting {@link isStale} for its default owner. */
  readonly staleSections = computed<ReadonlySet<VendorPortalSection>>(() => {
    const held = this.stashed();
    const dirty = this.dirty();
    const out = new Set<VendorPortalSection>();
    for (const section of SECTIONS) {
      if (held.has(SECTION_RESOURCE[section]) && (dirty.get(section)?.size ?? 0) > 0) {
        out.add(section);
      }
    }
    return out;
  });

  // ── Internals ────────────────────────────────────────────────────────────

  /**
   * One request per resource at a time. `runFetch` never rejects, so the
   * bookkeeping below cannot leave an unhandled rejection behind.
   */
  private fetch(resource: VendorPortalResource): Promise<void> {
    const existing = this.inFlight.get(resource);
    if (existing) return existing;

    const tracked = this.runFetch(resource);
    this.inFlight.set(resource, tracked);
    void tracked.finally(() => {
      if (this.inFlight.get(resource) === tracked) this.inFlight.delete(resource);
    });
    return tracked;
  }

  private async runFetch(resource: VendorPortalResource): Promise<void> {
    const status = this.statuses[resource];
    status.set(this.loadedOnce.has(resource) ? 'refreshing' : 'loading');
    try {
      switch (resource) {
        case 'me':
          this.receive('me', await this.api.getMe());
          break;
        case 'integrations':
          this.receive('integrations', (await this.api.getIntegrations()).integrations);
          break;
        case 'notifications':
          this.receive('notifications', (await this.api.getNotifications()).notifications);
          break;
        case 'seats': {
          const payload = await this.api.getSeats();
          this.receive('seats', payload.seats);
          // Defaulted, not assumed. The SSR Worker and the API Worker deploy
          // separately, so during a rollout a new bundle can briefly talk to an
          // API that predates AECI-664 and answers without these two fields.
          // Defaulting degrades the section to "roster only, no controls" — the
          // pre-664 surface — instead of throwing inside the template and taking
          // the whole Seats section down. Fail closed on the capability bit.
          this.invites.set(payload.pending_invites ?? []);
          this.manageSeats.set(payload.can_manage_seats ?? false);
          break;
        }
      }
      this.loadedOnce.add(resource);
      status.set('loaded');
    } catch {
      // Keep whatever we already hold. A failed refresh is a stale surface, not
      // an empty one.
      status.set('failed');
    }
  }

  /** The deferral rule, in one place: a resource a dirty section is rendering is
   *  stashed, never applied. */
  private receive<R extends VendorPortalResource>(resource: R, next: VendorPortalData[R]): void {
    if (this.isHeld(resource)) {
      this.stashed.update((current) => new Map(current).set(resource, next));
      return;
    }
    this.write(resource, next);
    this.dropStash(resource);
  }

  private isHeld(resource: VendorPortalResource): boolean {
    for (const [section, owners] of this.dirty()) {
      if (owners.size > 0 && SECTION_RESOURCE[section] === resource) return true;
    }
    return false;
  }

  private adoptStash(resource: VendorPortalResource): boolean {
    const value = this.stashed().get(resource);
    if (value === undefined) return false;
    this.write(resource, value as VendorPortalData[typeof resource]);
    this.dropStash(resource);
    return true;
  }

  private dropStash(resource: VendorPortalResource): void {
    if (!this.stashed().has(resource)) return;
    this.stashed.update((current) => {
      const next = new Map(current);
      next.delete(resource);
      return next;
    });
  }

  private clearSectionDirty(section: VendorPortalSection): void {
    if (!this.dirty().has(section)) return;
    this.dirty.update((current) => {
      const next = new Map(current);
      next.delete(section);
      return next;
    });
  }

  private read<R extends VendorPortalResource>(resource: R): VendorPortalData[R] {
    return this.signalFor(resource)();
  }

  private write<R extends VendorPortalResource>(resource: R, value: VendorPortalData[R]): void {
    this.signalFor(resource).set(value);
    this.versions[resource] += 1;
  }

  /**
   * The one cast in this file. `this.state[resource]` is a union of four
   * `WritableSignal`s; TypeScript cannot prove the indexed access lines up with
   * `VendorPortalData[R]`, even though it does by construction. Isolating it here
   * keeps every call site — and every consumer of `apply()` — cast-free.
   */
  private signalFor<R extends VendorPortalResource>(
    resource: R,
  ): WritableSignal<VendorPortalData[R]> {
    return this.state[resource] as unknown as WritableSignal<VendorPortalData[R]>;
  }
}

/** Nothing to render yet: never asked, or asked and still waiting. A background
 *  `refreshing` is deliberately excluded — it has data behind it. */
function isPending(status: VendorPortalStatus): boolean {
  return status === 'idle' || status === 'loading';
}
