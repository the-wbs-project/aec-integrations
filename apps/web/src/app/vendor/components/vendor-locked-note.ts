import { Component, computed, input } from '@angular/core';

import { isHttpsUrl, type LockedField } from '@aeci/shared';

import { NewTabIcon } from '../../shared/new-tab-icon/new-tab-icon';

/**
 * The line under a field AEC Integrations corrected and locked (AECI-1237,
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §11d.5): who set it and AECi's vendor-visible
 * reason. The field itself renders read-only; the host points its
 * `aria-describedby` at `noteId`, so a screen reader hears why it cannot be edited.
 *
 * The dispute route is §11d.4: email support@aecintegrations.com. A lock is lifted only by
 * AECi, so the line says so rather than offering an action the vendor cannot take.
 *
 * The reason reaches only the vendor holding the lock (AECI-1668, §11d.5). Another vendor
 * that sees the record, such as the other endpoint of an integration, gets `reason` as
 * `null`. Its note then says who set the value and links the source, which the public
 * page shows anyway. It has no reason and no dispute line, because the dispute is the
 * holder's.
 *
 * The line caps at `24rem`, about 69 characters of 12px Atkinson (AECI-2123). `max-w-prose`
 * ran about 91, because `ch` is a wide digit. A rem measure also holds through the font swap.
 */
@Component({
  selector: 'aec-vendor-locked-note',
  imports: [NewTabIcon],
  template: `
    <p
      [id]="noteId()"
      class="max-w-[24rem] text-xs text-(--text-secondary)"
      data-testid="locked-note"
    >
      <span class="font-semibold text-(--text-primary)" i18n="@@vendor.locked.setBy"
        >Set by AEC Integrations.</span
      >
      @if (lock().reason !== null) {
        <span i18n="@@vendor.locked.reason">Reason: {{ lock().reason }}</span>
      }
      @if (sourceHref(); as href) {
        <!-- AECI-1614: the source readers see on the public page. A new tab, because the
             reader is mid-edit (DESIGN.md, "The Link Treatment Rule"). -->
        <a
          [href]="href"
          target="_blank"
          rel="noopener nofollow"
          data-testid="locked-note-source"
          class="inline-flex items-center gap-1 rounded-(--radius-sm) font-medium underline
            decoration-(--border-strong) underline-offset-4 hover:text-(--text-primary)
            focus-visible:outline-2 focus-visible:outline-offset-2
            focus-visible:outline-(--accent-primary)"
          ><span i18n="@@vendor.locked.source">Source</span><aec-new-tab-icon
        /></a>
      }
      @if (lock().reason !== null) {
        <span i18n="@@vendor.locked.dispute"
          >To dispute it, email support@aecintegrations.com and quote this reason.</span
        >
      }
    </p>
  `,
  styles: [':host { display: block; }'],
})
export class VendorLockedNote {
  readonly lock = input.required<LockedField>();
  readonly noteId = input.required<string>();

  /** https only. An older correction has no source, and the note then omits the link. */
  protected readonly sourceHref = computed(() => {
    const url = this.lock().source_url;
    return url && isHttpsUrl(url) ? url : null;
  });
}
