import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it } from 'vitest';

import { BrandLogo, type BrandLogoTone } from './brand-logo';

/**
 * AECI-1754: the wordmark has two tones. The default is the Forest-on-light file
 * every current call site already uses. `on-dark` is the transparent Bone and
 * Clay file for a Forest ground. Both keep one accessible name, carried by the
 * home link, so a screen reader hears it once.
 */
describe('BrandLogo', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), provideRouter([])],
    });
  });

  async function render(tone?: BrandLogoTone): Promise<HTMLElement> {
    const fixture = TestBed.createComponent(BrandLogo);
    if (tone !== undefined) fixture.componentRef.setInput('tone', tone);
    fixture.detectChanges();
    await fixture.whenStable();
    return fixture.nativeElement as HTMLElement;
  }

  it('draws the Forest wordmark by default, as every call site did before', async () => {
    const img = (await render()).querySelector('img')!;
    expect(img.getAttribute('src')).toBe('/branding/wordmark.svg');
  });

  it('draws the same file when the tone is set to default', async () => {
    const img = (await render('default')).querySelector('img')!;
    expect(img.getAttribute('src')).toBe('/branding/wordmark.svg');
  });

  it('draws the transparent Bone wordmark for the on-dark tone', async () => {
    const img = (await render('on-dark')).querySelector('img')!;
    expect(img.getAttribute('src')).toBe('/branding/wordmark-on-dark.svg');
  });

  it('keeps one intrinsic size in both tones so the layout never shifts', async () => {
    for (const tone of ['default', 'on-dark'] as const) {
      const img = (await render(tone)).querySelector('img')!;
      expect(img.getAttribute('width')).toBe('196');
      expect(img.getAttribute('height')).toBe('30');
    }
  });

  it('names the home link once in both tones, with the image alt as the brand name', async () => {
    for (const tone of ['default', 'on-dark'] as const) {
      const el = await render(tone);
      const links = el.querySelectorAll('a');
      expect(links).toHaveLength(1);
      expect(links[0].getAttribute('aria-label')).toBe('AEC Integrations home');
      expect(links[0].getAttribute('href')).toBe('/');
      expect(el.querySelectorAll('img')).toHaveLength(1);
      expect(el.querySelector('img')!.getAttribute('alt')).toBe('AEC Integrations');
    }
  });

  /**
   * AECI-1845: the ring follows the ground. The on-dark tone draws the Bone ring
   * at 3px with a 3px offset from plain utilities, with no `!`. The default tone
   * keeps the Forest ring it always had.
   */
  it('gives the on-dark tone the Bone ring at 3px with a 3px offset, with no !important', async () => {
    const link = (await render('on-dark')).querySelector('a')!;
    const classes = [...link.classList];
    expect(classes).toEqual(
      expect.arrayContaining([
        'focus-visible:outline-3',
        'focus-visible:outline-offset-3',
        'focus-visible:outline-(--focus-ring-on-brand)',
      ]),
    );
    expect(classes).not.toContain('focus-visible:outline-(--accent-primary)');
    expect(classes.some((c) => c.endsWith('!') || c.startsWith('!'))).toBe(false);
  });

  it('keeps the default ring exactly as before', async () => {
    for (const tone of [undefined, 'default'] as const) {
      const link = (await render(tone)).querySelector('a')!;
      expect([...link.classList].sort()).toEqual(
        [
          'inline-flex',
          'items-center',
          'rounded-md',
          'focus-visible:outline-2',
          'focus-visible:outline-offset-2',
          'focus-visible:outline-(--accent-primary)',
        ].sort(),
      );
    }
  });
});
