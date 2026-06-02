import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { Meta, Title } from '@angular/platform-browser';
import { map } from 'rxjs';

/**
 * Phase 2 placeholder for the vendor-side "Suggest a correction" flow.
 * Mirrors `VendorClaimPlaceholder` shape — see that component's header for
 * the Phase 6 timing and noindex rationale.
 */
@Component({
  selector: 'aec-vendor-correction-placeholder',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section
      class="mx-auto w-full max-w-3xl px-6 py-16 text-(--text-primary) md:py-24"
      aria-labelledby="vendor-correction-placeholder-title"
    >
      <p
        class="text-xs uppercase tracking-[0.14em] text-(--text-tertiary)"
        i18n="@@vendors.correction.eyebrow"
      >
        Suggest a correction
      </p>
      <h1
        id="vendor-correction-placeholder-title"
        class="mt-3 font-display text-3xl font-semibold tracking-tight md:text-4xl"
        i18n="@@vendors.correction.title"
      >
        Coming soon — Phase 6.
      </h1>
      <p
        class="mt-4 max-w-2xl text-base leading-relaxed text-(--text-secondary)"
        i18n="@@vendors.correction.body"
      >
        We're building the correction-request flow next. If something on this listing is wrong,
        <a
          href="mailto:hello@aecintegrations.com?subject=Vendor%20correction"
          class="text-(--accent-primary) underline underline-offset-2"
          >drop us an email</a
        >
        with the details and we'll fix it.
      </p>

      <div class="mt-8">
        <a
          [routerLink]="['/vendors', slug()]"
          class="inline-flex items-center rounded-(--radius-md) border border-(--border-default)
            bg-(--surface-raised) px-5 py-3 text-sm font-bold text-(--text-primary)
            no-underline transition-colors hover:border-(--border-strong)
            hover:text-(--accent-primary) focus-visible:outline-none focus-visible:ring-2
            focus-visible:ring-(--accent-primary) focus-visible:ring-offset-2
            focus-visible:ring-offset-(--surface-base)"
          i18n="@@vendors.correction.back"
        >
          ← Back to vendor
        </a>
      </div>
    </section>
  `,
})
export class VendorCorrectionPlaceholder {
  private readonly route = inject(ActivatedRoute);
  private readonly titleSvc = inject(Title);
  private readonly metaSvc = inject(Meta);

  protected readonly slug = toSignal(this.route.paramMap.pipe(map((p) => p.get('slug') ?? '')), {
    initialValue: this.route.snapshot.paramMap.get('slug') ?? '',
  });

  constructor() {
    this.titleSvc.setTitle(
      $localize`:@@vendors.correction.metaTitle:Suggest a correction — AEC Integrations`,
    );
    this.metaSvc.updateTag({ name: 'robots', content: 'noindex' });
  }
}
