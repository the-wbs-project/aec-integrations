/**
 * VendorAccountBadge render tests (AECI-965). Named `.component.spec.ts` so
 * the Angular TestBed lane executes them.
 */
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { VendorAccountBadge } from './vendor-account-badge';

function render(active: boolean, variant: 'full' | 'compact' = 'full'): HTMLElement {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
  const fixture = TestBed.createComponent(VendorAccountBadge);
  fixture.componentRef.setInput('active', active);
  fixture.componentRef.setInput('variant', variant);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('VendorAccountBadge', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('renders nothing when the vendor account is inactive', () => {
    const el = render(false);
    expect(el.querySelector('span')).toBeNull();
    expect(el.textContent?.trim()).toBe('');
  });

  it('describes an active account without a trust glyph or verification claim', () => {
    const el = render(true, 'full');
    expect(el.textContent?.trim()).toBe('Vendor account active');
    expect(el.querySelector('svg')).toBeNull();

    const label = el.querySelector('span[title]');
    const title = label?.getAttribute('title') ?? '';
    expect(title).toContain('active access');
    expect(title).toContain('does not verify product quality or integration accuracy');
    expect(title).toContain('does not affect ranking or placement');
    expect(label?.getAttribute('aria-label')).toBeNull();
  });

  it('keeps a short visible label in compact contexts', () => {
    const el = render(true, 'compact');
    expect(el.textContent?.trim()).toBe('Account active');
    expect(el.querySelector('svg')).toBeNull();
    expect(el.querySelector('[aria-label]')).toBeNull();
  });
});
