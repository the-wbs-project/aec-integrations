import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { Meta, Title } from '@angular/platform-browser';
import { map } from 'rxjs';

/**
 * Phase 2 placeholder for the "Claim this listing" flow on the vendor side
 * (full form lands in Phase 6 — see Phase 2 Spec §3.2 "explicitly out of
 * scope"). Rendered at `/vendors/:slug/claim` so the AC's placeholder CTA
 * buttons on the vendor detail page have a real destination instead of a
 * dangling href.
 *
 * Noindex robots meta keeps these stub URLs out of the index until Phase 6.
 */
@Component({
  selector: 'aec-vendor-claim-placeholder',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section
      class="mx-auto w-full max-w-3xl px-6 py-16 text-(--text-primary) md:py-24"
      aria-labelledby="vendor-claim-placeholder-title"
    >
      <p
        class="text-xs uppercase tracking-[0.14em] text-(--text-tertiary)"
        i18n="@@vendors.claim.eyebrow"
      >
        Claim this listing
      </p>
      <h1
        id="vendor-claim-placeholder-title"
        class="mt-3 font-serif text-3xl font-semibold tracking-tight md:text-4xl"
        i18n="@@vendors.claim.title"
      >
        Coming soon — Phase 6.
      </h1>
      <p
        class="mt-4 max-w-2xl text-base leading-relaxed text-(--text-secondary)"
        i18n="@@vendors.claim.body"
      >
        Vendor claim and verification flow is part of the next release. For now, please
        <a
          href="mailto:hello@aecintegrations.com?subject=Claim%20vendor%20listing"
          class="text-(--accent-primary) underline underline-offset-2"
          >reach out by email</a
        >
        and we'll prioritise your listing.
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
          i18n="@@vendors.claim.back"
        >
          ← Back to vendor
        </a>
      </div>
    </section>
  `,
})
export class VendorClaimPlaceholder {
  private readonly route = inject(ActivatedRoute);
  private readonly titleSvc = inject(Title);
  private readonly metaSvc = inject(Meta);

  protected readonly slug = toSignal(this.route.paramMap.pipe(map((p) => p.get('slug') ?? '')), {
    initialValue: this.route.snapshot.paramMap.get('slug') ?? '',
  });

  constructor() {
    // Stub URLs stay out of the index until Phase 6 ships the real form.
    this.titleSvc.setTitle(
      $localize`:@@vendors.claim.metaTitle:Claim this listing — AEC Integrations`,
    );
    this.metaSvc.updateTag({ name: 'robots', content: 'noindex' });
  }
}
