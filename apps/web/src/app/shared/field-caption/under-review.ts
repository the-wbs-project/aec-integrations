import { Component, computed, input } from '@angular/core';

/**
 * The **under-review marker** (AECI-1238, `STAGE_2_VENDOR_PORTAL_SPEC.md` §11d.7): what a
 * reader sees in a value's slot while AECi has hidden that one value to check it. The API
 * sends the value as `null` and names the field in `under_review`; this line stands where
 * the value would render.
 *
 * **Never a finding.** Hiding is an interim step while AECi verifies. The copy says AECi
 * is checking the detail, and nothing else: no "disputed", no "incorrect", no warning
 * colour or icon. It is the same muted line as the field caption, so it reads as a status
 * of the page, not a verdict on the vendor.
 *
 * `label` names the field where the line cannot sit in that one value's slot, such as the
 * vendor page's row of links.
 *
 * Visitor-neutral and clock-free, so it belongs in the edge-cached HTML. A block span
 * rather than a paragraph, because a table row mounts this inside a `<span>`.
 */
@Component({
  selector: 'aec-under-review',
  host: { class: 'block' },
  template: `<span
    class="block text-xs leading-5 text-(--text-secondary)"
    data-testid="field-under-review"
    >{{ text() }}</span
  >`,
})
export class UnderReviewMarker {
  /** Names the field where the line cannot sit in its own slot. */
  readonly label = input<string | null>(null);

  protected readonly text = computed(() => {
    const label = this.label();
    return label
      ? $localize`:@@fieldCaption.underReview.labelled:${label}:FIELD:: Under review. AEC Integrations is checking this detail.`
      : $localize`:@@fieldCaption.underReview:Under review. AEC Integrations is checking this detail.`;
  });
}
