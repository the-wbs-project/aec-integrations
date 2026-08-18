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

  it('is noindex — a placeholder must not compete in the index', () => {
    const { title } = setup();
    expect(title.getTitle()).toBe('Roadmap · AEC Integrations');
    expect(document.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe('noindex');
  });
});
