import { Component } from '@angular/core';

import { NewTabIcon } from '../new-tab-icon/new-tab-icon';

/**
 * `CompanyFactsNote` (AECI-1310): the Open Government Licence v3.0 attribution.
 *
 * Company facts can come from Companies House, whose licence requires this line.
 * It is a blanket note, ruled by Chris on 2026-11-04: every page that shows company
 * facts carries it, whether or not that vendor's facts came from Companies House.
 * It renders on the vendor page and on `/search`.
 *
 * Do not remove it or reword it without checking the review app's
 * `docs/company-data-sources.md`. The Companies House rows there depend on it.
 */
@Component({
  selector: 'aec-company-facts-note',
  imports: [NewTabIcon],
  template: `
    <p class="text-sm text-(--text-secondary)" i18n="@@companyFacts.oglNote">
      Company facts may include public sector information licensed under the
      <a
        href="https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/"
        target="_blank"
        rel="noopener nofollow"
        class="text-(--accent-primary) underline underline-offset-2 hover:text-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) [&_svg]:inline"
        >Open Government Licence v3.0<aec-new-tab-icon /></a
      >.
    </p>
  `,
})
export class CompanyFactsNote {}
