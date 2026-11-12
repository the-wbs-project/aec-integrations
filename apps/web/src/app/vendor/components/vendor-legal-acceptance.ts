import { DOCUMENT } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import {
  Component,
  ElementRef,
  LOCALE_ID,
  afterNextRender,
  computed,
  inject,
  input,
  linkedSignal,
  signal,
  viewChild,
} from '@angular/core';
import {
  FormField,
  form,
  maxLength,
  required,
  submit,
  validateStandardSchema,
} from '@angular/forms/signals';

import {
  AcceptLegalVersionRequestSchema,
  ApiErrorCode,
  LEGAL_ACCEPT_LEGAL_NAME_MAX,
  LEGAL_ACCEPT_SIGNER_NAME_MAX,
  LEGAL_ACCEPT_SIGNER_TITLE_MAX,
  type VendorLegalPending,
} from '@aeci/shared';

import {
  BUTTON_PRIMARY_CLASS,
  BUTTON_SECONDARY_CLASS,
  CHOICE_INPUT_CLASS,
  FIELD_ERROR_CLASS,
  FIELD_HINT_CLASS,
  FIELD_INPUT_CLASS,
  FIELD_LABEL_CLASS,
} from '../../shared/form-field/form-field-classes';
import { formatTermDate } from '../../shared/term-date/format-term-date';
import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorApi } from '../vendor-api';
import { VendorLegalAcceptanceState } from '../vendor-legal-acceptance-state';

const SUPPORT_EMAIL = 'support@aecintegrations.com';

/** The fields the owner gives. `accepted` is `z.literal(true)`, so the form stays invalid
 *  until the box is ticked. `signer_name` is checked by `required` below, only when asked;
 *  `loose()` lets the model carry it past this strict schema. */
const AcceptFormSchema = AcceptLegalVersionRequestSchema.pick({
  accepted: true,
  signer_title: true,
  company_legal_name: true,
}).loose();

interface AcceptModel {
  accepted: boolean;
  signer_title: string;
  company_legal_name: string;
  /** Asked only when the server has no name for the seat (`signer.name` null). */
  signer_name: string;
}

/** A refusal, mapped to a sentence the owner can act on. `stale`: the state is out of
 *  date, so the screen re-reads it. */
export interface LegalAcceptFailure {
  readonly message: string;
  readonly stale: boolean;
  readonly field: 'signer_title' | 'company_legal_name' | 'signer_name' | null;
}

export function legalAcceptFailure(err: unknown): LegalAcceptFailure {
  const status = err instanceof HttpErrorResponse ? err.status : null;
  const body = err instanceof HttpErrorResponse ? err.error?.error : null;
  const code = typeof body?.code === 'string' ? body.code : null;
  const inline = (message: string, field: LegalAcceptFailure['field'] = null) => ({
    message,
    stale: false,
    field,
  });
  if (code === ApiErrorCode.LEGAL_ACCEPTANCE_NOT_PENDING) {
    return {
      message: $localize`:@@vendor.legalAccept.error.notPending:This version is no longer waiting for your acceptance. Another owner may have accepted it. We reloaded what you need to accept.`,
      stale: true,
      field: null,
    };
  }
  switch (status) {
    case 400: {
      const field = typeof body?.field === 'string' ? body.field : null;
      if (field === 'signer_title') {
        return inline(
          $localize`:@@vendor.legalAccept.error.title:Enter your title, up to 100 characters.`,
          'signer_title',
        );
      }
      if (field === 'signer_name') {
        return inline(
          $localize`:@@vendor.legalAccept.error.name:Enter your name, up to 200 characters.`,
          'signer_name',
        );
      }
      if (field === 'company_legal_name') {
        return inline(
          $localize`:@@vendor.legalAccept.error.legalName:Enter the company's legal name, up to 200 characters.`,
          'company_legal_name',
        );
      }
      return inline(
        $localize`:@@vendor.legalAccept.error.invalid:That request was not valid. Refresh the page and try again.`,
      );
    }
    case 403:
      return inline(
        $localize`:@@vendor.legalAccept.error.forbidden:Only an owner seat can accept for the company. Ask an owner at your company to accept.`,
      );
    case 429:
      return inline(
        $localize`:@@vendor.legalAccept.error.rate:Too many changes in a short time. Try again in a minute.`,
      );
  }
  return inline(
    $localize`:@@vendor.legalAccept.error.generic:We could not record your acceptance. Nothing was saved. Try again.`,
  );
}

/** The document's name, as the screen writes it. */
export function legalDocumentTitle(document: VendorLegalPending['document']): string {
  return document === 'vendor_terms'
    ? $localize`:@@vendor.legalAccept.doc.vendorTerms:Vendor Terms`
    : $localize`:@@vendor.legalAccept.doc.managedPlan:Managed plan agreement`;
}

/**
 * The portal's acceptance screen (AECI-1677, `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.24;
 * counsel Q42, rulings 24 and 25, counsel Q3). One screen, two modes, chosen by the item:
 *
 *   - `required` (ruling 24): the shell renders this in place of the tabs. An owner seat
 *     accepts for the company. A member seat sees who the owners are, and can check again.
 *   - `optional`: the shell renders this above the tabs, with "Not now". Until an owner
 *     accepts, the earlier version keeps applying to the company.
 *
 * The box is the claim form's (`vendor-terms-box.ts`, `@@requests.terms.label`): required,
 * unticked, its label naming the version and the company. The server records the same
 * words (`portalAcceptanceLabel` in `@aeci/shared`; the component spec holds them equal).
 * The link opens the fixed copy of exactly this version in a new tab, so the screen stays.
 * The "What changes" bullets are rendered as text: they are stored unescaped.
 *
 * After an accept, {@link VendorLegalAcceptanceState} takes the new state and shows the
 * confirmation ({@link VendorLegalAccepted}), which takes the focus and announces itself.
 */
@Component({
  selector: 'aec-vendor-legal-acceptance',
  imports: [FormField],
  host: { class: 'block' },
  template: `
    @let it = item();
    <section
      [attr.aria-labelledby]="id('heading')"
      [class]="
        it.mode === 'required'
          ? 'mt-6 border-t border-(--border-default) pt-8'
          : 'mb-6 rounded-(--radius-md) border border-(--border-default) bg-(--surface-raised) p-5 md:p-6'
      "
      data-testid="legal-accept"
      [attr.data-mode]="it.mode"
    >
      <div
        [class]="
          it.mode === 'required'
            ? 'grid gap-8 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]'
            : 'grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]'
        "
      >
        <div class="min-w-0">
          <h2
            [id]="id('heading')"
            tabindex="-1"
            class="font-display text-2xl font-semibold tracking-tight text-(--text-primary) focus-visible:outline-none"
            data-testid="legal-accept-heading"
          >
            {{ headingLabel() }}
          </h2>

          <div class="mt-3 max-w-prose space-y-3 text-base text-(--text-secondary)">
            @if (it.mode === 'required') {
              @if (canAccept()) {
                <p i18n="@@vendor.legalAccept.required.lead">
                  Version {{ it.version }} of the {{ docTitle() }} took effect on {{ dateLabel() }}.
                  Your company has not accepted a version that is in force yet, so the portal opens
                  once an owner seat accepts this one. Any owner seat can accept for
                  {{ companyName() }}.
                </p>
              } @else {
                <p i18n="@@vendor.legalAccept.member.lead">
                  Version {{ it.version }} of the {{ docTitle() }} took effect on {{ dateLabel() }}.
                  An owner seat at {{ companyName() }} needs to accept it before the portal opens. A
                  member seat cannot accept for the company.
                </p>
              }
              <p i18n="@@vendor.legalAccept.required.listing">
                Your listing stays claimed in the meantime. There is no deadline.
              </p>
            } @else {
              <p>{{ optionalLead() }}</p>
              @if (it.document === 'vendor_terms') {
                <p i18n="@@vendor.legalAccept.optional.terms">
                  This version changes the liability, indemnity, disputes or content license
                  sections in a way that reduces your rights. That change applies to
                  {{ companyName() }} only after an owner seat accepts it. Until then the earlier
                  version applies to you.
                </p>
              }
            }
          </div>

          @if (it.summary.length > 0) {
            <h3
              class="mt-6 font-label text-sm font-semibold text-(--text-primary)"
              i18n="@@vendor.legalAccept.changes"
            >
              What changes
            </h3>
            <ul
              class="mt-2 max-w-prose list-disc space-y-1 ps-5 text-sm text-(--text-primary)"
              data-testid="legal-accept-summary"
            >
              @for (line of it.summary; track $index) {
                <li>{{ line }}</li>
              }
            </ul>
          }

          <p class="mt-5 text-sm">
            <a
              [href]="it.page_path"
              target="_blank"
              rel="noopener"
              [class]="linkClass"
              data-testid="legal-accept-read"
              >{{ readLabel()
              }}<span class="sr-only" i18n="@@vendor.legalAccept.newTab">
                (opens in a new tab)</span
              ></a
            >
          </p>

          @if (canAccept()) {
            <form novalidate class="mt-6 max-w-xl space-y-5" (submit)="accept($event)">
              @if (askName()) {
                <div class="space-y-1.5 sm:max-w-[calc(50%-0.625rem)]">
                  <label
                    [attr.for]="id('name')"
                    [class]="labelClass"
                    i18n="@@vendor.legalAccept.name"
                    >Your name</label
                  >
                  <input
                    [id]="id('name')"
                    type="text"
                    autocomplete="name"
                    [class]="inputClass"
                    [formField]="form.signer_name"
                    [attr.aria-invalid]="nameError() ? 'true' : null"
                    [attr.aria-describedby]="
                      nameError() ? id('name-hint') + ' ' + id('name-error') : id('name-hint')
                    "
                    data-testid="legal-accept-name"
                    (input)="rejected.set(null)"
                  />
                  <p
                    [id]="id('name-hint')"
                    [class]="hintClass"
                    i18n="@@vendor.legalAccept.nameHint"
                  >
                    We have no name on file for your seat. We record it with your acceptance.
                  </p>
                  @if (nameError()) {
                    <p
                      [id]="id('name-error')"
                      role="alert"
                      [class]="errorClass"
                      i18n="@@vendor.legalAccept.nameError"
                    >
                      Enter your name, up to 200 characters.
                    </p>
                  }
                </div>
              }
              <div class="grid gap-5 sm:grid-cols-2">
                <div class="space-y-1.5">
                  <label
                    [attr.for]="id('title')"
                    [class]="labelClass"
                    i18n="@@vendor.legalAccept.title"
                    >Your title</label
                  >
                  <input
                    [id]="id('title')"
                    type="text"
                    autocomplete="organization-title"
                    [class]="inputClass"
                    [formField]="form.signer_title"
                    [attr.aria-invalid]="titleError() ? 'true' : null"
                    [attr.aria-describedby]="
                      titleError() ? id('title-hint') + ' ' + id('title-error') : id('title-hint')
                    "
                    data-testid="legal-accept-title"
                    (input)="rejected.set(null)"
                  />
                  <p
                    [id]="id('title-hint')"
                    [class]="hintClass"
                    i18n="@@vendor.legalAccept.titleHint"
                  >
                    We record your title with your acceptance.
                  </p>
                  @if (titleError()) {
                    <p
                      [id]="id('title-error')"
                      role="alert"
                      [class]="errorClass"
                      i18n="@@vendor.legalAccept.titleError"
                    >
                      Enter your title, up to 100 characters.
                    </p>
                  }
                </div>
                <div class="space-y-1.5">
                  <label
                    [attr.for]="id('legal-name')"
                    [class]="labelClass"
                    i18n="@@vendor.legalAccept.legalName"
                    >Company legal name</label
                  >
                  <input
                    [id]="id('legal-name')"
                    type="text"
                    autocomplete="organization"
                    [class]="inputClass"
                    [formField]="form.company_legal_name"
                    [attr.aria-invalid]="legalNameError() ? 'true' : null"
                    [attr.aria-describedby]="
                      legalNameError()
                        ? id('legal-name-hint') + ' ' + id('legal-name-error')
                        : id('legal-name-hint')
                    "
                    data-testid="legal-accept-legal-name"
                    (input)="rejected.set(null)"
                  />
                  <p
                    [id]="id('legal-name-hint')"
                    [class]="hintClass"
                    i18n="@@vendor.legalAccept.legalNameHint"
                  >
                    The registered name of the company you accept for.
                  </p>
                  @if (legalNameError()) {
                    <p
                      [id]="id('legal-name-error')"
                      role="alert"
                      [class]="errorClass"
                      i18n="@@vendor.legalAccept.legalNameError"
                    >
                      Enter the company's legal name, up to 200 characters.
                    </p>
                  }
                </div>
              </div>

              <div class="space-y-1.5">
                <div class="flex items-start gap-3">
                  <input
                    [id]="id('accept')"
                    type="checkbox"
                    [formField]="form.accepted"
                    [attr.aria-invalid]="acceptError() ? 'true' : null"
                    [attr.aria-describedby]="acceptError() ? id('accept-error') : null"
                    [class]="choiceInputClass + ' mt-0.5'"
                    data-testid="legal-accept-box"
                  />
                  <label
                    [attr.for]="id('accept')"
                    class="text-sm leading-relaxed text-(--text-primary)"
                    data-testid="legal-accept-label"
                  >
                    @if (it.document === 'vendor_terms') {
                      <span i18n="@@vendor.legalAccept.label.vendorTerms"
                        >I have read and accept the Vendor Terms, version {{ it.version }}, on
                        behalf of {{ companyName() }}, and I am authorized to bind that
                        company.</span
                      >
                    } @else {
                      <span i18n="@@vendor.legalAccept.label.managedPlan"
                        >I have read and accept the Managed plan agreement, version
                        {{ it.version }}, on behalf of {{ companyName() }}.</span
                      >
                    }
                  </label>
                </div>
                @if (acceptError()) {
                  <p
                    [id]="id('accept-error')"
                    role="alert"
                    [class]="errorClass"
                    i18n="@@vendor.legalAccept.acceptError"
                  >
                    Tick the box to accept this version.
                  </p>
                }
              </div>

              @if (failure(); as message) {
                <p role="alert" [class]="errorClass" data-testid="legal-accept-error">
                  {{ message }}
                </p>
              }

              <div class="flex flex-col gap-3 sm:flex-row sm:items-center">
                <button
                  type="submit"
                  [class]="primaryClass"
                  [disabled]="form().invalid() || busy()"
                  [attr.aria-busy]="busy()"
                  data-testid="legal-accept-submit"
                >
                  @if (busy()) {
                    <ng-container i18n="@@vendor.legalAccept.accepting">Recording…</ng-container>
                  } @else {
                    {{ acceptLabel() }}
                  }
                </button>
                @if (it.mode === 'optional') {
                  <button
                    type="button"
                    [class]="secondaryClass"
                    data-testid="legal-accept-dismiss"
                    (click)="dismiss()"
                    i18n="@@vendor.legalAccept.notNow"
                  >
                    Not now
                  </button>
                }
              </div>
              @if (it.mode === 'optional') {
                <p [class]="hintClass" i18n="@@vendor.legalAccept.notNowHint">
                  You can keep using the portal. We ask again on your next visit.
                </p>
              }
            </form>
          } @else {
            <div class="mt-6 space-y-3 text-sm text-(--text-primary)">
              @if (ownerNames().length > 0) {
                <p data-testid="legal-accept-owners">{{ ownersLabel() }}</p>
              } @else {
                <p i18n="@@vendor.legalAccept.member.noOwner">
                  Your company has no owner seat that can sign in. Write to
                  {{ supportEmail }} and we will help.
                </p>
              }
              <button
                type="button"
                [class]="secondaryClass"
                [disabled]="checking()"
                [attr.aria-busy]="checking()"
                data-testid="legal-accept-check"
                (click)="checkAgain()"
              >
                @if (checking()) {
                  <ng-container i18n="@@vendor.legalAccept.checking">Checking…</ng-container>
                } @else {
                  <ng-container i18n="@@vendor.legalAccept.checkAgain">Check again</ng-container>
                }
              </button>
              @if (checkNote(); as note) {
                <p role="status" [class]="hintClass" data-testid="legal-accept-check-note">
                  {{ note }}
                </p>
              }
            </div>
          }
        </div>

        @if (it.mode === 'required') {
          <div
            class="self-start rounded-(--radius-md) border border-(--border-default) bg-(--surface-raised) p-5"
          >
            <h3
              [id]="id('aside')"
              class="text-base font-bold text-(--text-primary)"
              i18n="@@vendor.legalAccept.aside.heading"
            >
              What happens when an owner accepts
            </h3>
            <ul class="mt-3 list-disc space-y-2 ps-5 text-sm text-(--text-secondary)">
              <li i18n="@@vendor.legalAccept.aside.opens">
                The portal opens for every seat at {{ companyName() }}.
              </li>
              <li i18n="@@vendor.legalAccept.aside.record">
                We record the owner's name and title, the company's legal name, the time and the
                version. Owner seats can see the record on the Billing tab.
              </li>
              <li i18n="@@vendor.legalAccept.aside.questions">
                Questions about these terms go to {{ supportEmail }}.
              </li>
            </ul>
            @if (canAccept() && stripeBilling()) {
              <!-- The Stripe portal route passes a blocked company (allowTermsPending), so an
                   owner can still manage or cancel billing without accepting first. -->
              <div class="mt-5 border-t border-(--border-default) pt-4">
                <p class="text-sm text-(--text-secondary)" i18n="@@vendor.legalAccept.billing.body">
                  You can still manage or cancel your billing.
                </p>
                <button
                  type="button"
                  [class]="secondaryClass + ' mt-3'"
                  [disabled]="portalBusy()"
                  [attr.aria-busy]="portalBusy()"
                  data-testid="legal-accept-billing"
                  (click)="openBillingPortal()"
                >
                  @if (portalBusy()) {
                    <ng-container i18n="@@vendor.legalAccept.billing.pending"
                      >Opening Stripe…</ng-container
                    >
                  } @else {
                    <ng-container i18n="@@vendor.legalAccept.billing.action"
                      >Manage billing in Stripe</ng-container
                    >
                  }
                </button>
                @if (portalFailed()) {
                  <p
                    role="alert"
                    [class]="errorClass + ' mt-2'"
                    data-testid="legal-accept-billing-error"
                    i18n="@@vendor.legalAccept.billing.error"
                  >
                    We could not open Stripe just now. Try again in a moment.
                  </p>
                }
              </div>
            }
          </div>
        } @else {
          <div class="text-sm text-(--text-secondary)">
            <p i18n="@@vendor.legalAccept.optional.record">
              We record your name and title, the company's legal name, the time and the version.
              Owner seats can see the record on the Billing tab.
            </p>
          </div>
        }
      </div>
    </section>
  `,
})
export class VendorLegalAcceptance {
  readonly item = input.required<VendorLegalPending>();
  readonly companyName = input.required<string>();
  readonly canAccept = input.required<boolean>();
  readonly ownerNames = input<readonly string[]>([]);
  readonly prefillTitle = input<string | null>(null);
  readonly prefillLegalName = input<string | null>(null);
  /** The server has no name for this seat, so the screen asks for it. */
  readonly askName = input(false);
  /** The company has Stripe billing: the required screen offers the Stripe portal. */
  readonly stripeBilling = input(false);

  private readonly api = inject(VendorApi);
  private readonly legal = inject(VendorLegalAcceptanceState);
  private readonly announcer = inject(VendorPortalAnnouncer);
  private readonly locale = inject(LOCALE_ID);

  /** Seeded from the prefill once. A later re-read keeps what the owner typed. */
  private readonly model = linkedSignal<
    { title: string; legalName: string; key: string },
    AcceptModel
  >({
    source: () => ({
      title: this.prefillTitle() ?? '',
      legalName: this.prefillLegalName() ?? '',
      key: `${this.item().document}@${this.item().version}`,
    }),
    computation: (src, previous) =>
      previous && previous.source.key === src.key
        ? previous.value
        : {
            accepted: false,
            signer_title: src.title,
            company_legal_name: src.legalName,
            signer_name: '',
          },
  });
  protected readonly form = form(this.model, (p) => {
    validateStandardSchema(p, () => AcceptFormSchema);
    maxLength(p.signer_title, LEGAL_ACCEPT_SIGNER_TITLE_MAX);
    maxLength(p.company_legal_name, LEGAL_ACCEPT_LEGAL_NAME_MAX);
    required(p.signer_name, { when: () => this.askName() });
    maxLength(p.signer_name, LEGAL_ACCEPT_SIGNER_NAME_MAX);
  });

  protected readonly busy = signal(false);
  protected readonly failure = signal<string | null>(null);
  protected readonly rejected = signal<LegalAcceptFailure['field']>(null);
  protected readonly checking = signal(false);
  protected readonly checkNote = signal<string | null>(null);

  protected readonly titleError = computed(() => {
    if (this.rejected() === 'signer_title') return true;
    const f = this.form.signer_title();
    return f.touched() && f.invalid();
  });
  protected readonly nameError = computed(() => {
    if (this.rejected() === 'signer_name') return true;
    const f = this.form.signer_name();
    return f.touched() && f.invalid();
  });
  protected readonly legalNameError = computed(() => {
    if (this.rejected() === 'company_legal_name') return true;
    const f = this.form.company_legal_name();
    return f.touched() && f.invalid();
  });
  protected readonly acceptError = computed(() => {
    const f = this.form.accepted();
    return !f.value() && f.touched();
  });

  protected readonly docTitle = computed(() => legalDocumentTitle(this.item().document));
  protected readonly dateLabel = computed(() =>
    formatTermDate(this.item().effective_at, this.locale),
  );

  protected readonly headingLabel = computed(() => {
    const it = this.item();
    const doc = this.docTitle();
    const version = it.version;
    if (it.mode === 'required' && !this.canAccept()) {
      return $localize`:@@vendor.legalAccept.member.heading:An owner needs to accept the ${doc}:DOCUMENT:`;
    }
    return it.mode === 'required'
      ? $localize`:@@vendor.legalAccept.required.heading:Accept the ${doc}:DOCUMENT:, version ${version}:VERSION:`
      : $localize`:@@vendor.legalAccept.optional.heading:${doc}:DOCUMENT:, version ${version}:VERSION:, is ready for you to accept`;
  });

  protected readonly optionalLead = computed(() => {
    const it = this.item();
    const doc = this.docTitle();
    const version = it.version;
    const date = this.dateLabel();
    if (it.document === 'managed_plan') {
      return it.in_force
        ? $localize`:@@vendor.legalAccept.optional.managedLeadInForce:Version ${version}:VERSION: of the ${doc}:DOCUMENT: took effect on ${date}:DATE:. Because your company pays monthly, we ask an owner seat to accept it here.`
        : $localize`:@@vendor.legalAccept.optional.managedLead:Version ${version}:VERSION: of the ${doc}:DOCUMENT: takes effect on ${date}:DATE:. Because your company pays monthly, we ask an owner seat to accept it here.`;
    }
    return it.in_force
      ? $localize`:@@vendor.legalAccept.optional.termsLeadInForce:Version ${version}:VERSION: of the ${doc}:DOCUMENT: took effect on ${date}:DATE:.`
      : $localize`:@@vendor.legalAccept.optional.termsLead:Version ${version}:VERSION: of the ${doc}:DOCUMENT: takes effect on ${date}:DATE:.`;
  });

  protected readonly readLabel = computed(() => {
    const doc = this.docTitle();
    const version = this.item().version;
    return $localize`:@@vendor.legalAccept.read:Read version ${version}:VERSION: of the ${doc}:DOCUMENT:`;
  });

  protected readonly acceptLabel = computed(() => {
    const version = this.item().version;
    return $localize`:@@vendor.legalAccept.accept:Accept version ${version}:VERSION:`;
  });

  protected readonly ownersLabel = computed(() => {
    const names = this.ownerNames().join(', ');
    return this.ownerNames().length === 1
      ? $localize`:@@vendor.legalAccept.member.ownerOne:The owner at your company is ${names}:NAMES:.`
      : $localize`:@@vendor.legalAccept.member.owners:The owners at your company are ${names}:NAMES:.`;
  });

  protected readonly supportEmail = SUPPORT_EMAIL;

  protected id(key: string): string {
    const it = this.item();
    return `legal-accept-${it.document}-${it.version.replace(/\W/g, '-')}-${key}`;
  }

  protected async accept(event: Event): Promise<void> {
    event.preventDefault();
    if (this.busy()) return;
    this.failure.set(null);
    await submit(this.form, async (f) => {
      const v = f().value();
      if (!v.accepted) return undefined;
      this.busy.set(true);
      try {
        const it = this.item();
        const res = await this.api.acceptLegalVersion({
          document: it.document,
          version: it.version,
          accepted: true,
          signer_title: v.signer_title.trim(),
          company_legal_name: v.company_legal_name.trim(),
          ...(this.askName() ? { signer_name: v.signer_name.trim() } : {}),
        });
        this.legal.accepted(res);
      } catch (err) {
        const mapped = legalAcceptFailure(err);
        this.failure.set(mapped.message);
        this.rejected.set(mapped.field);
        if (mapped.stale) await this.legal.refresh();
      } finally {
        this.busy.set(false);
      }
      return undefined;
    });
  }

  protected readonly portalBusy = signal(false);
  protected readonly portalFailed = signal(false);

  /** `POST /api/vendor/billing/portal`, then leave for Stripe. Busy stays on while leaving. */
  protected async openBillingPortal(): Promise<void> {
    if (this.portalBusy()) return;
    this.portalFailed.set(false);
    this.portalBusy.set(true);
    try {
      const { url } = await this.api.openBillingPortal();
      globalThis.location.assign(url);
    } catch {
      this.portalBusy.set(false);
      this.portalFailed.set(true);
    }
  }

  protected dismiss(): void {
    this.legal.dismiss(this.item());
    this.announcer.announce(
      $localize`:@@vendor.legalAccept.dismissed:We hid this for now. We ask again on your next visit.`,
    );
  }

  protected async checkAgain(): Promise<void> {
    if (this.checking()) return;
    this.checking.set(true);
    this.checkNote.set(null);
    const ok = await this.legal.refresh();
    this.checking.set(false);
    if (!ok) {
      this.checkNote.set(
        $localize`:@@vendor.legalAccept.checkFailed:We could not check just now. Try again in a moment.`,
      );
    } else if (this.legal.blocked()) {
      this.checkNote.set(
        $localize`:@@vendor.legalAccept.stillWaiting:No owner has accepted yet. Check again after an owner accepts.`,
      );
    }
  }

  protected readonly labelClass = FIELD_LABEL_CLASS;
  protected readonly inputClass = FIELD_INPUT_CLASS;
  protected readonly hintClass = FIELD_HINT_CLASS;
  protected readonly errorClass = FIELD_ERROR_CLASS;
  protected readonly choiceInputClass = CHOICE_INPUT_CLASS;
  protected readonly primaryClass = BUTTON_PRIMARY_CLASS;
  protected readonly secondaryClass = BUTTON_SECONDARY_CLASS;
  protected readonly linkClass =
    'font-semibold text-(--accent-primary) underline underline-offset-2 hover:text-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';
}

/**
 * The confirmation after an accept (AECI-1677). It takes the focus when it appears, and
 * announces itself once through the portal's one live region. It stays until the seat
 * closes it or leaves the page.
 */
@Component({
  selector: 'aec-vendor-legal-accepted',
  host: { class: 'block' },
  template: `
    <div
      class="mb-6 rounded-(--radius-md) border border-(--border-default) bg-(--surface-raised) p-5"
      data-testid="legal-accepted"
    >
      <h2
        #heading
        tabindex="-1"
        class="text-base font-bold text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
        data-testid="legal-accepted-heading"
      >
        {{ headingLabel() }}
      </h2>
      <p class="mt-2 text-sm text-(--text-secondary)">{{ bodyLabel() }}</p>
      <button
        type="button"
        class="mt-3 text-sm font-semibold text-(--accent-primary) underline underline-offset-2 hover:text-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
        data-testid="legal-accepted-close"
        (click)="close()"
        i18n="@@vendor.legalAccepted.close"
      >
        Close this message
      </button>
    </div>
  `,
})
export class VendorLegalAccepted {
  readonly companyName = input.required<string>();

  private readonly legal = inject(VendorLegalAcceptanceState);
  private readonly announcer = inject(VendorPortalAnnouncer);
  private readonly locale = inject(LOCALE_ID);
  private readonly heading = viewChild.required<ElementRef<HTMLElement>>('heading');
  private readonly doc = inject(DOCUMENT);

  protected readonly headingLabel = computed(() => {
    const done = this.legal.confirmation();
    if (!done) return '';
    const doc = legalDocumentTitle(done.document);
    const version = done.version;
    return $localize`:@@vendor.legalAccepted.heading:You accepted the ${doc}:DOCUMENT:, version ${version}:VERSION:`;
  });

  protected readonly bodyLabel = computed(() => {
    const done = this.legal.confirmation();
    if (!done) return '';
    const company = this.companyName();
    const date = formatTermDate(done.acceptedAt, this.locale);
    return done.unblocked
      ? $localize`:@@vendor.legalAccepted.bodyOpen:We recorded the acceptance for ${company}:COMPANY: on ${date}:DATE:. The portal is now open for every seat.`
      : $localize`:@@vendor.legalAccepted.body:We recorded the acceptance for ${company}:COMPANY: on ${date}:DATE:.`;
  });

  constructor() {
    afterNextRender(() => {
      this.heading().nativeElement.focus();
      this.announcer.announce(`${this.headingLabel()}. ${this.bodyLabel()}`);
    });
  }

  protected close(): void {
    this.legal.clearConfirmation();
    // The message is gone: hand the focus to the page heading, never to the body.
    this.doc.querySelector<HTMLElement>('h1')?.focus();
  }
}
