import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { Title } from '@angular/platform-browser';
import { beforeEach, describe, expect, it } from 'vitest';

import { SessionStatus } from '../auth/session-status';
import { ContactPage } from './contact';

function setup(): { host: HTMLElement; title: Title } {
  TestBed.configureTestingModule({ providers: [provideRouter([])] });
  const fixture = TestBed.createComponent(ContactPage);
  fixture.detectChanges();
  return { host: fixture.nativeElement as HTMLElement, title: TestBed.inject(Title) };
}

describe('ContactPage', () => {
  // The Angular vitest builder shares one jsdom document across every
  // *.component.spec.ts and never resets <head> between files. Sibling specs
  // write `<meta name="robots" content="noindex">` (search-page's
  // setSearchMeta; the resolver/404 specs' setNotFoundMeta) and don't clean it
  // up, so strip any lingering robots tag first — same hygiene as
  // meta.service.component.spec.ts. Without this the indexable-page assertion
  // below fails purely on run order.
  beforeEach(() => {
    document.head.querySelector('meta[name="robots"]')?.remove();
  });

  it('renders the page H1', () => {
    expect(setup().host.querySelector('h1')?.textContent?.trim()).toBe('Get in touch');
  });

  it('exposes a mailto link to the Stage 1 contact address', () => {
    const host = setup().host;
    const mailto = host.querySelector<HTMLAnchorElement>('a[href^="mailto:"]');
    expect(mailto).not.toBeNull();
    expect(mailto?.getAttribute('href')).toBe('mailto:support@aecintegrations.com');
    // The visible label matches the address (built from the same const, can't drift).
    expect(mailto?.textContent?.trim()).toBe('support@aecintegrations.com');
  });

  it('points listing fixes back at the directory', () => {
    const hrefs = Array.from(setup().host.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/products');
  });

  it('sets an indexable static-page title (no noindex robots tag)', () => {
    expect(setup().title.getTitle()).toBe('Contact · AEC Integrations');
    expect(document.querySelector('meta[name="robots"]')).toBeNull();
  });

  // ?topic=managed (the Plans page buttons' link target, AECI-1279): the inquiry
  // form inline, the same one the Plans page dialog shows.
  it('shows the Managed inquiry form on ?topic=managed', () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: SessionStatus, useValue: { email: signal(null) } },
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { queryParamMap: convertToParamMap({ topic: 'managed' }) } },
        },
      ],
    });
    const fixture = TestBed.createComponent(ContactPage);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    const panel = host.querySelector('[data-testid="contact-managed"]');
    expect(panel?.querySelector('h2')?.textContent?.trim()).toBe('Talk to us about Managed');
    const form = panel?.querySelector('aec-plan-inquiry-form form');
    expect(form).not.toBeNull();
    expect(form?.querySelector('#contact-plan-inquiry-email')).not.toBeNull();
    // The panel no longer starts an email; the general card still does.
    expect(panel?.querySelector('a[href^="mailto:"]')).toBeNull();
    expect(host.querySelector('a[href^="mailto:"]')?.getAttribute('href')).toBe(
      'mailto:support@aecintegrations.com',
    );
  });

  it('shows no Managed panel and a bare mailto without the topic', () => {
    TestBed.resetTestingModule();
    const { host } = setup();
    expect(host.querySelector('[data-testid="contact-managed"]')).toBeNull();
    expect(host.querySelector('a[href^="mailto:"]')?.getAttribute('href')).toBe(
      'mailto:support@aecintegrations.com',
    );
  });
});
