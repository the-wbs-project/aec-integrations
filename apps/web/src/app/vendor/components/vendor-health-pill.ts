import { Component, computed, input } from '@angular/core';

import { healthLabel } from './vendor-attestation-labels';
import type { IntegrationHealth } from './vendor-integration-health';

/**
 * The health pill on a collapsed counterpart or integration row (AECI-999 /
 * `STAGE_2_ATTESTATIONS_SPEC.md` §6.3).
 *
 * Tones come from the overview's "What needs you" pills (AECI-983) so the two
 * surfaces read as one vocabulary: red for `conflict` only, a strong neutral
 * border for work that waits on the vendor, the Forest wash for `confirmed` only,
 * and a quiet sunken chip for everything else.
 *
 * The coloured borders are unlayered classes in `styles.css`, not
 * `border-(--…)` utilities, because the unlayered `* { border-color }` rule beats
 * every border-colour utility in the app.
 *
 * Colour is never the only signal: each state has its own visible label, and
 * `conflict` also carries a shape.
 */
@Component({
  selector: 'aec-vendor-health-pill',
  host: { class: 'inline-flex shrink-0' },
  template: `
    <span [class]="toneClass()">
      @if (health() === 'conflict') {
        <svg
          aria-hidden="true"
          class="h-3 w-3 shrink-0"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.5"
          stroke-linecap="round"
        >
          <path d="M7 7l10 10M17 7L7 17" />
        </svg>
      } @else {
        <span aria-hidden="true" class="h-1.5 w-1.5 rounded-full" [class]="dotClass()"></span>
      }
      {{ label() }}
    </span>
  `,
})
export class VendorHealthPill {
  readonly health = input.required<IntegrationHealth>();

  protected readonly label = computed(() => healthLabel(this.health()));

  protected readonly toneClass = computed(() => {
    const base =
      'inline-flex items-center gap-1.5 whitespace-nowrap rounded-(--radius-sm) border px-2 py-0.5 text-xs font-semibold tracking-[0.01em]';
    switch (this.health()) {
      case 'conflict':
        return `${base} aec-pill-conflict bg-(--surface-raised) text-(--status-error)`;
      case 'needs_you':
        return `${base} aec-pill-attention bg-(--surface-raised) text-(--text-primary)`;
      case 'confirmed':
        return `${base} aec-notice-success bg-(--accent-primary-soft) text-(--accent-primary)`;
      default:
        return `${base} bg-(--surface-sunken) text-(--text-secondary)`;
    }
  });

  protected readonly dotClass = computed(() => {
    switch (this.health()) {
      case 'needs_you':
        return 'bg-(--accent-secondary-deep)';
      case 'confirmed':
        return 'bg-(--accent-primary)';
      case 'responded':
        return 'bg-(--text-secondary)';
      default:
        return 'bg-(--text-tertiary)';
    }
  });
}
