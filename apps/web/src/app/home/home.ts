import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  selector: 'app-home',
  template: `
    <section class="mx-auto max-w-3xl px-6 py-16">
      <p class="mb-3 text-xs uppercase tracking-wide text-(--text-tertiary)" i18n="@@home.eyebrow">
        AEC Integrations
      </p>
      <h1
        class="font-display text-4xl font-semibold tracking-tight text-(--text-primary)"
        i18n="@@home.heading"
      >
        Coming soon
      </h1>
      <p class="mt-4 text-base text-(--text-secondary)" i18n="@@home.lede">
        The vendor-verified directory for AEC software integrations is in pre-launch. The home page
        lands in Phase 4.
      </p>
    </section>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Home {}
