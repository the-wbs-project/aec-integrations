/**
 * Tests for the `[aecTrackExternalLink]` directive (AECI-239). `.component.spec.ts`
 * so it runs under `ng test` (TestBed + DOM). A tiny host renders an anchor with
 * the directive; clicking it must fire `Analytics.externalLinkClicked` with the
 * resolved destination, the configured source and the ownership context
 * (AECI-933). `Analytics` is faked at the DI boundary so no PostHog SDK loads.
 */
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';

import { Analytics, type ExternalLinkContext } from './analytics';
import { ExternalLinkTracker } from './external-link-tracker';

const VENDOR_CONTEXT: ExternalLinkContext = {
  owner_vendor_id: 'vendor-1',
  link_origin: 'vendor',
  source_entity_type: 'vendor',
  source_entity_id: 'vendor-1',
  link_purpose: 'website',
};

@Component({
  imports: [ExternalLinkTracker],
  template: `
    <a
      href="https://vendor.example.com/path"
      aecTrackExternalLink="vendor_detail"
      [aecLinkContext]="context()"
      >visit</a
    >
  `,
})
class Host {
  readonly context = signal<ExternalLinkContext>(VENDOR_CONTEXT);
}

function render(context: ExternalLinkContext = VENDOR_CONTEXT) {
  const analytics = { externalLinkClicked: vi.fn() };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [Host],
    providers: [{ provide: Analytics, useValue: analytics }],
  });
  const fixture = TestBed.createComponent(Host);
  fixture.componentInstance.context.set(context);
  fixture.detectChanges();
  const anchor = fixture.nativeElement.querySelector('a') as HTMLAnchorElement;
  // Keep jsdom from attempting the navigation. The tracker's listener still runs.
  (fixture.nativeElement as HTMLElement).addEventListener('click', (e) => e.preventDefault());
  return { analytics, anchor };
}

describe('ExternalLinkTracker', () => {
  it('fires external_link_clicked with the destination, source and context on click', () => {
    const { analytics, anchor } = render();
    anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(analytics.externalLinkClicked).toHaveBeenCalledExactlyOnceWith({
      destination: 'https://vendor.example.com/path',
      source: 'vendor_detail',
      owner_vendor_id: 'vendor-1',
      link_origin: 'vendor',
      source_entity_type: 'vendor',
      source_entity_id: 'vendor-1',
      link_purpose: 'website',
    });
  });

  it('passes a null owner through as a present key (AECI-933)', () => {
    const { analytics, anchor } = render({
      owner_vendor_id: null,
      link_origin: 'aeci',
      source_entity_type: 'pair',
      source_entity_id: 'a:b',
      link_purpose: 'docs',
    });
    anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(analytics.externalLinkClicked).toHaveBeenCalledExactlyOnceWith({
      destination: 'https://vendor.example.com/path',
      source: 'vendor_detail',
      owner_vendor_id: null,
      link_origin: 'aeci',
      source_entity_type: 'pair',
      source_entity_id: 'a:b',
      link_purpose: 'docs',
    });
  });
});
