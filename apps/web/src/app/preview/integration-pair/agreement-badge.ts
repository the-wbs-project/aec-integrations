import { Component } from '@angular/core';

import { COPY } from './integration-pair.fixtures';

/**
 * The neutral **"Unverified · AECi"** agreement badge (spec §3.4). Sole owner of
 * the badge copy + styling so it can't drift across the three concepts.
 *
 * By the AECi-never-red rule, an AECi-only claim can never be `conflict`; in
 * Stage 1.5 every claim is `unverified`, so this badge only ever renders the
 * neutral state. It uses the codebase's standard chip tokens
 * (`--border-default` / `--surface-raised` / `--text-secondary`) — never Clay,
 * never a status/red hue — because its job is "not yet vendor-confirmed", not
 * "defect". The dot is decorative; the meaning rides on the `aria-label`.
 *
 * Prototype-only (AECI-289). The production badge ships with claim rendering
 * (AECI-300).
 */
@Component({
  selector: 'app-ip-agreement-badge',
  template: `
    <span
      class="inline-flex items-center gap-1.5 rounded-(--radius-sm) border border-(--border-default)
        bg-(--surface-raised) px-2.5 py-1 text-[0.75rem] font-medium tracking-[0.01em]
        text-(--text-secondary)"
      [attr.aria-label]="copy.badgeAria"
    >
      <span aria-hidden="true" class="h-1.5 w-1.5 rounded-full bg-(--text-tertiary)"></span>
      {{ copy.badgeLabel }}
    </span>
  `,
})
export class AgreementBadge {
  protected readonly copy = COPY;
}
