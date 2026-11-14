/**
 * AECI-1758 - `aecButton`, the one shared button. These specs pin the recipe each
 * variant renders, the states, the link form and the iconOnly name check.
 *
 * jsdom does not run Tailwind, so computed sizes and colours are checked in the
 * browser by `e2e/button.spec.ts`. The unlayered edge rules and the danger hover
 * token are pinned by `button-styles.guard.spec.ts`.
 */
import { Component, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BUTTON_PRIMARY_CLASS, BUTTON_SECONDARY_CLASS } from '../form-field/form-field-classes';
import { AecIcon } from '../icon/icon';
import { AecButton, type AecButtonVariant, buttonClass, hasAccessibleName } from './button';

@Component({
  selector: 'aec-button-host',
  imports: [AecButton, AecIcon],
  template: `
    <button
      aecButton
      type="button"
      class="w-full"
      [variant]="variant()"
      [compact]="compact()"
      [disabled]="disabled()"
      data-testid="btn"
    >
      Save
    </button>
    <a aecButton variant="secondary" href="/docs" data-testid="link">Read the docs</a>
    @if (showIconOnly()) {
      <button
        aecButton
        variant="ghost"
        iconOnly
        type="button"
        data-testid="icon"
        [attr.aria-label]="iconLabel()"
      >
        <aec-icon name="search" decorative />
      </button>
    }
  `,
})
class Host {
  readonly variant = signal<AecButtonVariant>('primary');
  readonly compact = signal(false);
  readonly disabled = signal(false);
  readonly showIconOnly = signal(false);
  readonly iconLabel = signal<string | null>('Search');
}

const VARIANT_FILL: Record<AecButtonVariant, string[]> = {
  primary: ['bg-(--accent-primary)', 'text-(--surface-base)', 'hover:bg-(--accent-primary-hover)'],
  'on-brand': [
    'bg-(--accent-warm)',
    'text-(--accent-primary)',
    'hover:bg-(--surface-on-brand-hover)',
    'focus-visible:outline-(--focus-ring-on-brand)',
  ],
  secondary: ['aec-btn-secondary', 'bg-(--surface-raised)', 'hover:bg-(--surface-sunken)'],
  ghost: ['bg-transparent', 'text-(--text-primary)', 'hover:text-(--accent-primary)'],
  danger: ['bg-(--status-error)', 'text-(--surface-base)', 'hover:bg-(--status-error-hover)'],
};

const VARIANTS = Object.keys(VARIANT_FILL) as AecButtonVariant[];

const SHARED = [
  'aec-btn',
  'min-h-11',
  'rounded-control',
  'border',
  'text-t-14',
  'font-semibold',
  'focus-visible:outline-3',
  'focus-visible:outline-offset-3',
  'motion-safe:active:translate-y-px',
  'motion-safe:active:scale-98',
  'disabled:opacity-60',
  'aria-disabled:opacity-60',
];

describe('aecButton (AECI-1758)', () => {
  let fixture: ComponentFixture<Host>;
  let host: Host;
  const el = (id: string) =>
    fixture.nativeElement.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Host],
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();
    fixture = TestBed.createComponent(Host);
    host = fixture.componentInstance;
    await fixture.whenStable();
  });

  afterEach(() => vi.restoreAllMocks());

  for (const variant of VARIANTS) {
    it(`renders the ${variant} variant with the shared frame and its own fill`, async () => {
      host.variant.set(variant);
      await fixture.whenStable();
      const btn = el('btn')!;
      for (const cls of [...SHARED, ...VARIANT_FILL[variant]]) {
        expect(btn.classList.contains(cls), `${variant} missing ${cls}`).toBe(true);
      }
      expect(btn.getAttribute('data-variant')).toBe(variant);
      // The fill of every other variant stays out.
      for (const other of VARIANTS) {
        const own = VARIANT_FILL[other][0];
        if (other === variant || VARIANT_FILL[variant].includes(own)) continue;
        expect(btn.classList.contains(own), `${variant} carries ${other}'s ${own}`).toBe(false);
      }
    });
  }

  it('never draws a pill, a shadow, a fixed height or a Clay fill on any variant', () => {
    for (const variant of VARIANTS) {
      for (const cls of [buttonClass(variant), buttonClass(variant, { iconOnly: true })]) {
        expect(cls).not.toMatch(/rounded-(full|pill)\b/);
        expect(cls).not.toMatch(/\bshadow-/);
        expect(cls).not.toMatch(/accent-secondary/);
        expect(cls).not.toMatch(/(^|\s)h-\d/);
      }
    }
  });

  it('keeps the caller’s layout classes beside the recipe', () => {
    const btn = el('btn')!;
    expect(btn.classList.contains('w-full')).toBe(true);
    expect(btn.classList.contains('min-h-11')).toBe(true);
  });

  it('gives ghost the compact padding without the flag', async () => {
    host.variant.set('ghost');
    await fixture.whenStable();
    expect(el('btn')!.classList.contains('px-4')).toBe(true);
    expect(el('btn')!.classList.contains('px-6')).toBe(false);
  });

  it('uses 24px side padding by default and 16px when compact, at the same height', async () => {
    expect(el('btn')!.classList.contains('px-6')).toBe(true);
    host.compact.set(true);
    await fixture.whenStable();
    const btn = el('btn')!;
    expect(btn.classList.contains('px-4')).toBe(true);
    expect(btn.classList.contains('px-6')).toBe(false);
    expect(btn.classList.contains('min-h-11')).toBe(true);
  });

  it('disables a native button: the attribute is set and a click does not fire', async () => {
    const onClick = vi.fn();
    el('btn')!.addEventListener('click', onClick);
    host.disabled.set(true);
    await fixture.whenStable();
    const btn = el('btn') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    btn.click();
    expect(onClick).not.toHaveBeenCalled();
  });

  it('styles a link as a button and keeps it a link', () => {
    const link = el('link') as HTMLAnchorElement;
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe('/docs');
    expect(link.getAttribute('role')).toBeNull();
    expect(link.classList.contains('aec-btn-secondary')).toBe(true);
    expect(link.classList.contains('no-underline')).toBe(true);
  });

  it('draws an iconOnly button as a 44px square', async () => {
    host.showIconOnly.set(true);
    await fixture.whenStable();
    const btn = el('icon')!;
    expect(btn.classList.contains('size-11')).toBe(true);
    expect(btn.classList.contains('px-6')).toBe(false);
  });

  it('logs an error in dev mode when an iconOnly button has no accessible name', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    host.iconLabel.set(null);
    host.showIconOnly.set(true);
    await fixture.whenStable();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('iconOnly button needs'),
      el('icon'),
    );
  });

  it('stays quiet when the iconOnly button has a name', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    host.showIconOnly.set(true);
    await fixture.whenStable();
    expect(error).not.toHaveBeenCalled();
  });

  it('counts a decorative icon as no name, and visible or hidden text as a name', () => {
    const b = document.createElement('button');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('aria-hidden', 'true');
    b.appendChild(svg);
    expect(hasAccessibleName(b)).toBe(false);
    const hidden = document.createElement('span');
    hidden.className = 'sr-only';
    hidden.textContent = 'Close';
    b.appendChild(hidden);
    expect(hasAccessibleName(b)).toBe(true);
    const c = document.createElement('button');
    c.setAttribute('aria-labelledby', 'x');
    expect(hasAccessibleName(c)).toBe(true);
  });

  it('is what the two shared form-field constants render', () => {
    expect(BUTTON_PRIMARY_CLASS).toBe(buttonClass('primary'));
    expect(BUTTON_SECONDARY_CLASS).toBe(buttonClass('secondary'));
  });
});
