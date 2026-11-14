/**
 * `aec-figure` tests (AECI-1767). Named `.component.spec.ts` so they run under `ng test`.
 */
import { Component, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { AecFigure } from './figure';

const HEADING = 'We have no integrations for Revu on record';
const CAVEAT = 'Not on record means we have not found one. It is not proof that none exists.';

@Component({
  imports: [AecFigure],
  template: `
    <aec-figure [value]="value()" [label]="label()" [support]="support()">
      <a href="#know">Know of one?</a>
    </aec-figure>
  `,
})
class Host {
  readonly value = signal(12);
  readonly label = signal('integrations');
  readonly support = signal<string | null>(null);
}

function setup() {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
  const fixture = TestBed.createComponent(Host);
  fixture.detectChanges();
  const root = fixture.nativeElement as HTMLElement;
  return {
    root,
    numeral: () => root.querySelector<HTMLElement>('.aec-figure-value'),
    async update(fn: (h: Host) => void) {
      fn(fixture.componentInstance);
      fixture.detectChanges();
      await fixture.whenStable();
    },
  };
}

describe('AecFigure', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('prints the number and its label, and the numeral stays readable', () => {
    const { numeral, root } = setup();
    expect(numeral()!.textContent!.trim()).toBe('12');
    expect(numeral()!.getAttribute('aria-hidden')).toBeNull();
    expect(root.textContent).toContain('integrations');
  });

  it('sets the figure role: serif, Forest, the --t-fig size', () => {
    const cls = setup().numeral()!.className;
    expect(cls).toContain('font-display');
    expect(cls).toContain('font-semibold');
    expect(cls).toContain('text-t-fig');
    expect(cls).toContain('text-(--accent-primary)');
  });

  it('renders a zero with its honest text and hides the numeral from AT', async () => {
    const { numeral, root, update } = setup();
    await update((h) => {
      h.value.set(0);
      h.label.set(HEADING);
      h.support.set(CAVEAT);
    });
    expect(numeral()!.textContent!.trim()).toBe('0');
    expect(numeral()!.getAttribute('aria-hidden')).toBe('true');
    expect(root.textContent).toContain(HEADING);
    expect(root.textContent).toContain(CAVEAT);
    expect(root.querySelector('a')!.textContent).toContain('Know of one?');
  });

  it('never renders a bare zero without supporting text', async () => {
    const { numeral, root, update } = setup();
    await update((h) => {
      h.value.set(0);
      h.label.set(HEADING);
    });
    expect(numeral()).toBeNull();
    expect(root.textContent).not.toContain('0');
  });
});
