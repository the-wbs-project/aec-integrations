/**
 * `aec-figure` tests (AECI-1767). Named `.component.spec.ts` so they run under `ng test`.
 */
import { Component, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AecFigure, type FigureTone, type FigureZeroMode } from './figure';

/** The words PLAN.md section 5.2 fixes. Pinned here so a copy edit fails a test. */
const HEADING = 'We have no integrations for Bluebeam Revu on record';
const CAVEAT = 'Not on record means we have not found one. It is not proof that none exists.';

@Component({
  imports: [AecFigure],
  template: `
    <aec-figure
      [value]="value()"
      [text]="text()"
      [suffix]="suffix()"
      [label]="label()"
      [tone]="tone()"
      [zero]="zero()"
      [product]="product()"
    >
      <a href="#know">Know of one?</a>
    </aec-figure>
  `,
})
class Host {
  readonly value = signal(12);
  readonly text = signal('12');
  readonly suffix = signal<string | null>(null);
  readonly label = signal('integrations');
  readonly tone = signal<FigureTone>('forest');
  readonly zero = signal<FigureZeroMode | null>(null);
  readonly product = signal<string | null>(null);
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
  let errors: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    TestBed.resetTestingModule();
    errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => errors.mockRestore());

  it('prints the caller text as given: "4.0" keeps its decimal, "12,345" keeps its separator', async () => {
    const { numeral, update } = setup();
    await update((h) => {
      h.value.set(4);
      h.text.set('4.0');
    });
    expect(numeral()!.textContent!.trim()).toBe('4.0');
    await update((h) => {
      h.value.set(12345);
      h.text.set('12,345');
    });
    expect(numeral()!.textContent!.trim()).toBe('12,345');
  });

  it('prints an optional suffix next to the number', async () => {
    const { root, update } = setup();
    expect(root.querySelector('.aec-figure-suffix')).toBeNull();
    await update((h) => {
      h.text.set('4.5');
      h.suffix.set('/5');
    });
    expect(root.querySelector('.aec-figure-suffix')!.textContent).toBe('/5');
  });

  it('sets the figure role: serif, Forest, the --t-fig size', () => {
    const cls = setup().numeral()!.className;
    expect(cls).toContain('font-display');
    expect(cls).toContain('font-semibold');
    expect(cls).toContain('text-t-fig');
    expect(cls).toContain('text-(--accent-primary)');
  });

  it('on-brand takes the Bone numeral and the secondary label', async () => {
    const { numeral, root, update } = setup();
    await update((h) => h.tone.set('on-brand'));
    expect(numeral()!.className).toContain('text-(--text-on-brand)');
    expect(root.querySelector('p')!.className).toContain('text-(--text-on-brand-secondary)');
  });

  it('a zero with the zero mode owns the legal heading and caveat, and hides the numeral', async () => {
    const { numeral, root, update } = setup();
    await update((h) => {
      h.value.set(0);
      h.text.set('0');
      h.zero.set('integrations-not-on-record');
      h.product.set('Bluebeam Revu');
    });
    const paras = [...root.querySelectorAll('p')].map((p) => p.textContent!.trim());
    expect(paras).toEqual([HEADING, CAVEAT]);
    expect(numeral()!.getAttribute('aria-hidden')).toBe('true');
    expect(root.querySelector('a')!.textContent).toContain('Know of one?');
    expect(errors).not.toHaveBeenCalled();
  });

  it('ignores a caller label at zero: the legal words are the only words', async () => {
    const { root, update } = setup();
    await update((h) => {
      h.value.set(0);
      h.text.set('0');
      h.label.set('Not found yet');
      h.zero.set('integrations-not-on-record');
      h.product.set('Bluebeam Revu');
    });
    expect(root.textContent).not.toContain('Not found yet');
  });

  it('a zero with no zero mode logs an error and renders the label with the caller text', async () => {
    const { numeral, root, update } = setup();
    await update((h) => {
      h.value.set(0);
      h.text.set('0');
    });
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('zero mode'));
    expect(numeral()!.textContent!.trim()).toBe('0');
    expect(numeral()!.getAttribute('aria-hidden')).toBeNull();
    expect(root.textContent).toContain('integrations');
  });

  it('a zero mode with no product logs an error and falls back to the label', async () => {
    const { root, update } = setup();
    await update((h) => {
      h.value.set(0);
      h.text.set('0');
      h.zero.set('integrations-not-on-record');
    });
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('product name'));
    expect(root.textContent).toContain('integrations');
  });

  it('the zero mode is ignored for a non-zero value', async () => {
    const { root, update } = setup();
    await update((h) => {
      h.zero.set('integrations-not-on-record');
      h.product.set('Bluebeam Revu');
    });
    expect(root.textContent).not.toContain(CAVEAT);
    expect(root.textContent).toContain('integrations');
  });
});
