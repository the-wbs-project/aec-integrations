import { Component, LOCALE_ID, computed, inject, input } from '@angular/core';

import type {
  VendorHistoryFollowUp as FollowUpLine,
  VendorHistoryItem,
  VendorSearchChannel,
  VendorSearchFollowUpState,
} from '@aeci/shared';

import { historyPlanIsManaged, historyTimeFormatter } from './vendor-history-labels';

/**
 * The vendor-edit actions that can change a public page, and so would queue it for
 * search submission on Managed. The vendor writes that pass a recrawl to
 * `afterVendorWrite` (`apps/api/src/routes/vendor-shared.ts`). "Looks right",
 * seats, contests and replies change no public page and never queue a URL, so a
 * Free row of theirs gets no "No expedited search submission" line either.
 */
const LISTING_ACTIONS: ReadonlySet<string> = new Set([
  'vendor.updated',
  'product.updated',
  'product_version.created',
  'product_version.updated',
  'product_version.deleted',
  'claim.created',
  'attestation.created',
  'attestation.retracted',
  'integration.created',
  'integration.claimed',
  'integration.updated',
  'integration.link_set',
  'integration.link_removed',
  'integration.retired',
  'integration.restored',
  'integration.contest.accepted',
]);

/** One affected URL and its line per channel. */
interface FollowUpUrl {
  readonly url: string;
  readonly path: string;
  readonly lines: readonly FollowUpLine[];
}

/** The page path of an absolute URL, for display. The full URL stays the link. */
function displayPath(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}` || url;
  } catch {
    return url;
  }
}

export function followUpChannelLabel(channel: VendorSearchChannel): string {
  return channel === 'google'
    ? $localize`:@@vendor.history.followUp.channel.google:Google`
    : $localize`:@@vendor.history.followUp.channel.indexnow:IndexNow (Bing and others)`;
}

/**
 * What we did with one URL on one channel. Never what a search engine did with
 * it: "submitted" and "requested" only, never "indexed" or "ranked".
 */
export function followUpStateLabel(
  state: VendorSearchFollowUpState,
  channel: VendorSearchChannel,
): string {
  switch (state) {
    case 'queued':
      return channel === 'google'
        ? $localize`:@@vendor.history.followUp.state.queuedGoogle:Queued for AECi to request a Google re-crawl`
        : $localize`:@@vendor.history.followUp.state.queued:Queued for the next daily send`;
    case 'submitted':
      return $localize`:@@vendor.history.followUp.state.submitted:Submitted`;
    case 'requested':
      return $localize`:@@vendor.history.followUp.state.requested:Re-crawl requested in Google Search Console`;
    default:
      return $localize`:@@vendor.history.followUp.state.failed:Submission failed`;
  }
}

/** The reason under a failed line: what IndexNow answered, and what happens next. */
export function followUpFailureDetail(line: FollowUpLine): string {
  const answer =
    line.http_status === null
      ? $localize`:@@vendor.history.followUp.failed.noAnswer:IndexNow did not answer.`
      : $localize`:@@vendor.history.followUp.failed.status:IndexNow answered with HTTP ${line.http_status}:STATUS:.`;
  const next = line.retrying
    ? $localize`:@@vendor.history.followUp.failed.retrying:We will try again at the next daily send.`
    : $localize`:@@vendor.history.followUp.failed.final:We are not trying again.`;
  return `${answer} ${next}`;
}

/**
 * The search follow-up on one Changes row (AECI-1160,
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.19).
 *
 * The page reads `GET /api/vendor/history/follow-up` once per page and hands each
 * row its own lines, joined on the row's audit id. Three outcomes:
 *
 * - lines: one entry per affected URL, with one line per channel: queued,
 *   submitted, failed or requested, and when;
 * - no lines, a vendor edit to the listing made on Free: "No expedited search
 *   submission". IndexNow and the Google worklist are Managed-only
 *   (`STAGE_2_PAID_TIERS_SPEC.md` §13.1a);
 * - otherwise nothing. No line is better than a guess about search engines.
 */
@Component({
  selector: 'aec-vendor-history-follow-up',
  host: { class: 'block', 'data-history-follow-up': '' },
  template: `
    @if (urls().length > 0) {
      <div class="mt-3 max-w-[60ch] text-xs" data-follow-up-lines>
        <p class="font-semibold text-(--text-secondary)" [id]="headingId()">
          <span i18n="@@vendor.history.followUp.heading">Search follow-up</span>
        </p>
        <ul class="mt-1 space-y-2" [attr.aria-labelledby]="headingId()">
          @for (entry of urls(); track entry.url) {
            <li data-follow-up-url>
              <a
                class="break-all font-medium text-(--text-primary) underline underline-offset-2"
                [href]="entry.url"
                >{{ entry.path }}</a
              >
              <ul class="mt-1 space-y-1">
                @for (line of entry.lines; track line.channel) {
                  <li
                    class="text-(--text-secondary)"
                    [attr.data-channel]="line.channel"
                    [attr.data-state]="line.state"
                  >
                    <span class="font-medium text-(--text-primary)">{{
                      channelLabel(line.channel)
                    }}</span
                    >: {{ stateLabel(line) }},
                    <time class="tabular-nums" [attr.datetime]="line.at">{{
                      timeLabel(line)
                    }}</time>
                    @if (line.state === 'failed') {
                      <span class="block" data-follow-up-failure>{{ failureDetail(line) }}</span>
                    }
                  </li>
                }
              </ul>
            </li>
          }
        </ul>
      </div>
    } @else if (notEligible()) {
      <div class="mt-3 max-w-[60ch] text-xs text-(--text-secondary)" data-follow-up-not-eligible>
        <p class="font-semibold text-(--text-primary)" i18n="@@vendor.history.followUp.notEligible">
          No expedited search submission
        </p>
        <p class="mt-0.5" i18n="@@vendor.history.followUp.notEligible.detail">
          Sending changed pages to search engines is part of Managed. Search engines still find the
          change on their own schedule.
        </p>
      </div>
    }
  `,
})
export class VendorHistoryFollowUp {
  readonly item = input.required<VendorHistoryItem>();
  /** This row's lines from the page's one follow-up read. Empty while loading. */
  readonly lines = input<readonly FollowUpLine[]>([]);

  private readonly time = historyTimeFormatter(inject(LOCALE_ID));

  protected readonly headingId = computed(() => `history-follow-up-${this.item().id}`);

  /** The lines grouped by URL, in the order the API sent them (URL, then channel). */
  protected readonly urls = computed<readonly FollowUpUrl[]>(() => {
    const byUrl = new Map<string, FollowUpLine[]>();
    for (const line of this.lines()) {
      const list = byUrl.get(line.url);
      if (list) list.push(line);
      else byUrl.set(line.url, [line]);
    }
    return [...byUrl].map(([url, lines]) => ({ url, path: displayPath(url), lines }));
  });

  /** A listing edit by the vendor's team, made on Free: nothing was submitted. */
  protected readonly notEligible = computed(() => {
    const item = this.item();
    return (
      item.actor_kind === 'your_team' &&
      item.plan !== null &&
      !historyPlanIsManaged(item.plan) &&
      LISTING_ACTIONS.has(item.action)
    );
  });

  protected channelLabel(channel: VendorSearchChannel): string {
    return followUpChannelLabel(channel);
  }

  protected stateLabel(line: FollowUpLine): string {
    return followUpStateLabel(line.state, line.channel);
  }

  protected failureDetail(line: FollowUpLine): string {
    return followUpFailureDetail(line);
  }

  protected timeLabel(line: FollowUpLine): string {
    return this.time.format(new Date(line.at));
  }
}
