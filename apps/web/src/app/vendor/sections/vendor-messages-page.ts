import { Component, inject } from '@angular/core';

import { AecCard } from '../../shared/card/card';
import { VendorContestsList } from '../components/vendor-contests-list';
import { VendorPairRightsList } from '../components/vendor-pair-rights-list';
import { VendorDocsLink } from '../components/vendor-docs-link';
import { VendorNotificationsList } from '../components/vendor-notifications-list';
import { VendorNudgeMuteToggle } from '../components/vendor-nudge-mute-toggle';
import { VendorRequestStatus } from '../components/vendor-request-status';
import { VendorPortalStore } from '../vendor-portal-store';

/**
 * `…/messages` (AECI-666) — everything addressed to the COMPANY rather than to
 * one of its products: where its claim and correction requests stand, and the
 * attestation nudges it has been sent.
 *
 * ── WHY THIS SECTION EXISTS ─────────────────────────────────────────────────
 * Both of these already shipped, in two unrelated places: claim/correction status
 * sat on Vendor Overview, and the notification archive sat *inside* the
 * Integrations tab, which is where you would look for it last. A vendor asking
 * "what has happened to us lately?" had to know to check two sections, one of
 * them by opening a collapsed disclosure inside a third thing. This is that
 * question given a place, and it takes Integrations' slot in the nav row now that
 * integrations are filed under the product they touch.
 *
 * ── WHAT THIS IS DELIBERATELY NOT ───────────────────────────────────────────
 * Not an inbox. `STAGE_2_REALTIME_SPEC.md` §6.2's substantive rule is unchanged
 * and is the reason: **these rows are historical, not live state.** The
 * notification rows are a 90-day archive of what was *recorded*, emailed or not
 * (`GET /api/vendor/notifications` reads `audit_log` `action='notification.sent'`
 * — decision §1.3(6), there is no notifications table), so a three-week-old
 * "Vendors disagree" row can sit above a claim whose badge now reads `confirmed`.
 * Rendered as current state, this surface would contradict itself.
 *
 * So: no banner, no unread badge, no auto-expand, and no "mark as read". The
 * "N new" count stays session-scoped and stays inside the disclosure's summary
 * line, exactly as {@link VendorNotificationBaseline} defines it. Giving the
 * archive a nav item is a *findability* change, not a promotion of historical
 * rows to live assertions — and the distinction is the whole of §6.2's argument.
 *
 * Requests are different in kind and are shown above: `vendor_requests` rows ARE
 * current state, they come down on `GET /api/vendor/me`, and they carry a
 * resolved/unresolved status the vendor can act on.
 *
 * The daily reminder email switch (AECI-1204) sits directly above the archive it
 * governs, because the two answer one question: "how do these reminders reach me".
 * It mutes the caller's own seat's digest email; the archive below keeps every
 * reminder either way.
 *
 * Field contests (AECI-1008) sit between the two for the same reason: each row
 * carries a status the vendor acts on (accept, decline, withdraw), so they are
 * current state and render open, not inside the archive's disclosure. Their
 * events ALSO appear in the archive as history, which is not a duplicate: the
 * archive says what happened when, the contests block says where each one
 * stands now.
 */
@Component({
  selector: 'aec-vendor-messages-page',
  imports: [
    AecCard,
    VendorPairRightsList,
    VendorContestsList,
    VendorDocsLink,
    VendorNotificationsList,
    VendorNudgeMuteToggle,
    VendorRequestStatus,
  ],
  template: `
    @if (me(); as m) {
      <!-- AECI-1812: each block is the shared white card (the contests list, the
           reminder switch and the archive carry their own), 32px apart. -->
      <div class="space-y-8">
        <div>
          <h2 i18n="@@vendor.section.messages">Messages</h2>
          <p
            class="mt-2 text-sm leading-relaxed text-(--text-secondary)"
            i18n="@@vendor.messages.intro.contests"
          >
            Updates about your company: where your claim and correction requests stand, the change
            requests you have sent or received, and the reminders we have sent you about your
            integrations.
          </p>
          <p class="mt-2"><aec-vendor-docs-link page="notifications-and-messages" /></p>
        </div>

        <section aecCard [class]="'p-6'" aria-labelledby="vendor-requests-heading">
          <h3 id="vendor-requests-heading" i18n="@@vendor.section.requests">
            Claim &amp; correction status
          </h3>
          <p class="mt-2"><aec-vendor-docs-link page="claiming-your-listing" /></p>
          <div class="mt-4">
            <aec-vendor-request-status [requests]="m.requests" />
          </div>
        </section>

        <aec-vendor-contests-list />

        <!-- AECI-2042: removals and reports on Sync Service pairs. -->
        <aec-vendor-pair-rights-list />

        <div class="space-y-6">
          <aec-vendor-nudge-mute-toggle />
          <aec-vendor-notifications-list />
        </div>
      </div>
    }
  `,
  styles: [':host { display: block; }'],
})
export class VendorMessagesPage {
  protected readonly me = inject(VendorPortalStore).me;
}
