import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Title } from '@angular/platform-browser';
import { describe, expect, it } from 'vitest';

import { ContactPage } from './contact';

function setup(): { host: HTMLElement; title: Title } {
  TestBed.configureTestingModule({ providers: [provideRouter([])] });
  const fixture = TestBed.createComponent(ContactPage);
  fixture.detectChanges();
  return { host: fixture.nativeElement as HTMLElement, title: TestBed.inject(Title) };
}

describe('ContactPage', () => {
  it('renders the page H1', () => {
    expect(setup().host.querySelector('h1')?.textContent?.trim()).toBe('Get in touch');
  });

  it('exposes a mailto link to the Stage 1 contact address', () => {
    const host = setup().host;
    const mailto = host.querySelector<HTMLAnchorElement>('a[href^="mailto:"]');
    expect(mailto).not.toBeNull();
    expect(mailto?.getAttribute('href')).toBe('mailto:founders@thewbsproject.com');
    // The visible label matches the address (built from the same const, can't drift).
    expect(mailto?.textContent?.trim()).toBe('founders@thewbsproject.com');
  });

  it('points listing fixes back at the directory', () => {
    const hrefs = Array.from(setup().host.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/products');
  });

  it('sets an indexable static-page title (no noindex robots tag)', () => {
    expect(setup().title.getTitle()).toBe('Contact · AEC Integrations');
    expect(document.querySelector('meta[name="robots"]')).toBeNull();
  });
});
