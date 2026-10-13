/**
 * AECI-1296 — `ProfileDetailsForm`, the shared "About you" questions. Runs under
 * `ng test` (TestBed). Pins the vendor branch, the audience cap, the LinkedIn
 * check and the draft model the two hosting pages save from.
 */
import { Component, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it, vi } from 'vitest';

import type { LinkRef } from '@aeci/shared';

import { AccountApi } from '../account-api';
import { ProfileDetailsForm } from './profile-details-form';
import {
  EMPTY_DRAFT,
  draftToPatch,
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
  template: `<aec-profile-details-form idPrefix="t" [(draft)]="draft" />`,
})
class Host {
  readonly draft = signal<ProfileDetailsDraft>(EMPTY_DRAFT);
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
    expect(el.querySelector('[data-testid="vendor-note"]')).toBeNull();
    const names = Array.from(el.querySelectorAll('[data-testid="audiences"] label span')).map((n) =>
      n.textContent?.trim(),
    );
    expect(names[0]).toBe('Audience C');
    // Case never decides the order: lowercase "estimator" sorts among the Es.
    expect(names.indexOf('estimator')).toBeGreaterThan(names.indexOf('Audience M'));
  });

  it('hides size, audiences and firm for a software vendor and links to the claim flow', async () => {
    const { el } = await setup({ ...EMPTY_DRAFT, company_type: 'software_vendor' });
    expect(el.querySelector('#t-company-size-trigger')).toBeNull();
    expect(el.querySelector('[data-testid="audiences"]')).toBeNull();
    expect(el.querySelector('#t-firm')).toBeNull();
    // Role and LinkedIn are asked of everyone.
    expect(el.querySelector('#t-role-trigger')).not.toBeNull();
    expect(el.querySelector('#t-linkedin')).not.toBeNull();
    const link = el.querySelector<HTMLAnchorElement>('[data-testid="vendor-note"] a');
    expect(link?.getAttribute('href')).toBe('/vendor-program');
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

  it('treats an empty LinkedIn field as valid', () => {
    expect(linkedInInvalid(EMPTY_DRAFT)).toBe(false);
    expect(linkedInInvalid({ ...EMPTY_DRAFT, linkedin_url: 'linkedin.com/company/x' })).toBe(true);
  });
});
