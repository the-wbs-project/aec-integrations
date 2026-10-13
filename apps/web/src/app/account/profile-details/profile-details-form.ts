import {
  Component,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  input,
  model,
  output,
  signal,
  viewChild,
} from '@angular/core';

import {
  MAX_FIRM_NAME_LENGTH,
  MAX_PROFILE_AUDIENCES,
  type CompanySize,
  type CompanyType,
  type LinkRef,
  type ProfilePrimaryRole,
} from '@aeci/shared';
import { compareText } from '@aeci/shared/text-sort';

import { AecSelect, type AecSelectOption } from '../../shared/aec-select/aec-select';
import {
  CHOICE_CARD_CLASS,
  CHOICE_INPUT_CLASS,
  FIELD_ERROR_CLASS,
  FIELD_HINT_CLASS,
  FIELD_INPUT_CLASS,
  FIELD_LABEL_CLASS,
} from '../../shared/form-field/form-field-classes';
import { AccountApi } from '../account-api';
import {
  COMPANY_SIZE_OPTIONS,
  COMPANY_TYPE_OPTIONS,
  isVendorDraft,
  linkedInInvalid,
  roleForCompanyType,
  roleOptionsFor,
  type Labelled,
  type ProfileDetailsDraft,
} from './profile-details-model';

const CLEAR_ANSWER_LABEL = $localize`:@@profileDetails.clearAnswer:Clear answer`;

/**
 * The options for one single choice. Unanswered (`null`) shows the "Choose one"
 * placeholder and no row is selected, because no option carries `null`. Once
 * there is an answer, a "Clear answer" row leads the list so the question can go
 * back to unanswered. That row is the only `null`-valued option, and it exists
 * only while the value is not `null`, so `AecSelect` never renders it as chosen.
 * "I'd rather not say" is a separate, stored answer (`undisclosed`).
 */
function choiceOptions(
  options: ReadonlyArray<Labelled<string>>,
  current: string | null,
): AecSelectOption[] {
  return current === null ? [...options] : [{ value: null, label: CLEAR_ANSWER_LABEL }, ...options];
}

/** The fields a software company is not asked, and the role list swap, named
 *  for the live region. */
const VENDOR_HIDDEN = $localize`:@@profileDetails.vendor.hidden:Company size, audiences and firm name were removed from the form. The role list now shows software company roles.`;
const VENDOR_SHOWN = $localize`:@@profileDetails.vendor.shown:Company size, audiences and firm name were added back to the form. The role list now shows AEC roles.`;

/**
 * The "About you" questions 2 to 7 (AECI-1296, `docs/ACCOUNT_ONBOARDING_SPEC.md`):
 * where you work, your role, company size, audiences, firm name and LinkedIn.
 * Display name is NOT here: `/welcome` and `/account` each own that field.
 *
 * Presentational over a two-way `draft` model. The parent owns saving, so the
 * same questions serve the first-sign-in page and the account page. "Where do
 * you work?" is grouped: AEC firms, software companies, other options. Picking
 * any software company hides size, audiences and firm, with nothing in their
 * place, and swaps the role list for software company roles. Role and LinkedIn
 * stay for everyone. Status changes a screen reader should
 * hear (fields removed or restored, the audience count) go out on `announce`
 * for the host's one polite live region.
 *
 * The audience vocabulary loads after hydration (`GET /api/audiences`). Both
 * hosting pages are `no-store` and render answers in the browser only, so no
 * personal data reaches a cached render.
 *
 * Single choices use the shared `AecSelect` (Angular Aria combobox, ADR 0010).
 * Layout follows the claim dialog (`shared/form-field/form-field-classes.ts`):
 * label, control, then hint, fields `space-y-6` apart, and audiences as the
 * plan question's choice cards. The host and every `aec-select` are `block`,
 * because an inline host takes no `space-y` margin.
 *
 * Audiences are a filterable checkbox list in a `fieldset`: 36 terms is too many
 * for a listbox popup and native checkboxes give the multi-select semantics free.
 */
@Component({
  selector: 'aec-profile-details-form',
  imports: [AecSelect],
  host: { class: 'block' },
  template: `
    <div class="space-y-6">
      <aec-select
        class="block"
        layout="stacked"
        [idPrefix]="idPrefix() + '-company-type'"
        i18n-label="@@profileDetails.companyType.label"
        label="Where do you work?"
        i18n-placeholder="@@profileDetails.choose"
        placeholder="Choose one"
        [options]="companyTypeOptions()"
        [value]="draft().company_type"
        (changed)="setCompanyType($event)"
      />

      <aec-select
        class="block"
        layout="stacked"
        [idPrefix]="idPrefix() + '-role'"
        i18n-label="@@profileDetails.role.label"
        label="Your role"
        i18n-placeholder="@@profileDetails.choose"
        placeholder="Choose one"
        [options]="roleOptions()"
        [value]="draft().primary_role"
        (changed)="setRole($event)"
      />

      @if (!vendor()) {
        <aec-select
          class="block"
          layout="stacked"
          [idPrefix]="idPrefix() + '-company-size'"
          i18n-label="@@profileDetails.companySize.label"
          label="Company size"
          i18n-placeholder="@@profileDetails.choose"
          placeholder="Choose one"
          [options]="companySizeOptions()"
          [value]="draft().company_size"
          (changed)="setSize($event)"
        />

        <fieldset data-testid="audiences" [attr.aria-describedby]="idPrefix() + '-audiences-hint'">
          <legend [class]="labelClass" i18n="@@profileDetails.audiences.label">
            Which audiences describe you?
          </legend>
          <p [id]="idPrefix() + '-audiences-hint'" class="mt-1.5" [class]="hintClass">
            <span i18n="@@profileDetails.audiences.hint"
              >Pick up to {{ maxAudiences }} that fit.</span
            >
            {{ ' ' }}
            <span i18n="@@profileDetails.audiences.count"
              >{{ draft().audience_ids.length }} of {{ maxAudiences }} chosen.</span
            >
          </p>
          @if (audiencesFailed()) {
            <p
              class="mt-3 text-sm font-medium text-(--text-primary)"
              role="alert"
              i18n="@@profileDetails.audiences.failed"
            >
              We couldn't load the audience list. You can still save your other answers.
            </p>
          } @else if (audiences() === null) {
            <p
              class="mt-3 text-sm text-(--text-secondary)"
              i18n="@@profileDetails.audiences.loading"
            >
              Loading audiences…
            </p>
          } @else {
            <label
              [for]="idPrefix() + '-audience-filter'"
              class="sr-only"
              i18n="@@profileDetails.audiences.filterLabel"
              >Filter audiences</label
            >
            <input
              [id]="idPrefix() + '-audience-filter'"
              type="search"
              autocomplete="off"
              i18n-placeholder="@@profileDetails.audiences.filterPlaceholder"
              placeholder="Filter, e.g. estimator"
              [value]="filter()"
              (input)="onFilter($event)"
              class="mt-3"
              [class]="inputClass"
            />
            <!-- The bottom hairline and the always-drawn thin scrollbar
                 (.aec-scroll-box) tell the reader a clipped last row scrolls. -->
            <ul
              class="aec-scroll-box mt-3 grid max-h-80 grid-cols-1 gap-2 overflow-y-auto border-b p-0.5 pb-2 sm:grid-cols-2"
              data-testid="audience-list"
            >
              @for (term of visibleAudiences(); track term.id) {
                <li>
                  <label [class]="choiceCardClass">
                    <input
                      type="checkbox"
                      [class]="choiceInputClass"
                      [checked]="isChosen(term.id)"
                      [disabled]="!isChosen(term.id) && atCap()"
                      (change)="toggleAudience(term.id, $event)"
                    />
                    <span>{{ term.name }}</span>
                  </label>
                </li>
              }
              @if (noMatch()) {
                <li
                  class="px-3 py-2 text-sm text-(--text-secondary) sm:col-span-2"
                  data-testid="audience-no-match"
                  i18n="@@profileDetails.audiences.none"
                >
                  No audience matches that filter.
                </li>
              }
            </ul>
          }
        </fieldset>

        <div class="space-y-1.5">
          <label
            [for]="idPrefix() + '-firm'"
            [class]="labelClass"
            i18n="@@profileDetails.firm.label"
          >
            Firm name
          </label>
          <input
            [id]="idPrefix() + '-firm'"
            type="text"
            autocomplete="organization"
            [attr.maxlength]="maxFirm"
            [attr.aria-describedby]="idPrefix() + '-firm-hint'"
            [value]="draft().firm_name"
            (input)="onFirm($event)"
            [class]="inputClass"
          />
          <p [id]="idPrefix() + '-firm-hint'" [class]="hintClass" i18n="@@profileDetails.firm.hint">
            Private. It is never shown on your published reviews. We fill it in on each review form
            for you, and you can change or clear it there for any review.
          </p>
        </div>
      }

      <div class="space-y-1.5">
        <label
          [for]="idPrefix() + '-linkedin'"
          [class]="labelClass"
          i18n="@@profileDetails.linkedin.label"
        >
          LinkedIn profile
        </label>
        <input
          #linkedin
          [id]="idPrefix() + '-linkedin'"
          type="url"
          inputmode="url"
          autocomplete="url"
          placeholder="linkedin.com/in/your-name"
          [value]="draft().linkedin_url"
          (input)="onLinkedIn($event)"
          (blur)="linkedInTouched.set(true)"
          [attr.aria-invalid]="showLinkedInError() ? 'true' : null"
          [attr.aria-describedby]="
            idPrefix() +
            '-linkedin-hint' +
            (showLinkedInError() ? ' ' + idPrefix() + '-linkedin-error' : '')
          "
          [class]="inputClass"
        />
        <p
          [id]="idPrefix() + '-linkedin-hint'"
          [class]="hintClass"
          i18n="@@profileDetails.linkedin.hint"
        >
          Optional and private. Only our team sees it. It helps us confirm that reviews come from
          real people working in the industry.
        </p>
        @if (showLinkedInError()) {
          <p
            [id]="idPrefix() + '-linkedin-error'"
            [class]="errorClass"
            role="alert"
            i18n="@@profileDetails.linkedin.error"
          >
            Enter a LinkedIn profile link, like https://www.linkedin.com/in/your-name.
          </p>
        }
      </div>
    </div>
  `,
})
export class ProfileDetailsForm {
  private readonly api = inject(AccountApi);

  /** The answers. Two-way: the parent reads it at save time. */
  readonly draft = model.required<ProfileDetailsDraft>();
  /** Id stem, so two instances on one page never collide. */
  readonly idPrefix = input('profile-details');
  /** Text for the host's single polite live region. */
  readonly announce = output<string>();

  private readonly linkedInInput = viewChild<ElementRef<HTMLInputElement>>('linkedin');

  protected readonly maxAudiences = MAX_PROFILE_AUDIENCES;

  // The claim dialog's field recipe (`shared/form-field/form-field-classes.ts`).
  protected readonly labelClass = FIELD_LABEL_CLASS;
  protected readonly inputClass = FIELD_INPUT_CLASS;
  protected readonly hintClass = FIELD_HINT_CLASS;
  protected readonly errorClass = FIELD_ERROR_CLASS;
  /** A choice card. A term disabled at the cap greys out with the token
   *  pair `DESIGN.md` uses for disabled fields, never by opacity. */
  protected readonly choiceCardClass = `${CHOICE_CARD_CLASS} has-[:disabled]:cursor-not-allowed has-[:disabled]:bg-(--surface-sunken) has-[:disabled]:text-(--text-secondary)`;
  protected readonly choiceInputClass = CHOICE_INPUT_CLASS;
  protected readonly maxFirm = MAX_FIRM_NAME_LENGTH;

  protected readonly companyTypeOptions = computed(() =>
    choiceOptions(COMPANY_TYPE_OPTIONS, this.draft().company_type),
  );
  protected readonly companySizeOptions = computed(() =>
    choiceOptions(COMPANY_SIZE_OPTIONS, this.draft().company_size),
  );
  protected readonly roleOptions = computed(() =>
    choiceOptions(roleOptionsFor(this.draft().company_type), this.draft().primary_role),
  );

  /** `null` until the vocabulary loads. Sorted A to Z, case never deciding. */
  protected readonly audiences = signal<readonly LinkRef[] | null>(null);
  protected readonly audiencesFailed = signal(false);
  protected readonly filter = signal('');
  protected readonly linkedInTouched = signal(false);

  protected readonly vendor = computed(() => isVendorDraft(this.draft()));
  protected readonly atCap = computed(
    () => this.draft().audience_ids.length >= MAX_PROFILE_AUDIENCES,
  );
  protected readonly showLinkedInError = computed(
    () => this.linkedInTouched() && linkedInInvalid(this.draft()),
  );

  private readonly needle = computed(() => this.filter().trim().toLowerCase());

  /** The filtered list. A chosen term always stays visible, so a filter can
   *  never hide a pick the user may want to undo. */
  protected readonly visibleAudiences = computed(() => {
    const all = this.audiences() ?? [];
    const needle = this.needle();
    if (!needle) return all;
    const chosen = new Set(this.draft().audience_ids);
    return all.filter((t) => chosen.has(t.id) || t.name.toLowerCase().includes(needle));
  });

  /** True when the filter matches no UNCHOSEN term. Chosen terms stay listed
   *  under any filter, so an empty list is not the test. */
  protected readonly noMatch = computed(() => {
    const all = this.audiences() ?? [];
    const needle = this.needle();
    if (!needle) return all.length === 0;
    const chosen = new Set(this.draft().audience_ids);
    return !all.some((t) => !chosen.has(t.id) && t.name.toLowerCase().includes(needle));
  });

  constructor() {
    afterNextRender(() => void this.loadAudiences());
  }

  private async loadAudiences(): Promise<void> {
    try {
      const terms = await this.api.listAudiences();
      this.audiences.set([...terms].sort((a, b) => compareText(a.name, b.name)));
    } catch {
      this.audiencesFailed.set(true);
    }
  }

  /**
   * Show every error this form holds and focus the first bad field. The host
   * calls it when Save is pressed. Returns true when there was an error. Pass
   * `focus: false` when the host already focused an earlier bad field. Today
   * the only check here is the LinkedIn link.
   */
  revealErrors(options: { readonly focus?: boolean } = {}): boolean {
    this.linkedInTouched.set(true);
    if (!linkedInInvalid(this.draft())) return false;
    if (options.focus !== false) this.linkedInInput()?.nativeElement.focus();
    return true;
  }

  protected isChosen(id: string): boolean {
    return this.draft().audience_ids.includes(id);
  }

  protected setCompanyType(value: string | null): void {
    const wasVendor = this.vendor();
    // A role from the other group's list is not on the new list, so it goes
    // back to unanswered. "Other" and "I'd rather not say" are on both.
    this.draft.update((d) => {
      const companyType = value as CompanyType | null;
      return {
        ...d,
        company_type: companyType,
        primary_role: roleForCompanyType(d.primary_role, companyType),
      };
    });
    const isVendor = this.vendor();
    if (isVendor !== wasVendor) this.announce.emit(isVendor ? VENDOR_HIDDEN : VENDOR_SHOWN);
  }

  protected setRole(value: string | null): void {
    this.draft.update((d) => ({ ...d, primary_role: value as ProfilePrimaryRole | null }));
  }

  protected setSize(value: string | null): void {
    this.draft.update((d) => ({ ...d, company_size: value as CompanySize | null }));
  }

  protected toggleAudience(id: string, event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    this.draft.update((d) => {
      const rest = d.audience_ids.filter((a) => a !== id);
      if (!checked) return { ...d, audience_ids: rest };
      if (rest.length >= MAX_PROFILE_AUDIENCES) return d;
      return { ...d, audience_ids: [...rest, id] };
    });
    const count = this.draft().audience_ids.length;
    this.announce.emit(
      $localize`:@@profileDetails.audiences.countStatus:${count}:count: of ${MAX_PROFILE_AUDIENCES}:max: chosen.`,
    );
  }

  protected onFilter(event: Event): void {
    this.filter.set((event.target as HTMLInputElement).value);
  }

  protected onFirm(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.draft.update((d) => ({ ...d, firm_name: value }));
  }

  protected onLinkedIn(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.draft.update((d) => ({ ...d, linkedin_url: value }));
  }
}
