/**
 * VerifiedBadge render tests (AECI-523). Named `.component.spec.ts` so it runs
 * under `ng test` (TestBed).
 */
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { VerifiedBadge } from './verified-badge';

function render(verified: boolean, variant: 'full' | 'compact' = 'full'): HTMLElement {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
  const fixture = TestBed.createComponent(VerifiedBadge);
  fixture.componentRef.setInput('verified', verified);
  fixture.componentRef.setInput('variant', variant);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('VerifiedBadge', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('renders nothing when the vendor is not verified', () => {
    const el = render(false);
    expect(el.querySelector('span')).toBeNull();
    expect(el.textContent?.trim()).toBe('');
  });

  it('renders the label pill with a non-overclaiming tooltip when verified (full)', () => {
    const el = render(true, 'full');
    expect(el.textContent).toContain('Verified vendor');

    const pill = el.querySelector('span[title]');
    expect(pill).not.toBeNull();
    // Tooltip must scope the claim to the account, never product quality.
    const title = pill?.getAttribute('title') ?? '';
    expect(title).toContain('vendor account');
    expect(title).toContain('Not a rating of product quality');

    // Visible label carries the accessible name in the full variant, so no
    // redundant aria-label is set.
    expect(pill?.getAttribute('aria-label')).toBeNull();
  });

  it('hides the decorative glyph from assistive tech', () => {
    const svg = render(true).querySelector('svg');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
  });

  it('is icon-only with an accessible name in the compact variant', () => {
    const el = render(true, 'compact');
    // No visible label text in compact.
    expect(el.textContent?.trim()).toBe('');
    // Accessible name comes from aria-label instead.
    const pill = el.querySelector('span[aria-label]');
    expect(pill?.getAttribute('aria-label')).toBe('Verified vendor');
    expect(el.querySelector('svg')).not.toBeNull();
  });
});
