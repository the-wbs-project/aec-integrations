import {
  Component,
  DOCUMENT,
  type ElementRef,
  Injector,
  type OnInit,
  computed,
  effect,
  inject,
  input,
  output,
  afterNextRender,
  runInInjectionContext,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import {
  type FieldTree,
  FormField,
  form,
  submit,
  validateStandardSchema,
} from '@angular/forms/signals';
import { RouterLink } from '@angular/router';

import {
  CLAIM_OWNER_REVIEW_DAYS,
  REQUEST_CONFIRMATION_DAYS,
  ClaimFormSchema,
  CorrectionFormSchema,
  type FoundVia,
  type RequestSubmitResponse,
} from '@aeci/shared';

import { Analytics } from '../analytics/analytics';
import { SessionStatus } from '../auth/session-status';
import { FoundViaField } from '../shared/found-via/found-via-field';
import { NewTabIcon } from '../shared/new-tab-icon/new-tab-icon';

import { ClaimRoutedNotice } from './claim-routed-notice';
import { ClaimantFields } from './claimant-fields';
import { RequestsApi, type RequestTargetRef } from './requests-api';
import { VendorTermsBox, isAcceptedTermsRejection } from './vendor-terms-box';
import { isReplayedEvent } from '../core/event-replay';
import { AecButton } from '../shared/button/button';
import { AecCard, FORM_CARD_GAP_CLASS, cardClass } from '../shared/card/card';
import { AecIcon } from '../shared/icon/icon';
import {
  FIELD_ERROR_CLASS,
  FIELD_HINT_CLASS,
  FIELD_INPUT_CLASS,
  FIELD_LABEL_CLASS,
  FIELD_OPTIONAL_CLASS,
  FORM_FOOTER_CLASS,
} from '../shared/form-field/form-field-classes';
import { AecEarlyInput } from '../shared/form-field/early-input';

type Entity = 'product' | 'vendor';
type Kind = 'claim' | 'correction';

/** Where the body is rendered. `page` keeps the full header + "Back" link (the
 *  routed `/…/{claim,correction}` fallback); `drawer` drops the header (the
 *  overlay panel supplies the title, and swaps it to the "sent" copy on `sent`)
 *  and swaps "Back" for a "Done" button. */
type Variant = 'page' | 'drawer';

/**
 * Superset of both forms' fields. The active `kind` picks which shared Zod schema
 * validates the model and which fields the template renders; the other fields
 * stay empty and unvalidated. One model ⇒ one `form()`.
 */
interface RequestModel {
  submitter_name: string;
  submitter_email: string;
  /** Claim-only (AECI-847). Empty string when skipped, never `undefined`. */
  submitter_linkedin_url: string;
  /** Claim-only (AECI-1617): the signer's title. */
  submitter_title: string;
  /** Claim-only (AECI-1617): pre-filled from the company the claim is on, editable. */
  company_legal_name: string;
  body: string;
  source_url: string;
  /** Claim-only (AECI-1366): the vendor terms box. Must be `true` to submit. */
  accepted_terms: boolean;
  /** Claim-only (AECI-1063): "How did you find AEC Integrations?". `''` = not
   *  answered. Never required. */
  found_via: '' | FoundVia;
  found_via_detail: string;
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
 *
 * Signed-in prefill: both forms ask for an email the session already knows, so the
 * field is seeded from `SessionStatus.email()` after hydration (see the effect in
 * the constructor). Prefill, never lock — the endpoints stay public (anonymous
 * submission is supported), and a claim asks for a *work* email that may differ
 * from the account's, which the server's `domain_match` signal compares against
 * the target vendor's website.
 */
@Component({
  selector: 'aec-request-form-body',
  imports: [
    AecButton,
    AecCard,
    AecIcon,
    FormField,
    AecEarlyInput,
    RouterLink,
    ClaimantFields,
    ClaimRoutedNotice,
    VendorTermsBox,
    NewTabIcon,
    FoundViaField,
  ],
  templateUrl: './request-form-body.html',
})
export class RequestFormBody implements OnInit {
  private readonly api = inject(RequestsApi);
  private readonly injector = inject(Injector);
  private readonly analytics = inject(Analytics);
  private readonly session = inject(SessionStatus);
  private readonly document = inject(DOCUMENT);

  readonly entity = input.required<Entity>();
  readonly kind = input.required<Kind>();
  readonly slug = input.required<string>();
  readonly variant = input<Variant>('page');

  /**
   * AECI-1364: the company a claim is on, for "Claim <Company>" on the routed page.
   * `null` when unknown (the entity or its vendor did not resolve), which reads
   * "Claim your company". The drawer supplies its own title, and passes the company
   * only for the routed notice and receipt (AECI-1366).
   */
  readonly company = input<string | null>(null);

  /** AECI-1364: the product page a claim came from ("from the <Product> page"), or
   *  `null` on a company page. Display only: the API resolves the company itself. */
  readonly contextProduct = input<string | null>(null);

  /**
   * Seed text for `body` (AECI-967), supplied by the surface that opened the
   * drawer. Read ONCE in `ngOnInit`, before `form()` is built, and then never
   * again — unlike the `submitter_email` prefill below there is no async probe to
   * race, so there is nothing to latch against.
   *
   * The routed `/…/{claim,correction}` page never passes one. It could only come
   * from a query param, and free text in the URL would join the SSR cache key
   * (`cacheKeyFor`, WC-4) and the request logs for a page that is otherwise
   * ordinary. The routed page is the no-JS fallback; an empty body there is what
   * ships today and stays correct.
   */
  readonly bodyPrefill = input<string | null>(null);
  /** AECI-1828: the other product of an empty pair, sent as `pair_slug` on a correction. */
  readonly pairSlug = input<string | null>(null);

  /** Emitted from the drawer-variant dismiss actions ("Done", the help link). The
   *  drawer listens to close the overlay; the routed page ignores it. */
  readonly done = output<void>();

  /** Emitted once on a successful submit with the email the answer goes to (both
   *  forms require one). The drawer swaps its header to the
   *  "sent" title and email line on it; the routed page renders its own. */
  readonly sent = output<string>();

  /** AECI-1366: emitted just before `sent`, true when the claim went to the company's
   *  owners first (AECI-1368). The drawer drops its "with our decision" line on it. */
  readonly sentRouted = output<boolean>();

  /** AECI-1435: emitted just before `sent`, true when the claim waits on the emailed
   *  link. The drawer swaps its header to "Check your inbox" on it. */
  readonly sentConfirm = output<boolean>();

  // The shared field recipe (`shared/form-field/form-field-classes.ts`), as the claim
  // dialog, `/welcome` and `/account` use it (AECI-1807).
  protected readonly labelClass = FIELD_LABEL_CLASS;
  protected readonly optionalClass = FIELD_OPTIONAL_CLASS;
  protected readonly inputClass = FIELD_INPUT_CLASS;
  protected readonly hintClass = FIELD_HINT_CLASS;
  protected readonly errorClass = FIELD_ERROR_CLASS;

  /** AECI-1807: on the routed page the form is the shared card. The drawer panel is
   *  already the surface, so there the form stays bare. */
  protected readonly formClass = computed(() =>
    this.variant() === 'page'
      ? `${cardClass({ phoneFlush: true })} ${FORM_CARD_GAP_CLASS}`
      : 'space-y-6',
  );
  protected readonly fieldsClass = computed(() =>
    this.variant() === 'page' ? 'space-y-6 p-6 sm:p-8' : 'space-y-6',
  );
  /** The page's form footer, or the drawer's pinned submit bar (AECI-847). */
  protected readonly footerClass = computed(() =>
    this.variant() === 'page'
      ? `${FORM_FOOTER_CLASS} px-6 py-4 sm:px-8`
      : 'sticky bottom-0 -mx-6 space-y-4 border-t border-(--border-default) bg-(--surface-raised) px-6 pt-4 pb-6',
  );
  /** The routed confirmation sits in one shared card, as the claim receipt page does. */
  protected readonly confirmCardClass = `${cardClass({ phoneFlush: true })} p-6 sm:p-8`;
  /** A standalone docs link: the in-text link look with a 44px target (AECI-1808). */
  protected readonly docsLinkClass =
    'mt-3 inline-flex min-h-11 items-center gap-2 text-t-14 font-semibold text-(--accent-primary) ' +
    'underline underline-offset-2 hover:text-(--accent-primary-hover) focus-visible:outline-2 ' +
    'focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';

  /**
   * False until the browser has hydrated, as on sign-in. The submit stays disabled
   * until then. Event replay never cancels a native submit. Before AECI-1919 the SSR
   * form had no method, so an early press or Enter would GET this page with every
   * answer, the email included, in the query string (AECI-1807 review). The form now
   * declares `method="dialog"`, whose native submit does nothing, and this gate
   * stays as the second layer.
   */
  protected readonly hydrated = signal(false);

  /** The submitted email, for the routed page's confirmation line. */
  protected readonly sentTo = signal('');

  /** The drawer's "Done" button or the routed page's confirmation heading. Focus
   *  moves here on success, because the submit button that held it is gone. */
  private readonly confirmFocus = viewChild<ElementRef<HTMLElement>>('confirmFocus');

  /** Set to the API response on a successful submit; flips to the confirmation. */
  protected readonly submitted = signal<RequestSubmitResponse | null>(null);

  /** AECI-1435: the claim waits on the emailed link, so the receipt says so. */
  protected readonly confirmationRequired = computed(
    () => this.submitted()?.confirmation_required === true,
  );
  protected readonly confirmDays = REQUEST_CONFIRMATION_DAYS;

  /** True when the last submit attempt failed. Surfaced as a non-blocking notice
   *  (not a form error) so the submit button stays enabled and the user can retry. */
  protected readonly submitFailed = signal(false);

  /** AECI-1366: the server refused the submit on `accepted_terms` (a stale bundle).
   *  The terms box shows its own error instead of the generic failure. */
  protected readonly termsRejected = signal(false);

  /**
   * AECI-1366: the company already has an owner seat (`has_seats` from
   * `GET /api/requests/claim-target/:type/:slug`), so the claim goes to its team first.
   * Drives the routed notice on the form. Loaded in the browser after first render,
   * never during SSR, so the cached routed page stays neutral. A failed lookup leaves it
   * false: no notice, and the submit is never blocked.
   */
  protected readonly routed = signal(false);

  /**
   * AECI-1972 (ruling 61): the claim was sent with `routed_notice_shown: true`, so the
   * API routes it to the owners. Drives the routed receipt. It is the value the submit
   * carried, not the live lookup: a lookup that lands after the submit must not turn a
   * claim AECi will decide into a "their team confirms you" receipt.
   */
  protected readonly sentAsRouted = signal(false);
  protected readonly reviewDays = CLAIM_OWNER_REVIEW_DAYS;

  private readonly model = signal<RequestModel>({
    submitter_name: '',
    submitter_email: '',
    submitter_linkedin_url: '',
    submitter_title: '',
    company_legal_name: '',
    body: '',
    source_url: '',
    accepted_terms: false,
    found_via: '',
    found_via_detail: '',
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

  /** One-shot latch so a later `email()` emission can't overwrite the visitor's
   *  own edits — including deliberately clearing the field. */
  private prefilledEmail = false;

  constructor() {
    afterNextRender(() => this.hydrated.set(true));
    // Don't make a signed-in visitor retype an address we already have.
    // `SessionStatus.email()` is `null` during SSR and until the post-hydration
    // probe resolves (the cache-neutral default, §8), so this only ever fires in
    // the browser — the server-rendered HTML stays visitor-state-neutral and the
    // routed `/…/{claim,correction}` page remains safe to cache.
    effect(() => {
      const email = this.session.email();
      if (!email) return;
      untracked(() => {
        // Never clobber what the visitor typed: the probe usually resolves before
        // anyone can type, but the field wins if it didn't.
        if (this.prefilledEmail || this.model().submitter_email) return;
        this.prefilledEmail = true;
        this.model.update((m) => ({ ...m, submitter_email: email }));
      });
    });
  }

  ngOnInit(): void {
    // Seed BEFORE `form()` so the field's initial value is the seeded one and the
    // schema validates against it from the first render.
    const seed = this.bodyPrefill();
    if (seed) this.model.update((m) => ({ ...m, body: seed }));
    // AECI-1617: the listing's company name is the starting point, and the claimant may
    // change it. Not visitor state, so the cached routed page stays neutral.
    const company = this.company();
    if (company && this.kind() === 'claim') {
      this.model.update((m) => ({ ...m, company_legal_name: company }));
    }

    runInInjectionContext(this.injector, () => {
      // Validate the whole model against the shared Zod schema — the single source
      // of validation truth (client + server). `kind` is fixed per instance, so the
      // active schema is chosen once. Fields the schema doesn't cover (e.g.
      // `source_url` for a claim) are ignored and stay unvalidated.
      this.form = form(this.model, (p) => {
        if (this.kind() === 'claim') {
          // The function form: the model holds `accepted_terms` as a boolean, which the
          // schema narrows to `true`, so the schema cannot be the static argument.
          validateStandardSchema(p, () => ClaimFormSchema);
        } else {
          validateStandardSchema(p, CorrectionFormSchema);
        }
      });
    });

    // AECI-1366: browser-only, after first render (see `routed`).
    if (this.kind() === 'claim') {
      afterNextRender(() => void this.loadClaimTarget(), { injector: this.injector });
    }
  }

  private async loadClaimTarget(): Promise<void> {
    try {
      const target = await this.api.getClaimTarget(this.target());
      this.routed.set(target.has_seats);
    } catch {
      // Fail quiet: no disclosure. The submit still works.
    }
  }

  /** The form's submit. Drops a replayed early submit. The form is `method="dialog"`,
   *  so the native submit did nothing (AECI-1919, `core/event-replay.ts`). */
  protected onFormSubmit(event: Event): void {
    if (isReplayedEvent(event)) return;
    event.preventDefault();
    void this.onSubmit();
  }

  protected async onSubmit(): Promise<void> {
    this.submitFailed.set(false);
    this.termsRejected.set(false);
    await submit(this.form, {
      onInvalid: () => this.focusFirstInvalid(),
      action: (f) => this.send(f().value()),
    });
  }

  /**
   * Submit stays enabled while an answer is bad (DESIGN.md "Submit stays enabled"),
   * as on the claim dialog. `submit()` marks every field touched, so each error
   * shows, and focus moves to the first bad field, top to bottom. The terms box is
   * the exception: the button stays disabled until it is ticked
   * (VENDOR_SIGNUP_PROCESS.md section 4), so it is never the first bad field here.
   */
  private focusFirstInvalid(): void {
    const f = this.form;
    const order =
      this.kind() === 'claim'
        ? [
            f.submitter_name,
            f.submitter_title,
            f.submitter_linkedin_url,
            f.submitter_email,
            f.company_legal_name,
            f.body,
            f.accepted_terms,
          ]
        : [f.body, f.source_url, f.submitter_email];
    const first = order.find((field) => field().invalid());
    if (!first) return;
    first().focusBoundControl();
    // The error renders on the next pass, below its field. Bring it into view too:
    // in the drawer the pinned submit bar would cover it (the port's scroll padding
    // keeps it above the bar).
    afterNextRender(
      () => {
        const ids = this.document.activeElement?.getAttribute('aria-describedby')?.split(' ');
        const error = ids?.length ? this.document.getElementById(ids[ids.length - 1]) : null;
        error?.scrollIntoView?.({ block: 'nearest' });
      },
      { injector: this.injector },
    );
  }

  private async send(v: RequestModel): Promise<undefined> {
    const target = this.target();
    // The schema already refused an unchecked box; this narrows the type.
    if (this.kind() === 'claim' && !v.accepted_terms) return undefined;
    // AECI-1972: read once, before the request. The notice renders on this form
    // whenever `routed()` is true, so this is "the notice was on screen at submit".
    const noticeShown = this.kind() === 'claim' && this.routed();
    try {
      const res =
        this.kind() === 'claim'
          ? await this.api.submitClaim(target, {
              submitter_name: v.submitter_name,
              submitter_email: v.submitter_email,
              submitter_linkedin_url: v.submitter_linkedin_url,
              submitter_title: v.submitter_title,
              company_legal_name: v.company_legal_name,
              body: v.body,
              accepted_terms: true,
              found_via: v.found_via,
              found_via_detail: v.found_via_detail.trim(),
              routed_notice_shown: noticeShown,
            })
          : await this.api.submitCorrection(
              target,
              {
                body: v.body,
                source_url: v.source_url,
                submitter_email: v.submitter_email,
              },
              this.pairSlug(),
            );
      this.sentTo.set(v.submitter_email.trim());
      this.sentAsRouted.set(noticeShown);
      this.submitted.set(res);
      this.sentRouted.emit(noticeShown);
      this.sentConfirm.emit(res.confirmation_required);
      this.sent.emit(this.sentTo());
      afterNextRender(() => this.confirmFocus()?.nativeElement.focus(), {
        injector: this.injector,
      });
      // §14.1: the form holds only (target_type, slug) — never a UUID — so the
      // event records that + the returned request_id (consent-gated, no-throw).
      const payload = {
        target_type: target.targetType,
        slug: target.slug,
        request_id: res.request_id,
      };
      if (this.kind() === 'claim') {
        this.analytics.claimRequested({
          ...payload,
          confirmation_required: res.confirmation_required,
          found_via: v.found_via || null,
        });
      } else {
        this.analytics.correctionRequested(payload);
      }
    } catch (err) {
      // Surface the failure as a notice, not a form error. A `ValidationError`
      // here would mark the form invalid, so the next press would stop at the
      // invalid check and never retry the send the message invites.
      if (this.kind() === 'claim' && isAcceptedTermsRejection(err)) {
        // AECI-1366: the box's own error, and focus on the box.
        this.termsRejected.set(true);
        this.model.update((m) => ({ ...m, accepted_terms: false }));
        afterNextRender(() => this.document.getElementById('claim-terms')?.focus(), {
          injector: this.injector,
        });
      } else {
        this.submitFailed.set(true);
      }
    }
    return undefined;
  }
}
