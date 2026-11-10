import { HttpErrorResponse } from '@angular/common/http';
import {
  Component,
  LOCALE_ID,
  computed,
  inject,
  input,
  linkedSignal,
  output,
  signal,
} from '@angular/core';
import { FormField, form, maxLength, submit, validateStandardSchema } from '@angular/forms/signals';

import {
  AcceptLicenseGrantSchema,
  ApiErrorCode,
  LICENSE_GRANT_SIGNER_TITLE_MAX,
  type AcceptLicenseGrantResponse,
  type VendorPendingGrant,
} from '@aeci/shared';

import { legalPath } from '../../legal/legal-manifest';
import {
  BUTTON_PRIMARY_CLASS,
  CHOICE_INPUT_CLASS,
  FIELD_ERROR_CLASS,
  FIELD_HINT_CLASS,
  FIELD_INPUT_CLASS,
  FIELD_LABEL_CLASS,
} from '../../shared/form-field/form-field-classes';
import { formatTermDate } from '../../shared/term-date/format-term-date';
import { VendorApi } from '../vendor-api';
import { licenseActionErrorCode } from './vendor-license-action-errors';
import { acceptanceHref } from './vendor-agreement-href';

/** The two fields the owner gives. The shared schema's own rules: `accepted` is
 *  `z.literal(true)`, so the form stays invalid until the box is ticked. */
const AcceptGrantFormSchema = AcceptLicenseGrantSchema.pick({ accepted: true, signer_title: true });

interface AcceptGrantModel {
  accepted: boolean;
  signer_title: string;
}

/** A refusal, mapped. `stale`: this tab's copy of the grant is out of date, so the
 *  section shows the message, re-reads billing and the card may go away. */
export interface GrantAcceptFailure {
  readonly message: string;
  readonly stale: boolean;
  /** The server refused the typed title. */
  readonly titleRejected: boolean;
}

/** Each status and code `POST /api/vendor/license-grants/:id/accept` returns gets a
 *  sentence the owner can act on. */
export function grantAcceptFailure(err: unknown): GrantAcceptFailure {
  const status = err instanceof HttpErrorResponse ? err.status : null;
  const code = licenseActionErrorCode(err);
  const stale = (message: string): GrantAcceptFailure => ({
    message,
    stale: true,
    titleRejected: false,
  });
  const inline = (message: string, titleRejected = false): GrantAcceptFailure => ({
    message,
    stale: false,
    titleRejected,
  });
  if (code === ApiErrorCode.LICENSE_GRANT_VERSION_CHANGED) {
    return stale(
      $localize`:@@vendor.billing.grantPending.error.versionChanged:The agreement version for this grant is not the one this page showed. We reloaded the page. Read the version linked and accept again.`,
    );
  }
  if (code === ApiErrorCode.LICENSE_GRANT_NOT_PENDING) {
    const state = (err as HttpErrorResponse).error?.error?.details?.state as string | undefined;
    return stale(
      state === 'expired'
        ? $localize`:@@vendor.billing.grantPending.error.expired:This grant passed its end date, so it can no longer be accepted. We reloaded the page. Contact AEC Integrations if you still want it.`
        : $localize`:@@vendor.billing.grantPending.error.notPending:This grant is no longer waiting for you. AEC Integrations may have withdrawn it, or another owner accepted it. We reloaded the page.`,
    );
  }
  if (code === ApiErrorCode.VENDOR_SEATS_CHANGED) {
    return stale(
      $localize`:@@vendor.billing.grantPending.error.seatsChanged:Your company's seats changed while you were accepting, so nothing was saved. We reloaded the page. Try again.`,
    );
  }
  if (status === 404) {
    return stale(
      $localize`:@@vendor.billing.grantPending.error.notFound:This grant is no longer on your account. We reloaded the page.`,
    );
  }
  if (code === ApiErrorCode.PRODUCT_ALREADY_LICENSED) {
    return inline(
      $localize`:@@vendor.billing.grantPending.error.productLicensed:A product in this grant took a subscription while you were accepting. Nothing was saved. Try again.`,
    );
  }
  if (code === ApiErrorCode.LICENSE_GRANT_PRODUCTS_CHANGED) {
    return stale(
      $localize`:@@vendor.billing.grantPending.error.productLeft:A product in this grant left your account while you were accepting, so nothing was saved. We reloaded the page. Try again.`,
    );
  }
  switch (status) {
    case 400: {
      const field = (err as HttpErrorResponse).error?.error?.field as string | undefined;
      return field === 'signer_title'
        ? inline(
            $localize`:@@vendor.billing.grantPending.error.title:Enter your title, up to 100 characters.`,
            true,
          )
        : inline(
            $localize`:@@vendor.billing.error.invalid:That request was not valid. Refresh the page and try again.`,
          );
    }
    case 403:
      return inline(
        $localize`:@@vendor.billing.error.forbidden:Only an account owner can manage subscriptions.`,
      );
    case 429:
      return inline(
        $localize`:@@vendor.billing.error.rate:Too many changes in a short time. Try again in a minute.`,
      );
    case 503:
      return inline(
        $localize`:@@vendor.billing.grantPending.error.unavailable:We could not confirm your sign-in just now. Nothing was saved. Try again in a moment.`,
      );
  }
  return inline(
    $localize`:@@vendor.billing.grantPending.error.generic:Could not accept the subscriptions. Nothing was saved. Try again.`,
  );
}

/**
 * One grant waiting for an owner's accept (AECI-1615, counsel Q5;
 * `VENDOR_SIGNUP_PROCESS.md` §3 step 5). Rendered by the Billing tab's "Subscriptions
 * waiting for you" card, one per entry in `pending_grants`, owner seats only.
 *
 * The grant starts only on an affirmative acceptance. So the box is unticked, the
 * label is the checkout's wording, and the agreement link is the version the grant
 * pins: the archive when a later version is current, because the grant-date version
 * governs the whole term. The title is pre-filled from this seat's own claim, as on
 * the buy form (AECI-1625).
 *
 * Signal forms over the shared `AcceptLicenseGrantSchema` (the `vendor-terms-box.ts`
 * pattern): Accept stays disabled until the box is ticked and a title is given. Each
 * error shows once its field is touched or once the server refuses it, tied to the
 * control with `aria-describedby`.
 *
 * On success it emits {@link accepted}. A stale refusal (`409`, `404`, `422`) emits
 * {@link stale}. In both cases the section re-reads billing, which removes this card,
 * so the section owns the message and the focus.
 */
@Component({
  selector: 'aec-vendor-pending-grant-card',
  imports: [FormField],
  // One entry in the waiting panel. The panel is the only container: entries are split
  // by the section's dividers, never a card inside a card.
  host: { class: 'block py-5 first:pt-0 last:pb-0' },
  template: `
    <article [attr.aria-labelledby]="id('heading')" data-testid="pending-grant">
      <h4
        [id]="id('heading')"
        class="font-label text-sm font-semibold text-(--text-primary)"
        data-testid="pending-grant-heading"
      >
        {{ headingLabel() }}
      </h4>
      <dl class="mt-2 grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1.5 text-sm">
        <dt class="text-(--text-secondary)" i18n="@@vendor.billing.grantPending.source">Source</dt>
        <dd class="text-(--text-primary)" data-testid="pending-grant-source">
          {{ sourceLabel() }}
          @if (referenceLabel(); as ref) {
            <span class="block text-xs text-(--text-secondary)">{{ ref }}</span>
          }
        </dd>
        <dt class="text-(--text-secondary)" i18n="@@vendor.billing.grantPending.starts">Starts</dt>
        <dd class="text-(--text-primary)">{{ startsLabel() }}</dd>
        <dt class="text-(--text-secondary)" i18n="@@vendor.billing.grantPending.ends">Ends</dt>
        <dd class="text-(--text-primary) tabular-nums" data-testid="pending-grant-ends">
          {{ endsLabel() }}
        </dd>
        @if (items().length > 0) {
          <dt class="text-(--text-secondary)" i18n="@@vendor.billing.grantPending.goesOn">
            Goes on
          </dt>
          <dd class="text-(--text-primary)">
            <ul class="m-0 list-none space-y-0.5 p-0" data-testid="pending-grant-products">
              @for (item of items(); track item.productId) {
                <li>{{ item.label }}</li>
              }
            </ul>
          </dd>
        }
        <dt class="text-(--text-secondary)" i18n="@@vendor.billing.grantPending.agreement">
          Agreement
        </dt>
        <dd class="text-(--text-primary)">
          @if (agreementHref(); as href) {
            <a
              [href]="href"
              target="_blank"
              rel="noopener"
              [class]="linkClass"
              data-testid="pending-grant-version-link"
              >{{ versionLabel()
              }}<span class="sr-only" i18n="@@vendor.billing.grantPending.newTab">
                (opens in a new tab)</span
              ></a
            >
          } @else {
            {{ versionLabel() }}
          }
          @if (!grant().terms_version_current) {
            <span
              class="block text-xs text-(--text-secondary)"
              data-testid="pending-grant-superseded"
              i18n="@@vendor.billing.grantPending.superseded"
              >A later version is now current. This version governs this grant for its whole
              term.</span
            >
          }
        </dd>
      </dl>

      <form novalidate class="mt-4 space-y-4" (submit)="accept($event)">
        <div class="space-y-1.5">
          <label
            [attr.for]="id('title')"
            [class]="labelClass"
            i18n="@@vendor.billing.grantPending.title"
          >
            Your title
          </label>
          <input
            [id]="id('title')"
            type="text"
            autocomplete="organization-title"
            [class]="inputClass + ' max-w-md'"
            [formField]="form.signer_title"
            [attr.aria-invalid]="titleError() ? 'true' : null"
            [attr.aria-describedby]="
              titleError() ? id('title-hint') + ' ' + id('title-error') : id('title-hint')
            "
            data-testid="pending-grant-title"
            (input)="titleRejected.set(false)"
          />
          <p
            [id]="id('title-hint')"
            [class]="hintClass"
            i18n="@@vendor.billing.grantPending.titleHint"
          >
            We record your title with your acceptance.
          </p>
          @if (titleError()) {
            <p
              [id]="id('title-error')"
              role="alert"
              [class]="errorClass"
              i18n="@@vendor.billing.grantPending.titleError"
            >
              Enter your title, up to 100 characters.
            </p>
          }
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
              data-testid="pending-grant-accept-box"
            />
            <label [attr.for]="id('accept')" class="text-sm leading-relaxed text-(--text-primary)">
              @if (agreementHref(); as href) {
                <span i18n="@@vendor.billing.grantPending.acceptLabel"
                  >I have read and accept the
                  <a [href]="href" target="_blank" rel="noopener" [class]="linkClass"
                    >Managed plan agreement<span class="sr-only"> (opens in a new tab)</span></a
                  >.</span
                >
              } @else {
                <span i18n="@@vendor.billing.grantPending.acceptLabelNoLink"
                  >I have read and accept the Managed plan agreement.</span
                >
              }
            </label>
          </div>
          @if (acceptError()) {
            <p
              [id]="id('accept-error')"
              role="alert"
              [class]="errorClass"
              i18n="@@vendor.billing.grantPending.acceptError"
            >
              Tick the box to accept the Managed plan agreement.
            </p>
          }
        </div>

        @if (failure(); as message) {
          <p role="alert" [class]="errorClass" data-testid="pending-grant-error">{{ message }}</p>
        }

        <button
          type="submit"
          [class]="primaryClass"
          [disabled]="form().invalid() || busy()"
          [attr.aria-busy]="busy()"
          data-testid="pending-grant-accept"
        >
          @if (busy()) {
            <ng-container i18n="@@vendor.billing.grantPending.accepting">Accepting…</ng-container>
          } @else {
            <ng-container i18n="@@vendor.billing.grantPending.accept">Accept</ng-container
            ><span class="sr-only">{{ ' ' + headingLabel() }}</span>
          }
        </button>
      </form>
    </article>
  `,
})
export class VendorPendingGrantCard {
  readonly grant = input.required<VendorPendingGrant>();
  /** This seat's own claim title (`checkout_signer_title`). */
  readonly prefillTitle = input<string | null>(null);

  /** The accept committed. The section re-reads billing and shows the result. */
  readonly accepted = output<AcceptLicenseGrantResponse>();
  /** A stale refusal's message. The section shows it and re-reads billing. */
  readonly stale = output<string>();

  private readonly api = inject(VendorApi);
  private readonly locale = inject(LOCALE_ID);

  /** Seeded from the prefill once. A later billing re-read keeps what the owner typed. */
  private readonly model = linkedSignal<string, AcceptGrantModel>({
    source: () => this.prefillTitle() ?? '',
    computation: (title, previous) => previous?.value ?? { accepted: false, signer_title: title },
  });
  protected readonly form = form(this.model, (p) => {
    // A thunk, as the claim dialog passes its schema: the model holds a `boolean` that
    // the schema narrows to `true`.
    validateStandardSchema(p, () => AcceptGrantFormSchema);
    // Also renders `maxlength` on the input, which the form owns.
    maxLength(p.signer_title, LICENSE_GRANT_SIGNER_TITLE_MAX);
  });

  protected readonly busy = signal(false);
  protected readonly failure = signal<string | null>(null);
  /** The server refused the title (`400` on `signer_title`). Cleared on the next edit. */
  protected readonly titleRejected = signal(false);

  protected readonly titleError = computed(() => {
    const field = this.form.signer_title();
    if (this.titleRejected()) return true;
    return field.touched() && field.invalid();
  });
  protected readonly acceptError = computed(() => {
    const field = this.form.accepted();
    if (field.value()) return false;
    return field.touched();
  });

  protected readonly headingLabel = computed(() => {
    const n = this.grant().quantity;
    return n === 1
      ? $localize`:@@vendor.billing.grantPending.countOne:1 Managed subscription`
      : $localize`:@@vendor.billing.grantPending.count:${n}:COUNT: Managed subscriptions`;
  });

  protected readonly sourceLabel = computed(() => {
    const g = this.grant();
    if (g.kind === 'ban_term') {
      return $localize`:@@vendor.billing.grantPending.source.banTerm:Complimentary, for the rest of the term your company had paid for`;
    }
    return g.source === 'invoice'
      ? $localize`:@@vendor.billing.grantPending.source.invoice:Invoiced to your company`
      : $localize`:@@vendor.billing.grantPending.source.complimentary:Complimentary, no charge`;
  });

  /** The invoice number or PO. A ban-term grant's reference is AECi's note, not shown. */
  protected readonly referenceLabel = computed(() => {
    const g = this.grant();
    if (g.kind !== 'grant' || !g.reference) return null;
    const ref = g.reference;
    return $localize`:@@vendor.billing.grantPending.reference:Reference: ${ref}:REFERENCE:`;
  });

  protected readonly startsLabel = computed(() => {
    const start = this.grant().starts_at;
    if (start && Date.parse(start) > Date.now()) return formatTermDate(start, this.locale);
    return $localize`:@@vendor.billing.grantPending.startsOnAccept:When an owner accepts`;
  });

  protected readonly endsLabel = computed(() => formatTermDate(this.grant().ends_at, this.locale));

  protected readonly items = computed(() =>
    this.grant().items.map((item) => {
      const date = formatTermDate(item.ends_at, this.locale);
      const name = item.product?.name;
      return {
        productId: item.product_id,
        label: name
          ? $localize`:@@vendor.billing.grantPending.item:${name}:PRODUCT:, until ${date}:DATE:`
          : $localize`:@@vendor.billing.grantPending.itemGone:A product no longer on your account, until ${date}:DATE:`,
      };
    }),
  );

  /** The pinned version's page: the live page when it is current, else its archive. */
  protected readonly agreementHref = computed(() => {
    const g = this.grant();
    return g.terms_version_current
      ? legalPath('managed-plan-agreement')
      : acceptanceHref('managed_plan', g.terms_version);
  });

  protected readonly versionLabel = computed(() => {
    const version = this.grant().terms_version;
    return $localize`:@@vendor.billing.grantPending.version:Managed plan agreement, version ${version}:VERSION:`;
  });

  protected id(key: string): string {
    return `vendor-grant-${this.grant().id}-${key}`;
  }

  protected async accept(event: Event): Promise<void> {
    event.preventDefault();
    if (this.busy()) return;
    this.failure.set(null);
    await submit(this.form, async (f) => {
      const v = f().value();
      // The schema already refused an unticked box; this narrows the type.
      if (!v.accepted) return undefined;
      this.busy.set(true);
      try {
        const result = await this.api.acceptLicenseGrant(this.grant().id, {
          accepted: true,
          version: this.grant().terms_version,
          signer_title: v.signer_title.trim(),
        });
        this.accepted.emit(result);
      } catch (err) {
        const mapped = grantAcceptFailure(err);
        if (mapped.stale) {
          this.stale.emit(mapped.message);
        } else {
          this.failure.set(mapped.message);
          if (mapped.titleRejected) this.titleRejected.set(true);
        }
      } finally {
        this.busy.set(false);
      }
      return undefined;
    });
  }

  protected readonly labelClass = FIELD_LABEL_CLASS;
  protected readonly inputClass = FIELD_INPUT_CLASS;
  protected readonly hintClass = FIELD_HINT_CLASS;
  protected readonly errorClass = FIELD_ERROR_CLASS;
  protected readonly choiceInputClass = CHOICE_INPUT_CLASS;
  protected readonly primaryClass = BUTTON_PRIMARY_CLASS;
  protected readonly linkClass =
    'font-semibold text-(--accent-primary) underline underline-offset-2 hover:text-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';
}
