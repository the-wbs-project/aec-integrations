/**
 * VendorAccountBadge render tests (AECI-965, AECI-1131). Named `.component.spec.ts`
 * so the Angular TestBed lane executes them.
 */
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it } from 'vitest';

import { VendorAccountBadge } from './vendor-account-badge';

function render(active: boolean, variant: 'public' | 'portal' = 'public'): HTMLElement {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection(), provideRouter([])],
  });
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

  it('says "Active on AECi" publicly, with no trust glyph or verification claim', () => {
    const el = render(true, 'public');
    expect(el.textContent).toContain('Active on AECi');
    expect(el.textContent).not.toMatch(/verified/i);
    expect(el.querySelector('svg')).toBeNull();
  });

  it('explains the label with a visible link, not a hover-only tooltip', () => {
    const el = render(true, 'public');
    expect(el.querySelector('[title]')).toBeNull();

    const link = el.querySelector('a');
    expect(link?.getAttribute('href')).toBe('/docs/vendors/plans-and-the-account-label');
    expect(link?.textContent).toContain('What this means');
  });

  it('shows the vendor the same label in the portal, without the explainer link', () => {
    const el = render(true, 'portal');
    expect(el.textContent?.trim()).toBe('Active on AECi');
    expect(el.querySelector('a')).toBeNull();
  });
});
