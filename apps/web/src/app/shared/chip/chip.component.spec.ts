/**
 * `aec-chip` render and behaviour tests (AECI-1763). Named `.component.spec.ts`
 * so it runs under `ng test` (TestBed).
 */
import { Component, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it } from 'vitest';

import { Chip } from './chip';

@Component({
  imports: [Chip],
  template: `
    <aec-chip id="static">Static</aec-chip>
    <aec-chip id="dense" density="dense">Dense</aec-chip>
    <aec-chip id="iconic" icon="link">With icon</aec-chip>
    <aec-chip id="link" [link]="['/categories', 'bim']" ariaLabel="BIM 4 products">BIM</aec-chip>
    <aec-chip id="filter" [selected]="on()" (activated)="toggle()">Filter</aec-chip>
    <aec-chip id="label" label tone="wash">Label</aec-chip>
  `,
})
class Host {
  readonly on = signal(false);
  toggle() {
    this.on.update((v) => !v);
  }
}

function setup() {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection(), provideRouter([])],
  });
  const fixture = TestBed.createComponent(Host);
  fixture.detectChanges();
  const root = fixture.nativeElement as HTMLElement;
  return {
    fixture,
    root,
    chip: (id: string) => root.querySelector<HTMLElement>(`#${id} .aec-chip`)!,
  };
}

describe('Chip', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('renders a static chip as a span with no focus stop and no control role', () => {
    const { chip } = setup();
    const el = chip('static');
    expect(el.tagName).toBe('SPAN');
    expect(el.getAttribute('tabindex')).toBeNull();
    expect(el.getAttribute('role')).toBeNull();
    expect(el.getAttribute('aria-pressed')).toBeNull();
  });

  it('sets density, icon and face as data attributes the recipe keys off', () => {
    const { chip } = setup();
    expect(chip('dense').getAttribute('data-density')).toBe('dense');
    expect(chip('static').getAttribute('data-density')).toBe('default');
    expect(chip('iconic').hasAttribute('data-icon')).toBe(true);
    expect(chip('iconic').querySelector('svg')).not.toBeNull();
    expect(chip('static').hasAttribute('data-icon')).toBe(false);
    expect(chip('label').getAttribute('data-face')).toBe('label');
  });

  it('renders a link chip as an anchor with its accessible name', () => {
    const { chip } = setup();
    const el = chip('link');
    expect(el.tagName).toBe('A');
    expect(el.getAttribute('href')).toBe('/categories/bim');
    expect(el.getAttribute('aria-label')).toBe('BIM 4 products');
  });

  it('renders a filter chip as a button that toggles aria-pressed and shows a tick', () => {
    const { fixture, chip } = setup();
    const el = chip('filter');
    expect(el.tagName).toBe('BUTTON');
    expect(el.getAttribute('type')).toBe('button');
    expect(el.getAttribute('aria-pressed')).toBe('false');
    expect(el.querySelector('svg')).toBeNull();
    expect(el.hasAttribute('data-tone')).toBe(false);

    el.click();
    fixture.detectChanges();
    const on = chip('filter');
    expect(on.getAttribute('aria-pressed')).toBe('true');
    // Selection is never colour alone: the wash tone AND a tick.
    expect(on.getAttribute('data-tone')).toBe('wash');
    expect(on.querySelector('svg')).not.toBeNull();
  });
});

const CONSOLE_TONES = [
  'count',
  'neutral',
  'waiting',
  'positive',
  'quiet',
  'attention',
  'critical',
] as const;

@Component({
  imports: [Chip],
  template: `
    @for (tone of tones; track tone) {
      <aec-chip [id]="tone" density="dense" [tone]="tone">{{ tone }}</aec-chip>
    }
  `,
})
class ToneHost {
  readonly tones = CONSOLE_TONES;
}

describe('Chip: the console tones (AECI-1813)', () => {
  it('renders each of the seven tones as a static span the recipe keys off', () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    const fixture = TestBed.createComponent(ToneHost);
    document.body.appendChild(fixture.nativeElement);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    for (const tone of CONSOLE_TONES) {
      const el = root.querySelector<HTMLElement>(`#${tone} .aec-chip`)!;
      expect(el.tagName).toBe('SPAN');
      expect(el.getAttribute('data-tone')).toBe(tone);
      // Words carry the state: the label is the chip's text, never colour alone.
      expect(el.textContent?.trim()).toBe(tone);
    }
    fixture.nativeElement.remove();
  });
});

@Component({
  imports: [Chip],
  template: `
    <div role="group" aria-label="Types of data" id="group">
      <aec-chip id="zero" [selected]="on()" [disabled]="!on()" (activated)="on.set(!on())"
        >Models 0</aec-chip
      >
      <aec-chip id="other" [selected]="false">Drawings 4</aec-chip>
    </div>
  `,
})
class ZeroHost {
  readonly on = signal(true);
}

describe('Chip: releasing a chip that becomes disabled (AECI-1783)', () => {
  it('moves focus to its chip group instead of dropping it to the body', async () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    const fixture = TestBed.createComponent(ZeroHost);
    document.body.appendChild(fixture.nativeElement);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const button = root.querySelector<HTMLButtonElement>('#zero button')!;
    const group = root.querySelector<HTMLElement>('#group')!;
    expect(group.getAttribute('tabindex')).toBeNull();
    button.focus();
    button.click();
    await fixture.whenStable();
    expect(button.disabled).toBe(true);
    expect(document.activeElement).toBe(group);
    expect(group.getAttribute('tabindex')).toBe('-1');
    fixture.nativeElement.remove();
  });

  it('leaves focus alone when the released chip stays enabled', async () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), provideRouter([])],
    });
    const fixture = TestBed.createComponent(Host);
    document.body.appendChild(fixture.nativeElement);
    fixture.detectChanges();
    const button = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(
      '#filter button',
    )!;
    button.focus();
    button.click();
    await fixture.whenStable();
    expect(document.activeElement).toBe(button);
    fixture.nativeElement.remove();
  });
});
