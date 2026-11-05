import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { CompanyFactsNote } from './company-facts-note';

function render(): HTMLElement {
  TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
  const fixture = TestBed.createComponent(CompanyFactsNote);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('CompanyFactsNote', () => {
  it('states the ruled attribution line', () => {
    const text = render().querySelector('p')!.textContent!.replace(/\s+/g, ' ');
    expect(text).toContain(
      'Company facts may include public sector information licensed under the Open Government Licence v3.0',
    );
  });

  it('links the licence to the National Archives page in a new tab', () => {
    const link = render().querySelector('a')!;
    expect(link.getAttribute('href')).toBe(
      'https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/',
    );
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer nofollow');
    expect(link.querySelector('aec-new-tab-icon')).not.toBeNull();
  });
});
