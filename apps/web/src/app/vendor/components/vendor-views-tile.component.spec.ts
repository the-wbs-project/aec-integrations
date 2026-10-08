/**
 * `VendorViewsTile` (AECI-983) — the placeholder Views tile. What is pinned is
 * that it says "Coming soon", shows no figure, no link and no period toggle.
 */
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { VendorViewsTile } from './vendor-views-tile';

beforeEach(() => {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
});

function create(): ComponentFixture<VendorViewsTile> {
  const fixture = TestBed.createComponent(VendorViewsTile);
  fixture.detectChanges();
  return fixture;
}

const el = (f: ComponentFixture<VendorViewsTile>) => f.nativeElement as HTMLElement;

describe('VendorViewsTile', () => {
  it('says "Coming soon" and hides the period toggle', () => {
    const el1 = el(create());
    expect(el1.querySelector('[data-views-sentence]')?.textContent?.trim()).toBe('Coming soon');
    expect(el1.querySelector('fieldset')).toBeNull();
    expect(el1.querySelector('button')).toBeNull();
  });

  it('shows no figure and no link while it is a placeholder', () => {
    const root = el(create());
    expect(root.querySelector('.text-5xl')).toBeNull();
    expect(root.querySelector('a')).toBeNull();
    expect(root.textContent).not.toMatch(/\d/);
  });
});
