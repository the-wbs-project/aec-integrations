import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Title } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Analytics } from '../analytics/analytics';

import { RoadmapPage } from './roadmap';

function setup(): { host: HTMLElement; title: Title } {
  // The rendered signup band injects Analytics (`providedIn: 'root'`); stub it to
  // avoid the real service's Router/consent dependencies (same as the home
  // closing-CTA spec).
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: Analytics, useValue: { mailingListSignup: vi.fn() } },
    ],
  });
  const fixture = TestBed.createComponent(RoadmapPage);
  fixture.detectChanges();
  return { host: fixture.nativeElement as HTMLElement, title: TestBed.inject(Title) };
}

describe('RoadmapPage', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    // The Angular vitest builder shares one jsdom document across every
    // *.component.spec.ts and never resets <head>, so clear any robots tag a
    // sibling spec left behind before asserting this page's own.
    document.head.querySelector('meta[name="robots"]')?.remove();
  });

  it('states plainly that the roadmap is coming, in one h1', () => {
    const { host } = setup();
    expect(host.querySelectorAll('h1')).toHaveLength(1);
    expect(host.querySelector('h1')?.textContent).toContain("What we're building next");
    expect(host.textContent).toContain('coming soon');
  });

  it('offers the shared mailing-list band as the interim subscription', () => {
    const { host } = setup();
    expect(host.querySelector('aec-mailing-list-signup')).not.toBeNull();
  });

  // AECI-1801: one Bone band per page. The hero is the band, and the signup takes its
  // white ground, as on the product and vendor pages.
  it('has one Bone band, the hero, and the signup on its white ground', () => {
    const { host } = setup();
    expect(host.querySelectorAll('.aec-bone-band')).toHaveLength(1);
    const band = host.querySelector('aec-bone-band')!;
    expect(band.querySelector('h1')).not.toBeNull();
    const signup = host.querySelector('aec-mailing-list-signup section')!;
    expect(signup.classList).not.toContain('aec-bone-band');
    expect(signup.classList).toContain('bg-(--surface-base)');
  });

  it('puts the section heading at the Section role on an inner span, in a 5:7 row', () => {
    const { host } = setup();
    const h2 = [...host.querySelectorAll('h2')].find((h) =>
      h.textContent?.includes('In the meantime'),
    )!;
    expect(h2.querySelector('span')!.className).toContain('text-t-36');
    expect(h2.parentElement!.className).toContain('lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]');
  });

  it('is noindex — a placeholder must not compete in the index', () => {
    const { title } = setup();
    expect(title.getTitle()).toBe('Roadmap · AEC Integrations');
    expect(document.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe('noindex');
  });
});
