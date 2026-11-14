/**
 * `aec-meter` tests (AECI-1767). Named `.component.spec.ts` so they run under `ng test`.
 */
import { Component, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AecMeter, type MeterLayout, type MeterTone } from './meter';

@Component({
  imports: [AecMeter],
  template: `
    <h3 id="score-name">Product quality</h3>
    <aec-meter
      [value]="value()"
      [max]="max()"
      [text]="text()"
      [tone]="tone()"
      [label]="label()"
      [labelledBy]="labelledBy()"
      [decorative]="decorative()"
      [layout]="layout()"
    />
  `,
})
class Host {
  readonly value = signal(4.3);
  readonly max = signal(5);
  readonly text = signal<string | null>(null);
  readonly tone = signal<MeterTone>('forest');
  readonly label = signal('Product quality');
  readonly labelledBy = signal<string | null>(null);
  readonly decorative = signal(false);
  readonly layout = signal<MeterLayout>('inline');
}

function setup() {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
  const fixture = TestBed.createComponent(Host);
  fixture.detectChanges();
  const root = fixture.nativeElement as HTMLElement;
  return {
    meter: () => root.querySelector<HTMLElement>('aec-meter')!,
    fill: () => root.querySelector<HTMLElement>('.aec-meter-fill')!,
    async update(fn: (h: Host) => void) {
      fn(fixture.componentInstance);
      fixture.detectChanges();
      await fixture.whenStable();
    },
  };
}

/** Every text node under the meter that is not inside an `aria-hidden` subtree. */
function exposedText(el: HTMLElement): string {
  if (el.closest('[aria-hidden="true"]')) return '';
  const out: string[] = [];
  const walk = (n: Node) => {
    if (n.nodeType === Node.TEXT_NODE) {
      const t = n.textContent!.trim();
      if (t) out.push(t);
    } else if (!(n as HTMLElement).matches?.('[aria-hidden="true"]')) {
      n.childNodes.forEach(walk);
    }
  };
  walk(el);
  return out.join(' | ');
}

describe('AecMeter', () => {
  let errors: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    TestBed.resetTestingModule();
    errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => errors.mockRestore());

  it('uses the plain pattern: no meter role and no aria-value attributes', () => {
    const el = setup().meter();
    expect(el.getAttribute('role')).toBeNull();
    for (const a of ['aria-valuenow', 'aria-valuemin', 'aria-valuemax', 'aria-valuetext']) {
      expect(el.hasAttribute(a)).toBe(false);
    }
  });

  it('exposes the label and the number as text exactly once, and hides the bar', () => {
    const el = setup().meter();
    expect(exposedText(el)).toBe('Product quality | 4.3');
    expect(el.querySelector('.aec-meter-track')!.getAttribute('aria-hidden')).toBe('true');
  });

  it('sizes the fill to the share of the range', () => {
    expect(setup().fill().style.width).toBe('86%');
  });

  it('reads zero as an empty bar and a printed 0', async () => {
    const { fill, meter, update } = setup();
    await update((h) => h.value.set(0));
    expect(fill().style.width).toBe('0%');
    expect(exposedText(meter())).toContain('0');
  });

  it('reads the maximum as a full bar', async () => {
    const { fill, update } = setup();
    await update((h) => h.value.set(5));
    expect(fill().style.width).toBe('100%');
    expect(errors).not.toHaveBeenCalled();
  });

  it('clamps an out-of-range value, prints it as given and logs an error in dev mode', async () => {
    const { fill, meter, update } = setup();
    await update((h) => h.value.set(9));
    expect(fill().style.width).toBe('100%');
    expect(exposedText(meter())).toContain('9');
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('outside 0 to 5'));
  });

  it('prints the caller text', async () => {
    const { meter, update } = setup();
    await update((h) => {
      h.value.set(24);
      h.max.set(58);
      h.text.set('Showing 24 of 58');
    });
    expect(exposedText(meter())).toBe('Product quality | Showing 24 of 58');
  });

  it('a decorative meter is hidden from assistive tech whole', async () => {
    const { meter, update } = setup();
    await update((h) => h.decorative.set(true));
    expect(meter().getAttribute('aria-hidden')).toBe('true');
    expect(exposedText(meter())).toBe('');
    expect(meter().textContent).toContain('4.3');
    expect(errors).not.toHaveBeenCalled();
  });

  it('labelledBy renders no label of its own and becomes a group the heading names', async () => {
    const { meter, update } = setup();
    await update((h) => h.labelledBy.set('score-name'));
    expect(meter().getAttribute('role')).toBe('group');
    expect(meter().getAttribute('aria-labelledby')).toBe('score-name');
    expect(meter().textContent).not.toContain('Product quality');
    expect(exposedText(meter())).toBe('4.3');
  });

  it('the onboarding tone paints Clay deep and still has a visible name', async () => {
    const { meter, fill, update } = setup();
    await update((h) => h.tone.set('onboarding'));
    expect(fill().getAttribute('data-tone')).toBe('onboarding');
    expect(exposedText(meter())).toContain('Product quality');
  });

  it('logs an error for an unnamed meter, and for an unnamed onboarding meter', async () => {
    const { update } = setup();
    await update((h) => {
      h.label.set('');
      h.tone.set('onboarding');
    });
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('label or labelledBy'));
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('onboarding tone needs'));
  });

  it('the stacked layout puts the bar over its text, at most 260px wide', async () => {
    const { meter, update } = setup();
    await update((h) => h.layout.set('stacked'));
    expect(meter().className).toContain('flex-col');
    expect(meter().className).toContain('max-w-[260px]');
  });
});
