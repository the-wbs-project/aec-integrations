import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { Title } from '@angular/platform-browser';
import { beforeEach, describe, expect, it } from 'vitest';

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

  // E8.1 (2026-10-19): the Managed inquiry form is gone, so the managed topic is
  // ignored like any other unknown value. No panel, no form, the bare mailto.
  it('ignores the managed topic: no panel and the bare mailto', () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { queryParamMap: convertToParamMap({ topic: 'managed' }) } },
        },
      ],
    });
    const fixture = TestBed.createComponent(ContactPage);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('[data-testid="contact-managed"]')).toBeNull();
    expect(host.querySelector('[data-testid="contact-add-product"]')).toBeNull();
    expect(host.querySelector('form')).toBeNull();
    expect(host.textContent).not.toContain('Talk to us about Managed');
    const mailtos = [...host.querySelectorAll('a[href^="mailto:"]')].map((a) =>
      a.getAttribute('href'),
    );
    expect(mailtos.length).toBeGreaterThan(0);
    for (const href of mailtos) expect(href).toBe('mailto:support@aecintegrations.com');
  });

  // ?topic=add-product (VENDOR_PROGRAM_PAGE_SPEC.md section 6, kept for outside links):
  // the support mailto with the subject and the prompt filled in. No form.
  it('offers a prefilled email on ?topic=add-product', () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { queryParamMap: convertToParamMap({ topic: 'add-product' }) } },
        },
      ],
    });
    const fixture = TestBed.createComponent(ContactPage);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    const panel = host.querySelector('[data-testid="contact-add-product"]')!;
    expect(panel.querySelector('h2')?.textContent?.trim()).toBe('Ask us to add your product');
    expect(panel.querySelector('form')).toBeNull();
    const href = panel.querySelector('a')?.getAttribute('href') ?? '';
    const url = new URL(href);
    expect(url.protocol).toBe('mailto:');
    expect(url.pathname).toBe('support@aecintegrations.com');
    expect(url.searchParams.get('subject')).toBe('Please add my product to AEC Integrations');
    expect(url.searchParams.get('body')).toBe(
      'Product name:\n\nWebsite:\n\nThe products it integrates with:\n',
    );
    expect(host.querySelector('[data-testid="contact-managed"]')).toBeNull();
  });

  it('shows no Managed panel and a bare mailto without the topic', () => {
    TestBed.resetTestingModule();
    const { host } = setup();
    expect(host.querySelector('[data-testid="contact-managed"]')).toBeNull();
    expect(host.querySelector('[data-testid="contact-add-product"]')).toBeNull();
    expect(host.querySelector('a[href^="mailto:"]')?.getAttribute('href')).toBe(
      'mailto:support@aecintegrations.com',
    );
  });
});
