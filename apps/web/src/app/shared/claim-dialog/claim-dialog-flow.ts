import { HttpErrorResponse } from '@angular/common/http';
import {
  Component,
  DOCUMENT,
  type ElementRef,
  Injector,
  type OnInit,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  output,
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

import { ClaimFormSchema, ListingRequestFormSchema, type PlanInterest } from '@aeci/shared';

import { Analytics, planInterestProperty, type ClaimDialogStep } from '../../analytics/analytics';
import { SessionStatus } from '../../auth/session-status';
import { ClaimantFields } from '../../requests/claimant-fields';
import { PlanInterestField } from '../../requests/plan-interest-field';
import { RequestsApi } from '../../requests/requests-api';
import type { AutocompleteSuggestion } from '../../search/autocomplete-mapping';
import { SearchAutocomplete } from '../../search/search-autocomplete';

import type { ClaimDialogOpening, ClaimListing } from './claim-dialog.service';

/** The four numbered steps, in order. `done` is the receipt, outside the count. */
const STEPS: readonly ClaimDialogStep[] = ['find', 'you', 'plan', 'comments'];

/** A step's field: its model key, the control to focus on error, and the field tree. */
type StepField = [keyof ClaimDialogModel, string, FieldTree<string>];

/** Every field either path can send. One model, one `form()`. */
interface ClaimDialogModel {
  listing_name: string;
  website: string;
  submitter_name: string;
  submitter_email: string;
  submitter_role: string;
  submitter_linkedin_url: string;
  plan_interest: '' | PlanInterest;
  body: string;
}

/**
 * The claim dialog's steps (AECI-1293, `docs/VENDOR_PROGRAM_PAGE_SPEC.md` §15.2):
 * find it, you, plan, additional comments, done. `ClaimDialog` is the BrnDialog shell
 * around it; this component holds the state, so its spec needs no overlay.
 *
 * **Two paths.** A catalog listing (`found`) submits `POST /api/requests/claim` with
 * the plan answer and the comments as the claim's `body`. A typed-in listing
 * (`typed`, "Not listed? Type it in") submits `POST /api/requests/listing`. One model
 * holds both; the active path picks the shared Zod schema that validates it
 * (`ClaimFormSchema` or `ListingRequestFormSchema`), so the LinkedIn host allowlist and
 * every other rule match the API exactly.
 *
 * **Steps.** "Continue" checks only the fields on screen. Back returns one step, and
 * never appears on the first step the visitor saw or on the receipt. Focus moves to
 * the step heading on every change, so a screen reader hears where it is.
 *
 * **Analytics** (§15.7). `claim_dialog_step` once per step shown, with the page, the
 * control that opened it and the path. `claim_requested` (with `plan_interest`) or
 * `listing_requested` on a `201`. Never the search text, a typed name, a website or an
 * email.
 *
 * Signed-in visitors get the email prefill `RequestFormBody` gives them, one-shot and
 * browser-only. Every string is `i18n` / `$localize`. Light only.
 */
@Component({
  selector: 'aec-claim-dialog-flow',
  imports: [ClaimantFields, FormField, PlanInterestField, SearchAutocomplete],
  host: { class: 'flex min-h-0 flex-1 flex-col' },
  template: `
    @if (step() !== 'done') {
      <div class="border-b border-(--border-default) px-6 pb-4" data-testid="claim-dialog-progress">
        <p class="text-xs font-semibold text-(--text-secondary)">
          <span i18n="@@claimDialog.progress">Step {{ stepNumber() }} of {{ stepCount }}</span>
          <span aria-hidden="true"> · </span>
          <span>{{ stepName() }}</span>
        </p>
        <div class="mt-2 h-1 overflow-hidden rounded-full bg-(--surface-sunken)" aria-hidden="true">
          <div
            class="h-full rounded-full bg-(--accent-primary) transition-[width] duration-200 motion-reduce:transition-none"
            [style.width.%]="(stepNumber() / stepCount) * 100"
          ></div>
        </div>
      </div>
    }

    <div class="min-h-0 flex-1 overflow-y-auto px-6 py-6" data-testid="claim-dialog-body">
      @switch (step()) {
        @case ('find') {
          <h3 #stepHeading tabindex="-1" [class]="headingClass" i18n="@@claimDialog.find.heading">
            Find your listing
          </h3>
          <p class="mt-1 text-sm text-(--text-secondary)" i18n="@@claimDialog.find.lede">
            Your product or company may already be listed, under a different name.
          </p>
          <div class="mt-5">
            <aec-search-autocomplete
              inputId="claim-dialog-search"
              [label]="searchLabel"
              [labelVisible]="true"
              [placeholder]="searchPlaceholder"
              inputClass="w-full"
              inputHeightClass="h-11"
              (suggestionChosen)="choose($event)"
            />
          </div>
          <p class="mt-4 text-sm text-(--text-secondary)">
            <span i18n="@@claimDialog.find.notListedLead">Not listed?</span>
            {{ ' ' }}
            <button
              type="button"
              (click)="typeItIn()"
              [class]="textButtonClass"
              data-testid="claim-dialog-type-it-in"
              i18n="@@claimDialog.find.typeItIn"
            >
              Type it in
            </button>
          </p>
        }
        @case ('done') {
          <span
            aria-hidden="true"
            class="inline-flex size-9 items-center justify-center rounded-full bg-(--accent-primary-soft) text-(--accent-primary)"
          >
            <svg
              class="size-[18px]"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M20 6 9 17l-5-5" />
            </svg>
          </span>
          @if (path() === 'typed') {
            <h3
              #stepHeading
              tabindex="-1"
              [class]="headingClass + ' mt-3'"
              i18n="@@claimDialog.done.typed.heading"
            >
              Request sent
            </h3>
            <p
              class="mt-2 text-sm leading-relaxed text-(--text-secondary)"
              i18n="@@claimDialog.done.typed.body"
            >
              We'll add
              <strong class="font-semibold text-(--text-primary)">{{ sentName() }}</strong> to the
              directory, then email
              <strong class="font-semibold break-all text-(--text-primary)">{{ sentTo() }}</strong>
              so you can finish your claim.
            </p>
          } @else {
            <h3
              #stepHeading
              tabindex="-1"
              [class]="headingClass + ' mt-3'"
              i18n="@@requests.sent.claim.title"
            >
              Claim sent
            </h3>
            <p
              class="mt-2 text-sm leading-relaxed text-(--text-secondary)"
              i18n="@@requests.sent.claim.subtitle"
            >
              We'll email
              <strong class="font-bold break-all text-(--text-primary)">{{ sentTo() }}</strong> with
              our decision.
            </p>
            <div
              class="mt-5 rounded-(--radius-md) border border-(--border-default) bg-(--surface-raised) p-4"
            >
              <p
                class="text-sm font-bold text-(--text-primary)"
                i18n="@@requests.sent.next.heading"
              >
                What happens next
              </p>
              <ol
                class="mt-2 list-decimal space-y-1 ps-5 text-sm leading-relaxed text-(--text-secondary)"
              >
                <li i18n="@@requests.sent.claim.step1">
                  A person at AEC Integrations reviews every claim. Nothing is granted
                  automatically.
                </li>
                <li i18n="@@requests.sent.claim.step2">
                  We check your email domain against your company's website, and your LinkedIn if
                  you added it.
                </li>
                <li i18n="@@requests.sent.claim.step3">
                  If we approve it, we email you a link to your vendor portal.
                </li>
              </ol>
            </div>
          }
        }
        @default {
          <form id="claim-dialog-form" novalidate (submit)="$event.preventDefault(); primary()">
            @switch (step()) {
              @case ('you') {
                <h3
                  #stepHeading
                  tabindex="-1"
                  [class]="headingClass"
                  i18n="@@claimDialog.you.heading"
                >
                  About you
                </h3>
                @if (path() === 'found') {
                  <p
                    class="mt-3 flex flex-wrap items-baseline gap-x-2 rounded-(--radius-md) bg-(--surface-raised) px-3 py-2 text-sm text-(--text-primary)"
                    data-testid="claim-dialog-listing"
                  >
                    <span class="text-(--text-secondary)" i18n="@@claimDialog.you.claiming"
                      >Claiming</span
                    >
                    <strong class="font-semibold">{{ listing()?.name }}</strong>
                    <button
                      type="button"
                      (click)="toFind()"
                      [class]="textButtonClass"
                      i18n="@@claimDialog.you.change"
                    >
                      Change
                    </button>
                  </p>
                } @else {
                  <p class="mt-1 text-sm text-(--text-secondary)">
                    <span i18n="@@claimDialog.you.typedLede"
                      >Tell us the product or company to add.</span
                    >
                  </p>
                  <div class="mt-5 space-y-6">
                    <div class="space-y-1.5">
                      <label
                        for="claim-dialog-listing-name"
                        [class]="labelClass"
                        i18n="@@claimDialog.you.listingName"
                      >
                        Product or company name
                      </label>
                      <input
                        id="claim-dialog-listing-name"
                        type="text"
                        autocomplete="organization"
                        [formField]="form.listing_name"
                        [attr.aria-invalid]="invalid(form.listing_name) ? 'true' : null"
                        [attr.aria-describedby]="
                          invalid(form.listing_name) ? 'claim-dialog-listing-name-error' : null
                        "
                        [class]="inputClass"
                      />
                      @if (invalid(form.listing_name)) {
                        <p
                          id="claim-dialog-listing-name-error"
                          class="text-xs font-medium text-(--text-primary)"
                          role="alert"
                          i18n="@@claimDialog.you.listingName.error"
                        >
                          Enter the product or company name.
                        </p>
                      }
                    </div>
                    <div class="space-y-1.5">
                      <label
                        for="claim-dialog-website"
                        [class]="labelClass"
                        i18n="@@claimDialog.you.website"
                      >
                        Website
                      </label>
                      <input
                        id="claim-dialog-website"
                        type="url"
                        inputmode="url"
                        autocomplete="url"
                        placeholder="https://"
                        [formField]="form.website"
                        [attr.aria-invalid]="invalid(form.website) ? 'true' : null"
                        [attr.aria-describedby]="
                          invalid(form.website) ? 'claim-dialog-website-error' : null
                        "
                        [class]="inputClass"
                      />
                      @if (invalid(form.website)) {
                        <p
                          id="claim-dialog-website-error"
                          class="text-xs font-medium text-(--text-primary)"
                          role="alert"
                          i18n="@@claimDialog.you.website.error"
                        >
                          Enter the website, starting with https://
                        </p>
                      }
                    </div>
                  </div>
                }
                <aec-claimant-fields
                  class="mt-6"
                  idPrefix="claim-dialog"
                  [name]="form.submitter_name"
                  [role]="form.submitter_role"
                  [linkedin]="form.submitter_linkedin_url"
                  [email]="form.submitter_email"
                />
              }
              @case ('plan') {
                <h3
                  #stepHeading
                  tabindex="-1"
                  [class]="headingClass"
                  i18n="@@claimDialog.plan.heading"
                >
                  Your plan
                </h3>
                <aec-plan-interest-field
                  class="mt-4"
                  idPrefix="claim-dialog"
                  [field]="form.plan_interest"
                />
              }
              @case ('comments') {
                <h3
                  #stepHeading
                  tabindex="-1"
                  [class]="headingClass"
                  i18n="@@claimDialog.comments.heading"
                >
                  Anything to add?
                </h3>
                <div class="mt-4 space-y-1.5">
                  <label
                    for="claim-dialog-comments"
                    [class]="labelClass"
                    i18n="@@requests.claim.comments.label"
                  >
                    Additional comments
                    <span class="font-normal normal-case text-(--text-tertiary)">(optional)</span>
                  </label>
                  <textarea
                    id="claim-dialog-comments"
                    rows="5"
                    [formField]="form.body"
                    [attr.aria-invalid]="invalid(form.body) ? 'true' : null"
                    [attr.aria-describedby]="
                      invalid(form.body)
                        ? 'claim-dialog-comments-hint claim-dialog-comments-error'
                        : 'claim-dialog-comments-hint'
                    "
                    [class]="inputClass"
                  ></textarea>
                  <p
                    id="claim-dialog-comments-hint"
                    class="text-xs text-(--text-secondary)"
                    i18n="@@claimDialog.comments.hint"
                  >
                    Your team, the products you make, or anything that helps us review your claim.
                    Up to 2,000 characters.
                  </p>
                  @if (invalid(form.body)) {
                    <p
                      id="claim-dialog-comments-error"
                      class="text-xs font-medium text-(--text-primary)"
                      role="alert"
                      i18n="@@requests.claim.body.error"
                    >
                      Keep this under 2,000 characters.
                    </p>
                  }
                </div>
                @if (submitError() === 'gone') {
                  <p class="mt-4 text-sm font-medium text-(--text-primary)" role="alert">
                    <span i18n="@@claimDialog.error.gone"
                      >That listing is no longer available.</span
                    >
                    {{ ' ' }}
                    <button
                      type="button"
                      (click)="typeItInFromGone()"
                      [class]="textButtonClass"
                      i18n="@@claimDialog.error.typeInstead"
                    >
                      Type it in instead
                    </button>
                  </p>
                } @else if (submitError() === 'failed') {
                  <p
                    class="mt-4 text-sm font-medium text-(--text-primary)"
                    role="alert"
                    i18n="@@requests.submitFailed"
                  >
                    Something went wrong. Please try again.
                  </p>
                }
              }
            }
          </form>
        }
      }
    </div>

    @if (step() !== 'find') {
      <div
        class="flex flex-wrap items-center justify-end gap-3 border-t border-(--border-default) px-6 py-4"
        data-testid="claim-dialog-footer"
      >
        @if (step() === 'done') {
          <button
            type="button"
            (click)="done.emit()"
            [class]="primaryClass"
            i18n="@@requests.sent.done"
          >
            Done
          </button>
        } @else {
          @if (canGoBack()) {
            <button
              type="button"
              (click)="back()"
              [class]="secondaryClass + ' me-auto'"
              data-testid="claim-dialog-back"
              i18n="@@claimDialog.back"
            >
              Back
            </button>
          }
          <button
            type="submit"
            form="claim-dialog-form"
            [disabled]="submitting()"
            [class]="primaryClass"
            data-testid="claim-dialog-primary"
          >
            @if (step() !== 'comments') {
              <span i18n="@@claimDialog.continue">Continue</span>
            } @else if (submitting()) {
              <span i18n="@@requests.submitting">Submitting…</span>
            } @else if (path() === 'typed') {
              <span i18n="@@claimDialog.submit.typed">Send request</span>
            } @else {
              <span i18n="@@requests.claim.submit">Send claim</span>
            }
          </button>
        }
      </div>
    }
  `,
})
export class ClaimDialogFlow implements OnInit {
  private readonly api = inject(RequestsApi);
  private readonly analytics = inject(Analytics);
  private readonly session = inject(SessionStatus);
  private readonly injector = inject(Injector);
  private readonly document = inject(DOCUMENT);

  /** How the dialog was opened. Read once, in `ngOnInit`. */
  readonly opening = input.required<ClaimDialogOpening>();
  /** "Done" on the receipt. The shell closes the dialog. */
  readonly done = output<void>();

  protected readonly stepCount = STEPS.length;
  protected readonly step = signal<ClaimDialogStep>('find');
  protected readonly path = signal<'found' | 'typed' | null>(null);
  protected readonly listing = signal<ClaimListing | null>(null);
  protected readonly submitting = signal(false);
  protected readonly submitError = signal<'gone' | 'failed' | null>(null);
  protected readonly sentTo = signal('');
  protected readonly sentName = signal('');

  private readonly stepHeading = viewChild<ElementRef<HTMLElement>>('stepHeading');

  private readonly model = signal<ClaimDialogModel>({
    listing_name: '',
    website: '',
    submitter_name: '',
    submitter_email: '',
    submitter_role: '',
    submitter_linkedin_url: '',
    plan_interest: '',
    body: '',
  });

  /** Validated against the shared schema of the active path: the API's own rules. */
  protected readonly form = form(this.model, (p) => {
    validateStandardSchema(p, () =>
      this.path() === 'typed' ? ListingRequestFormSchema : ClaimFormSchema,
    );
  });

  protected readonly stepNumber = computed(() => Math.max(1, STEPS.indexOf(this.step()) + 1));
  protected readonly stepName = computed(() => {
    switch (this.step()) {
      case 'find':
        return $localize`:@@claimDialog.stepName.find:Find it`;
      case 'you':
        return $localize`:@@claimDialog.stepName.you:You`;
      case 'plan':
        return $localize`:@@claimDialog.stepName.plan:Plan`;
      default:
        return $localize`:@@claimDialog.stepName.comments:Comments`;
    }
  });
  protected readonly canGoBack = computed(() => this.step() !== 'done' && this.step() !== 'find');

  protected readonly searchLabel = $localize`:@@vendorProgram.find.label:Your product or company`;
  protected readonly searchPlaceholder = $localize`:@@vendorProgram.find.placeholder:Search for your product or company`;

  protected readonly headingClass =
    'font-display text-xl font-normal text-(--text-primary) focus:outline-none';
  protected readonly labelClass =
    'block text-xs font-bold uppercase tracking-[0.08em] text-(--text-secondary)';
  protected readonly inputClass =
    'w-full rounded-(--radius-md) border border-(--border-default) bg-(--surface-base) px-3 py-2 text-sm text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';
  protected readonly textButtonClass =
    'font-semibold text-(--accent-primary) underline underline-offset-2 hover:text-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';
  protected readonly primaryClass =
    'inline-flex min-h-11 items-center justify-center rounded-(--radius-md) bg-(--accent-primary) px-5 py-2.5 text-sm font-bold text-(--surface-base) transition-colors hover:bg-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) disabled:cursor-not-allowed disabled:opacity-50';
  protected readonly secondaryClass =
    'inline-flex min-h-11 items-center justify-center rounded-(--radius-md) border border-(--border-strong) bg-(--surface-base) px-5 py-2.5 text-sm font-medium text-(--text-primary) transition-colors hover:bg-(--surface-sunken) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';

  private prefilledEmail = false;

  constructor() {
    // The signed-in prefill `RequestFormBody` does: one-shot, never over the visitor.
    effect(() => {
      const email = this.session.email();
      if (!email) return;
      untracked(() => {
        if (this.prefilledEmail || this.model().submitter_email) return;
        this.prefilledEmail = true;
        this.model.update((m) => ({ ...m, submitter_email: email }));
      });
    });
  }

  ngOnInit(): void {
    const opening = this.opening();
    if (opening.plan) this.model.update((m) => ({ ...m, plan_interest: opening.plan ?? '' }));
    this.show('find', false);
  }

  /** A suggestion chosen in step 1: that listing, then step 2. */
  protected choose(hit: AutocompleteSuggestion): void {
    const slug = hit.routerLink.at(-1);
    if (!slug) return;
    this.listing.set({ targetType: hit.kind, slug, name: hit.title });
    this.path.set('found');
    this.submitError.set(null);
    this.show('you');
  }

  protected typeItIn(): void {
    this.path.set('typed');
    this.submitError.set(null);
    this.show('you');
  }

  /** A found listing 404'd on submit: carry its name into the typed-in path. */
  protected typeItInFromGone(): void {
    const name = this.listing()?.name ?? '';
    this.model.update((m) => ({ ...m, listing_name: m.listing_name || name }));
    this.listing.set(null);
    this.typeItIn();
  }

  protected toFind(): void {
    this.show('find');
  }

  protected back(): void {
    const index = STEPS.indexOf(this.step());
    if (index > 0) this.show(STEPS[index - 1]!);
  }

  /** Continue, or send on the last step. */
  protected async primary(): Promise<void> {
    switch (this.step()) {
      case 'you':
        if (this.checkFields(this.youFields())) this.show('plan');
        return;
      case 'plan':
        this.show('comments');
        return;
      case 'comments':
        if (this.checkFields([['body', 'claim-dialog-comments', this.form.body]]))
          await this.send();
        return;
      default:
        return;
    }
  }

  protected invalid(field: FieldTree<string>): boolean {
    return field().touched() && !!field().getError('standardSchema');
  }

  /** Step 2's fields: the model key, the control to focus on error, and the field. */
  private youFields(): StepField[] {
    const fields: StepField[] = [];
    if (this.path() === 'typed') {
      fields.push(['listing_name', 'claim-dialog-listing-name', this.form.listing_name]);
      fields.push(['website', 'claim-dialog-website', this.form.website]);
    }
    fields.push(
      ['submitter_name', 'claim-dialog-name', this.form.submitter_name],
      ['submitter_role', 'claim-dialog-role', this.form.submitter_role],
      ['submitter_linkedin_url', 'claim-dialog-linkedin', this.form.submitter_linkedin_url],
      ['submitter_email', 'claim-dialog-email', this.form.submitter_email],
    );
    return fields;
  }

  /**
   * Touch the step's fields, so their messages show, and check them against the active
   * shared schema synchronously: the form's own schema validation may still be pending
   * when Continue is pressed. On any error, focus the first bad control and stay.
   */
  private checkFields(fields: StepField[]): boolean {
    for (const [, , field] of fields) field().markAsTouched();
    const schema = this.path() === 'typed' ? ListingRequestFormSchema : ClaimFormSchema;
    const result = schema.safeParse(this.model());
    const badKeys = new Set(
      result.success ? [] : result.error.issues.map((i) => String(i.path[0])),
    );
    const bad = fields.find(([key]) => badKeys.has(key));
    if (!bad) return true;
    this.document.getElementById(bad[1])?.focus();
    return false;
  }

  private async send(): Promise<void> {
    this.submitError.set(null);
    this.submitting.set(true);
    await submit(this.form, async (f) => {
      const v = f().value();
      const opening = this.opening();
      const identity = {
        submitter_name: v.submitter_name,
        submitter_email: v.submitter_email,
        submitter_role: v.submitter_role,
        submitter_linkedin_url: v.submitter_linkedin_url,
        plan_interest: v.plan_interest,
        body: v.body,
      };
      const listing = this.listing();
      try {
        if (this.path() === 'found' && listing) {
          const res = await this.api.submitClaim(
            { targetType: listing.targetType, slug: listing.slug },
            identity,
          );
          this.analytics.claimRequested({
            target_type: listing.targetType,
            slug: listing.slug,
            request_id: res.request_id,
            plan_interest: planInterestProperty(v.plan_interest),
          });
        } else {
          await this.api.submitListing({
            ...identity,
            listing_name: v.listing_name,
            website: v.website,
          });
          this.analytics.listingRequested({
            plan_interest: planInterestProperty(v.plan_interest),
            page: opening.page,
          });
        }
        this.sentTo.set(v.submitter_email.trim());
        this.sentName.set(v.listing_name.trim());
        this.show('done');
      } catch (err) {
        this.submitError.set(
          err instanceof HttpErrorResponse && err.status === 404 && this.path() === 'found'
            ? 'gone'
            : 'failed',
        );
      }
      return undefined;
    });
    this.submitting.set(false);
  }

  /** Show a step, report it, and move focus to its heading. */
  private show(step: ClaimDialogStep, focus = true): void {
    this.step.set(step);
    const opening = this.opening();
    const path = this.path();
    this.analytics.claimDialogStep({
      step,
      page: opening.page,
      entry: opening.entry,
      ...(step !== 'find' && path ? { path } : {}),
    });
    if (!focus) return;
    afterNextRender(
      () => {
        if (step === 'find') {
          this.document.getElementById('claim-dialog-search')?.focus();
        } else {
          this.stepHeading()?.nativeElement.focus();
        }
      },
      { injector: this.injector },
    );
  }
}
