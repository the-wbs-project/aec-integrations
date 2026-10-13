/**
 * AECI-1296 — `ProfileDetailsForm`, the shared "About you" questions. Runs under
 * `ng test` (TestBed). Pins the vendor branch, the audience cap, the LinkedIn
 * check and the draft model the two hosting pages save from.
 */
import { Component, provideZonelessChangeDetection, signal, viewChild } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it, vi } from 'vitest';

import type { LinkRef } from '@aeci/shared';

import { AccountApi } from '../account-api';
import { ProfileDetailsForm } from './profile-details-form';
import {
  COMPANY_SIZE_OPTIONS,
  COMPANY_TYPE_OPTIONS,
  EMPTY_DRAFT,
  PRIMARY_ROLE_OPTIONS,
  draftFromDetails,
  draftToPatch,
  labelFor,
  linkedInInvalid,
  type ProfileDetailsDraft,
} from './profile-details-model';

const AUDIENCES: LinkRef[] = Array.from({ length: 12 }, (_, i) => ({
  id: `00000000-0000-4000-8000-${String(100 + i).padStart(12, '0')}`,
  name: i === 0 ? 'estimator' : `Audience ${String.fromCharCode(66 + i)}`,
  slug: `a-${i}`,
}));

@Component({
  imports: [ProfileDetailsForm],
  template: `<aec-profile-details-form
    idPrefix="t"
    [(draft)]="draft"
    (announce)="said.push($event)"
  />`,
})
class Host {
  readonly draft = signal<ProfileDetailsDraft>(EMPTY_DRAFT);
  readonly said: string[] = [];
  readonly form = viewChild.required(ProfileDetailsForm);
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

async function setup(draft: ProfileDetailsDraft = EMPTY_DRAFT, fail = false) {
  const api = {
    listAudiences: vi.fn(async () => {
      if (fail) throw new Error('offline');
      return AUDIENCES;
    }),
  };
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: AccountApi, useValue: api },
    ],
  });
  const fixture = TestBed.createComponent(Host);
  fixture.componentInstance.draft.set(draft);
  fixture.detectChanges();
  await fixture.whenStable();
  await settle();
  fixture.detectChanges();
  return {
    fixture,
    api,
    el: fixture.nativeElement as HTMLElement,
    host: fixture.componentInstance,
  };
}

const checkboxes = (el: HTMLElement) =>
  Array.from(
    el.querySelectorAll<HTMLInputElement>('[data-testid="audiences"] input[type="checkbox"]'),
  );

describe('ProfileDetailsForm', () => {
  it('asks every question for a non-vendor, audiences A to Z', async () => {
    const { el } = await setup();
    expect(el.querySelector('#t-company-type-trigger')).not.toBeNull();
    expect(el.querySelector('#t-role-trigger')).not.toBeNull();
    expect(el.querySelector('#t-company-size-trigger')).not.toBeNull();
    expect(el.querySelector('#t-firm')).not.toBeNull();
    expect(el.querySelector('#t-linkedin')).not.toBeNull();
    const names = Array.from(el.querySelectorAll('[data-testid="audiences"] label span')).map((n) =>
      n.textContent?.trim(),
    );
    expect(names[0]).toBe('Audience C');
    // Case never decides the order: lowercase "estimator" sorts among the Es.
    expect(names.indexOf('estimator')).toBeGreaterThan(names.indexOf('Audience M'));
  });

  it('hides size, audiences and firm for a software vendor, with nothing in their place', async () => {
    const { el } = await setup({ ...EMPTY_DRAFT, company_type: 'software_vendor' });
    expect(el.querySelector('#t-company-size-trigger')).toBeNull();
    expect(el.querySelector('[data-testid="audiences"]')).toBeNull();
    expect(el.querySelector('#t-firm')).toBeNull();
    // Role and LinkedIn are asked of everyone.
    expect(el.querySelector('#t-role-trigger')).not.toBeNull();
    expect(el.querySelector('#t-linkedin')).not.toBeNull();
    // The claim note and link are gone (Chris, 2026-10-13).
    expect(el.querySelector('a')).toBeNull();
    expect(el.textContent).not.toContain('Claim your listing');
  });

  it('shows the placeholder, never a selected row, for an unanswered choice', async () => {
    const { el } = await setup();
    for (const id of ['#t-company-type-trigger', '#t-role-trigger', '#t-company-size-trigger']) {
      const trigger = el.querySelector<HTMLElement>(id)!;
      expect(trigger.textContent?.trim(), id).toBe('Choose one');
      expect(trigger.textContent, id).not.toContain('rather not say');
    }
  });

  it('shows "I\'d rather not say" as a stored answer', async () => {
    const { el } = await setup({
      ...EMPTY_DRAFT,
      company_type: 'undisclosed',
      company_size: 'undisclosed',
      primary_role: 'undisclosed',
    });
    for (const id of ['#t-company-type-trigger', '#t-role-trigger', '#t-company-size-trigger']) {
      expect(el.querySelector<HTMLElement>(id)!.textContent?.trim(), id).toBe("I'd rather not say");
    }
  });

  it('offers "Clear answer" only once there is an answer, and it returns to unanswered', async () => {
    const { fixture, el, host } = await setup({ ...EMPTY_DRAFT, company_type: 'architect' });
    type Internals = {
      companyTypeOptions(): { value: string | null; label: string }[];
      setCompanyType(v: string | null): void;
    };
    const form = host.form() as unknown as Internals;
    expect(form.companyTypeOptions()[0]).toEqual({ value: null, label: 'Clear answer' });
    form.setCompanyType(null);
    fixture.detectChanges();
    expect(host.draft().company_type).toBeNull();
    expect(form.companyTypeOptions().some((o) => o.value === null)).toBe(false);
    expect(el.querySelector('#t-company-type-trigger')!.textContent?.trim()).toBe('Choose one');
  });

  it('announces the vendor branch removing and restoring fields', async () => {
    const { fixture, host } = await setup();
    const form = host.form() as unknown as { setCompanyType(v: string | null): void };
    form.setCompanyType('software_vendor');
    form.setCompanyType('architect');
    form.setCompanyType('engineer');
    fixture.detectChanges();
    expect(host.said).toEqual([
      'Company size, audiences and firm name were removed from the form.',
      'Company size, audiences and firm name were added back to the form.',
    ]);
  });

  it('writes typed answers and audience picks into the draft, capped at ten', async () => {
    const { fixture, el, host } = await setup();
    const firm = el.querySelector<HTMLInputElement>('#t-firm')!;
    firm.value = 'Turner Build';
    firm.dispatchEvent(new Event('input'));

    const boxes = checkboxes(el);
    for (const box of boxes.slice(0, 10)) box.click();
    fixture.detectChanges();
    expect(host.draft().firm_name).toBe('Turner Build');
    expect(host.draft().audience_ids).toHaveLength(10);
    // At the cap every unchosen box is disabled, and a chosen one is not.
    const after = checkboxes(el);
    expect(after[10]!.disabled).toBe(true);
    expect(after[0]!.disabled).toBe(false);

    after[0]!.click();
    fixture.detectChanges();
    expect(host.draft().audience_ids).toHaveLength(9);
    // Each pick and un-pick is announced as the new count.
    expect(host.said.at(0)).toBe('1 of 10 chosen.');
    expect(host.said.at(-1)).toBe('9 of 10 chosen.');
  });

  it('says no audience matches when no unchosen term matches, chosen ones still listed', async () => {
    const chosen = AUDIENCES[3]!.id;
    const { fixture, el } = await setup({ ...EMPTY_DRAFT, audience_ids: [chosen] });
    const filter = el.querySelector<HTMLInputElement>('#t-audience-filter')!;
    filter.value = 'zzz';
    filter.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(checkboxes(el)).toHaveLength(1);
    expect(el.querySelector('[data-testid="audience-no-match"]')).not.toBeNull();

    filter.value = 'estim';
    filter.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(el.querySelector('[data-testid="audience-no-match"]')).toBeNull();
  });

  it('marks the audience scroll box with the scroll cue class', async () => {
    const { el } = await setup();
    const list = el.querySelector('[data-testid="audience-list"]')!;
    expect(list.classList).toContain('aec-scroll-box');
    expect(list.classList).toContain('border-b');
  });

  it('filters the audience list but keeps chosen terms visible', async () => {
    const chosen = AUDIENCES[3]!.id;
    const { fixture, el } = await setup({ ...EMPTY_DRAFT, audience_ids: [chosen] });
    const filter = el.querySelector<HTMLInputElement>('#t-audience-filter')!;
    filter.value = 'estim';
    filter.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    const names = Array.from(el.querySelectorAll('[data-testid="audiences"] label span')).map((n) =>
      n.textContent?.trim(),
    );
    expect(names).toEqual([AUDIENCES[3]!.name, 'estimator']);
  });

  it('flags a non-profile LinkedIn link after blur', async () => {
    const { fixture, el } = await setup();
    const input = el.querySelector<HTMLInputElement>('#t-linkedin')!;
    input.value = 'https://example.com/me';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new Event('blur'));
    fixture.detectChanges();
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(el.querySelector('#t-linkedin-error')).not.toBeNull();
    // The error border comes from the unlayered `.aec-field-control` rule.
    expect(input.classList).toContain('aec-field-control');
    expect(input.getAttribute('placeholder')).toBe('linkedin.com/in/your-name');
  });

  it('revealErrors shows the LinkedIn error and focuses the field', async () => {
    const { fixture, el, host } = await setup({ ...EMPTY_DRAFT, linkedin_url: 'example.com/me' });
    expect(el.querySelector('#t-linkedin-error')).toBeNull();
    expect(host.form().revealErrors()).toBe(true);
    fixture.detectChanges();
    expect(el.querySelector('#t-linkedin-error')).not.toBeNull();
    expect(document.activeElement).toBe(el.querySelector('#t-linkedin'));
  });

  it('revealErrors reports nothing for a valid form', async () => {
    const { host } = await setup({ ...EMPTY_DRAFT, linkedin_url: 'linkedin.com/in/ada' });
    expect(host.form().revealErrors()).toBe(false);
  });

  it('still renders the other questions when the audience list fails to load', async () => {
    const { el } = await setup(EMPTY_DRAFT, true);
    expect(el.querySelector('[data-testid="audiences"] [role="alert"]')).not.toBeNull();
    expect(el.querySelector('#t-firm')).not.toBeNull();
  });
});

describe('profile-details-model', () => {
  it('clears the vendor-hidden answers when the company type is software vendor', () => {
    const patch = draftToPatch({
      company_type: 'software_vendor',
      company_size: '11-50',
      primary_role: 'exec',
      firm_name: 'Old Firm',
      linkedin_url: ' linkedin.com/in/ada ',
      audience_ids: ['x'],
    });
    expect(patch).toEqual({
      company_type: 'software_vendor',
      company_size: null,
      primary_role: 'exec',
      firm_name: null,
      linkedin_url: 'linkedin.com/in/ada',
      audience_ids: [],
    });
  });

  it('sends undisclosed as a stored answer, never as a clear', () => {
    const patch = draftToPatch({
      ...EMPTY_DRAFT,
      company_type: 'undisclosed',
      company_size: 'undisclosed',
      primary_role: 'undisclosed',
    });
    expect(patch).toMatchObject({
      company_type: 'undisclosed',
      company_size: 'undisclosed',
      primary_role: 'undisclosed',
    });
    expect(draftToPatch(EMPTY_DRAFT)).toMatchObject({
      company_type: null,
      company_size: null,
      primary_role: null,
    });
  });

  it('round-trips undisclosed from the account read', () => {
    const draft = draftFromDetails({
      company_type: 'undisclosed',
      company_size: null,
      primary_role: 'undisclosed',
      firm_name: null,
      linkedin_url: null,
      audience_ids: [],
    });
    expect(draft.company_type).toBe('undisclosed');
    expect(draft.primary_role).toBe('undisclosed');
  });

  it('lists "I\'d rather not say" last, after "Other", and labels it for admin', () => {
    for (const options of [COMPANY_TYPE_OPTIONS, COMPANY_SIZE_OPTIONS, PRIMARY_ROLE_OPTIONS]) {
      expect(options.at(-1)).toEqual({ value: 'undisclosed', label: "I'd rather not say" });
    }
    expect(COMPANY_TYPE_OPTIONS.at(-2)?.value).toBe('other');
    expect(PRIMARY_ROLE_OPTIONS.at(-2)?.value).toBe('other');
    expect(labelFor(COMPANY_TYPE_OPTIONS, 'undisclosed')).toBe("I'd rather not say");
  });

  it('treats an empty LinkedIn field as valid', () => {
    expect(linkedInInvalid(EMPTY_DRAFT)).toBe(false);
    expect(linkedInInvalid({ ...EMPTY_DRAFT, linkedin_url: 'linkedin.com/company/x' })).toBe(true);
  });
});
