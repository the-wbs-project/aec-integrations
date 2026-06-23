import {
  Component,
  Injector,
  type OnInit,
  computed,
  inject,
  input,
  output,
  runInInjectionContext,
  signal,
} from '@angular/core';
import {
  type FieldTree,
  FormField,
  form,
  submit,
  validateStandardSchema,
} from '@angular/forms/signals';
import { RouterLink } from '@angular/router';

import { ClaimFormSchema, CorrectionFormSchema, type RequestSubmitResponse } from '@aeci/shared';

import { Analytics } from '../analytics/analytics';

import { RequestsApi, type RequestTargetRef } from './requests-api';

type Entity = 'product' | 'vendor';
type Kind = 'claim' | 'correction';

/** Where the body is rendered. `page` keeps the full header + "Back" link (the
 *  routed `/…/{claim,correction}` fallback); `drawer` drops the header (the
 *  overlay panel supplies the title) and swaps "Back" for a "Close" button. */
type Variant = 'page' | 'drawer';

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
 * Presentational form body for the claim & correction flows (AECI-128). Extracted
 * from `RequestForm` so the *same* form renders in two hosts:
 *   - the routed `/products|vendors/:slug/{claim,correction}` page (`variant="page"`,
 *     the no-JS / deep-link / SSR fallback), and
 *   - the in-place `RequestDrawer` launched from a detail page (`variant="drawer"`).
 *
 * The target is addressed by `(entity, slug)` — never a UUID — and the API resolves
 * the slug, so the body behaves identically whether it's landed on (SSR) or opened
 * client-side from a detail-page CTA.
 *
 * Signal Forms note: the `form()` schema callback runs **once** at form creation
 * (it's the structural layer — see angular.dev/guide/forms/signals/schemas), so the
 * active `kind` must be known when `form()` runs. Because `kind` is a *required
 * signal input* (unreadable in a field initializer), the form is built in `ngOnInit`
 * — inputs are set by then, and `ngOnInit` completes before this view's first render
 * — via `runInInjectionContext` so `form()`'s internal `inject()`/effects bind to
 * this component's lifecycle. `kind` is fixed per instance (the drawer recreates the
 * body via `@if` per target), so the once-resolved validator is correct.
 *
 * i18n: the shared Zod schema is framework-agnostic and can't hold `$localize`
 * strings, so its messages are never rendered. The template owns user-facing copy
 * via `$localize`, keyed off field validity / `getError()` (ADR 0009).
 */
@Component({
  selector: 'aec-request-form-body',
  imports: [FormField, RouterLink],
  templateUrl: './request-form-body.html',
})
export class RequestFormBody implements OnInit {
  private readonly api = inject(RequestsApi);
  private readonly injector = inject(Injector);
  private readonly analytics = inject(Analytics);

  readonly entity = input.required<Entity>();
  readonly kind = input.required<Kind>();
  readonly slug = input.required<string>();
  readonly variant = input<Variant>('page');

  /** Emitted from the drawer-variant dismiss actions (success "Close" button). The
   *  drawer listens to close the overlay; the routed page ignores it. */
  readonly done = output<void>();

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

  /** Built in `ngOnInit` (see class doc) — guaranteed assigned before first render. */
  protected form!: FieldTree<RequestModel>;

  protected readonly backRouterLink = computed(() => [
    this.entity() === 'product' ? '/products' : '/vendors',
    this.slug(),
  ]);

  private readonly target = computed<RequestTargetRef>(() => ({
    targetType: this.entity(),
    slug: this.slug(),
  }));

  ngOnInit(): void {
    runInInjectionContext(this.injector, () => {
      // Validate the whole model against the shared Zod schema — the single source
      // of validation truth (client + server). `kind` is fixed per instance, so the
      // active schema is chosen once. Fields the schema doesn't cover (e.g.
      // `source_url` for a claim) are ignored and stay unvalidated.
      this.form = form(this.model, (p) => {
        if (this.kind() === 'claim') {
          validateStandardSchema(p, ClaimFormSchema);
        } else {
          validateStandardSchema(p, CorrectionFormSchema);
        }
      });
    });
  }

  protected async onSubmit(): Promise<void> {
    this.submitFailed.set(false);
    await submit(this.form, async (f) => {
      const v = f().value();
      const target = this.target();
      try {
        const res =
          this.kind() === 'claim'
            ? await this.api.submitClaim(target, {
                submitter_name: v.submitter_name,
                submitter_email: v.submitter_email,
                submitter_role: v.submitter_role,
                body: v.body,
              })
            : await this.api.submitCorrection(target, {
                body: v.body,
                source_url: v.source_url,
                submitter_email: v.submitter_email,
              });
        this.submitted.set(res);
        // §14.1: the form holds only (target_type, slug) — never a UUID — so the
        // event records that + the returned request_id (consent-gated, no-throw).
        const payload = {
          target_type: target.targetType,
          slug: target.slug,
          request_id: res.request_id,
        };
        if (this.kind() === 'claim') this.analytics.claimRequested(payload);
        else this.analytics.correctionRequested(payload);
      } catch {
        // Surface the failure as a notice, not a form error — returning a
        // `ValidationError` here would mark the form invalid and disable the
        // submit button, blocking the retry the message invites.
        this.submitFailed.set(true);
      }
      return undefined;
    });
  }
}
