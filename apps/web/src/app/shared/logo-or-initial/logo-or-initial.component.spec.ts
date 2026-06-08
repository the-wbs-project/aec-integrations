import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { LogoOrInitial, type LogoSize } from './logo-or-initial';

// jsdom never loads images, so an `<img>` always reports `complete === true` /
// `naturalWidth === 0`. The component's `afterNextRender` + `requestAnimationFrame`
// broken-image net is therefore deliberately inert here (it's guarded by
// `img.currentSrc`, which jsdom never populates, and the rAF is never flushed by
// `fixture.detectChanges()`). The failure path is driven exclusively by an
// explicitly dispatched `error` event — see the "swaps to the initial" case.

@Component({
  imports: [LogoOrInitial],
  template: `<aec-logo-or-initial [src]="src" [name]="name" [alt]="alt" [size]="size" />`,
})
class LogoOrInitialHost {
  src: string | null = 'https://cdn.example.com/acme.png';
  name = 'Acme';
  alt = '';
  size: LogoSize = 'lg';
}

// Signal-backed host for the reused-instance case, where `src` must change
// *after* the first render — a plain field bound with `[src]="src"` wouldn't
// flush to the signal input mid-test (this harness only applies pre-first-CD
// inputs; see renderHost).
@Component({
  imports: [LogoOrInitial],
  template: `<aec-logo-or-initial [src]="src()" name="Acme" alt="" size="lg" />`,
})
class ReusedSrcHost {
  readonly src = signal<string | null>('https://cdn.example.com/dead.png');
}

function renderHost(overrides: Partial<LogoOrInitialHost> = {}) {
  const fixture = TestBed.createComponent(LogoOrInitialHost);
  Object.assign(fixture.componentInstance, overrides);
  fixture.detectChanges();
  return { fixture, root: fixture.nativeElement as HTMLElement };
}

describe('LogoOrInitial', () => {
  it('renders the image when src is set and the load has not failed', () => {
    const { root } = renderHost({ src: 'https://cdn.example.com/acme.png', name: 'Acme' });
    const img = root.querySelector('img');
    expect(img).not.toBeNull();
    // `NgOptimizedImage` rewrites `ngSrc` → `src` via the (noop) image loader.
    expect(img?.getAttribute('src')).toBe('https://cdn.example.com/acme.png');
    // The afterNextRender net must NOT false-positive into the fallback.
    expect(root.querySelector('span[aria-hidden]')).toBeNull();
  });

  it('swaps to the initial when the image fires an error event', () => {
    const { fixture, root } = renderHost({ src: 'https://cdn.example.com/dead.png', name: 'Acme' });
    const img = root.querySelector('img');
    expect(img).not.toBeNull();

    img!.dispatchEvent(new Event('error'));
    fixture.detectChanges();

    expect(root.querySelector('img')).toBeNull();
    const span = root.querySelector('span[aria-hidden]');
    expect(span).not.toBeNull();
    expect(span?.textContent?.trim()).toBe('A');
  });

  it('clears a prior load failure when src changes (reused instance)', () => {
    // The detail pages reuse one LogoOrInitial across client-side navigation
    // (default RouteReuseStrategy + toSignal(route.data)), so a 404 on entity A
    // must not suppress entity B's valid logo when [src] updates in place. A
    // signal-backed host is required: this harness only flushes input changes
    // applied before the first detectChanges() (see renderHost) — a plain-field
    // mutation after init never reaches the signal input.
    const fixture = TestBed.createComponent(ReusedSrcHost);
    const root = fixture.nativeElement as HTMLElement;
    fixture.detectChanges();

    root.querySelector('img')!.dispatchEvent(new Event('error'));
    fixture.detectChanges();
    expect(root.querySelector('img')).toBeNull();

    fixture.componentInstance.src.set('https://cdn.example.com/beta.png');
    fixture.detectChanges();

    const img = root.querySelector('img');
    expect(img).not.toBeNull();
    expect(img?.getAttribute('src')).toBe('https://cdn.example.com/beta.png');
    expect(root.querySelector('span[aria-hidden]')).toBeNull();
  });

  it('renders the initial when src is null', () => {
    const { root } = renderHost({ src: null, name: 'Beta' });
    expect(root.querySelector('img')).toBeNull();
    expect(root.querySelector('span[aria-hidden]')?.textContent?.trim()).toBe('B');
  });

  it.each([
    ['🚀 Rocket', '🚀'], // leading surrogate pair → whole glyph, not half a surrogate
    ['acme', 'A'], // lower-cased → upper
    ['', '·'], // empty name → middot placeholder
  ])('derives the initial %o → %o', (name, expected) => {
    const { root } = renderHost({ src: null, name });
    expect(root.querySelector('span[aria-hidden]')?.textContent?.trim()).toBe(expected);
  });

  it('applies the lg box + framing to the image', () => {
    const { root } = renderHost({ src: 'https://cdn.example.com/acme.png', size: 'lg' });
    const img = root.querySelector('img')!;
    expect(img.classList.contains('h-16')).toBe(true);
    expect(img.classList.contains('w-16')).toBe(true);
    expect(img.classList.contains('border')).toBe(true);
    expect(img.classList.contains('object-contain')).toBe(true);
  });

  it('applies the sm box to the image', () => {
    const { root } = renderHost({ src: 'https://cdn.example.com/acme.png', size: 'sm' });
    const img = root.querySelector('img')!;
    expect(img.classList.contains('h-8')).toBe(true);
    expect(img.classList.contains('w-8')).toBe(true);
    expect(img.classList.contains('object-contain')).toBe(true);
  });

  it('reserves the same box in the fallback span (no layout shift)', () => {
    const lg = renderHost({ src: null, size: 'lg' });
    const lgSpan = lg.root.querySelector('span[aria-hidden]')!;
    expect(lgSpan.classList.contains('h-16')).toBe(true);
    expect(lgSpan.classList.contains('w-16')).toBe(true);

    const sm = renderHost({ src: null, size: 'sm' });
    const smSpan = sm.root.querySelector('span[aria-hidden]')!;
    expect(smSpan.classList.contains('h-8')).toBe(true);
    expect(smSpan.classList.contains('w-8')).toBe(true);
  });

  it('passes alt through verbatim and keeps the fallback decorative', () => {
    const decorative = renderHost({ src: 'https://cdn.example.com/acme.png', alt: '' });
    expect(decorative.root.querySelector('img')?.getAttribute('alt')).toBe('');

    const meaningful = renderHost({ src: 'https://cdn.example.com/acme.png', alt: 'Acme logo' });
    expect(meaningful.root.querySelector('img')?.getAttribute('alt')).toBe('Acme logo');

    // The fallback span is always aria-hidden — the real name is in adjacent text.
    const nullFallback = renderHost({ src: null, name: 'Acme' });
    expect(nullFallback.root.querySelector('span')?.getAttribute('aria-hidden')).toBe('true');

    const errorFallback = renderHost({ src: 'https://cdn.example.com/dead.png', name: 'Acme' });
    const img = errorFallback.root.querySelector('img')!;
    img.dispatchEvent(new Event('error'));
    errorFallback.fixture.detectChanges();
    expect(errorFallback.root.querySelector('span')?.getAttribute('aria-hidden')).toBe('true');
  });
});
