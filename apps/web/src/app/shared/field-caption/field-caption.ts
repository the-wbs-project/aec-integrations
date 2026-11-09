import { formatDate } from '@angular/common';
import { Component, LOCALE_ID, computed, inject, input } from '@angular/core';

import { isHttpsUrl, type FieldCaption, type FieldCorrection } from '@aeci/shared';

import type { ExternalLinkContext, ExternalLinkSourceEntityType } from '../../analytics/analytics';
import { ExternalLinkTracker } from '../../analytics/external-link-tracker';
import { NewTabIcon } from '../new-tab-icon/new-tab-icon';

/** The page a caption sits on, for the source link's click event. */
export interface FieldCaptionPage {
  /** The `external_link_clicked` `source`: `product_detail`, `pair_detail`, `vendor_detail`. */
  readonly surface: string;
  readonly entityType: ExternalLinkSourceEntityType;
  readonly entityId: string;
}

/**
 * The **field caption** (AECI-1614; `STAGE_2_VENDOR_PORTAL_SPEC.md` §4.5.8): one quiet line
 * under a group of fields that says who wrote them and when. It is the group-level
 * companion of the page-level `MaintenanceMarker`, which it does not replace.
 *
 *   - `caption`: "Maintained by {vendor} · updated {date}" or "Maintained by {vendor} until
 *     {date}". The server picks the form and the date from a real vendor write or a plan
 *     end, never `updated_at` or `last_reviewed_at`.
 *   - `correction`: "Corrected by AEC Integrations on {date}", then the source link when
 *     one is recorded. `label` names the field where the line cannot sit under one value,
 *     such as the vendor page's row of company facts. A correction that cleared the value
 *     (`cleared`, AECI-1628) reads "Removed by AEC Integrations on {date}" instead, in the
 *     slot the value would fill. Same muted line, same source rule.
 *
 * **Attribution, never endorsement.** Muted small text with no fill, border, chip or badge.
 * It must not read as a trust signal, a status or an ad. That is why this is not a chip
 * like the marker: the marker labels a whole record once, and this repeats down a page.
 *
 * **Text colour.** `--text-secondary` passes AA on every surface this sits on: base, raised,
 * Bone and a hovered table row. `--text-tertiary` fails on muted and sunken ones.
 *
 * **Visitor-neutral.** A pure function of its inputs, with no cookie, session or clock, so
 * it belongs in the edge-cached HTML. The date is formatted in UTC, the same as
 * `MaintenanceMarker`: the SSR Worker runs in UTC and the browser does not, and a local
 * format would render two dates either side of midnight and trip a hydration mismatch.
 *
 * **Renders nothing when it has nothing to say.** A null input, or a date that does not
 * parse, leaves the host `[hidden]`, so a parent's `space-y-*` rhythm is undisturbed.
 *
 * Block spans rather than paragraphs, because a table row mounts this inside a `<span>`.
 */
@Component({
  selector: 'aec-field-caption',
  imports: [ExternalLinkTracker, NewTabIcon],
  host: { class: 'block', '[hidden]': '!maintained() && !corrected()' },
  template: `
    @if (maintained(); as text) {
      <span class="block text-xs leading-5 text-(--text-secondary)" data-testid="field-caption">{{
        text
      }}</span>
    }
    @if (corrected(); as text) {
      <span class="block text-xs leading-5 text-(--text-secondary)" data-testid="field-correction"
        >{{ text }}
        @if (sourceHref(); as href) {
          <span aria-hidden="true">·</span>&ngsp;
          <!-- The citation role (DESIGN.md, "The Link Treatment Rule"). A third party's
               page, so the new-tab cue and the full external rel. -->
          <a
            [href]="href"
            target="_blank"
            rel="noopener nofollow"
            [aecTrackExternalLink]="page().surface"
            [aecLinkContext]="sourceLinkContext()"
            data-testid="field-correction-source"
            class="inline-flex items-center gap-1 rounded-(--radius-sm) font-medium underline
              decoration-(--border-strong) underline-offset-4 transition-colors
              hover:text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2
              focus-visible:outline-(--accent-primary)"
            ><span
              ><ng-container i18n="@@fieldCaption.source.link">Source</ng-container
              ><span class="sr-only" i18n="@@fieldCaption.source.link.sr">
                for this correction</span
              ></span
            ><aec-new-tab-icon
          /></a>
        }
      </span>
    }
  `,
})
export class FieldCaptionLine {
  /** The "Maintained by" form. Absent or `null` renders no such line. */
  readonly caption = input<FieldCaption | null | undefined>(null);
  /** The "Corrected by" form. Absent or `null` renders no such line. */
  readonly correction = input<FieldCorrection | null | undefined>(null);
  /** Names the corrected field where the line cannot sit under that one value. */
  readonly label = input<string | null>(null);
  /** The page this sits on, reported with a click on the source link. */
  readonly page = input.required<FieldCaptionPage>();

  private readonly locale = inject(LOCALE_ID);

  protected readonly maintained = computed<string | null>(() => {
    const caption = this.caption();
    if (!caption || caption.vendor_names.length === 0) return null;
    const date = this.formatted(caption.date);
    if (date === null) return null;
    const vendors = new Intl.ListFormat(this.locale, {
      style: 'long',
      type: 'conjunction',
    }).format(caption.vendor_names);
    return caption.form === 'until'
      ? $localize`:@@fieldCaption.maintained.until:Maintained by ${vendors}:VENDORS: until ${date}:DATE:`
      : $localize`:@@fieldCaption.maintained.updated:Maintained by ${vendors}:VENDORS: · updated ${date}:DATE:`;
  });

  protected readonly corrected = computed<string | null>(() => {
    const correction = this.correction();
    if (!correction) return null;
    const date = this.formatted(correction.date);
    if (date === null) return null;
    const label = this.label();
    // AECI-1628: a correction that cleared the value sits in the value's empty slot.
    if (correction.cleared) {
      return label
        ? $localize`:@@fieldCaption.removed.labelled:${label}:FIELD:: Removed by AEC Integrations on ${date}:DATE:`
        : $localize`:@@fieldCaption.removed:Removed by AEC Integrations on ${date}:DATE:`;
    }
    return label
      ? $localize`:@@fieldCaption.corrected.labelled:${label}:FIELD:: Corrected by AEC Integrations on ${date}:DATE:`
      : $localize`:@@fieldCaption.corrected:Corrected by AEC Integrations on ${date}:DATE:`;
  });

  /** https only. A stored value that is anything else renders the date alone. */
  protected readonly sourceHref = computed<string | null>(() => {
    const url = this.correction()?.source_url;
    return url && isHttpsUrl(url) ? url : null;
  });

  /**
   * Who runs a source site is unknown, so the owner is `null` and the origin is AECi. That
   * keeps the click out of every vendor's Delivered count (`VENDOR_PERFORMANCE_SPEC.md` §3.2).
   */
  protected readonly sourceLinkContext = computed<ExternalLinkContext>(() => ({
    owner_vendor_id: null,
    link_origin: 'aeci',
    source_entity_type: this.page().entityType,
    source_entity_id: this.page().entityId,
    link_purpose: 'source',
  }));

  private formatted(at: string): string | null {
    const parsed = new Date(at);
    if (Number.isNaN(parsed.getTime())) return null;
    return formatDate(parsed, 'MMMM d, y', this.locale, 'UTC');
  }
}
