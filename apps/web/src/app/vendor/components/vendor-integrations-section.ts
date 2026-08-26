import {
  Component,
  afterNextRender,
  afterRenderEffect,
  computed,
  inject,
  input,
  signal,
  viewChildren,
} from '@angular/core';

import type {
  DataObjectOption,
  ProductVersion,
  VendorClaim,
  VendorIntegration,
} from '@aeci/shared';

import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorApi } from '../vendor-api';
import { VendorPortalStore } from '../vendor-portal-store';

import { VendorIntegrationCard } from './vendor-integration-card';
import { VendorNotificationsList } from './vendor-notifications-list';

/**
 * The Integrations tab's body (AECI-606 / `STAGE_2_ATTESTATIONS_SPEC.md` §6):
 * every integration touching a product this vendor owns, what each side has said
 * about each data flow, and the controls to say something.
 *
 * ── WHY THIS FETCHES, WHEN THE DASHBOARD IS "PRESENTATIONAL" ────────────────
 * §6 says the dashboard component takes its payload as an input and must stay
 * that way, because it renders both `/preview/vendor-dashboard` and the gated
 * `/vendor` route. That holds — `VendorDashboardTabbed` still takes only `me`.
 * The rule lands one level down, exactly as it already does for
 * `vendor-seat-roster.ts` and `vendor-products-section.ts`: a child injects
 * `VendorApi`, and the preview shadows `VendorApi` through DI. So the same
 * component runs verbatim on both surfaces with no conditional code, and the
 * heavier read stays off every other tab's SSR path.
 *
 * ── STATE (AECI-628) ────────────────────────────────────────────────────────
 * The integration list is owned by {@link VendorPortalStore}, not by this
 * component: a revalidation loop has to be able to refresh it while the tab is
 * closed, and an optimistic attestation write has to be able to roll back to an
 * exact prior value that survives the `@switch` destroying this component.
 * Everything else about the reconciliation contract is unchanged.
 *
 * Writes reconcile from the echo (`POST`/`PUT` both return the recomputed claim,
 * agreement included), so there is no refetch on the common path; the echo is
 * spliced into the store through `apply(...).commit()`. `DELETE` is the
 * exception: it answers `204` with no body, and the claim cannot be
 * reconstructed locally, because `counterparty` is a *lossy* reduction of every
 * other voter — with a third vendor in play, dropping the caller's own row can
 * leave a genuine `conflict` that a local guess would render as `single_source`.
 * The contract is explicit that the dashboard never re-derives
 * `computeAgreement`. So a retract triggers one targeted re-read, and that read
 * stays HERE rather than becoming `store.revalidate(['integrations'])`: the
 * store would replace the whole list, and splicing the one claim by id is what
 * keeps a concurrent write on another claim from being clobbered.
 *
 * The vocabulary and per-product version lists are NOT store state. They are
 * lookup tables this tab uses to render its controls, they never change under
 * the reader, and they are read straight from `VendorApi` (which is also what
 * keeps the preview's DI shadow working for them).
 *
 * Per-claim busy/error state lives in `VendorAttestationControl`, one instance
 * per claim — the component boundary is the scoping mechanism, so there is no
 * map keyed by claim id to keep in sync.
 *
 * ── ANNOUNCEMENTS (AECI-631 / §6.3) ─────────────────────────────────────────
 * This tab used to own the surface's live region. It no longer does: the region
 * was hoisted to `vendor-dashboard-tabbed.ts` and this component announces
 * through {@link VendorPortalAnnouncer}. Two things made the move necessary
 * rather than cosmetic. The `@switch` in the shell DESTROYS this component on a
 * tab switch, taking a region mid-announcement with it; and the integration card
 * carried a second `role="status"` of its own, so one event could queue two
 * competing utterances.
 *
 * The wording still originates here, because this component is the one place
 * that sees every write's result and can therefore name the subject ("RFIs ·
 * position saved") rather than saying something vague. Only the channel moved.
 *
 * The loading and failure paragraphs are deliberately NOT live regions. They are
 * the state of this section, not announcements, and a `role="status"` on each
 * would put three regions back on the page. The block carries `aria-busy` while
 * it loads, and the one moment where silence would be wrong — a vendor pressing
 * "Try again" and getting no feedback — announces its outcome explicitly.
 *
 * ── NO LAYOUT SHIFT UNDER THE POINTER (§6.3) ────────────────────────────────
 * A revalidation that reflows the control the vendor is about to click is a
 * worse outcome than the staleness it fixes. Two properties hold that here, and
 * both are load-bearing rather than incidental. `loading()` is false while the
 * store reports `refreshing` — it distinguishes "no data yet" from "we have data
 * and are checking" precisely so a background fetch cannot swap the card list
 * for the loading paragraph or drop the summary line. And `@for` tracks by
 * `integration.id`, so a poll returning the same integrations patches the lanes
 * that changed instead of tearing down and rebuilding the list under the cursor.
 *
 * ── COPY ────────────────────────────────────────────────────────────────────
 * §6's discipline, enforced here and in `vendor-attestation-labels.ts`: no
 * instant-search promise, nothing implying attestation affects ranking or
 * placement, and "Verified" framed as an account status arranged with AEC
 * Integrations.
 */
@Component({
  selector: 'aec-vendor-integrations-section',
  imports: [VendorIntegrationCard, VendorNotificationsList],
  styles: [':host { display: block; }'],
  template: `
    <div class="space-y-6" [attr.aria-busy]="loading() ? 'true' : null">
      <p class="max-w-prose text-sm text-(--text-secondary)" i18n="@@vendor.attest.intro">
        These are the integrations we have on record for your products. Confirm the data flows that
        are real, and say so when one is not. The other vendor sees the same list from their side.
      </p>

      @if (canWrite() && loaded()) {
        <p class="text-sm text-(--text-secondary)">{{ summaryLine() }}</p>
      }

      @if (!canWrite()) {
        <!--
          The plan read-out itself lives ONCE, on the Overview panel
          (vendor-plan-panel.ts, AECI-614). This is only the local consequence, so
          it states what is closed here and does not restate the status chip.
        -->
        <div class="rounded-(--radius-md) border border-(--border-default) p-4">
          <p class="text-sm text-(--text-secondary)" i18n="@@vendor.attest.readOnly">
            You can review everything on record here. Confirming data flows and adding new ones
            opens up once your account is verified. Verification is an account status arranged with
            AEC Integrations, not something you switch on from this portal.
          </p>
        </div>
      }

      <aec-vendor-notifications-list />

      @if (loading()) {
        <!--
          No role="status" here: this is the section's state, not an
          announcement, and the surface has exactly one announcement channel
          (the shell's region). aria-busy on the wrapper above is what tells
          assistive tech this block is still settling.
        -->
        <p class="text-sm text-(--text-secondary)" i18n="@@vendor.attest.loading">
          Loading your integrations…
        </p>
      } @else if (failed()) {
        <div class="space-y-2">
          <p class="text-sm text-(--text-primary)" i18n="@@vendor.attest.failed">
            Could not load your integrations.
          </p>
          <button
            type="button"
            [class]="retryClass"
            (click)="reload()"
            i18n="@@vendor.attest.retry"
          >
            Try again
          </button>
        </div>
      } @else if (integrations().length === 0) {
        <p class="max-w-prose text-sm text-(--text-secondary)" i18n="@@vendor.attest.empty">
          No integrations are on record for your products yet. AEC Integrations adds integrations
          from public sources; when one appears you can confirm what data it moves.
        </p>
      } @else {
        @if (dataObjectsFailed() && canWrite()) {
          <p class="text-sm text-(--text-secondary)" i18n="@@vendor.attest.vocabularyFailed">
            The data object list could not be loaded, so new data flows cannot be added right now.
          </p>
        }
        <div class="space-y-6">
          @for (integration of integrations(); track integration.id) {
            <aec-vendor-integration-card
              [integration]="integration"
              [vendorName]="vendorName()"
              [canWrite]="canWrite()"
              [dataObjects]="dataObjects()"
              [versions]="versionsFor(integration)"
              (claimChanged)="onClaimChanged($event)"
              (claimCreated)="onClaimCreated($event)"
              (retracted)="onRetracted($event)"
            />
          }
        </div>
      }
    </div>
  `,
})
export class VendorIntegrationsSection {
  private readonly api = inject(VendorApi);
  private readonly store = inject(VendorPortalStore);
  private readonly announcer = inject(VendorPortalAnnouncer);

  readonly verified = input.required<boolean>();
  readonly vendorName = input.required<string>();

  private readonly cards = viewChildren(VendorIntegrationCard);

  protected readonly integrations = this.store.integrations;
  protected readonly loading = this.store.integrationsLoading;
  protected readonly failed = this.store.integrationsFailed;
  protected readonly dataObjects = signal<readonly DataObjectOption[]>([]);
  protected readonly dataObjectsFailed = signal(false);
  protected readonly versionsByProduct = signal<ReadonlyMap<string, readonly ProductVersion[]>>(
    new Map(),
  );

  /** Set after a create or a pivot; consumed once the lane exists. */
  private readonly pendingFocusClaimId = signal<string | null>(null);

  protected readonly canWrite = computed(() => this.verified());
  protected readonly loaded = computed(() => !this.loading() && !this.failed());

  protected readonly summaryLine = computed(() => {
    const claims = this.integrations().flatMap((i) => i.claims);
    const awaiting = claims.filter((c) => c.mine.length === 0).length;
    return $localize`:@@vendor.attest.summary:${claims.length}:total: data flows on record · ${awaiting}:awaiting: waiting on your confirmation`;
  });

  protected readonly retryClass =
    'rounded-(--radius-sm) border border-(--border-default) px-3 py-1.5 text-sm font-medium text-(--text-primary) transition-colors hover:border-(--border-strong) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';

  constructor() {
    afterNextRender(() => void this.load('ensure'));

    // `afterRenderEffect`, not `afterNextRender`: focus has to move repeatedly —
    // after every create and every duplicate pivot — and only once the lane it
    // targets actually exists.
    afterRenderEffect(() => {
      const claimId = this.pendingFocusClaimId();
      if (!claimId) return;
      for (const card of this.cards()) card.focusClaim(claimId);
      this.pendingFocusClaimId.set(null);
    });
  }

  protected versionsFor(integration: VendorIntegration): readonly ProductVersion[] {
    // The caller's OWN endpoint product only. §8.2 requires a version stamp to
    // belong to the attesting side's endpoint, so offering the counterpart's
    // releases here would generate guaranteed 400s.
    return this.versionsByProduct().get(integration.context_product.id) ?? [];
  }

  /**
   * The retry beside the failure state. It announces its outcome because it is
   * the one path where the section's own state paragraphs are not enough: the
   * vendor deliberately pressed a button, and the loading/failure text is not a
   * live region, so without this a retry is silent for a screen-reader user.
   */
  protected reload(): void {
    void this.load('reload').then(() => {
      this.announcer.announce(
        this.failed()
          ? $localize`:@@vendor.attest.live.reloadFailed:Your integrations could not be loaded.`
          : $localize`:@@vendor.attest.live.reloaded:Your integrations are up to date.`,
      );
    });
  }

  /**
   * `ensure` on mount (the store may already hold the list from an earlier visit
   * to this tab), `reload` from the retry button. The two secondary reads are
   * component-local, so they run on both paths.
   */
  private async load(mode: 'ensure' | 'reload'): Promise<void> {
    await (mode === 'ensure'
      ? this.store.ensure('integrations')
      : this.store.reload('integrations'));
    if (this.store.integrationsFailed()) return;

    // Both secondary reads degrade without blocking the list: an unseeded
    // vocabulary or a versions outage removes an affordance, it does not remove
    // the surface.
    void this.loadVocabulary();
    void this.loadVersions();
  }

  private async loadVocabulary(): Promise<void> {
    try {
      const res = await this.api.getDataObjects();
      this.dataObjects.set(res.data_objects);
      this.dataObjectsFailed.set(res.data_objects.length === 0);
    } catch {
      this.dataObjectsFailed.set(true);
    }
  }

  private async loadVersions(): Promise<void> {
    const productIds = [...new Set(this.integrations().map((i) => i.context_product.id))];
    const results = await Promise.allSettled(
      productIds.map(
        async (id) => [id, (await this.api.listProductVersions(id)).versions] as const,
      ),
    );
    const next = new Map<string, readonly ProductVersion[]>();
    for (const result of results) {
      if (result.status === 'fulfilled') next.set(result.value[0], result.value[1]);
    }
    this.versionsByProduct.set(next);
  }

  /** Splice one claim in place, leaving every other object identity untouched so
   *  `@for`'s `track claim.id` only rebuilds the lane that actually changed.
   *
   *  `commit()` because the patch IS the server's answer: these all come from a
   *  write echo or a targeted re-read, so there is nothing left to reconcile. */
  private applyClaim(claim: VendorClaim, mode: 'replace' | 'append'): void {
    this.store
      .apply('integrations', (list) =>
        list.map((integration) => {
          if (integration.id !== claim.integration_id) return integration;
          const claims =
            mode === 'append'
              ? [...integration.claims, claim]
              : integration.claims.map((c) => (c.id === claim.id ? claim : c));
          return { ...integration, claims };
        }),
      )
      .commit();
  }

  protected onClaimChanged(claim: VendorClaim): void {
    this.applyClaim(claim, 'replace');
    this.announcer.announce(
      $localize`:@@vendor.attest.live.saved:${claim.data_object_name}:dataObject: · position saved.`,
    );
  }

  protected onClaimCreated(claim: VendorClaim): void {
    // Appended, not re-sorted: the new lane appears directly above the form the
    // vendor just used, where their attention already is.
    this.applyClaim(claim, 'append');
    this.announcer.announce(
      $localize`:@@vendor.attest.live.added:${claim.data_object_name}:dataObject: · data flow added.`,
    );
    this.pendingFocusClaimId.set(claim.id);
  }

  protected async onRetracted(claimId: string): Promise<void> {
    this.announcer.announce($localize`:@@vendor.attest.live.cleared:Position withdrawn.`);
    // See the header: a 204 carries nothing to reconcile from, and the agreement
    // must not be guessed. One targeted re-read, spliced by id so a concurrent
    // write on another claim is not clobbered.
    try {
      const res = await this.api.getIntegrations();
      const fresh = res.integrations.flatMap((i) => i.claims).find((claim) => claim.id === claimId);
      if (fresh) this.applyClaim(fresh, 'replace');
      else this.store.apply('integrations', () => res.integrations).commit();
    } catch {
      // The write committed; only the refresh failed. Leave the list as it is
      // rather than showing a stale claim as an error.
    }
  }
}
