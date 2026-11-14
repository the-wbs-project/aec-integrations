import type { ClaimStatus } from '@aeci/shared';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { LogoOrInitial, logoAlt, type LogoShape, type LogoSize } from './logo-or-initial';

// jsdom never loads images, so an `<img>` always reports `complete === true` /
// `naturalWidth === 0`. The component's `afterNextRender` + `requestAnimationFrame`
// broken-image net is therefore deliberately inert here (it's guarded by
// `img.currentSrc`, which jsdom never populates, and the rAF is never flushed by
// `fixture.detectChanges()`). The failure path is driven exclusively by an
// explicitly dispatched `error` event — see the "swaps to the initial" case.

@Component({
  imports: [LogoOrInitial],
  template: `<aec-logo-or-initial
    [src]="src"
    [name]="name"
    [alt]="alt"
    [size]="size"
    [shape]="shape"
    [referrerPolicy]="referrerPolicy"
    [claimStatus]="claimStatus"
    [ownPage]="ownPage"
  />`,
})
class LogoOrInitialHost {
  claimStatus: ClaimStatus | null = null;
  ownPage = false;
  src: string | null = 'https://cdn.example.com/acme.png';
  name = 'Acme';
  alt = '';
  size: LogoSize = 'lg';
  shape: LogoShape = 'rounded';
  referrerPolicy: string | null = null;
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

  it('logoAlt names the entity (AECI-1569)', () => {
    expect(logoAlt('Acme')).toBe('Acme logo');
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

  // ── shape + referrerPolicy (AECI-850) ────────────────────────────────────
  // Added for the account-menu avatar. A person is a circle; a company logo is
  // a rectangle. Both branches (img and initial span) must agree, or the shape
  // would change the instant a profile photo 404s.

  it('renders the catalog default as a rounded rectangle, not a circle', () => {
    const { root } = renderHost({ src: 'https://cdn.example.com/acme.png', size: 'sm' });
    expect(root.querySelector('img')!.classList.contains('rounded-full')).toBe(false);
  });

  it('applies the circle shape to BOTH the image and the initial fallback', () => {
    const withPhoto = renderHost({
      src: 'https://lh3.googleusercontent.com/a/photo',
      size: 'sm',
      shape: 'circle',
    });
    const img = withPhoto.root.querySelector('img')!;
    expect(img.classList.contains('rounded-full')).toBe(true);
    // A cropped photo, not a letterboxed logo.
    expect(img.classList.contains('object-cover')).toBe(true);
    expect(img.classList.contains('object-contain')).toBe(false);

    // The magic-link case, which is the MAJORITY of accounts: no photo at all.
    // The circle has to survive it, or the header would show a rounded square
    // for most signed-in visitors.
    const noPhoto = renderHost({ src: null, size: 'sm', shape: 'circle', name: 'Chris' });
    const span = noPhoto.root.querySelector('span[aria-hidden]')!;
    expect(span.classList.contains('rounded-full')).toBe(true);
    expect(span.textContent?.trim()).toBe('C');
  });

  it('keeps the circle when a profile photo fails to load', () => {
    const { fixture, root } = renderHost({
      src: 'https://lh3.googleusercontent.com/a/dead',
      size: 'sm',
      shape: 'circle',
    });
    root.querySelector('img')!.dispatchEvent(new Event('error'));
    fixture.detectChanges();
    expect(root.querySelector('img')).toBeNull();
    expect(root.querySelector('span[aria-hidden]')!.classList.contains('rounded-full')).toBe(true);
  });

  it('emits referrerpolicy only when one is supplied', () => {
    // Catalog logos are public URLs on crawlable pages, so no policy is set and
    // the attribute must be ABSENT rather than empty.
    const catalog = renderHost({ src: 'https://cdn.example.com/acme.png' });
    expect(catalog.root.querySelector('img')!.hasAttribute('referrerpolicy')).toBe(false);

    // The account avatar sets it so loading a Google-hosted photo does not tell
    // Google which AECi page the signed-in visitor is on.
    const avatar = renderHost({
      src: 'https://lh3.googleusercontent.com/a/photo',
      referrerPolicy: 'no-referrer',
    });
    expect(avatar.root.querySelector('img')!.getAttribute('referrerpolicy')).toBe('no-referrer');
  });

  // ── the logo rule (AECI-1769, ADR 0056 floor 3, counsel's ruling 9) ──────
  // An unclaimed listing shows the initial tile everywhere except the slot on its
  // own page where the "not affiliated" note sits beside it.

  const LOGO = 'https://cdn.example.com/acme.png';

  it('shows the logo of a claimed listing, on its own page or off it', () => {
    for (const ownPage of [false, true]) {
      const { root } = renderHost({ src: LOGO, claimStatus: 'claimed', ownPage });
      expect(root.querySelector('img')?.getAttribute('src')).toBe(LOGO);
    }
  });

  it('shows the initial tile for an unclaimed listing off its own page, even with a logo', () => {
    const { root } = renderHost({ src: LOGO, name: 'Acme', claimStatus: 'unclaimed' });
    expect(root.querySelector('img')).toBeNull();
    expect(root.querySelector('span[aria-hidden]')?.textContent?.trim()).toBe('A');
  });

  it('keeps the small sourced logo of an unclaimed listing on its own page', () => {
    const { root } = renderHost({
      src: LOGO,
      claimStatus: 'unclaimed',
      ownPage: true,
      size: 'sm',
    });
    expect(root.querySelector('img')?.getAttribute('src')).toBe(LOGO);
  });

  it('trusts a link payload with no claim status, whose logo the API already withheld', () => {
    expect(renderHost({ src: LOGO }).root.querySelector('img')).not.toBeNull();
    expect(renderHost({ src: null }).root.querySelector('img')).toBeNull();
  });

  it('ownPage never conjures a logo the payload does not carry', () => {
    const { root } = renderHost({ src: null, claimStatus: 'unclaimed', ownPage: true });
    expect(root.querySelector('img')).toBeNull();
    expect(root.querySelector('span[aria-hidden]')).not.toBeNull();
  });

  it.each(['lg', 'sm'] as const)(
    'gives a %s logo and its initial tile the same box, border, fill and radius',
    (size) => {
      const logo = renderHost({ src: LOGO, size }).root.querySelector('img')!;
      const tile = renderHost({ src: LOGO, size, claimStatus: 'unclaimed' }).root.querySelector(
        'span[aria-hidden]',
      )!;
      const frame = (el: Element) =>
        [...el.classList].filter((c) => /^(h-|w-|border|bg-|rounded)/.test(c)).sort();
      expect(frame(tile)).toEqual(frame(logo));
      expect(frame(logo)).toContain('border');
      expect(frame(logo)).toContain('bg-(--surface-raised)');
      // No muted styling: the tile's initial is primary text at full opacity.
      expect(tile.classList.contains('text-(--text-primary)')).toBe(true);
      expect([...tile.classList].some((c) => c.startsWith('opacity-'))).toBe(false);
    },
  );

  it('rounds the 32px mark at the 8px mark radius (DESIGN.md §4 "Radius")', () => {
    const { root } = renderHost({ src: LOGO, size: 'sm' });
    expect(root.querySelector('img')!.classList.contains('rounded-mark')).toBe(true);
  });
});
