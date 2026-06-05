import { Component, computed, inject, signal } from '@angular/core';
import { FormField, form, submit, validateStandardSchema } from '@angular/forms/signals';
import { Meta, Title } from '@angular/platform-browser';
import { ActivatedRoute, RouterLink } from '@angular/router';

import { ClaimFormSchema, CorrectionFormSchema, type RequestSubmitResponse } from '@aeci/shared';

import { RequestsApi, type RequestTargetRef } from './requests-api';

type Entity = 'product' | 'vendor';
type Kind = 'claim' | 'correction';

/**
 * Superset of both forms' fields. The active `kind` picks which shared Zod schema
 * validates the model and which fields the template renders; the other fields
 * stay empty and unvalidated. One model ⇒ one `form()`.
 */
interface RequestModel {
  submitter_name: string;
  submitter_email: string;
  submitter_role: string;
  body: string;
  source_url: string;
}

/**
 * First real Signal Forms form (AECI-128) — the claim & correction submission
 * flows that replace the four `PlaceholderPage` stubs
 * (`/products|vendors/:slug/{claim,correction}`). Established as the standard in
 * `docs/adr/0009-signal-forms.md` and `ANGULAR_STYLE_GUIDE.md` §13.
 *
 * One component renders all four routes, keyed by the static route `data`
 * ({ entity, kind }). The target is addressed by `(entity, slug)` from the route
 * — never a UUID — and the API resolves the slug, so the form works whether it's
 * landed on (SSR) or reached via a detail-page CTA (`[routerLink]`, i.e.
 * client-side navigation).
 *
 * Signal Forms surface exercised here:
 *   - `validateStandardSchema(p, Schema)` reuses the shared `@aeci/shared` Zod
 *     schema as the single source of validation truth (client + server).
 *   - `submit()` runs the POST and only fires when the form is valid.
 *   - `getError('standardSchema')` drives per-field error display (the template).
 *
 * Server-side duplicate detection is deliberately not done here — it belongs to
 * the Phase 6 moderation pipeline (see `routes/requests.ts`), so this form stays
 * a clean `validateStandardSchema`-only exemplar with no async `validateHttp`.
 *
 * i18n: the shared Zod schema is framework-agnostic and can't hold `$localize`
 * strings, so its messages are never rendered. The template owns user-facing
 * copy via `$localize`, keyed off field validity / `getError()` — Zod = logic,
 * `$localize` = presentation (ADR 0009).
 */
@Component({
  selector: 'aec-request-form',
  imports: [FormField, RouterLink],
  templateUrl: './request-form.html',
})
export class RequestForm {
  private readonly route = inject(ActivatedRoute);
  private readonly api = inject(RequestsApi);
  private readonly titleSvc = inject(Title);
  private readonly metaSvc = inject(Meta);

  protected readonly entity = this.route.snapshot.data['entity'] as Entity;
  protected readonly kind = this.route.snapshot.data['kind'] as Kind;

  private readonly slug = this.route.snapshot.paramMap.get('slug') ?? '';
  private readonly target: RequestTargetRef = { targetType: this.entity, slug: this.slug };

  /** Set to the API response on a successful submit; flips to the confirmation. */
  protected readonly submitted = signal<RequestSubmitResponse | null>(null);

  /** True when the last submit attempt failed. Surfaced as a non-blocking notice
   *  (not a form error) so the submit button stays enabled and the user can retry. */
  protected readonly submitFailed = signal(false);

  private readonly model = signal<RequestModel>({
    submitter_name: '',
    submitter_email: '',
    submitter_role: '',
    body: '',
    source_url: '',
  });

  protected readonly form = form(this.model, (p) => {
    // Validate the whole model against the shared Zod schema — the single source
    // of validation truth (client + server). `kind` is fixed per route, so the
    // active schema is chosen once. Fields the schema doesn't cover (e.g.
    // `source_url` for a claim) are ignored and stay unvalidated.
    if (this.kind === 'claim') {
      validateStandardSchema(p, ClaimFormSchema);
    } else {
      validateStandardSchema(p, CorrectionFormSchema);
    }
  });

  protected readonly backRouterLink = computed(() => [
    this.entity === 'product' ? '/products' : '/vendors',
    this.slug,
  ]);

  constructor() {
    this.titleSvc.setTitle(this.metaTitle());
    // Utility form pages stay out of the index, mirroring the PlaceholderPage
    // they replace.
    this.metaSvc.updateTag({ name: 'robots', content: 'noindex' });
  }

  protected async onSubmit(): Promise<void> {
    this.submitFailed.set(false);
    await submit(this.form, async (f) => {
      const v = f().value();
      try {
        const res =
          this.kind === 'claim'
            ? await this.api.submitClaim(this.target, {
                submitter_name: v.submitter_name,
                submitter_email: v.submitter_email,
                submitter_role: v.submitter_role,
                body: v.body,
              })
            : await this.api.submitCorrection(this.target, {
                body: v.body,
                source_url: v.source_url,
                submitter_email: v.submitter_email,
              });
        this.submitted.set(res);
      } catch {
        // Surface the failure as a notice, not a form error — returning a
        // `ValidationError` here would mark the form invalid and disable the
        // submit button, blocking the retry the message invites.
        this.submitFailed.set(true);
      }
      return undefined;
    });
  }

  private metaTitle(): string {
    return this.kind === 'claim'
      ? $localize`:@@requests.claim.metaTitle:Claim this listing · AEC Integrations`
      : $localize`:@@requests.correction.metaTitle:Suggest a correction · AEC Integrations`;
  }
}
