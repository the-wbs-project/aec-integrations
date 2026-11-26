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
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink, type ParamMap } from '@angular/router';

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
import { NewTabIcon } from '../../shared/new-tab-icon/new-tab-icon';
import {
  ProductCombobox,
  type ProductComboboxItem,
  type ProductComboboxSearch,
} from '../../shared/product-combobox/product-combobox';
import {
  PORTAL_FIELDSET_CLASS,
  PORTAL_FIELD_CLASS,
  PORTAL_FORM_CLASS,
  PORTAL_FORM_GRID_CLASS,
  PORTAL_FORM_SPAN_CLASS,
  PORTAL_LEGEND_CLASS,
  PORTAL_SAVE_BAR_CLASS,
  PORTAL_SAVE_BUTTON_CLASS,
  PORTAL_SAVE_STATUS_CLASS,
} from '../shared/portal-form';
import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorApi } from '../vendor-api';
import { readVendorApiError } from '../vendor-api-error';
import { VendorPortalStore } from '../vendor-portal-store';

import { editFieldLabel } from './vendor-contest-labels';
import { STANDALONE_LINK_CLASS, VendorDocsLink } from './vendor-docs-link';
import { EDIT_GROUPS } from './vendor-integration-edit-form';
import { claimErrorMessage, editValueMessage } from './vendor-integration-ownership-labels';
import { isReplayedEvent } from '../../core/event-replay';
import { AecButton } from '../../shared/button/button';
import { AecCard } from '../../shared/card/card';
import {
  FIELD_ERROR_CLASS,
  FIELD_HINT_CLASS,
  FIELD_INPUT_CLASS,
  FIELD_LABEL_CLASS,
  FIELD_OPTIONAL_CLASS,
} from '../../shared/form-field/form-field-classes';
import { AecIcon } from '../../shared/icon/icon';
import { KeepClearOfSaveBar } from '../shared/keep-clear-of-save-bar';
import { CloseOnEscape } from '../shared/close-on-escape';

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

/**
 * The portal route of one integration on the tab's product (AECI-1953). The
 * Integrations section passes its own `linkFor` logic, so the routed tab and the
 * single-page concept both resolve. Every match sits on the tab's product.
 */
export type VendorIntegrationLink = (id: string, productSlug: string) => readonly string[];

/** What a pre-create match offers (AECI-1953, §4.7.5). */
export type DuplicateAction = 'claim' | 'open' | 'restore' | 'ask';

/** The pre-create check's state for the chosen pair. `failed` fails open. */
type DuplicateCheck =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'failed' }
  | { state: 'ready'; key: string; rows: readonly PossibleDuplicateIntegration[] };

/** The receipt: a new row, or an existing row the vendor claimed instead. */
interface CreateResult {
  kind: 'created' | 'claimed';
  id: string;
  name: string;
  own: { slug: string; name: string };
  other: { slug: string; name: string };
  /** After a create only: matches the pre-check did not already show. */
  duplicates: readonly PossibleDuplicateIntegration[];
}

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
 * portal's one live region. The receipt links to the new row's portal page and to
 * its public pair page.
 *
 * ── A LIKELY DUPLICATE, BEFORE THE CREATE (AECI-1953, §4.7.5) ───────────────
 * Duplicates never block (AECI-1003 decision 10). When the vendor picks the other
 * product, the form reads `GET /api/vendor/integrations/possible-duplicates`, the
 * create's own strong-match rule, and lists each match at the top of step 2 with
 * one action: Claim this one instead (the caller's live, unclaimed row), Open it
 * (already the caller's, or retired by AEC Integrations, which only AECi restores),
 * Open it to restore (a row the caller retired), or Ask to be recorded as the owner
 * (a live row with no owner on file). A retired row with no owner only opens.
 * A claim closes the form and shows the same receipt for the claimed row. Change is disabled while a create or a claim is in flight, and each
 * receipt is built from what was submitted, never from the form after the await.
 * A failed check fails open: the create still runs, and its `201` still warns. After the `201` the receipt lists only matches
 * the pre-check did not show, such as a row created in between.
 *
 * The type picker leaves out the connector-delivered kinds, which the server
 * refuses (decision 9). The wording is AECI-1023's, and matches `/methodology`.
 *
 * ── TWO STEPS, AND THE WAY OUT OF A MISS (AECI-1377, §4.7.6) ────────────────
 * Step 1 of 2 is the locked product and the search, nothing else. Choosing a
 * product is step 2: the chosen card with Change, the likely duplicates and the
 * three field groups. Change goes back to step 1 and keeps the typed values. Under the
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
  imports: [
    CloseOnEscape,
    AecButton,
    AecCard,
    AecIcon,
    KeepClearOfSaveBar,
    LogoOrInitial,
    NewTabIcon,
    NgTemplateOutlet,
    ProductCombobox,
    RouterLink,
    VendorDocsLink,
  ],
  styles: [':host { display: block; }'],
  template: `
    <div class="space-y-4" data-testid="integration-create">
      <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
        <button
          #trigger
          aecButton
          variant="secondary"
          type="button"
          [attr.aria-expanded]="open()"
          [attr.aria-controls]="formId"
          (click)="toggle()"
          data-testid="add-integration"
          i18n="@@vendor.integrationCreate.trigger"
        >
          Add an integration
        </button>
        @if (!open()) {
          <p class="text-sm text-(--text-secondary)" i18n="@@vendor.integrationCreate.teaser">
            List an integration your company offers that is not on record yet.
          </p>
        }
        <aec-vendor-docs-link page="owning-an-integration" />
      </div>

      @if (result(); as created) {
        <!-- AECI-1953: one compact success block. A check, the title, one action row,
             and a close button in the corner. The claim receipt uses the same layout. -->
        <div aecCard class="max-w-3xl py-4 ps-6 pe-2" data-testid="create-result">
          <div class="flex items-start gap-3">
            <span class="mt-1 flex shrink-0 text-(--accent-primary)">
              <aec-icon name="check-circle" decorative />
            </span>
            <div class="min-w-0 flex-1 space-y-1">
              <p
                #resultHeading
                tabindex="-1"
                class="mt-1 text-sm font-semibold text-(--text-primary) focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--accent-primary)"
                data-testid="create-result-title"
              >
                {{ resultTitle(created) }}
              </p>
              <div class="flex flex-wrap items-center gap-x-4 gap-y-1">
                @if (linkTo(created.id, created.own.slug); as link) {
                  <a
                    [routerLink]="link"
                    [class]="rowActionClass"
                    data-testid="create-result-open"
                    i18n="@@vendor.integrationCreate.done.open"
                    >Open your integration</a
                  >
                }
                <a
                  [href]="publicHref(created)"
                  target="_blank"
                  rel="noopener"
                  [attr.aria-label]="publicAria(created)"
                  [class]="publicLinkClass"
                  data-testid="create-result-public"
                  ><span i18n="@@vendor.integrationCreate.done.viewPublic">View public page</span>
                  <aec-new-tab-icon [announce]="false"
                /></a>
              </div>
            </div>
            <button
              aecButton
              variant="ghost"
              iconOnly
              type="button"
              aria-label="Dismiss"
              i18n-aria-label="@@vendor.integrationCreate.done.dismiss"
              (click)="dismissResult()"
              data-testid="create-result-dismiss"
            >
              <aec-icon name="x" decorative [size]="4" />
            </button>
          </div>
          @if (created.duplicates.length > 0) {
            <div class="mt-3 space-y-2 pe-4 ps-8">
              <p
                class="max-w-prose text-sm text-(--text-secondary)"
                i18n="@@vendor.integrationCreate.done.lateDupes"
              >
                These integrations are also on record for the same two products. If one of them is
                the same integration, retire the one you just added from its page, then use the
                existing one.
              </p>
              <ul
                class="m-0 list-none divide-y divide-(--border-default) border-t border-(--border-default) p-0"
                data-testid="create-duplicates"
              >
                @for (dup of created.duplicates; track dup.id) {
                  <ng-container
                    [ngTemplateOutlet]="duplicateRow"
                    [ngTemplateOutletContext]="{
                      $implicit: dup,
                      receipt: true,
                      ownSlug: created.own.slug,
                    }"
                  />
                }
              </ul>
            </div>
          }
        </div>
      }

      @if (open()) {
        <!-- AECI-1811: the panel is a portal form card (vendor/shared/portal-form.ts). -->
        <div
          aecCard
          phoneFlush
          [id]="formId"
          role="group"
          aria-labelledby="vendor-create-title"
          class="max-w-4xl space-y-6 p-6 md:p-8"
          data-testid="create-panel"
        >
          <div class="max-w-prose space-y-1">
            <p
              id="vendor-create-title"
              class="font-display text-t-20 font-semibold text-(--text-primary)"
              i18n="@@vendor.integrationCreate.title"
            >
              Add an integration
            </p>
            <p
              class="max-w-prose text-sm text-(--text-secondary)"
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
                class="text-sm font-semibold text-(--text-primary) focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--accent-primary)"
                i18n="@@vendor.productRequest.receipt.title"
              >
                We have your request.
              </p>
              <p class="text-sm text-(--text-secondary)">{{ receiptBody(sent.name) }}</p>
              <button
                aecButton
                variant="secondary"
                type="button"
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
              aecKeepClearOfSaveBar
              method="dialog"
              [class]="formClass"
              novalidate
              (submit)="onRequestSubmit($event)"
              aria-labelledby="vendor-request-title"
              data-testid="product-request-form"
            >
              <div class="mb-6 max-w-prose space-y-1">
                <p
                  #focusTarget
                  id="vendor-request-title"
                  tabindex="-1"
                  [class]="stepTitleClass"
                  i18n="@@vendor.productRequest.title"
                >
                  Ask us to add the other product
                </p>
                <p class="text-sm text-(--text-secondary)" i18n="@@vendor.productRequest.intro">
                  Tell us which product it is. We will add it to the catalog or tell you why not.
                  Once it is listed, you add the integration yourself.
                </p>
              </div>

              <div [class]="gridClass">
                @for (field of requestFields; track field) {
                  <div [class]="field === 'body' ? fieldClass + ' ' + spanClass : fieldClass">
                    <label [for]="requestFieldId(field)" [class]="labelClass">
                      {{ requestFieldLabel(field) }}
                      @if (field === 'website' || field === 'body') {
                        <span [class]="optionalClass">{{ optionalLabel }}</span>
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
              </div>

              <div [class]="saveBarClass">
                <div [class]="saveStatusClass">
                  @if (requestNotice(); as message) {
                    <p
                      role="alert"
                      class="font-semibold text-(--text-primary)"
                      data-testid="product-request-notice"
                    >
                      {{ message }}
                    </p>
                  }
                </div>
                <button
                  aecButton
                  type="submit"
                  [class]="saveButtonClass"
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
                  aecButton
                  variant="secondary"
                  type="button"
                  [class]="saveButtonClass"
                  [disabled]="requestSaving()"
                  (click)="backToSearch()"
                  data-testid="product-request-back"
                  i18n="@@vendor.productRequest.back"
                >
                  Back to search
                </button>
              </div>
            </form>
          } @else if (counterpart(); as chosen) {
            <form
              aecCloseOnEscape
              [escapeBusy]="saving()"
              (escapeCancel)="close()"
              aecKeepClearOfSaveBar
              method="dialog"
              [class]="formClass"
              novalidate
              (submit)="onSubmit($event)"
              aria-labelledby="vendor-create-step"
              data-testid="create-form"
            >
              <p
                #focusTarget
                id="vendor-create-step"
                tabindex="-1"
                class="mb-8 space-y-1 focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--accent-primary)"
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

              <fieldset [class]="fieldsetClass">
                <legend [class]="legendClass" i18n="@@vendor.integrationCreate.group.products">
                  The two products
                </legend>
                <div [class]="gridClass">
                  <ng-container [ngTemplateOutlet]="ownProductBox" />

                  <div [class]="fieldClass">
                    <p [class]="labelClass" i18n="@@vendor.integrationCreate.counterpart.label">
                      The other product
                    </p>
                    <div [class]="productBoxClass" data-testid="create-counterpart">
                      <aec-logo-or-initial
                        [claimStatus]="'stored'"
                        [src]="chosen.logo_url ?? null"
                        [name]="chosen.name"
                        size="sm"
                      />
                      <span class="flex min-w-0 flex-1 flex-col">
                        <span class="truncate text-sm font-semibold text-(--text-primary)">{{
                          chosen.name
                        }}</span>
                        @if (chosen.vendor; as vendor) {
                          <span class="truncate text-xs text-(--text-secondary)">{{
                            vendor.name
                          }}</span>
                        }
                      </span>
                      <button
                        aecButton
                        variant="secondary"
                        compact
                        type="button"
                        [attr.aria-label]="changeCounterpartLabel(chosen.name)"
                        [disabled]="saving() || claimingId() !== null"
                        (click)="onChangeCounterpart()"
                        data-testid="create-change-counterpart"
                        i18n="@@vendor.integrationCreate.counterpart.change"
                      >
                        Change
                      </button>
                    </div>
                  </div>

                  @if (check().state === 'loading') {
                    <p
                      [class]="'max-w-prose text-sm text-(--text-secondary) ' + spanClass"
                      data-testid="create-dupes-loading"
                      i18n="@@vendor.integrationCreate.dupes.loading"
                    >
                      Checking for integrations already on record…
                    </p>
                  } @else if (duplicates().length > 0) {
                    <!-- AECI-1953: the create's own strong matches, before the create. -->
                    <div
                      [class]="dupesClass"
                      role="group"
                      aria-labelledby="vendor-create-dupes-title vendor-create-dupes-count"
                      data-testid="create-dupes"
                    >
                      <div class="px-4 py-3">
                        <div class="flex flex-wrap items-baseline justify-between gap-x-3">
                          <p
                            id="vendor-create-dupes-title"
                            class="text-sm font-semibold text-(--text-primary)"
                            data-testid="create-dupes-title"
                            i18n="@@vendor.integrationCreate.dupes.heading"
                          >
                            Already on record for these two products
                          </p>
                          <span
                            id="vendor-create-dupes-count"
                            class="text-sm text-(--text-secondary) tabular-nums"
                            data-testid="create-dupes-count"
                            >{{ duplicatesCount() }}</span
                          >
                        </div>
                        <p
                          class="mt-1 max-w-prose text-sm text-(--text-secondary)"
                          i18n="@@vendor.integrationCreate.dupes.help"
                        >
                          If one of them is yours, use it instead of adding a copy.
                        </p>
                      </div>
                      <ul
                        class="m-0 list-none divide-y divide-(--border-default) border-t border-(--border-default) p-0"
                      >
                        @for (dup of duplicates(); track dup.id) {
                          <ng-container
                            [ngTemplateOutlet]="duplicateRow"
                            [ngTemplateOutletContext]="{
                              $implicit: dup,
                              receipt: false,
                              ownSlug: ownSlug(),
                            }"
                          />
                        }
                      </ul>
                    </div>
                  }
                </div>
              </fieldset>

              @for (group of groups; track group.key) {
                <fieldset [class]="fieldsetClass">
                  <legend [class]="legendClass">{{ groupLabel(group.key) }}</legend>
                  <div [class]="gridClass">
                    @for (field of group.fields; track field) {
                      <div
                        [class]="
                          field === 'description' ? fieldClass + ' ' + spanClass : fieldClass
                        "
                      >
                        <label [for]="fieldId(field)" [class]="labelClass">
                          {{ fieldLabel(field) }}
                          @if (!required(field)) {
                            <span [class]="optionalClass">{{ optionalLabel }}</span>
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
                          <div class="relative">
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
                            <span [class]="selectChevronClass">
                              <aec-icon name="chevron-down" decorative [size]="4" />
                            </span>
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
                  </div>
                </fieldset>
              }

              <div [class]="saveBarClass">
                <div [class]="saveStatusClass">
                  @if (saveNotice(); as message) {
                    <p role="alert" class="font-semibold text-(--text-primary)">{{ message }}</p>
                  }
                </div>
                <button
                  aecButton
                  type="submit"
                  [class]="saveButtonClass"
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
                  aecButton
                  variant="secondary"
                  type="button"
                  [class]="saveButtonClass"
                  [disabled]="saving()"
                  (click)="close()"
                  i18n="@@vendor.integrationCreate.cancel"
                >
                  Cancel
                </button>
              </div>
            </form>
          } @else {
            <!-- Step 1 of 2: the locked product and the search. Nothing else shows. -->
            <div
              aecCloseOnEscape
              (escapeCancel)="close()"
              class="space-y-6"
              data-testid="create-step-find"
            >
              <p
                #focusTarget
                id="vendor-create-step"
                tabindex="-1"
                class="space-y-1 focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--accent-primary)"
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

              <div [class]="gridClass">
                <ng-container [ngTemplateOutlet]="ownProductBox" />

                <div [class]="fieldClass">
                  <label
                    for="vendor-create-search"
                    [class]="labelClass"
                    i18n="@@vendor.integrationCreate.search.label"
                    >The other product</label
                  >
                  <aec-product-combobox
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
                    [class]="hintClass"
                    i18n="@@vendor.integrationCreate.search.hint"
                  >
                    Search the published catalog by product name, then choose one result.
                  </p>
                  <!-- Below the input and outside the popup, so a keyboard can reach it:
                       focus stays in the input while the popup is open (AECI-1377). -->
                  <div class="space-y-1">
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
                      aecButton
                      variant="ghost"
                      type="button"
                      class="-ms-4"
                      (click)="askUs()"
                      data-testid="create-ask-us"
                      i18n="@@vendor.productRequest.ask"
                    >
                      Can't find it? Ask us to add it
                    </button>
                  </div>
                </div>
              </div>

              <div
                class="flex flex-wrap items-center gap-3 border-t border-(--border-default) pt-6"
              >
                <button
                  aecButton
                  variant="secondary"
                  type="button"
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

      <!-- One match: its name, a status line under it, and the one action that fits
           it on the right. On a narrow column the action wraps under the text. The
           receipt offers links only, so a claim there goes through the row's page.
           The receipt passes the own slug it was built with, never the live form's. -->
      <ng-template #duplicateRow let-dup let-receipt="receipt" let-rowOwnSlug="ownSlug">
        <li [class]="receipt ? 'py-3' : 'px-4 py-3'" [attr.data-duplicate]="dup.id">
          <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <div class="min-w-0 flex-1 basis-48">
              <p
                class="text-sm font-semibold break-words text-(--text-primary)"
                data-testid="create-dupe-name"
              >
                {{ duplicateName(dup) }}
              </p>
              <p class="text-sm text-(--text-secondary)" data-testid="create-dupe-status">
                {{ statusLine(dup) }}
              </p>
            </div>
            <div class="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1">
              @switch (actionFor(dup)) {
                @case ('claim') {
                  @if (linkTo(dup.id, rowOwnSlug); as link) {
                    <a
                      [routerLink]="link"
                      [attr.aria-label]="openAria(dup, 'open')"
                      [class]="receipt ? rowActionClass : quietActionClass"
                      data-testid="create-dupe-open"
                      i18n="@@vendor.integrationCreate.dupes.open"
                      >Open it</a
                    >
                  }
                  @if (!receipt) {
                    <button
                      aecButton
                      variant="secondary"
                      compact
                      type="button"
                      [disabled]="claimingId() !== null"
                      [attr.aria-label]="claimAria(dup)"
                      (click)="onClaimDuplicate(dup)"
                      data-testid="create-dupe-claim"
                    >
                      @if (claimingId() === dup.id) {
                        <span i18n="@@vendor.integrationCreate.dupes.claiming">Claiming…</span>
                      } @else {
                        <span i18n="@@vendor.integrationCreate.dupes.claim"
                          >Claim this one instead</span
                        >
                      }
                    </button>
                  }
                }
                @case ('restore') {
                  @if (linkTo(dup.id, rowOwnSlug); as link) {
                    <a
                      [routerLink]="link"
                      [attr.aria-label]="openAria(dup, 'restore')"
                      [class]="rowActionClass"
                      data-testid="create-dupe-restore"
                      i18n="@@vendor.integrationCreate.dupes.restore"
                      >Open it to restore</a
                    >
                  }
                }
                @case ('ask') {
                  @if (linkTo(dup.id, rowOwnSlug); as link) {
                    <a
                      [routerLink]="link"
                      [attr.aria-label]="openAria(dup, 'ask')"
                      [class]="rowActionClass"
                      data-testid="create-dupe-ask"
                      i18n="@@vendor.integrationCreate.dupes.ask"
                      >Ask to be recorded as the owner</a
                    >
                  }
                }
                @default {
                  @if (linkTo(dup.id, rowOwnSlug); as link) {
                    <a
                      [routerLink]="link"
                      [attr.aria-label]="openAria(dup, 'open')"
                      [class]="rowActionClass"
                      data-testid="create-dupe-open"
                      i18n="@@vendor.integrationCreate.dupes.open"
                      >Open it</a
                    >
                  }
                }
              }
            </div>
          </div>
          @if (claimNotice(); as notice) {
            @if (notice.id === dup.id) {
              <p
                role="alert"
                class="mt-2 max-w-prose text-sm font-semibold text-(--text-primary)"
                data-testid="create-dupe-notice"
              >
                {{ notice.message }}
              </p>
            }
          }
        </li>
      </ng-template>

      <ng-template #ownProductBox>
        <div [class]="fieldClass">
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
              [class]="productBoxClass"
              data-testid="create-own-product"
            >
              @if (contextOwnProduct(); as own) {
                <aec-logo-or-initial
                  [claimStatus]="'stored'"
                  [src]="own.logo_url"
                  [name]="own.name"
                  size="sm"
                />
                <span
                  id="vendor-create-own-name"
                  class="min-w-0 flex-1 truncate text-sm font-semibold text-(--text-primary)"
                  >{{ own.name }}</span
                >
              } @else {
                <span id="vendor-create-own-name" class="flex-1">
                  <span
                    class="block h-4 w-40 motion-safe:animate-pulse rounded-mark bg-(--border-default)"
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
            <div class="relative">
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
              <span [class]="selectChevronClass">
                <aec-icon name="chevron-down" decorative [size]="4" />
              </span>
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
  /** Builds a match's or the new row's portal route (AECI-1953). With none, the
   *  form shows no portal links. */
  readonly integrationLink = input<VendorIntegrationLink | null>(null);

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

  protected readonly result = signal<CreateResult | null>(null);

  // ── The pre-create duplicate check (AECI-1953) ───────────────────────────
  protected readonly check = signal<DuplicateCheck>({ state: 'idle' });
  /** Bumped on every pair change, so a slow answer for an earlier pair is dropped. */
  private checkSeq = 0;
  protected readonly claimingId = signal<string | null>(null);
  protected readonly claimNotice = signal<{ id: string; message: string } | null>(null);
  private readonly myVendorId = computed(() => this.store.me()?.vendor.id ?? null);

  /** The matches for the pair on screen now. Empty while loading or after a failure. */
  protected readonly duplicates = computed(() => {
    const check = this.check();
    return check.state === 'ready' && check.key === this.pairKey() ? check.rows : [];
  });

  /** The neutral count beside the panel's heading. */
  protected readonly duplicatesCount = computed(() => {
    const count = this.duplicates().length;
    return count === 1
      ? $localize`:@@vendor.integrationCreate.dupes.countOne:1 integration`
      : $localize`:@@vendor.integrationCreate.dupes.countMany:${count}:count: integrations`;
  });

  private readonly pairKey = computed(() => {
    const own = this.ownProductId();
    const other = this.counterpart()?.id;
    return own && other ? `${own}:${other}` : null;
  });

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
    // AECI-1953: the pick (or the deep-link hit, or a new own product) starts the
    // check. Change clears it, and the sequence drops a stale answer.
    effect(() => {
      const key = this.pairKey();
      untracked(() => void this.checkDuplicates(key));
    });
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
    if (isReplayedEvent(event)) return;
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
    if (isReplayedEvent(event)) return;
    event.preventDefault();
    if (this.saving() || this.claimingId() !== null) return;
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

    // The receipt is built only from what was submitted. The form stays live
    // while the request runs, so nothing is read from it after the await.
    const pair = this.pairFor() ?? {
      own: { slug: '', name: '' },
      other: { slug: other.slug, name: other.name },
    };
    const shown = new Set(this.duplicates().map((dup) => dup.id));
    const name = body.name ?? '';

    this.saving.set(true);
    try {
      const response = await this.api.createIntegration(body);
      // The receipt repeats only what the pre-check did not show (AECI-1953).
      const late = response.possible_duplicates.filter((dup) => !shown.has(dup.id));
      this.saving.set(false);
      this.open.set(false);
      this.result.set({
        kind: 'created',
        id: response.integration.id,
        name,
        ...pair,
        duplicates: late,
      });
      this.announcer.announce(
        late.length > 0
          ? $localize`:@@vendor.integrationCreate.live.doneLateDupes:Your integration is live. Other integrations are also on record for the same two products.`
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

  /** Read the create's own strong matches for the pair on screen. Fails open. */
  private async checkDuplicates(key: string | null): Promise<void> {
    const seq = ++this.checkSeq;
    this.claimNotice.set(null);
    const own = this.ownProductId();
    const other = this.counterpart()?.id;
    if (key === null || !own || !other) {
      this.check.set({ state: 'idle' });
      return;
    }
    this.check.set({ state: 'loading' });
    try {
      const response = await this.api.getPossibleDuplicates(own, other);
      if (seq !== this.checkSeq) return;
      const rows = response.possible_duplicates;
      this.check.set({ state: 'ready', key, rows });
      if (rows.length > 0) {
        const count = rows.length;
        this.announcer.announce(
          $localize`:@@vendor.integrationCreate.dupes.live:${count}:count: integrations are already on record for these two products.`,
        );
      }
    } catch {
      // Fail open: the create still runs, and its 201 still warns.
      if (seq === this.checkSeq) this.check.set({ state: 'failed' });
    }
  }

  /** The one action a match offers. The claim route does not refuse a retired row,
   *  so Claim shows only on a live, unclaimed row the caller owns. Restore shows only
   *  on a row the owner retired: the restore route refuses an AECi retire, so that
   *  row only opens. Ask shows only on a live row with no owner: the owner-request
   *  route refuses a retired row, and its page hides the action. A retired row with
   *  no owner was retired by AECi, since the owner retire needs an owner, so it opens. */
  protected actionFor(dup: PossibleDuplicateIntegration): DuplicateAction {
    if (dup.owner === null) return dup.retired ? 'open' : 'ask';
    if (dup.owner.id !== this.myVendorId()) return 'open';
    if (dup.retired) return dup.retired_by === 'aeci' ? 'open' : 'restore';
    return dup.claimed ? 'open' : 'claim';
  }

  /** The muted line under a match's name: who owns it, and whether it is retired.
   *  An own match never repeats the caller's company name. */
  protected statusLine(dup: PossibleDuplicateIntegration): string {
    if (dup.owner === null) {
      return dup.retired
        ? $localize`:@@vendor.integrationCreate.dupes.status.noOwnerRetiredByAeci:No owner on file, retired by AEC Integrations. Only AEC Integrations can restore it.`
        : $localize`:@@vendor.integrationCreate.dupes.status.noOwner:No owner on file`;
    }
    if (dup.owner.id === this.myVendorId()) {
      if (dup.retired)
        return dup.retired_by === 'aeci'
          ? $localize`:@@vendor.integrationCreate.dupes.status.yoursRetiredByAeci:Yours, retired by AEC Integrations. Only AEC Integrations can restore it.`
          : $localize`:@@vendor.integrationCreate.dupes.status.yoursRetired:Yours, retired`;
      return dup.claimed
        ? $localize`:@@vendor.integrationCreate.dupes.status.yours:Yours`
        : $localize`:@@vendor.integrationCreate.dupes.status.yoursUnclaimed:Yours, not claimed yet`;
    }
    const owner = dup.owner.name;
    return dup.retired
      ? $localize`:@@vendor.integrationCreate.dupes.status.otherRetired:Offered by ${owner}:owner:, retired`
      : $localize`:@@vendor.integrationCreate.dupes.status.other:Offered by ${owner}:owner:`;
  }

  /** The portal route of an integration on the own product, or `null` with no
   *  builder or before the product list has loaded. */
  protected linkTo(id: string, ownSlug: string | null = this.ownSlug()): readonly string[] | null {
    const build = this.integrationLink();
    return build && ownSlug ? build(id, ownSlug) : null;
  }

  private readonly ownSlug = computed(() => {
    const own = this.ownProductId();
    return this.ownProducts().find((p) => p.id === own)?.slug ?? null;
  });

  protected publicHref(created: CreateResult): string {
    return `/products/${created.own.slug}/integrations/${created.other.slug}`;
  }

  /** Built in TS: an interpolated `i18n-aria-label` emits no attribute. It starts
   *  with the visible text (WCAG 2.5.3) and names the destination. */
  protected publicAria(created: CreateResult): string {
    const own = created.own.name;
    const other = created.other.name;
    return $localize`:@@vendor.integrationCreate.done.viewPublicAria:View public page: the ${own}:OWN: and ${other}:OTHER: integration (opens in a new tab)`;
  }

  protected resultTitle(created: CreateResult): string {
    const name = created.name;
    return created.kind === 'claimed'
      ? $localize`:@@vendor.integrationCreate.claimed.title:You now own ${name}:NAME:.`
      : $localize`:@@vendor.integrationCreate.done.title:Your integration is live on the public site.`;
  }

  /** The two endpoints as the receipt names them, or `null` before they load. */
  private pairFor(): Pick<CreateResult, 'own' | 'other'> | null {
    const ownId = this.ownProductId();
    const own = this.ownProducts().find((p) => p.id === ownId);
    const other = this.counterpart();
    if (!own || !other) return null;
    return {
      own: { slug: own.slug, name: own.name },
      other: { slug: other.slug, name: other.name },
    };
  }

  /** "Claim this one instead" (§4.7.5): the `onClaim` pattern of the owned rows. */
  protected async onClaimDuplicate(dup: PossibleDuplicateIntegration): Promise<void> {
    if (this.claimingId() !== null || this.saving()) return;
    // Snapshot before the await, as the create does: the receipt names the pair
    // the vendor claimed from, not whatever the form shows when the claim lands.
    const pair = this.pairFor();
    if (!pair) return;
    const name = this.duplicateName(dup);
    this.claimingId.set(dup.id);
    this.claimNotice.set(null);
    try {
      await this.api.claimIntegration(dup.id);
      this.open.set(false);
      this.result.set({ kind: 'claimed', id: dup.id, name, ...pair, duplicates: [] });
      this.announcer.announce(
        $localize`:@@vendor.integrationCreate.live.claimed:You now own ${name}:NAME:. AEC Integrations no longer updates it.`,
      );
      void this.store.revalidate(['integrations']);
      afterNextRender(() => this.resultHeading()?.nativeElement.focus(), {
        injector: this.injector,
      });
    } catch (err) {
      this.claimNotice.set({ id: dup.id, message: claimErrorMessage(err) });
    } finally {
      this.claimingId.set(null);
    }
  }

  protected claimAria(dup: PossibleDuplicateIntegration): string {
    const name = this.duplicateName(dup);
    return $localize`:@@vendor.integrationCreate.dupes.claimAria:Claim this one instead: ${name}:NAME:`;
  }

  protected openAria(dup: PossibleDuplicateIntegration, action: DuplicateAction): string {
    const name = this.duplicateName(dup);
    switch (action) {
      case 'restore':
        return $localize`:@@vendor.integrationCreate.dupes.restoreAria:Open it to restore: ${name}:NAME:`;
      case 'ask':
        return $localize`:@@vendor.integrationCreate.dupes.askAria:Ask to be recorded as the owner: ${name}:NAME:`;
      default:
        return $localize`:@@vendor.integrationCreate.dupes.openAria:Open it: ${name}:NAME:`;
    }
  }

  protected duplicateName(dup: PossibleDuplicateIntegration): string {
    return dup.name ?? dup.mechanism_name ?? mechanismKindLabel(dup.mechanism_kind) ?? '';
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

  // AECI-1811: the portal form layout (`vendor/shared/portal-form.ts`) and the shared
  // field recipe (`shared/form-field/form-field-classes.ts`).
  protected readonly formClass = PORTAL_FORM_CLASS;
  protected readonly fieldsetClass = PORTAL_FIELDSET_CLASS;
  protected readonly legendClass = PORTAL_LEGEND_CLASS;
  protected readonly gridClass = PORTAL_FORM_GRID_CLASS;
  protected readonly spanClass = PORTAL_FORM_SPAN_CLASS;
  protected readonly fieldClass = PORTAL_FIELD_CLASS;
  protected readonly saveBarClass = PORTAL_SAVE_BAR_CLASS;
  protected readonly saveStatusClass = PORTAL_SAVE_STATUS_CLASS;
  protected readonly saveButtonClass = PORTAL_SAVE_BUTTON_CLASS;
  protected readonly labelClass = FIELD_LABEL_CLASS;
  protected readonly optionalClass = FIELD_OPTIONAL_CLASS;
  protected readonly hintClass = `max-w-prose ${FIELD_HINT_CLASS}`;
  protected readonly inputClass = FIELD_INPUT_CLASS;
  protected readonly selectClass = `${FIELD_INPUT_CLASS} cursor-pointer appearance-none pe-12`;
  protected readonly selectChevronClass =
    'pointer-events-none absolute end-4 top-1/2 flex -translate-y-1/2 text-(--text-secondary)';
  protected readonly errorClass = `max-w-prose ${FIELD_ERROR_CLASS}`;
  /** "Step 1 of 2": the overline role. */
  protected readonly stepCountClass = 'aec-overline block text-(--text-secondary)';
  protected readonly stepTitleClass =
    'block font-display text-t-20 font-semibold text-(--text-primary) focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--accent-primary)';
  /** A product shown in a box (the tab's own, or the chosen one): 44px, the control radius. */
  protected readonly productBoxClass =
    'flex min-h-11 items-center gap-3 rounded-control bg-(--surface-sunken) px-4 py-2';
  /** The likely duplicates: a bordered panel across both columns, no card in a card. */
  protected readonly dupesClass = `rounded-panel border border-(--border-default) ${PORTAL_FORM_SPAN_CLASS}`;
  /** A row's link ("Open it", "Open your integration"): Forest, the role radius. It
   *  was the detail page's `ROW_ACTION`, retired with its buttons (AECI-1811 part 2). */
  protected readonly rowActionClass =
    'inline-flex min-h-6 cursor-pointer items-center rounded-mark text-sm font-semibold text-(--accent-primary) underline-offset-4 hover:underline focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--accent-primary)';
  /** A row's second, quieter link: the same shape as the row action, out of accent. */
  protected readonly quietActionClass =
    'inline-flex min-h-6 items-center rounded-mark text-sm font-semibold text-(--text-secondary) underline-offset-4 hover:text-(--text-primary) hover:underline focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--accent-primary)';
  /** DESIGN.md's standalone link, as `aec-view-public-link` draws it (14px at 600). */
  protected readonly publicLinkClass = STANDALONE_LINK_CLASS;
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
