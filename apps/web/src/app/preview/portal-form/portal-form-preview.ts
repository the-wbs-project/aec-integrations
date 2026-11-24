import { Component, inject, signal } from '@angular/core';

import { AecButton } from '../../shared/button/button';
import { AecCard } from '../../shared/card/card';
import {
  FIELD_HINT_CLASS,
  FIELD_INPUT_CLASS,
  FIELD_LABEL_CLASS,
} from '../../shared/form-field/form-field-classes';
import {
  PORTAL_FIELD_CLASS,
  PORTAL_FIELDSET_CLASS,
  PORTAL_FORM_CLASS,
  PORTAL_FORM_GRID_CLASS,
  PORTAL_FORM_SPAN_CLASS,
  PORTAL_LEGEND_CLASS,
  PORTAL_SAVE_BAR_CLASS,
  PORTAL_SAVE_BUTTON_CLASS,
  PORTAL_SAVE_STATUS_CLASS,
} from '../../vendor/shared/portal-form';
import { PORTAL_WRAP_CLASS } from '../../vendor/shared/portal-layout';
import { VendorPortalAnnouncer } from '../../vendor/vendor-announcer';

/**
 * Dev-only reference for the portal form layout (AECI-1809, `vendor/shared/portal-form.ts`):
 * two columns of fields from 768px, overline legends, and the save bar stuck to the foot of
 * the form card. The later portal slices (the company Profile form first) adopt this shape,
 * and `e2e/preview-portal-form.spec.ts` holds the bar off a focused field (WCAG 2.4.11).
 *
 * Nothing here saves. "Save changes" shows a status line and announces it through the
 * portal announcer, which is the pattern: the status line itself is not a live region.
 * The page has its own sr-only region only because no portal shell hosts it here.
 *
 * Route: `/preview/portal-form`, production-blocked by `isPreviewPath`. Copy is dev-only.
 */
@Component({
  selector: 'app-portal-form-preview',
  imports: [AecButton, AecCard],
  template: `
    <div [class]="wrapClass + ' pt-12'">
      <h1>Portal form layout</h1>
      <form
        aecCard
        phoneFlush
        [class]="formClass + ' mt-8 p-6 md:p-8'"
        method="dialog"
        novalidate
        (submit)="save($event)"
        aria-labelledby="pf-demo-legend-1"
      >
        @for (set of sets; track set.legend; let i = $index) {
          <fieldset [class]="fieldsetClass">
            <legend [id]="'pf-demo-legend-' + (i + 1)" [class]="legendClass">
              {{ set.legend }}
            </legend>
            <div [class]="gridClass">
              @for (f of set.fields; track f.id) {
                <div [class]="f.wide ? fieldClass + ' ' + spanClass : fieldClass">
                  <label [for]="f.id" [class]="labelClass">{{ f.label }}</label>
                  @if (f.wide) {
                    <textarea
                      [id]="f.id"
                      rows="4"
                      [class]="inputClass + ' min-h-28 py-3'"
                    ></textarea>
                  } @else {
                    <input
                      [id]="f.id"
                      type="text"
                      [class]="inputClass"
                      [attr.aria-describedby]="f.id + '-hint'"
                    />
                  }
                  <p [id]="f.id + '-hint'" [class]="hintClass">{{ f.hint }}</p>
                </div>
              }
            </div>
          </fieldset>
        }
        <div [class]="saveBarClass" data-testid="portal-save-bar">
          <p [class]="statusClass" data-testid="portal-save-status">{{ status() }}</p>
          <button aecButton type="submit" [class]="saveButtonClass">Save changes</button>
        </div>
      </form>
      <p class="sr-only" role="status">{{ announced() }}</p>
    </div>
  `,
})
export class PortalFormPreview {
  private readonly announcer = inject(VendorPortalAnnouncer);
  protected readonly announced = this.announcer.message;
  protected readonly status = signal('');

  protected readonly sets = [
    {
      legend: 'Profile details',
      fields: [
        { id: 'pf-desc', label: 'Description', hint: 'Shown on your public page.', wide: true },
        { id: 'pf-web', label: 'Website', hint: 'Starts with https://.', wide: false },
        { id: 'pf-hq', label: 'Headquarters', hint: 'City and region.', wide: false },
        { id: 'pf-year', label: 'Founded year', hint: 'Four digits.', wide: false },
        { id: 'pf-parent', label: 'Parent company', hint: 'Leave empty if none.', wide: false },
      ],
    },
    {
      legend: 'Links',
      fields: [
        { id: 'pf-li', label: 'LinkedIn', hint: 'The company page.', wide: false },
        { id: 'pf-x', label: 'X (Twitter)', hint: 'The company account.', wide: false },
        { id: 'pf-fb', label: 'Facebook', hint: 'The company page.', wide: false },
        { id: 'pf-yt', label: 'YouTube', hint: 'The company channel.', wide: false },
      ],
    },
  ];

  protected save(event: Event): void {
    event.preventDefault();
    const message =
      'Profile updated. Your listing shows the change now. Search on AEC Integrations updates within a day.';
    this.status.set(message);
    this.announcer.announce(message);
  }

  protected readonly wrapClass = PORTAL_WRAP_CLASS;
  protected readonly formClass = PORTAL_FORM_CLASS;
  protected readonly fieldsetClass = PORTAL_FIELDSET_CLASS;
  protected readonly legendClass = PORTAL_LEGEND_CLASS;
  protected readonly gridClass = PORTAL_FORM_GRID_CLASS;
  protected readonly fieldClass = PORTAL_FIELD_CLASS;
  protected readonly spanClass = PORTAL_FORM_SPAN_CLASS;
  protected readonly saveBarClass = PORTAL_SAVE_BAR_CLASS;
  protected readonly statusClass = PORTAL_SAVE_STATUS_CLASS;
  protected readonly saveButtonClass = PORTAL_SAVE_BUTTON_CLASS;
  protected readonly labelClass = FIELD_LABEL_CLASS;
  protected readonly inputClass = FIELD_INPUT_CLASS;
  protected readonly hintClass = FIELD_HINT_CLASS;
}
