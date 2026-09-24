/**
 * `VendorHealthPill`: `responded` renders no pill, because nothing waits on the
 * vendor. Every other state keeps its visible label.
 */
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { VendorHealthPill } from './vendor-health-pill';
import type { IntegrationHealth } from './vendor-integration-health';

beforeEach(() => {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
});

function render(health: IntegrationHealth): HTMLElement {
  const fixture = TestBed.createComponent(VendorHealthPill);
  fixture.componentRef.setInput('health', health);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('VendorHealthPill', () => {
  it('renders nothing once the vendor has responded', () => {
    const el = render('responded');
    expect(el.querySelector('span')).toBeNull();
    expect(el.textContent?.trim()).toBe('');
  });

  it('keeps the label for every other state', () => {
    expect(render('needs_you').textContent).toContain('Needs your input');
    expect(render('conflict').textContent).toContain('Conflict');
    expect(render('confirmed').textContent).toContain('Fully confirmed');
  });
});
