/**
 * The page's tooltip (`STAGE_2_VENDOR_PORTAL_SPEC.md` §6.17.9, WCAG 1.4.13): a real
 * button, its text always in the DOM as `aria-describedby`, open on hover, focus
 * and click, Escape from anywhere, and a flag that activates.
 */
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { VendorTip } from './vendor-tip';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve));

beforeEach(() => {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
});
afterEach(() => document.querySelectorAll('.cdk-overlay-container').forEach((n) => n.remove()));

async function create(
  inputs: Partial<{ variant: 'info' | 'pill' | 'flag'; label: string; lines: string[] }>,
): Promise<ComponentFixture<VendorTip>> {
  const fixture = TestBed.createComponent(VendorTip);
  fixture.componentRef.setInput('label', inputs.label ?? 'About Name');
  fixture.componentRef.setInput('lines', inputs.lines ?? ['Line one.', 'Line two.']);
  if (inputs.variant) fixture.componentRef.setInput('variant', inputs.variant);
  fixture.detectChanges();
  await flush();
  fixture.detectChanges();
  return fixture;
}

const button = (f: ComponentFixture<VendorTip>) =>
  (f.nativeElement as HTMLElement).querySelector('button')!;
const panel = () => document.querySelector('[data-testid="vendor-tip-panel"]');

describe('VendorTip', () => {
  it('names an info trigger and describes it with every line', async () => {
    const fixture = await create({});
    const trigger = button(fixture);
    expect(trigger.getAttribute('aria-label')).toBe('About Name');
    const desc = document.getElementById(trigger.getAttribute('aria-describedby')!)!;
    expect(desc.textContent).toBe('Line one. Line two.');
  });

  it('opens on focus and on hover, and Escape closes it from anywhere', async () => {
    const fixture = await create({});
    button(fixture).dispatchEvent(new Event('focus'));
    fixture.detectChanges();
    await flush();
    expect(panel()).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    fixture.detectChanges();
    await flush();
    expect(panel()).toBeNull();
    button(fixture).dispatchEvent(new Event('mouseenter'));
    fixture.detectChanges();
    await flush();
    expect(panel()).not.toBeNull();
  });

  it('gives a pill its visible text as its name, not an aria-label', async () => {
    const fixture = await create({ variant: 'pill', label: 'Disputed' });
    expect(button(fixture).getAttribute('aria-label')).toBeNull();
    expect(button(fixture).textContent).toContain('Disputed');
  });

  it('activates a flag on click instead of toggling', async () => {
    const fixture = await create({ variant: 'flag', label: 'Open change request on Name' });
    let activated = 0;
    fixture.componentInstance.activate.subscribe(() => activated++);
    button(fixture).click();
    expect(activated).toBe(1);
    expect(button(fixture).getAttribute('aria-expanded')).toBeNull();
  });

  it('is at least 24 by 24 CSS pixels (WCAG 2.5.8)', async () => {
    const fixture = await create({});
    expect(button(fixture).className).toContain('h-6');
    expect(button(fixture).className).toContain('w-6');
  });
});
