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

  it('sizes by class when responsive, and keeps the px height otherwise', async () => {
    const fixture = TestBed.createComponent(BrandLogo);
    fixture.detectChanges();
    const link = (fixture.nativeElement as HTMLElement).querySelector('a')!;
    expect(link.style.height).toBe('32px');
    expect(link.className).not.toContain('h-7');

    fixture.componentRef.setInput('responsive', true);
    fixture.detectChanges();
    expect(link.style.height).toBe('');
    expect(link.classList).toContain('h-7');
    expect(link.classList).toContain('md:h-8');
  });

  it('takes the Bone focus ring on a Forest ground and the Forest ring on a light one', async () => {
    const onDark = (await render('on-dark')).querySelector('a')!.className;
    expect(onDark).toContain('outline-(--focus-ring-on-brand)!');
    expect(onDark).not.toContain('outline-(--accent-primary)');
    const onLight = (await render('default')).querySelector('a')!.className;
    expect(onLight).toContain('outline-(--accent-primary)');
    expect(onLight).not.toContain('--focus-ring-on-brand');
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
});
