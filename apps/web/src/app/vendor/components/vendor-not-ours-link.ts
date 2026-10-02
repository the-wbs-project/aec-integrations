import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import { RequestTrigger } from '../../requests/request-trigger';
import { NewTabIcon } from '../../shared/new-tab-icon/new-tab-icon';

/**
 * "Not ours?" beside "Claim this integration" (AECI-1218, the checklist's "Claim
 * or say not ours" step, `STAGE_2_PAID_TIERS_SPEC.md` §13.10).
 *
 * The recorded owner cannot contest its own row (`STAGE_2_VENDOR_PORTAL_SPEC.md`
 * §11b.2, `CONTEST_OWN_INTEGRATION`), so there is no "not ours" route for it yet
 * (follow-up AECI-1225). Until there is, this opens the existing correction form
 * on the product, pre-filled to name the integration, the same drawer the public
 * product page uses (`POST /api/requests/correction`). AECi reviews it.
 *
 * The anchor's `href` is the no-JS fallback and carries the new-tab treatment,
 * because that path navigates away from a page that may hold unsaved state.
 */
@Component({
  selector: 'aec-vendor-not-ours-link',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RequestTrigger, NewTabIcon],
  template: `
    <a
      aecRequestTrigger
      [entity]="'product'"
      [kind]="'correction'"
      [slug]="productSlug()"
      [bodyPrefill]="prefill()"
      [href]="'/products/' + productSlug() + '/correction'"
      target="_blank"
      rel="noopener"
      [attr.aria-label]="ariaLabel()"
      class="text-sm font-medium text-(--accent-primary) underline underline-offset-2 focus-visible:rounded-(--radius-sm) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
      data-testid="not-ours"
      ><span i18n="@@vendor.notOurs.link">Not ours?</span>
      <span class="inline-flex align-middle"><aec-new-tab-icon /></span
    ></a>
  `,
  styles: [':host { display: inline-flex; }'],
})
export class VendorNotOursLink {
  /** The product the correction is filed against: the page's own product. */
  readonly productSlug = input.required<string>();
  /** The two product names, as the integration is known on the page. */
  readonly productA = input.required<string>();
  readonly productB = input.required<string>();

  protected readonly prefill = computed(
    () =>
      $localize`:@@vendor.notOurs.prefill:We did not build the integration between ${this.productA()}:A: and ${this.productB()}:B:, but it is recorded as ours. Please correct the builder.`,
  );

  /** Several rows per page, so the name says which integration. */
  protected readonly ariaLabel = computed(
    () =>
      $localize`:@@vendor.notOurs.aria:Not ours? Tell AEC Integrations you did not build the integration between ${this.productA()}:A: and ${this.productB()}:B:`,
  );
}
