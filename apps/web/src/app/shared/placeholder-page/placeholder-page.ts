import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { Meta, Title } from '@angular/platform-browser';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { map } from 'rxjs';

/** The four placeholder variants, keyed `<entity>.<kind>`. */
type PlaceholderKey = 'product.claim' | 'vendor.claim' | 'product.correction' | 'vendor.correction';

/**
 * Phase 2 placeholder for the "Claim this listing" / "Suggest a correction"
 * flows (full forms land in Phase 6 — see Phase 2 Spec §3.2 "explicitly out of
 * scope"). One component renders all four routes — products/vendors × claim/
 * correction — keyed by the static route `data` ({ entity, kind }), so the AC's
 * placeholder CTA buttons on the detail pages have a real destination instead
 * of a dangling href. The localized copy is selected per-variant in the
 * template so each entity/kind keeps its own `@@` i18n id.
 *
 * Noindex robots meta keeps these stub URLs out of the index until Phase 6.
 */
@Component({
  selector: 'aec-placeholder-page',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './placeholder-page.html',
})
export class PlaceholderPage {
  private readonly route = inject(ActivatedRoute);
  private readonly titleSvc = inject(Title);
  private readonly metaSvc = inject(Meta);

  private readonly entity = this.route.snapshot.data['entity'] as 'product' | 'vendor';
  private readonly kind = this.route.snapshot.data['kind'] as 'claim' | 'correction';

  /** Drives the per-variant `@switch` in the template. Constant per route. */
  protected readonly key: PlaceholderKey = `${this.entity}.${this.kind}`;

  protected readonly slug = toSignal(this.route.paramMap.pipe(map((p) => p.get('slug') ?? '')), {
    initialValue: this.route.snapshot.paramMap.get('slug') ?? '',
  });

  protected readonly backRouterLink = computed(() => [
    this.entity === 'product' ? '/products' : '/vendors',
    this.slug(),
  ]);

  constructor() {
    // Stub URLs stay out of the index until Phase 6 ships the real forms.
    // Title is informative rather than reusing the "Not found" copy.
    this.titleSvc.setTitle(this.metaTitle());
    this.metaSvc.updateTag({ name: 'robots', content: 'noindex' });
  }

  private metaTitle(): string {
    switch (this.key) {
      case 'product.claim':
        return $localize`:@@products.claim.metaTitle:Claim this listing · AEC Integrations`;
      case 'vendor.claim':
        return $localize`:@@vendors.claim.metaTitle:Claim this listing · AEC Integrations`;
      case 'product.correction':
        return $localize`:@@products.correction.metaTitle:Suggest a correction · AEC Integrations`;
      case 'vendor.correction':
        return $localize`:@@vendors.correction.metaTitle:Suggest a correction · AEC Integrations`;
    }
  }
}
