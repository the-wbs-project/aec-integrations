import { DatePipe } from '@angular/common';
import { Component, afterNextRender, computed, effect, inject, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';

import { isAttestationNotification, type VendorNotification } from '@aeci/shared';

import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorNotificationBaseline } from '../vendor-notification-baseline';
import { VendorPortalStore } from '../vendor-portal-store';

import { detectorTitle } from './vendor-attestation-labels';
import {
  contestFieldLabelLoose,
  contestNotificationNote,
  contestNotificationTitle,
} from './vendor-contest-labels';

/**
 * The in-portal notification list (AECI-606 rendering AECI-302's
 * `GET /api/vendor/notifications`; `STAGE_2_ATTESTATIONS_SPEC.md` §7.2 —
 * "surfaced on the §6 tab").
 *
 * ── WHY IT IS A COLLAPSED DISCLOSURE ────────────────────────────────────────
 * These rows are not live state. The endpoint reads the §7.3 `audit_log` ledger
 * of nudges that were **emailed**, over a 90-day window — "a historical record
 * of a nudge, and it stays accurate even after the underlying claim is
 * re-curated". Rendered prominently, a three-week-old "Vendors disagree" row
 * would sit above a lane whose badge now reads `confirmed`, and the surface
 * would visibly contradict itself. Collapsed, with the framing sentence inside,
 * it is a mail archive — which is what it is. Promoting this to a banner
 * reintroduces the contradiction.
 *
 * Reads through {@link VendorPortalStore} (AECI-628, the `vendor-seat-roster.ts`
 * pattern): the list, its load state and its retry are owned there so a
 * revalidation can bring new nudges in without a reload, and so re-opening the
 * tab does not re-request a 90-day archive that has not changed. The endpoint is
 * not account-access-gated, and a failure degrades to a retry rather than taking the
 * tab down.
 *
 * ── "N NEW", AND WHY IT IS ONLY THAT (AECI-631 / §6.2) ──────────────────────
 * The list can now grow under the reader, so it needs to say when it has. The
 * whole of that affordance is a count appended to the summary line:
 * "Recent notifications (5) · 2 new". Explicitly NOT a banner, NOT a badge above
 * the fold, NOT an auto-expand, and NOT a claim about current state, because the
 * paragraphs above are the reason: promoting a historical row to a live
 * assertion is what makes the surface contradict itself. A count of rows that
 * arrived during this session is a fact about this session, which is a claim
 * this component can actually keep. What "new" means, and where the baseline
 * lives so a tab switch cannot reset it, is {@link VendorNotificationBaseline}.
 *
 * The count is appended INSIDE the existing summary line rather than added as a
 * row of its own, which is also what keeps §6.3's no-layout-shift rule: the
 * disclosure's height does not change when the count appears, so nothing below
 * it moves under a pointer that is already on its way to a control.
 *
 * There is deliberately no "mark as read" and no reset when the disclosure is
 * opened. Both would be assertions about what the vendor has READ, which is
 * cross-session state this system has nowhere to keep and no way to keep true.
 */
@Component({
  selector: 'aec-vendor-notifications-list',
  imports: [DatePipe, RouterLink],
  styles: [':host { display: block; }'],
  template: `
    <details class="rounded-(--radius-md) border border-(--border-default) px-4 py-3">
      <summary class="cursor-pointer text-sm font-medium text-(--text-primary)">
        {{ summaryLabel() }}
        <!--
          The whole of the "new" affordance (§6.2): a count, on the line that is
          already there. It says how many rows arrived during this session, which
          is a fact about the session, and it says nothing about whether any of
          them still describes the current state of a lane.
        -->
        @if (newLabel(); as label) {
          <span class="font-normal text-(--text-secondary)">
            <span aria-hidden="true">·</span>
            {{ label }}
          </span>
        }
      </summary>

      <div class="mt-3 space-y-3" [attr.aria-busy]="loading() ? 'true' : null">
        <p
          class="max-w-prose text-xs text-(--text-secondary)"
          i18n="@@vendor.attest.notify.framing.contests"
        >
          What we sent you about these integrations in the last 90 days: the reminders we emailed,
          updates on field contests, and what owners changed on integrations with your products.
          Only the reminders were emailed. Each note reflects the state at the time it was sent.
        </p>

        @if (loading()) {
          <!--
            Not a live region. The surface has exactly one announcement channel
            (the dashboard shell's region, AECI-631); this is the state of one
            disclosure, and aria-busy above is how that is expressed.
          -->
          <p class="text-sm text-(--text-secondary)" i18n="@@vendor.attest.notify.loading">
            Loading notifications…
          </p>
        } @else if (failed()) {
          <div class="space-y-2">
            <p class="text-sm text-(--text-primary)" i18n="@@vendor.attest.notify.failed">
              Could not load your notifications.
            </p>
            <button
              type="button"
              [class]="retryClass"
              (click)="reload()"
              i18n="@@vendor.attest.notify.retry"
            >
              Try again
            </button>
          </div>
        } @else if (visible().length === 0) {
          <p class="text-sm text-(--text-secondary)" i18n="@@vendor.attest.notify.empty">
            No notifications in the last 90 days.
          </p>
        } @else {
          <ul class="m-0 list-none space-y-3 p-0">
            @for (notification of visible(); track notification.id) {
              <li class="border-t border-(--border-default) pt-3 first:border-t-0 first:pt-0">
                <p class="font-label text-sm text-(--text-primary)">
                  {{ titleFor(notification) }}
                </p>
                @if (noteFor(notification); as note) {
                  <p class="mt-0.5 max-w-prose text-xs text-(--text-primary)">{{ note }}</p>
                }
                <p class="mt-0.5 text-xs text-(--text-secondary)">
                  @for (part of detailParts(notification); track $index) {
                    <span>{{ part }}</span>
                    <span aria-hidden="true"> · </span>
                  }
                  <span>{{ notification.created_at | date: 'mediumDate' }}</span>
                </p>
                @if (notification.pair_path; as path) {
                  <a
                    [routerLink]="path"
                    class="mt-1 inline-block text-xs font-medium text-(--accent-primary) underline"
                    i18n="@@vendor.attest.notify.viewPair"
                    >View the integration page</a
                  >
                }
              </li>
            }
          </ul>
        }
      </div>
    </details>
  `,
})
export class VendorNotificationsList {
  private readonly store = inject(VendorPortalStore);
  private readonly baseline = inject(VendorNotificationBaseline);
  private readonly announcer = inject(VendorPortalAnnouncer);

  protected readonly notifications = this.store.notifications;
  protected readonly loading = this.store.notificationsLoading;
  protected readonly failed = this.store.notificationsFailed;

  /**
   * Every row with a title, which since AECI-961 is every row the endpoint can
   * return.
   *
   * This used to drop `aeci-denied` defensively: that detector was ops-only, its
   * ledger rows carried `vendorId: null`, and a row reaching a vendor would have
   * rendered with an empty title. AECI-961 renamed it `claim-denied` and gave it
   * a **counterparty** finding, so its vendor-addressed rows are now a real,
   * expected part of this list and `detectorTitle` has real copy for it. The ops
   * row still carries `vendorId: null` and still cannot match a caller, which is
   * a server-side property, not something this filter was ever enforcing.
   *
   * The empty-title guard is kept rather than removed. It is the one thing that
   * stops a detector added later, before its copy is written, from rendering a
   * blank row here.
   *
   * Contest rows (AECI-1008) are rendered too, titled by {@link titleFor} from
   * their event, and so are claim rows (AECI-1005). Only an attestation row can
   * have an empty title, so the guard applies to that member alone.
   */
  protected readonly visible = computed(() =>
    this.notifications().filter((n) => !isAttestationNotification(n) || titleOf(n) !== ''),
  );

  protected readonly summaryLabel = computed(() => {
    const count = this.visible().length;
    return count === 0
      ? $localize`:@@vendor.attest.notify.summary.empty:Recent notifications`
      : $localize`:@@vendor.attest.notify.summary:Recent notifications (${count}:count:)`;
  });

  /**
   * Which vendor the baseline belongs to. `me` is seeded synchronously by the
   * surface owner, so this is populated before the first load can complete; the
   * fallback only exists so the type is not nullable, and a baseline captured
   * under it would be replaced the moment a real vendor id appeared.
   */
  private readonly vendorKey = computed(() => this.store.me()?.vendor.id ?? 'unknown-vendor');

  /**
   * Rows that were not there when the list first loaded this session. Zero until
   * the baseline exists, which is the honest answer while the first load is
   * still in flight: with nothing to compare against, everything would otherwise
   * count as new.
   */
  protected readonly newCount = computed(() => {
    const seen = this.baseline.ids(this.vendorKey());
    if (seen === null) return 0;
    return this.visible().reduce((total, row) => (seen.has(row.id) ? total : total + 1), 0);
  });

  /** The count as it appears on the summary line; `null` when there is nothing
   *  to say, so the line is unchanged rather than carrying a "0 new". */
  protected readonly newLabel = computed<string | null>(() => {
    const count = this.newCount();
    if (count === 0) return null;
    return $localize`:@@vendor.attest.notify.new:${count}:count: new`;
  });

  protected readonly retryClass =
    'rounded-(--radius-sm) border border-(--border-default) px-3 py-1.5 text-sm font-medium text-(--text-primary) transition-colors hover:border-(--border-strong) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';

  constructor() {
    afterNextRender(() => void this.store.ensure('notifications'));

    // Capture the session baseline the first time a real list lands. Gated on
    // the store's status rather than on the array being non-empty, so a vendor
    // whose archive is genuinely empty still gets a baseline (and therefore a
    // count when the first nudge arrives) instead of waiting forever.
    effect(() => {
      if (this.store.notificationsStatus() !== 'loaded') return;
      untracked(() =>
        this.baseline.capture(
          this.vendorKey(),
          this.visible().map((row) => row.id),
        ),
      );
    });
  }

  protected titleFor(notification: VendorNotification): string {
    return titleOf(notification);
  }

  protected noteFor(notification: VendorNotification): string | null {
    return noteOf(notification);
  }

  /** The secondary line before the date. An attestation row names the data flow
   *  and the counterpart; a contest row names the field and the integration. */
  protected detailParts(notification: VendorNotification): readonly string[] {
    if (isAttestationNotification(notification)) {
      return [notification.data_object?.name, notification.counterpart_product?.name].filter(
        (part): part is string => !!part,
      );
    }
    if (
      notification.kind === 'integration_claim' ||
      notification.kind === 'integration_retire' ||
      notification.kind === 'integration_create'
    ) {
      return [notification.owner_name, notification.integration_name].filter(
        (part): part is string => !!part,
      );
    }
    if (notification.kind === 'integration_update') {
      const fields = notification.fields.map(contestFieldLabelLoose).join(', ');
      return [notification.owner_name, notification.integration_name, fields].filter(
        (part): part is string => !!part,
      );
    }
    return [contestFieldLabelLoose(notification.field), notification.integration_name].filter(
      (part): part is string => !!part,
    );
  }

  /**
   * The retry beside the failure state. It announces its outcome through the
   * surface's one live region (§6.3): the loading and failure paragraphs are
   * deliberately not live regions, so without this a keyboard or screen-reader
   * user pressing "Try again" would get no feedback at all.
   */
  protected reload(): void {
    void this.store.reload('notifications').then(() => {
      this.announcer.announce(
        this.failed()
          ? $localize`:@@vendor.attest.notify.live.failed:Your notifications could not be loaded.`
          : $localize`:@@vendor.attest.notify.live.reloaded:Notifications updated.`,
      );
    });
  }
}

/** One title rule for every union member. The ownership rows (AECI-1005,
 *  AECI-1006, AECI-1010) are written from the other endpoint vendor's seat, which
 *  is the only seat they reach; the wording is AECI-1023's. */
function titleOf(notification: VendorNotification): string {
  if (isAttestationNotification(notification)) return detectorTitle(notification.detector);
  if (notification.kind === 'integration_claim') {
    return $localize`:@@vendor.claim.notify.claimed:The owner claimed an integration on your product`;
  }
  if (notification.kind === 'integration_retire') {
    return notification.event === 'retired'
      ? $localize`:@@vendor.retire.notify.retired:The owner retired an integration on your product`
      : $localize`:@@vendor.retire.notify.restored:The owner restored an integration on your product`;
  }
  if (notification.kind === 'integration_update') {
    return $localize`:@@vendor.integrationEdit.notify.updated:The owner edited an integration on your product`;
  }
  if (notification.kind === 'integration_create') {
    return $localize`:@@vendor.integrationCreate.notify.created:Another company added an integration with your product`;
  }
  return contestNotificationTitle(notification.event);
}

/**
 * The sentence under an ownership or contest title that says what the event means
 * for the recipient (AECI-1023), or `null`. Attestation rows have none: their
 * detector titles already carry the ask. Every sentence here is true of every row
 * of its kind, which is why `accepted` has no note (see
 * {@link contestNotificationNote}).
 */
function noteOf(notification: VendorNotification): string | null {
  if (isAttestationNotification(notification)) return null;
  switch (notification.kind) {
    case 'integration_claim':
      return $localize`:@@vendor.claim.notify.note:The owner now keeps this integration's details, and AEC Integrations no longer updates them. If the owner on file is wrong, contest the Owner field on the integration.`;
    case 'integration_retire':
      return notification.event === 'retired'
        ? $localize`:@@vendor.retire.notify.note.retired:It is no longer shown on the public site. Nothing was deleted, and the owner can restore it.`
        : $localize`:@@vendor.retire.notify.note.restored:It is back on the public site as it was before it was retired.`;
    case 'integration_create':
      return $localize`:@@vendor.integrationCreate.notify.note:It is already live on the public site, and the company that added it owns it. If a detail is wrong, contest that field on the integration.`;
    case 'integration_update':
      return $localize`:@@vendor.integrationEdit.notify.note:The changes are already live on the public integration page. If one is wrong, contest that field on the integration.`;
    case 'contest':
      return contestNotificationNote(notification.event);
  }
}
