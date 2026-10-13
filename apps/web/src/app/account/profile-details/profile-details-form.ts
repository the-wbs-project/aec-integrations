import { Component, afterNextRender, computed, inject, input, model, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import {
  MAX_FIRM_NAME_LENGTH,
  MAX_PROFILE_AUDIENCES,
  type CompanySize,
  type CompanyType,
  type LinkRef,
  type PrimaryRole,
} from '@aeci/shared';
import { compareText } from '@aeci/shared/text-sort';

import { AecSelect, type AecSelectOption } from '../../shared/aec-select/aec-select';
import { AccountApi } from '../account-api';
import {
  COMPANY_SIZE_OPTIONS,
  COMPANY_TYPE_OPTIONS,
  PRIMARY_ROLE_OPTIONS,
  isVendorDraft,
  linkedInInvalid,
  type Labelled,
  type ProfileDetailsDraft,
} from './profile-details-model';

/** The "no answer" row every single-choice question carries, so an answer can
 *  be taken back and not only changed. */
function withNoAnswer(options: ReadonlyArray<Labelled<string>>): AecSelectOption[] {
  return [
    { value: null, label: $localize`:@@profileDetails.noAnswer:Prefer not to say` },
    ...options,
  ];
}

/**
 * The "About you" questions 2 to 7 (AECI-1296, `docs/ACCOUNT_ONBOARDING_SPEC.md`):
 * where you work, your role, company size, audiences, firm name and LinkedIn.
 * Display name is NOT here: `/welcome` and `/account` each own that field.
 *
 * Presentational over a two-way `draft` model. The parent owns saving, so the
 * same questions serve the first-sign-in page and the account page. Picking
 * "Software vendor" hides size, audiences and firm, and shows the way into the
 * vendor claim flow on `/vendor-program`. Role and LinkedIn stay for everyone.
 *
 * The audience vocabulary loads after hydration (`GET /api/audiences`). Both
 * hosting pages are `no-store` and render answers in the browser only, so no
 * personal data reaches a cached render.
 *
 * Single choices use the shared `AecSelect` (Angular Aria combobox, ADR 0010).
 * Audiences are a filterable checkbox list in a `fieldset`: 36 terms is too many
 * for a listbox popup and native checkboxes give the multi-select semantics free.
 */
@Component({
  selector: 'aec-profile-details-form',
  imports: [AecSelect, RouterLink],
  template: `
    <div class="space-y-6">
      <aec-select
        layout="stacked"
        [idPrefix]="idPrefix() + '-company-type'"
        i18n-label="@@profileDetails.companyType.label"
        label="Where do you work?"
        i18n-placeholder="@@profileDetails.choose"
        placeholder="Choose one"
        [options]="companyTypeOptions"
        [value]="draft().company_type"
        (changed)="setCompanyType($event)"
      />

      @if (vendor()) {
        <p
          class="rounded-(--radius-md) border border-(--border-default) bg-(--surface-base) p-4 text-sm leading-relaxed text-(--text-secondary)"
          data-testid="vendor-note"
        >
          <span i18n="@@profileDetails.vendor.note"
            >Work for a software company? Claim your listing to manage how your products
            appear.</span
          >
          {{ ' ' }}
          <a
            routerLink="/vendor-program"
            class="font-medium text-(--text-primary) underline underline-offset-2 hover:text-(--accent-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
            i18n="@@profileDetails.vendor.link"
            >Claim your listing</a
          >
        </p>
      }

      <aec-select
        layout="stacked"
        [idPrefix]="idPrefix() + '-role'"
        i18n-label="@@profileDetails.role.label"
        label="Your role"
        i18n-placeholder="@@profileDetails.choose"
        placeholder="Choose one"
        [options]="roleOptions"
        [value]="draft().primary_role"
        (changed)="setRole($event)"
      />

      @if (!vendor()) {
        <aec-select
          layout="stacked"
          [idPrefix]="idPrefix() + '-company-size'"
          i18n-label="@@profileDetails.companySize.label"
          label="Company size"
          i18n-placeholder="@@profileDetails.choose"
          placeholder="Choose one"
          [options]="companySizeOptions"
          [value]="draft().company_size"
          (changed)="setSize($event)"
        />

        <fieldset class="space-y-2" data-testid="audiences">
          <legend
            class="block text-xs font-bold tracking-[0.08em] text-(--text-secondary) uppercase"
            i18n="@@profileDetails.audiences.label"
          >
            Which audiences describe you?
          </legend>
          <p [id]="idPrefix() + '-audiences-hint'" class="text-xs text-(--text-secondary)">
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
              class="text-sm text-(--text-primary)"
              role="alert"
              i18n="@@profileDetails.audiences.failed"
            >
              We couldn't load the audience list. You can still save your other answers.
            </p>
          } @else if (audiences() === null) {
            <p class="text-sm text-(--text-secondary)" i18n="@@profileDetails.audiences.loading">
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
              class="w-full rounded-(--radius-md) border border-(--border-default) bg-(--surface-base) px-3 py-2 text-sm text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
            />
            <ul
              class="grid max-h-72 grid-cols-1 gap-x-4 overflow-y-auto rounded-(--radius-md) border border-(--border-default) bg-(--surface-base) p-2 sm:grid-cols-2"
              [attr.aria-describedby]="idPrefix() + '-audiences-hint'"
            >
              @for (term of visibleAudiences(); track term.id) {
                <li>
                  <label
                    class="flex cursor-pointer items-center gap-2.5 rounded-(--radius-sm) px-2 py-1.5 text-sm text-(--text-primary) hover:bg-(--surface-sunken)"
                  >
                    <input
                      type="checkbox"
                      class="h-4 w-4 shrink-0 accent-(--accent-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                      [checked]="isChosen(term.id)"
                      [disabled]="!isChosen(term.id) && atCap()"
                      (change)="toggleAudience(term.id, $event)"
                    />
                    <span>{{ term.name }}</span>
                  </label>
                </li>
              } @empty {
                <li
                  class="px-2 py-1.5 text-sm text-(--text-secondary)"
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
            class="block text-xs font-bold tracking-[0.08em] text-(--text-secondary) uppercase"
            i18n="@@profileDetails.firm.label"
          >
            Firm name
          </label>
          <p
            [id]="idPrefix() + '-firm-hint'"
            class="text-xs text-(--text-secondary)"
            i18n="@@profileDetails.firm.hint"
          >
            Private. We use it to fill in your reviews, and you can change it there.
          </p>
          <input
            [id]="idPrefix() + '-firm'"
            type="text"
            autocomplete="organization"
            [attr.maxlength]="maxFirm"
            [attr.aria-describedby]="idPrefix() + '-firm-hint'"
            [value]="draft().firm_name"
            (input)="onFirm($event)"
            class="w-full rounded-(--radius-md) border border-(--border-default) bg-(--surface-base) px-3 py-2 text-sm text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
          />
        </div>
      }

      <div class="space-y-1.5">
        <label
          [for]="idPrefix() + '-linkedin'"
          class="block text-xs font-bold tracking-[0.08em] text-(--text-secondary) uppercase"
          i18n="@@profileDetails.linkedin.label"
        >
          LinkedIn profile
        </label>
        <p
          [id]="idPrefix() + '-linkedin-hint'"
          class="text-xs text-(--text-secondary)"
          i18n="@@profileDetails.linkedin.hint"
        >
          Optional and private. Only our team sees it.
        </p>
        <input
          [id]="idPrefix() + '-linkedin'"
          type="url"
          inputmode="url"
          autocomplete="url"
          placeholder="https://www.linkedin.com/in/…"
          [value]="draft().linkedin_url"
          (input)="onLinkedIn($event)"
          (blur)="linkedInTouched.set(true)"
          [attr.aria-invalid]="showLinkedInError() ? 'true' : null"
          [attr.aria-describedby]="
            idPrefix() +
            '-linkedin-hint' +
            (showLinkedInError() ? ' ' + idPrefix() + '-linkedin-error' : '')
          "
          class="w-full rounded-(--radius-md) border border-(--border-default) bg-(--surface-base) px-3 py-2 text-sm text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
        />
        @if (showLinkedInError()) {
          <p
            [id]="idPrefix() + '-linkedin-error'"
            class="text-xs font-medium text-(--text-primary)"
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

  protected readonly maxAudiences = MAX_PROFILE_AUDIENCES;
  protected readonly maxFirm = MAX_FIRM_NAME_LENGTH;

  protected readonly companyTypeOptions = withNoAnswer(COMPANY_TYPE_OPTIONS);
  protected readonly companySizeOptions = withNoAnswer(COMPANY_SIZE_OPTIONS);
  protected readonly roleOptions = withNoAnswer(PRIMARY_ROLE_OPTIONS);

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

  /** The filtered list. A chosen term always stays visible, so a filter can
   *  never hide a pick the user may want to undo. */
  protected readonly visibleAudiences = computed(() => {
    const all = this.audiences() ?? [];
    const needle = this.filter().trim().toLowerCase();
    if (!needle) return all;
    const chosen = new Set(this.draft().audience_ids);
    return all.filter((t) => chosen.has(t.id) || t.name.toLowerCase().includes(needle));
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

  protected isChosen(id: string): boolean {
    return this.draft().audience_ids.includes(id);
  }

  protected setCompanyType(value: string | null): void {
    this.draft.update((d) => ({ ...d, company_type: value as CompanyType | null }));
  }

  protected setRole(value: string | null): void {
    this.draft.update((d) => ({ ...d, primary_role: value as PrimaryRole | null }));
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
