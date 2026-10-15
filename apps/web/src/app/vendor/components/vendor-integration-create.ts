import { NgTemplateOutlet } from '@angular/common';
import {
  Component,
  DestroyRef,
  ElementRef,
  InjectionToken,
  Injector,
  type OnInit,
  afterNextRender,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, type ParamMap } from '@angular/router';

import {
  CreateProductRequestSchema,
  PRODUCT_REQUEST_BODY_MAX,
  PRODUCT_REQUEST_MAKER_MAX,
  PRODUCT_REQUEST_NAME_MAX,
  PRODUCT_REQUEST_WEBSITE_MAX,
  type CreateProductRequestInput,
  type VendorProductRequest,
  CreateVendorIntegrationSchema,
  INTEGRATION_EDIT_MAX_LENGTH,
  INTEGRATION_EDIT_REQUIRED_FIELDS,
  INTEGRATION_EDIT_URL_FIELDS,
  OWNER_EDITABLE_MECHANISM_KINDS,
  type CreateVendorIntegrationInput,
  type IntegrationEditField,
  type PossibleDuplicateIntegration,
} from '@aeci/shared';

import { directionHeading } from '../../products/pair-direction-labels';
import { mechanismKindLabel } from '../../search/mechanism-labels';
import { LogoOrInitial } from '../../shared/logo-or-initial/logo-or-initial';
import {
  ProductCombobox,
  type ProductComboboxItem,
  type ProductComboboxSearch,
} from '../../shared/product-combobox/product-combobox';
import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorApi } from '../vendor-api';
import { readVendorApiError } from '../vendor-api-error';
import { VendorPortalStore } from '../vendor-portal-store';

import { editFieldLabel } from './vendor-contest-labels';
import { VendorDocsLink } from './vendor-docs-link';
import { EDIT_GROUPS } from './vendor-integration-edit-form';
import { editValueMessage } from './vendor-integration-ownership-labels';

/**
 * Render the form open on first paint. Provided ONLY by the dev preview
 * (`/preview/vendor-dashboard/products/<slug>/integrations?create=open`), so `npx impeccable detect`, which reads
 * the first render, can see the form. Nothing in the product provides it. Since
 * AECI-1377 the routed tab also honours `?create=open` itself (see {@link
 * VendorIntegrationCreate.deepLink}); the token still covers the preview's other
 * child routes and the single-page concept.
 */
export const VENDOR_CREATE_FORM_START_OPEN = new InjectionToken<boolean>(
  'VENDOR_CREATE_FORM_START_OPEN',
);

type Draft = Record<IntegrationEditField, string>;

/** The request form's fields, in order (AECI-1377, §4.7.6). `body` is the note. */
const REQUEST_FIELDS = ['name', 'maker', 'website', 'body'] as const;
type RequestField = (typeof REQUEST_FIELDS)[number];
type RequestDraft = Record<RequestField, string>;

const REQUEST_MAX: Readonly<Record<RequestField, number>> = {
  name: PRODUCT_REQUEST_NAME_MAX,
  maker: PRODUCT_REQUEST_MAKER_MAX,
  website: PRODUCT_REQUEST_WEBSITE_MAX,
  body: PRODUCT_REQUEST_BODY_MAX,
};

function emptyRequestDraft(name = ''): RequestDraft {
  return { name, maker: '', website: '', body: '' };
}

const URL_FIELDS: ReadonlySet<IntegrationEditField> = INTEGRATION_EDIT_URL_FIELDS;

function emptyDraft(): Draft {
  return Object.fromEntries(
    EDIT_GROUPS.flatMap((group) => group.fields).map((field) => [field, '']),
  ) as Draft;
}

/**
 * "Add an integration" on the Integrations tab (AECI-1011 /
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §4.7 / §6.14).
 *
 * The vendor picks one of its own products, finds the other product by name, and
 * fills in the same standard fields the owner edit uses (`EDIT_GROUPS`, the same
 * labels and the same value rule), so "what an owner may write" reads identically
 * in both forms. The new row is the vendor's from the first moment: born claimed,
 * so promote never writes it, and it goes live with no review step.
 *
 * **Pessimistic.** Nothing changes on screen until the server answers `201`; then
 * the integrations list revalidates and the outcome is announced through the
 * portal's one live region. Duplicates never block (AECI-1003 decision 10): the
 * rows already on record for the chosen pair are listed before submit, from the
 * list the tab already holds, and the server's strong matches are listed after.
 *
 * The type picker leaves out the connector-delivered kinds, which the server
 * refuses (decision 9). The wording is AECI-1023's, and matches `/methodology`.
 *
 * ── TWO STEPS, AND THE WAY OUT OF A MISS (AECI-1377, §4.7.6) ────────────────
 * Step 1 of 2 is the locked product and the search, nothing else. Choosing a
 * product is step 2: the chosen card with Change, the rows on record and the three
 * field groups. Change goes back to step 1 and keeps the typed values. Under the
 * search, "Can't find it? Ask us to add it" swaps step 1 for the request form
 * (`POST /api/vendor/product-requests`). A request never creates an integration:
 * after the receipt the vendor waits for our decision, then comes back through the
 * deep link.
 *
 * ── THE DEEP LINK ───────────────────────────────────────────────────────────
 * On the routed Integrations tab ({@link deepLink}), `?create=open` opens the form
 * and `?counterpart={slug}` preselects the other product through the public
 * `GET /api/products/{slug}`. A hit lands on step 2. A `404`, or the tab's own
 * product, leaves step 1 open. The two params are removed from the URL once read,
 * so "Add the integration" can be pressed again on the same tab. `create=open` is
 * read from the snapshot in `ngOnInit` too, so the form is open on the server's
 * first paint.
 */
@Component({
  selector: 'aec-vendor-integration-create',
  imports: [LogoOrInitial, NgTemplateOutlet, ProductCombobox, VendorDocsLink],
  styles: [':host { display: block; }'],
  template: `
    <div class="space-y-4" data-testid="integration-create">
      <div class="flex flex-wrap items-center gap-3">
        <button
          #trigger
          type="button"
          [attr.aria-expanded]="open()"
          [attr.aria-controls]="formId"
          (click)="toggle()"
          [class]="triggerClass"
          data-testid="add-integration"
          i18n="@@vendor.integrationCreate.trigger"
        >
          Add an integration
        </button>
        @if (!open()) {
          <p class="text-xs text-(--text-secondary)" i18n="@@vendor.integrationCreate.teaser">
            List an integration your company offers that is not on record yet.
          </p>
        }
        <aec-vendor-docs-link page="owning-an-integration" />
      </div>

      @if (result(); as created) {
        <div
          class="max-w-3xl space-y-2 rounded-(--radius-md) border border-(--border-default) p-4"
          data-testid="create-result"
        >
          <p
            #resultHeading
            tabindex="-1"
            class="text-sm font-semibold text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
            i18n="@@vendor.integrationCreate.done.title"
          >
            Your integration is live on the public site.
          </p>
          @if (created.duplicates.length > 0) {
            <p class="text-sm text-(--text-secondary)" i18n="@@vendor.integrationCreate.done.dupes">
              These integrations were already on record for the same two products. If one of them is
              the same integration, retire the one you just added. Then claim the existing one if
              your company owns it, or request a change on it if a detail is wrong.
            </p>
            <ul class="space-y-1 text-sm text-(--text-primary)" data-testid="create-duplicates">
              @for (dup of created.duplicates; track dup.id) {
                <li>{{ duplicateLine(dup) }}</li>
              }
            </ul>
          }
          <button
            type="button"
            [class]="secondaryButtonClass"
            (click)="dismissResult()"
            i18n="@@vendor.integrationCreate.done.dismiss"
          >
            Dismiss
          </button>
        </div>
      }

      @if (open()) {
        <div
          [id]="formId"
          role="group"
          aria-labelledby="vendor-create-title"
          class="max-w-3xl space-y-6 rounded-(--radius-md) border border-(--border-default) p-5"
          data-testid="create-panel"
        >
          <div class="max-w-prose space-y-1">
            <p
              id="vendor-create-title"
              class="text-sm font-semibold text-(--text-primary)"
              i18n="@@vendor.integrationCreate.title"
            >
              Add an integration
            </p>
            <p
              class="max-w-prose text-xs text-(--text-secondary)"
              i18n="@@vendor.integrationCreate.intro"
            >
              Your company will own this integration. It goes live on the public integration page as
              soon as you add it, with no review step, and the other product's vendor is told.
            </p>
          </div>

          @if (receipt(); as sent) {
            <!-- AECI-1377: the request was sent. The receipt replaces the form. -->
            <div class="max-w-prose space-y-3" data-testid="product-request-receipt">
              <p
                #focusTarget
                tabindex="-1"
                class="text-sm font-semibold text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                i18n="@@vendor.productRequest.receipt.title"
              >
                We have your request.
              </p>
              <p class="text-sm text-(--text-secondary)">{{ receiptBody(sent.name) }}</p>
              <button
                type="button"
                [class]="secondaryButtonClass"
                (click)="startOver()"
                data-testid="product-request-again"
                i18n="@@vendor.productRequest.receipt.again"
              >
                Add another integration
              </button>
            </div>
          } @else if (mode() === 'request') {
            <!-- AECI-1377: the request form swaps in for step 1. -->
            <form
              class="space-y-4"
              novalidate
              (submit)="onRequestSubmit($event)"
              aria-labelledby="vendor-request-title"
              data-testid="product-request-form"
            >
              <div class="max-w-prose space-y-1">
                <p
                  #focusTarget
                  id="vendor-request-title"
                  tabindex="-1"
                  class="text-sm font-semibold text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                  i18n="@@vendor.productRequest.title"
                >
                  Ask us to add the other product
                </p>
                <p class="text-xs text-(--text-secondary)" i18n="@@vendor.productRequest.intro">
                  Tell us which product it is. We will add it to the catalog or tell you why not.
                  Once it is listed, you add the integration yourself.
                </p>
              </div>

              @for (field of requestFields; track field) {
                <div class="max-w-2xl space-y-2">
                  <label [for]="requestFieldId(field)" [class]="labelClass">
                    {{ requestFieldLabel(field) }}
                    @if (field === 'website' || field === 'body') {
                      <span class="font-normal tracking-normal normal-case">{{
                        optionalLabel
                      }}</span>
                    }
                  </label>
                  @if (field === 'body') {
                    <textarea
                      [id]="requestFieldId(field)"
                      rows="3"
                      [attr.maxlength]="requestMax(field)"
                      [value]="requestDraft()[field]"
                      (input)="onRequestInput(field, inputValue($event))"
                      [class]="inputClass"
                    ></textarea>
                  } @else {
                    <input
                      [id]="requestFieldId(field)"
                      [type]="field === 'website' ? 'url' : 'text'"
                      [attr.inputmode]="field === 'website' ? 'url' : null"
                      [attr.placeholder]="field === 'website' ? 'https://' : null"
                      [attr.maxlength]="requestMax(field)"
                      [value]="requestDraft()[field]"
                      (input)="onRequestInput(field, inputValue($event))"
                      [attr.aria-invalid]="requestError(field) ? 'true' : null"
                      [attr.aria-describedby]="
                        requestError(field) ? requestFieldId(field) + '-error' : null
                      "
                      [attr.aria-required]="field === 'name' || field === 'maker' ? 'true' : null"
                      [class]="inputClass"
                    />
                  }
                  @if (requestError(field); as message) {
                    <p [id]="requestFieldId(field) + '-error'" role="alert" [class]="errorClass">
                      {{ message }}
                    </p>
                  }
                </div>
              }

              <div
                class="flex flex-wrap items-center gap-3 border-t border-(--border-default) pt-4"
              >
                <button
                  type="submit"
                  [class]="primaryButtonClass"
                  [disabled]="requestSaving()"
                  data-testid="product-request-submit"
                >
                  @if (requestSaving()) {
                    <span i18n="@@vendor.productRequest.sending">Sending…</span>
                  } @else {
                    <span i18n="@@vendor.productRequest.send">Send request</span>
                  }
                </button>
                <button
                  type="button"
                  [class]="secondaryButtonClass"
                  [disabled]="requestSaving()"
                  (click)="backToSearch()"
                  data-testid="product-request-back"
                  i18n="@@vendor.productRequest.back"
                >
                  Back to search
                </button>
              </div>

              @if (requestNotice(); as message) {
                <p
                  role="alert"
                  class="text-sm font-medium text-(--text-primary)"
                  data-testid="product-request-notice"
                >
                  {{ message }}
                </p>
              }
            </form>
          } @else if (counterpart(); as chosen) {
            <form
              class="space-y-6"
              novalidate
              (submit)="onSubmit($event)"
              aria-labelledby="vendor-create-step"
              data-testid="create-form"
            >
              <p
                #focusTarget
                id="vendor-create-step"
                tabindex="-1"
                class="space-y-0.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                data-testid="create-step"
              >
                <span [class]="stepCountClass" i18n="@@vendor.integrationCreate.step2.count"
                  >Step 2 of 2</span
                >
                <span class="sr-only">, </span>
                <span [class]="stepTitleClass" i18n="@@vendor.integrationCreate.step2.title"
                  >About the integration</span
                >
              </p>

              <fieldset class="space-y-4">
                <legend [class]="legendClass" i18n="@@vendor.integrationCreate.group.products">
                  The two products
                </legend>
                <ng-container [ngTemplateOutlet]="ownProductBox" />

                <div class="max-w-2xl space-y-2">
                  <p [class]="labelClass" i18n="@@vendor.integrationCreate.counterpart.label">
                    The other product
                  </p>
                  <div
                    class="flex max-w-sm items-center gap-3 rounded-(--radius-md) border border-(--border-default) bg-(--surface-base) px-3 py-2"
                    data-testid="create-counterpart"
                  >
                    <aec-logo-or-initial
                      [src]="chosen.logo_url ?? null"
                      [name]="chosen.name"
                      size="sm"
                    />
                    <span class="flex min-w-0 flex-1 flex-col">
                      <span class="truncate text-sm font-medium text-(--text-primary)">{{
                        chosen.name
                      }}</span>
                      @if (chosen.vendor; as vendor) {
                        <span class="truncate text-xs text-(--text-secondary)">{{
                          vendor.name
                        }}</span>
                      }
                    </span>
                    <button
                      type="button"
                      [class]="secondaryButtonClass"
                      [attr.aria-label]="changeCounterpartLabel(chosen.name)"
                      (click)="onChangeCounterpart()"
                      data-testid="create-change-counterpart"
                      i18n="@@vendor.integrationCreate.counterpart.change"
                    >
                      Change
                    </button>
                  </div>
                </div>

                @if (onRecord().length > 0) {
                  <div
                    class="max-w-prose space-y-1 rounded-(--radius-sm) bg-(--surface-sunken) p-3"
                    data-testid="create-on-record"
                  >
                    <p class="text-xs font-semibold text-(--text-primary)">{{ onRecordLine() }}</p>
                    <ul class="space-y-0.5 text-xs text-(--text-secondary)">
                      @for (row of onRecord(); track row.id) {
                        <li>{{ row.label }}</li>
                      }
                    </ul>
                  </div>
                }
              </fieldset>

              @for (group of groups; track group.key) {
                <fieldset class="space-y-4">
                  <legend [class]="legendClass">{{ groupLabel(group.key) }}</legend>
                  @for (field of group.fields; track field) {
                    <div class="max-w-2xl space-y-2">
                      <label [for]="fieldId(field)" [class]="labelClass">
                        {{ fieldLabel(field) }}
                        @if (!required(field)) {
                          <span class="font-normal tracking-normal normal-case">{{
                            optionalLabel
                          }}</span>
                        }
                      </label>
                      @if (field === 'description') {
                        <textarea
                          [id]="fieldId(field)"
                          rows="3"
                          [attr.maxlength]="maxLength(field)"
                          [value]="draft()[field]"
                          (input)="onInput(field, inputValue($event))"
                          [attr.aria-invalid]="showError(field) ? 'true' : null"
                          [attr.aria-describedby]="
                            showError(field) ? fieldId(field) + '-error' : null
                          "
                          [class]="inputClass"
                        ></textarea>
                      } @else if (field === 'mechanism_kind' || field === 'direction') {
                        <div class="relative max-w-sm">
                          <select
                            [id]="fieldId(field)"
                            (change)="onInput(field, selectValue($event))"
                            [attr.aria-invalid]="showError(field) ? 'true' : null"
                            [attr.aria-describedby]="
                              showError(field) ? fieldId(field) + '-error' : null
                            "
                            [class]="selectClass"
                          >
                            @if (draft()[field] === '') {
                              <option value="" disabled selected>{{ choosePlaceholder }}</option>
                            }
                            @for (option of optionsFor(field); track option.value) {
                              <option
                                [value]="option.value"
                                [selected]="option.value === draft()[field]"
                              >
                                {{ option.label }}
                              </option>
                            }
                          </select>
                          <svg
                            class="pointer-events-none absolute end-3 top-1/2 h-4 w-4 -translate-y-1/2 text-(--text-secondary)"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            aria-hidden="true"
                          >
                            <path d="m6 9 6 6 6-6" />
                          </svg>
                        </div>
                      } @else {
                        <input
                          [id]="fieldId(field)"
                          [type]="isUrl(field) ? 'url' : 'text'"
                          [attr.inputmode]="isUrl(field) ? 'url' : null"
                          [attr.maxlength]="maxLength(field)"
                          [value]="draft()[field]"
                          (input)="onInput(field, inputValue($event))"
                          [attr.aria-invalid]="showError(field) ? 'true' : null"
                          [attr.aria-describedby]="
                            showError(field) ? fieldId(field) + '-error' : null
                          "
                          [class]="inputClass"
                        />
                      }
                      @if (showError(field)) {
                        <p [id]="fieldId(field) + '-error'" role="alert" [class]="errorClass">
                          {{ errorFor(field) }}
                        </p>
                      }
                    </div>
                  }
                </fieldset>
              }

              <div
                class="flex flex-wrap items-center gap-3 border-t border-(--border-default) pt-4"
              >
                <button
                  type="submit"
                  [class]="primaryButtonClass"
                  [disabled]="saving()"
                  data-testid="create-submit"
                >
                  @if (saving()) {
                    <span i18n="@@vendor.integrationCreate.saving">Adding…</span>
                  } @else {
                    <span i18n="@@vendor.integrationCreate.submit">Add integration</span>
                  }
                </button>
                <button
                  type="button"
                  [class]="secondaryButtonClass"
                  [disabled]="saving()"
                  (click)="close()"
                  i18n="@@vendor.integrationCreate.cancel"
                >
                  Cancel
                </button>
              </div>

              @if (saveNotice(); as message) {
                <p role="alert" class="text-sm font-medium text-(--text-primary)">{{ message }}</p>
              }
            </form>
          } @else {
            <!-- Step 1 of 2: the locked product and the search. Nothing else shows. -->
            <div class="space-y-4" data-testid="create-step-find">
              <p
                #focusTarget
                id="vendor-create-step"
                tabindex="-1"
                class="space-y-0.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                data-testid="create-step"
              >
                <span [class]="stepCountClass" i18n="@@vendor.integrationCreate.step1.count"
                  >Step 1 of 2</span
                >
                <span class="sr-only">, </span>
                <span [class]="stepTitleClass" i18n="@@vendor.integrationCreate.step1.title"
                  >Find the other product</span
                >
              </p>

              <ng-container [ngTemplateOutlet]="ownProductBox" />

              <div class="max-w-2xl space-y-2">
                <label
                  for="vendor-create-search"
                  [class]="labelClass"
                  i18n="@@vendor.integrationCreate.search.label"
                  >The other product</label
                >
                <aec-product-combobox
                  class="max-w-sm"
                  inputId="vendor-create-search"
                  [search]="search"
                  [exclude]="excluded()"
                  [describedBy]="counterpartDescribedBy()"
                  (picked)="onCounterpart($event)"
                  (announce)="announcer.announce($event)"
                  (queryChange)="onQuery($event)"
                  (noMatch)="noMatchQuery.set($event)"
                />
                <p
                  id="vendor-create-search-hint"
                  class="max-w-prose text-xs text-(--text-secondary)"
                  i18n="@@vendor.integrationCreate.search.hint"
                >
                  Search the published catalog by product name, then choose one result.
                </p>
                <!-- Below the input and outside the popup, so a keyboard can reach it:
                     focus stays in the input while the popup is open (AECI-1377). -->
                <div class="space-y-1 pt-1">
                  @if (noMatchShown()) {
                    <p
                      id="vendor-create-no-match"
                      class="max-w-prose text-sm text-(--text-primary)"
                      data-testid="create-no-match"
                    >
                      {{ noMatchLine() }}
                    </p>
                  }
                  <button
                    type="button"
                    [class]="textButtonClass"
                    (click)="askUs()"
                    data-testid="create-ask-us"
                    i18n="@@vendor.productRequest.ask"
                  >
                    Can't find it? Ask us to add it
                  </button>
                </div>
              </div>

              <div
                class="flex flex-wrap items-center gap-3 border-t border-(--border-default) pt-4"
              >
                <button
                  type="button"
                  [class]="secondaryButtonClass"
                  (click)="close()"
                  data-testid="create-cancel"
                  i18n="@@vendor.integrationCreate.cancel"
                >
                  Cancel
                </button>
              </div>
            </div>
          }
        </div>
      }

      <ng-template #ownProductBox>
        <div class="max-w-2xl space-y-2">
          @if (contextProductId() !== null) {
            <!-- The tab already names the product. It is shown, never offered as a
                 choice, so an integration cannot land on the wrong product. The box
                 locks on the tab's id alone: until the portal's product list has it,
                 the name is a placeholder, never a picker. -->
            <p
              id="vendor-create-own-label"
              [class]="labelClass"
              i18n="@@vendor.integrationCreate.own.label"
            >
              Your product
            </p>
            <div
              role="group"
              aria-labelledby="vendor-create-own-label vendor-create-own-name"
              class="flex max-w-sm items-center gap-3 rounded-(--radius-md) border border-(--border-default) bg-(--surface-sunken) px-3 py-2"
              data-testid="create-own-product"
            >
              @if (contextOwnProduct(); as own) {
                <aec-logo-or-initial [src]="own.logo_url" [name]="own.name" size="sm" />
                <span
                  id="vendor-create-own-name"
                  class="min-w-0 flex-1 truncate text-sm font-medium text-(--text-primary)"
                  >{{ own.name }}</span
                >
              } @else {
                <span id="vendor-create-own-name" class="flex-1">
                  <span
                    class="block h-4 w-40 motion-safe:animate-pulse rounded-(--radius-sm) bg-(--border-default)"
                    aria-hidden="true"
                  ></span>
                  <span class="sr-only" i18n="@@vendor.integrationCreate.own.loading"
                    >Loading your product</span
                  >
                </span>
              }
            </div>
          } @else {
            <label
              for="vendor-create-own"
              [class]="labelClass"
              i18n="@@vendor.integrationCreate.own.label"
              >Your product</label
            >
            <div class="relative max-w-sm">
              <select
                id="vendor-create-own"
                (change)="onOwnProduct(selectValue($event))"
                [class]="selectClass"
              >
                @for (product of ownProducts(); track product.id) {
                  <option [value]="product.id" [selected]="product.id === ownProductId()">
                    {{ product.name }}
                  </option>
                }
              </select>
              <svg
                class="pointer-events-none absolute end-3 top-1/2 h-4 w-4 -translate-y-1/2 text-(--text-secondary)"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path d="m6 9 6 6 6-6" />
              </svg>
            </div>
          }
        </div>
      </ng-template>
    </div>
  `,
})
export class VendorIntegrationCreate implements OnInit {
  private readonly api = inject(VendorApi);
  private readonly store = inject(VendorPortalStore);
  protected readonly announcer = inject(VendorPortalAnnouncer);
  private readonly injector = inject(Injector);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  /** The product the tab is filed under, preselected as "your product". */
  readonly contextProductId = input<string | null>(null);
  /**
   * Read `?create=open&counterpart={slug}` (AECI-1377). Only the routed
   * Integrations tab turns this on. The single-page concept has no route of its own.
   */
  readonly deepLink = input(false);

  /** A product request was sent (`201`). The tab re-reads its request list. */
  readonly requested = output<VendorProductRequest>();

  private readonly trigger = viewChild<ElementRef<HTMLButtonElement>>('trigger');
  private readonly resultHeading = viewChild<ElementRef<HTMLElement>>('resultHeading');
  /** The heading of whichever step, form or receipt is showing. */
  private readonly focusTarget = viewChild<ElementRef<HTMLElement>>('focusTarget');
  private readonly combobox = viewChild(ProductCombobox);

  protected readonly groups = EDIT_GROUPS;
  protected readonly formId = 'vendor-create-form';
  protected readonly requestFields = REQUEST_FIELDS;

  protected readonly open = signal(
    inject(VENDOR_CREATE_FORM_START_OPEN, { optional: true }) ?? false,
  );
  protected readonly saving = signal(false);
  protected readonly attempted = signal(false);
  protected readonly saveNotice = signal<string | null>(null);
  protected readonly draft = signal<Draft>(emptyDraft());

  private readonly chosenOwn = signal<string | null>(null);
  protected readonly counterpart = signal<ProductComboboxItem | null>(null);

  // ── Step 1's search state, and the request form (AECI-1377) ──────────────
  /** `search` is step 1. `request` is the request form in its place. */
  protected readonly mode = signal<'search' | 'request'>('search');
  /** The combobox's trimmed query, for the request's prefill. */
  private readonly query = signal('');
  /** The last query whose finished search offered no row. */
  protected readonly noMatchQuery = signal<string | null>(null);
  protected readonly noMatchShown = computed(() => {
    const miss = this.noMatchQuery();
    return miss !== null && miss !== '' && miss === this.query();
  });
  protected readonly requestDraft = signal<RequestDraft>(emptyRequestDraft());
  protected readonly requestAttempted = signal(false);
  protected readonly requestSaving = signal(false);
  protected readonly requestNotice = signal<string | null>(null);
  protected readonly receipt = signal<{ name: string } | null>(null);
  /** Bumped whenever the vendor acts, so a slow deep-link read never overrides them. */
  private deepLinkSeq = 0;

  /** The public product search, A to Z (AECI-1244). */
  protected readonly search: ProductComboboxSearch = (query) => this.api.searchProducts(query);

  protected readonly result = signal<{
    id: string;
    duplicates: readonly PossibleDuplicateIntegration[];
  } | null>(null);

  protected readonly optionalLabel = $localize`:@@vendor.integrationCreate.optional:(optional)`;
  protected readonly choosePlaceholder = $localize`:@@vendor.integrationCreate.choose:Choose a value`;

  protected readonly ownProducts = computed(() => this.store.me()?.products ?? []);

  protected readonly ownProductId = computed(() => {
    const products = this.ownProducts();
    // Inside a product tab the product is fixed. It never falls back to another
    // product, so a list that has not loaded yet blocks the submit instead.
    const context = this.contextProductId();
    if (context !== null) return products.some((p) => p.id === context) ? context : null;
    const chosen = this.chosenOwn();
    if (chosen && products.some((p) => p.id === chosen)) return chosen;
    return products[0]?.id ?? null;
  });

  /** The tab's product, once the portal's product list has it. The box is
   *  locked whenever the tab names a product; this only supplies its name. */
  protected readonly contextOwnProduct = computed(() => {
    const context = this.contextProductId();
    return context !== null ? (this.ownProducts().find((p) => p.id === context) ?? null) : null;
  });

  /** The counterpart cannot be the vendor's own product. */
  protected readonly excluded = computed(() => {
    const own = this.ownProductId();
    return own ? [own] : [];
  });

  protected readonly counterpartDescribedBy = computed(() =>
    this.noMatchShown()
      ? 'vendor-create-search-hint vendor-create-no-match'
      : 'vendor-create-search-hint',
  );

  protected readonly noMatchLine = computed(() => {
    const query = this.noMatchQuery() ?? '';
    return $localize`:@@vendor.productRequest.noMatch:No product matches ${query}:QUERY:.`;
  });

  /** Every integration already on record for the chosen pair, from the list the
   *  tab holds. Context before submit, never a block. */
  protected readonly onRecord = computed(() => {
    const own = this.ownProductId();
    const other = this.counterpart()?.id;
    if (!own || !other) return [];
    const seen = new Set<string>();
    const rows: { id: string; label: string }[] = [];
    for (const entry of this.store.integrations() ?? []) {
      if (entry.context_product.id !== own || entry.other_product.id !== other) continue;
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      const name = entry.name ?? entry.mechanism_name ?? mechanismKindLabel(entry.mechanism_kind);
      const owner = entry.owner?.name;
      rows.push({
        id: entry.id,
        label: owner
          ? $localize`:@@vendor.integrationCreate.onRecord.owned:${name}:name:, offered by ${owner}:owner:`
          : (name ?? ''),
      });
    }
    return rows;
  });

  protected readonly onRecordLine = computed(() => {
    const count = this.onRecord().length;
    return $localize`:@@vendor.integrationCreate.onRecord.title:Already on record for these two products (${count}:count:). You can still add yours.`;
  });

  /** The per-field problems, in the vendor's words. Required fields are checked
   *  only after a submit attempt, so an empty form does not open covered in red. */
  private readonly errors = computed<Partial<Record<IntegrationEditField, string>>>(() => {
    const out: Partial<Record<IntegrationEditField, string>> = {};
    const draft = this.draft();
    for (const field of EDIT_GROUPS.flatMap((group) => group.fields)) {
      const value = draft[field].trim();
      if (value === '') {
        if (this.attempted() && this.required(field)) {
          out[field] =
            $localize`:@@vendor.integrationCreate.error.required:This field is required.`;
        }
        continue;
      }
      const message = editValueMessage(field, value);
      if (message) out[field] = message;
    }
    return out;
  });

  /** The request form's problems, in the portal's own words, never Zod's. Shown
   *  only after a send attempt. */
  private readonly requestErrors = computed<Partial<Record<RequestField, string>>>(() => {
    if (!this.requestAttempted()) return {};
    const draft = this.requestDraft();
    const out: Partial<Record<RequestField, string>> = {};
    if (draft.name.trim() === '') {
      out.name = $localize`:@@vendor.productRequest.error.name:Enter the product name.`;
    }
    if (draft.maker.trim() === '') {
      out.maker = $localize`:@@vendor.productRequest.error.maker:Enter the company that makes it.`;
    }
    const website = draft.website.trim();
    if (website !== '' && !CreateProductRequestSchema.shape.website.safeParse(website).success) {
      out.website = $localize`:@@vendor.productRequest.error.website:Use a full link that starts with https://, or leave it blank.`;
    }
    return out;
  });

  ngOnInit(): void {
    // The server's first paint: `?create=open` opens the form before hydration.
    if (this.deepLink() && this.route.snapshot.queryParamMap.get('create') === 'open') {
      this.open.set(true);
    }
  }

  constructor() {
    afterNextRender(() => {
      if (!this.deepLink()) return;
      this.route.queryParamMap
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe((params) => void this.applyDeepLink(params));
    });
  }

  /**
   * `?create=open&counterpart={slug}` (§4.7.6). Opens a fresh form, removes the two
   * params, then looks the product up. A hit that is not the tab's own product
   * lands on step 2. Anything else stays on step 1. Focus goes to the step heading
   * either way, so the vendor arrives at the form.
   */
  private async applyDeepLink(params: ParamMap): Promise<void> {
    if (params.get('create') !== 'open') return;
    const slug = params.get('counterpart');
    this.openFresh();
    const seq = ++this.deepLinkSeq;
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { create: null, counterpart: null },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
    if (slug) {
      try {
        const product = await this.api.getProduct(slug);
        const own = this.contextProductId() ?? this.ownProductId();
        if (seq === this.deepLinkSeq && product.id !== own) {
          this.counterpart.set({
            id: product.id,
            slug: product.slug,
            name: product.name,
            logo_url: product.logo_url,
            vendor: product.vendor,
          });
        }
      } catch {
        // A 404 (or any failure) leaves step 1 open with nothing chosen.
      }
    }
    if (seq === this.deepLinkSeq) this.focusStep();
  }

  protected toggle(): void {
    if (this.open()) {
      this.close();
      return;
    }
    this.openFresh();
  }

  private openFresh(): void {
    this.reset();
    this.result.set(null);
    this.open.set(true);
  }

  close(): void {
    this.deepLinkSeq++;
    this.open.set(false);
    this.saveNotice.set(null);
    this.trigger()?.nativeElement.focus();
  }

  protected dismissResult(): void {
    this.result.set(null);
    this.trigger()?.nativeElement.focus();
  }

  private reset(): void {
    this.draft.set(emptyDraft());
    this.attempted.set(false);
    this.saveNotice.set(null);
    this.counterpart.set(null);
    this.resetSearch();
    this.mode.set('search');
    this.receipt.set(null);
    this.requestDraft.set(emptyRequestDraft());
    this.requestAttempted.set(false);
    this.requestNotice.set(null);
  }

  /** The combobox mounts empty, so its mirrored state starts empty too. */
  private resetSearch(): void {
    this.query.set('');
    this.noMatchQuery.set(null);
  }

  protected onOwnProduct(id: string): void {
    this.chosenOwn.set(id);
    // The counterpart cannot be the product itself.
    if (this.counterpart()?.id === id) this.counterpart.set(null);
  }

  protected onQuery(query: string): void {
    // Typing is acting: a deep-link read still in flight must not pull the
    // vendor to step 2 over what they are searching for.
    if (query) this.deepLinkSeq++;
    this.query.set(query);
  }

  /** Step 1 → step 2. The picker unmounts, so focus moves to the step heading. */
  protected onCounterpart(product: ProductComboboxItem): void {
    this.deepLinkSeq++;
    this.counterpart.set(product);
    this.focusStep();
  }

  /** Step 2 → step 1. The typed field values stay. */
  protected onChangeCounterpart(): void {
    this.deepLinkSeq++;
    this.counterpart.set(null);
    this.saveNotice.set(null);
    this.resetSearch();
    this.focusSearch();
  }

  protected changeCounterpartLabel(name: string): string {
    return $localize`:@@vendor.integrationCreate.counterpart.changeAria:Change the other product, now ${name}:PRODUCT:`;
  }

  // ── The request form (AECI-1377) ─────────────────────────────────────────

  /** "Can't find it? Ask us to add it": swap step 1 for the request form, with the
   *  search text as the product name. */
  protected askUs(): void {
    this.deepLinkSeq++;
    this.requestDraft.set(emptyRequestDraft(this.query()));
    this.requestAttempted.set(false);
    this.requestNotice.set(null);
    this.mode.set('request');
    this.focusStep();
  }

  protected backToSearch(): void {
    this.mode.set('search');
    this.requestNotice.set(null);
    this.resetSearch();
    this.focusSearch();
  }

  /** "Add another integration" after the receipt: a fresh step 1. */
  protected startOver(): void {
    this.reset();
    this.focusSearch();
  }

  protected receiptBody(name: string): string {
    return $localize`:@@vendor.productRequest.receipt.body:We will add ${name}:NAME: or tell you why not. You will get an email and a message in your portal.`;
  }

  protected onRequestInput(field: RequestField, value: string): void {
    this.requestDraft.update((current) => ({ ...current, [field]: value }));
    this.requestNotice.set(null);
  }

  protected requestError(field: RequestField): string | null {
    return this.requestErrors()[field] ?? null;
  }

  protected requestFieldId(field: RequestField): string {
    return `vendor-request-${field}`;
  }

  protected requestMax(field: RequestField): number {
    return REQUEST_MAX[field];
  }

  protected requestFieldLabel(field: RequestField): string {
    switch (field) {
      case 'name':
        return $localize`:@@vendor.productRequest.field.name:Product name`;
      case 'maker':
        return $localize`:@@vendor.productRequest.field.maker:Company that makes it`;
      case 'website':
        return $localize`:@@vendor.productRequest.field.website:Website`;
      case 'body':
        return $localize`:@@vendor.productRequest.field.body:Anything we should know?`;
    }
  }

  protected async onRequestSubmit(event: Event): Promise<void> {
    event.preventDefault();
    if (this.requestSaving()) return;
    this.requestAttempted.set(true);
    this.requestNotice.set(null);

    const context = this.ownProductId();
    if (!context) {
      this.requestNotice.set(
        $localize`:@@vendor.integrationCreate.error.ownLoading:Your product is still loading. Try again in a moment.`,
      );
      return;
    }
    if (Object.keys(this.requestErrors()).length > 0) {
      this.requestNotice.set(
        $localize`:@@vendor.integrationCreate.error.fix:Fix the fields marked above, then try again.`,
      );
      return;
    }
    const draft = this.requestDraft();
    const body: CreateProductRequestInput = {
      context_product_id: context,
      name: draft.name.trim(),
      maker: draft.maker.trim(),
    };
    if (draft.website.trim() !== '') body.website = draft.website.trim();
    if (draft.body.trim() !== '') body.body = draft.body.trim();
    if (!CreateProductRequestSchema.safeParse(body).success) {
      this.requestNotice.set(
        $localize`:@@vendor.integrationCreate.error.shape:Check the values, then try again.`,
      );
      return;
    }

    this.requestSaving.set(true);
    try {
      const response = await this.api.createProductRequest(body);
      this.requestSaving.set(false);
      const name = response.request.name;
      this.receipt.set({ name });
      this.announcer.announce(
        $localize`:@@vendor.productRequest.live.sent:We have your request to add ${name}:NAME:.`,
      );
      this.requested.emit(response.request);
      this.focusStep();
    } catch (err) {
      this.requestSaving.set(false);
      this.requestNotice.set(productRequestErrorMessage(err, body.name));
    }
  }

  private focusStep(): void {
    afterNextRender(() => this.focusTarget()?.nativeElement.focus(), {
      injector: this.injector,
    });
  }

  private focusSearch(): void {
    afterNextRender(() => this.combobox()?.focus(), { injector: this.injector });
  }

  protected onInput(field: IntegrationEditField, value: string): void {
    this.draft.update((current) => ({ ...current, [field]: value }));
    this.saveNotice.set(null);
  }

  protected errorFor(field: IntegrationEditField): string | null {
    return this.errors()[field] ?? null;
  }

  protected showError(field: IntegrationEditField): boolean {
    return this.errorFor(field) !== null;
  }

  protected async onSubmit(event: Event): Promise<void> {
    event.preventDefault();
    if (this.saving()) return;
    this.attempted.set(true);
    this.saveNotice.set(null);

    const own = this.ownProductId();
    const other = this.counterpart();
    if (!own) {
      this.saveNotice.set(
        $localize`:@@vendor.integrationCreate.error.ownLoading:Your product is still loading. Try again in a moment.`,
      );
      return;
    }
    if (!other || Object.keys(this.errors()).length > 0) {
      this.saveNotice.set(
        $localize`:@@vendor.integrationCreate.error.fix:Fix the fields marked above, then try again.`,
      );
      return;
    }

    const body: CreateVendorIntegrationInput = {
      product_id: own,
      counterpart_product_id: other.id,
    };
    for (const [field, value] of Object.entries(this.draft()) as [IntegrationEditField, string][]) {
      if (value.trim() !== '') body[field] = value.trim();
    }
    if (!CreateVendorIntegrationSchema.safeParse(body).success) {
      this.saveNotice.set(
        $localize`:@@vendor.integrationCreate.error.shape:Check the values, then try again.`,
      );
      return;
    }

    this.saving.set(true);
    try {
      const response = await this.api.createIntegration(body);
      this.saving.set(false);
      this.open.set(false);
      this.result.set({ id: response.integration.id, duplicates: response.possible_duplicates });
      this.announcer.announce(
        response.possible_duplicates.length > 0
          ? $localize`:@@vendor.integrationCreate.live.doneDupes:Your integration is live. Some integrations were already on record for the same two products.`
          : $localize`:@@vendor.integrationCreate.live.done:Your integration is live on the public site.`,
      );
      void this.store.revalidate(['integrations']);
      afterNextRender(() => this.resultHeading()?.nativeElement.focus(), {
        injector: this.injector,
      });
    } catch (err) {
      this.saving.set(false);
      this.saveNotice.set(createErrorMessage(err));
    }
  }

  protected duplicateLine(dup: PossibleDuplicateIntegration): string {
    const name = dup.name ?? dup.mechanism_name ?? mechanismKindLabel(dup.mechanism_kind) ?? '';
    const owner = dup.owner?.name;
    if (dup.retired) {
      return $localize`:@@vendor.integrationCreate.dup.retired:${name}:name: (retired)`;
    }
    return owner
      ? $localize`:@@vendor.integrationCreate.dup.owned:${name}:name:, offered by ${owner}:owner:`
      : $localize`:@@vendor.integrationCreate.dup.noOwner:${name}:name:, no owner on file`;
  }

  protected groupLabel(key: (typeof EDIT_GROUPS)[number]['key']): string {
    switch (key) {
      case 'about':
        return $localize`:@@vendor.integrationCreate.group.about:About the integration`;
      case 'links':
        return $localize`:@@vendor.integrationCreate.group.links:Links`;
      case 'terms':
        return $localize`:@@vendor.integrationCreate.group.terms:Pricing and maturity`;
    }
  }

  protected fieldLabel(field: IntegrationEditField): string {
    return editFieldLabel(field);
  }

  protected required(field: IntegrationEditField): boolean {
    return INTEGRATION_EDIT_REQUIRED_FIELDS.has(field);
  }

  protected isUrl(field: IntegrationEditField): boolean {
    return URL_FIELDS.has(field);
  }

  protected maxLength(field: IntegrationEditField): number {
    return INTEGRATION_EDIT_MAX_LENGTH[field];
  }

  protected optionsFor(field: IntegrationEditField): readonly { value: string; label: string }[] {
    if (field === 'mechanism_kind') {
      return OWNER_EDITABLE_MECHANISM_KINDS.map((kind) => ({
        value: kind,
        label: mechanismKindLabel(kind) || kind,
      }));
    }
    const other =
      this.counterpart()?.name ??
      $localize`:@@vendor.integrationCreate.otherPlaceholder:the other product`;
    return (['outbound', 'both', 'inbound'] as const).map((direction) => ({
      value: direction,
      label: directionHeading(direction, other),
    }));
  }

  protected fieldId(field: string): string {
    return `vendor-create-${field}`;
  }

  protected selectValue(event: Event): string {
    return (event.target as HTMLSelectElement).value;
  }

  protected inputValue(event: Event): string {
    return (event.target as HTMLInputElement | HTMLTextAreaElement).value;
  }

  protected readonly triggerClass =
    'inline-flex items-center rounded-(--radius-md) border border-(--border-strong) px-4 py-2 text-sm font-semibold text-(--text-primary) transition-colors hover:border-(--accent-primary) hover:text-(--accent-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';
  protected readonly selectClass =
    'w-full cursor-pointer appearance-none rounded-(--radius-md) border border-(--border-default) bg-(--surface-base) py-2 pe-9 ps-3 text-sm text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';
  protected readonly legendClass = 'mb-3 text-sm font-semibold text-(--text-primary)';
  protected readonly labelClass =
    'block text-xs font-bold tracking-[0.08em] text-(--text-secondary) uppercase';
  protected readonly stepCountClass =
    'block text-xs font-bold tracking-[0.08em] text-(--text-secondary) uppercase';
  protected readonly stepTitleClass = 'block text-base font-semibold text-(--text-primary)';
  protected readonly inputClass =
    'w-full rounded-(--radius-md) border border-(--border-default) bg-(--surface-base) px-3 py-2 text-sm text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';
  protected readonly errorClass = 'max-w-prose text-xs font-medium text-(--text-primary)';
  protected readonly primaryButtonClass =
    'inline-flex items-center justify-center rounded-(--radius-md) border border-(--border-strong) bg-(--accent-primary) px-5 py-2.5 text-sm font-bold text-(--surface-base) transition-colors hover:bg-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) disabled:cursor-not-allowed disabled:opacity-50';
  protected readonly secondaryButtonClass =
    'inline-flex items-center justify-center rounded-(--radius-md) border border-(--border-default) px-4 py-2 text-sm font-medium text-(--text-primary) transition-colors hover:border-(--border-strong) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) disabled:cursor-not-allowed disabled:opacity-50';
  protected readonly textButtonClass =
    'cursor-pointer rounded-(--radius-sm) text-sm font-medium text-(--accent-primary) underline underline-offset-2 hover:text-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';
}

/** The refusals `POST /api/vendor/product-requests` can answer (AECI-1377). */
export function productRequestErrorMessage(err: unknown, name: string): string {
  const info = readVendorApiError(err);
  switch (info?.code) {
    case 'PRODUCT_REQUEST_EXISTS':
      return $localize`:@@vendor.productRequest.error.exists:You already asked us to add ${name}:NAME:. It is in the list below.`;
    case 'NOT_FOUND':
      return $localize`:@@vendor.productRequest.error.notFound:Your product is not available for a request. Reload the page and try again.`;
    case 'VALIDATION_FAILED':
      return $localize`:@@vendor.productRequest.error.validation:Check the fields, then try again.`;
    case 'RATE_LIMITED':
      return $localize`:@@vendor.integrationCreate.error.rate:Too many requests in a short time. Wait a minute and try again.`;
    default:
      return $localize`:@@vendor.productRequest.error.generic:Could not send the request. Try again.`;
  }
}

/** The refusals `POST /api/vendor/integrations` can answer, mapped to what to do
 *  next. */
export function createErrorMessage(err: unknown): string {
  const info = readVendorApiError(err);
  switch (info?.code) {
    case 'NOT_FOUND':
      return $localize`:@@vendor.integrationCreate.error.notFound:One of the two products is not available to link. Search again and choose another result.`;
    case 'INTEGRATION_INVALID_VALUE':
      return $localize`:@@vendor.integrationCreate.error.invalid:One of the values is not valid for its field. Check the form and try again.`;
    case 'VALIDATION_FAILED':
      return $localize`:@@vendor.integrationCreate.error.validation:Check the required fields, then try again.`;
    case 'RATE_LIMITED':
      return $localize`:@@vendor.integrationCreate.error.rate:Too many requests in a short time. Wait a minute and try again.`;
    default:
      return $localize`:@@vendor.integrationCreate.error.generic:Could not add the integration. Try again.`;
  }
}
