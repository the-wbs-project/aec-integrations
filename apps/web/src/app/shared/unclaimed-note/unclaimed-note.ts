import { Component, computed, input } from '@angular/core';

/**
 * The wording an unclaimed listing carries beside its logo (AECI-1618, ruling 9 on
 * AECI-1363, `STAGE_2_5_SPEC.md` §11). Counsel's condition is a small sourced logo with
 * this sentence next to it, so a host renders this directly after the logo, and a screen
 * reader hears the two together.
 *
 * Plain muted text. It is never a chip, badge or header, and no public label says
 * Claimed. The product page's stuck section bar carries no Unclaimed marking since AECI-2012:
 * this note in the hero is the one. The host decides from `claim_status` and shows it even with
 * no logo.
 * `claim_status` is listing state, so this stays safe on cached SSR routes.
 *
 * `tone="on-brand"` is for the Forest hero band (AECI-1778): `--text-on-brand-secondary`,
 * 7.96:1 on Forest and 4.96:1 at the glow's peak. The words never change with the tone.
 */
@Component({
  selector: 'aec-unclaimed-note',
  host: {
    class: 'block min-w-0 text-t-13 leading-snug',
    '[class]': 'toneClass()',
    'data-testid': 'unclaimed-note',
  },
  template: `{{ text }}`,
})
export class UnclaimedNote {
  /** `default` on a light ground, `on-brand` on Forest. */
  readonly tone = input<'default' | 'on-brand'>('default');

  protected readonly toneClass = computed(() =>
    this.tone() === 'on-brand' ? 'text-(--text-on-brand-secondary)' : 'text-(--text-secondary)',
  );

  protected readonly text = $localize`:@@shared.unclaimedNote:Unclaimed · not affiliated with or endorsed by this vendor`;
}
