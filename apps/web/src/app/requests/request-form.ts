import { Component, inject } from '@angular/core';
import { Meta, Title } from '@angular/platform-browser';
import { ActivatedRoute } from '@angular/router';

import { RequestFormBody } from './request-form-body';

type Entity = 'product' | 'vendor';
type Kind = 'claim' | 'correction';

/**
 * Routed host for the claim & correction forms (AECI-128) at
 * `/products|vendors/:slug/{claim,correction}`. One component renders all four
 * routes, keyed by the static route `data` ({ entity, kind }); the target is
 * addressed by `(entity, slug)` from the route — never a UUID.
 *
 * Thin wrapper: it owns the page chrome (`<title>` + `robots: noindex`, the
 * centered `<section>`), and delegates the form to `RequestFormBody`
 * (`variant="page"`). The same body renders inside `RequestDrawer` for the
 * in-place CTA on detail pages — so this route stays as the no-JS / deep-link /
 * SSR fallback. See `docs/adr/0009-signal-forms.md` and `ANGULAR_STYLE_GUIDE.md`
 * §13.
 */
@Component({
  selector: 'aec-request-form',
  imports: [RequestFormBody],
  templateUrl: './request-form.html',
})
export class RequestForm {
  private readonly route = inject(ActivatedRoute);
  private readonly titleSvc = inject(Title);
  private readonly metaSvc = inject(Meta);

  protected readonly entity = this.route.snapshot.data['entity'] as Entity;
  protected readonly kind = this.route.snapshot.data['kind'] as Kind;
  protected readonly slug = this.route.snapshot.paramMap.get('slug') ?? '';

  constructor() {
    this.titleSvc.setTitle(this.metaTitle());
    // Utility form pages stay out of the index, mirroring the PlaceholderPage
    // they replace.
    this.metaSvc.updateTag({ name: 'robots', content: 'noindex' });
  }

  private metaTitle(): string {
    return this.kind === 'claim'
      ? $localize`:@@requests.claim.metaTitle:Claim this listing · AEC Integrations`
      : $localize`:@@requests.correction.metaTitle:Suggest a correction · AEC Integrations`;
  }
}
