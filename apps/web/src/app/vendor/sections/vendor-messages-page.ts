import { Component, inject } from '@angular/core';

import { VendorNotificationsList } from '../components/vendor-notifications-list';
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
 * notification rows are a 90-day archive of what was *emailed*
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
 */
@Component({
  selector: 'aec-vendor-messages-page',
  imports: [VendorNotificationsList, VendorRequestStatus],
  template: `
    @if (me(); as m) {
      <div class="space-y-8">
        <div>
          <h2
            class="font-display text-xl font-semibold text-(--text-primary)"
            i18n="@@vendor.section.messages"
          >
            Messages
          </h2>
          <p
            class="mt-2 max-w-prose text-sm leading-relaxed text-(--text-secondary)"
            i18n="@@vendor.messages.intro"
          >
            Updates about your company: where your claim and correction requests stand, and the
            reminders we have emailed you about your integrations.
          </p>
        </div>

        <div>
          <h3
            class="font-display text-lg font-semibold text-(--text-primary)"
            i18n="@@vendor.section.requests"
          >
            Claim &amp; correction status
          </h3>
          <div class="mt-4">
            <aec-vendor-request-status [requests]="m.requests" />
          </div>
        </div>

        <aec-vendor-notifications-list />
      </div>
    }
  `,
  styles: [':host { display: block; }'],
})
export class VendorMessagesPage {
  protected readonly me = inject(VendorPortalStore).me;
}
