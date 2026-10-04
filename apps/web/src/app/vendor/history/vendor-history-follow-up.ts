import { Component, input } from '@angular/core';

import type { VendorHistoryItem } from '@aeci/shared';

/**
 * The search follow-up slot on one Changes row (AECI-1160,
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.19).
 *
 * Renders nothing today, on purpose. The per-URL search follow-up states (not
 * eligible, queued, submitted, failed, skipped) come from the search submission
 * log, which does not exist yet. Showing a guess here would be a claim about
 * search engines that nothing recorded.
 *
 * TODO(AECI-1187): once the submission log ships, read its rows for this audit
 * row's id (the causing audit id AECI-1184 adds) and render one state per URL and
 * channel. Copy says "submitted" or "requested" only. A Free vendor sees "No
 * expedited search submission". AECI-1160 stays open until this renders.
 */
@Component({
  selector: 'aec-vendor-history-follow-up',
  host: { class: 'contents', 'data-history-follow-up': '' },
  template: ``,
})
export class VendorHistoryFollowUp {
  readonly item = input.required<VendorHistoryItem>();
}
