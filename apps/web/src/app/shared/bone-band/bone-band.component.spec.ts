/**
 * AECI-1766 - `aec-bone-band`. Pins the ground, the wrap, the rhythm, the
 * `first` variant and the dev-mode "one per page" check. jsdom runs no Tailwind,
 * so computed colours are measured by `e2e/hero-band.spec.ts` on the specimen.
 */
import { Component, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BoneBand } from './bone-band';

@Component({
  selector: 'aec-bone-band-host',
  imports: [BoneBand],
  template: `
    <aec-bone-band [first]="first()" data-testid="one">
      <h2 data-testid="content">Heading</h2>
    </aec-bone-band>
    @if (second()) {
      <aec-bone-band data-testid="two">Second</aec-bone-band>
    }
  `,
})
class Host {
  readonly first = signal(false);
  readonly second = signal(false);
}

describe('aec-bone-band (AECI-1766)', () => {
  let fixture: ComponentFixture<Host>;
  const q = (sel: string) => fixture.nativeElement.querySelector(sel) as HTMLElement | null;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Host],
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();
  });

  afterEach(() => vi.restoreAllMocks());

  async function make(second = false) {
    fixture = TestBed.createComponent(Host);
    fixture.componentInstance.second.set(second);
    await fixture.whenStable();
  }

  it('paints the Bone ground with primary ink and projects its content', async () => {
    await make();
    const band = q('.aec-bone-band')!;
    expect(band.classList.contains('bg-(--accent-warm)')).toBe(true);
    expect(band.classList.contains('text-(--text-primary)')).toBe(true);
    expect(band.querySelector('[data-testid="content"]')).not.toBeNull();
  });

  it('keeps the 1328px wrap with 24, 32 and 48px gutters', async () => {
    await make();
    const wrap = q('.aec-bone-band > div')!;
    for (const cls of ['max-w-[1328px]', 'px-6', 'md:px-8', 'lg:px-12']) {
      expect(wrap.classList.contains(cls), cls).toBe(true);
    }
  });

  it('pads 96px above and below, 64px below md', async () => {
    await make();
    const wrap = q('.aec-bone-band > div')!;
    for (const cls of ['pt-16', 'md:pt-24', 'pb-16', 'md:pb-24']) {
      expect(wrap.classList.contains(cls), cls).toBe(true);
    }
  });

  it('takes 48px above, 32px below md, when it is the first band', async () => {
    await make();
    fixture.componentInstance.first.set(true);
    await fixture.whenStable();
    const wrap = q('.aec-bone-band > div')!;
    expect(wrap.classList.contains('pt-8')).toBe(true);
    expect(wrap.classList.contains('md:pt-12')).toBe(true);
    expect(wrap.classList.contains('pt-16')).toBe(false);
  });

  it('has no border and no animation of its own', async () => {
    await make();
    const band = q('.aec-bone-band')!;
    expect(band.className).not.toMatch(/border|animate|transition/);
  });

  it('logs nothing for one band', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await make(false);
    expect(err).not.toHaveBeenCalled();
  });

  it('logs an error in dev mode when a page has two Bone bands', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await make(true);
    expect(err).toHaveBeenCalledTimes(2);
    expect(String(err.mock.calls[0][0])).toContain('one Bone band per page');
    expect(String(err.mock.calls[0][0])).toContain('2');
  });
});
