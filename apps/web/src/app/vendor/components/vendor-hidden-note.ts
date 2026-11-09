import { Component, computed, input } from '@angular/core';

import { isHttpsUrl, type HiddenField } from '@aeci/shared';

import { NewTabIcon } from '../../shared/new-tab-icon/new-tab-icon';

/**
 * The line under a field AEC Integrations hid from the public page while it checks it
 * (AECI-1238, `STAGE_2_VENDOR_PORTAL_SPEC.md` §11d.7): what the hide does, AECi's
 * vendor-visible reason, the source AECi received, and the dispute route (§11d.4).
 *
 * Unlike a lock (`vendor-locked-note.ts`) the field stays EDITABLE. Saving a change to it
 * ends the hide, so the line says so. The host points the input's `aria-describedby` at
 * `noteId`, so a screen reader hears it beside the field. Hiding is not a finding that
 * the value is false, and the copy never says it is.
 */
@Component({
  selector: 'aec-vendor-hidden-note',
  imports: [NewTabIcon],
  template: `
    <p
      [id]="noteId()"
      class="max-w-prose text-xs text-(--text-secondary)"
      data-testid="hidden-note"
    >
      <span class="font-semibold text-(--text-primary)" i18n="@@vendor.hidden.lead"
        >Hidden from your public page while AEC Integrations checks it. Saving a change to this
        field ends the hide.</span
      >
      <span i18n="@@vendor.hidden.reason">Reason: {{ hide().reason }}</span>
      @if (sourceHref(); as href) {
        <!-- The source AECi received. A new tab, because the reader is mid-edit
             (DESIGN.md, "The Link Treatment Rule"). -->
        <a
          [href]="href"
          target="_blank"
          rel="noopener nofollow"
          data-testid="hidden-note-source"
          class="inline-flex items-center gap-1 rounded-(--radius-sm) font-medium underline
            decoration-(--border-strong) underline-offset-4 hover:text-(--text-primary)
            focus-visible:outline-2 focus-visible:outline-offset-2
            focus-visible:outline-(--accent-primary)"
          ><span i18n="@@vendor.hidden.source">Source</span><aec-new-tab-icon
        /></a>
      }
      <span i18n="@@vendor.hidden.dispute"
        >To dispute it, email support@aecintegrations.com and quote this message.</span
      >
    </p>
  `,
  styles: [':host { display: block; }'],
})
export class VendorHiddenNote {
  readonly hide = input.required<HiddenField>();
  readonly noteId = input.required<string>();

  /** https only. Anything else renders the note without the link. */
  protected readonly sourceHref = computed(() => {
    const url = this.hide().source_url;
    return url && isHttpsUrl(url) ? url : null;
  });
}
