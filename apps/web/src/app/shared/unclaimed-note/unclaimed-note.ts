import { Component } from '@angular/core';

/**
 * The wording an unclaimed listing carries beside its logo (AECI-1618, ruling 9 on
 * AECI-1363, `STAGE_2_5_SPEC.md` §11). Counsel's condition is a small sourced logo with
 * this sentence next to it, so a host renders this directly after the logo, and a screen
 * reader hears the two together.
 *
 * Plain muted text. It is never a chip, badge or header, and no public label says
 * Claimed. The host decides from `claim_status` and shows it even with no logo.
 * `claim_status` is listing state, so this stays safe on cached SSR routes.
 */
@Component({
  selector: 'aec-unclaimed-note',
  host: {
    class: 'block min-w-0 text-[0.8125rem] leading-snug text-(--text-secondary)',
    'data-testid': 'unclaimed-note',
  },
  template: `{{ text }}`,
})
export class UnclaimedNote {
  protected readonly text = $localize`:@@shared.unclaimedNote:Unclaimed · not affiliated with or endorsed by this vendor`;
}
