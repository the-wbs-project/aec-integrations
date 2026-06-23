/**
 * Tests for the `[aecTrackExternalLink]` directive (AECI-239). `.component.spec.ts`
 * so it runs under `ng test` (TestBed + DOM). A tiny host renders an anchor with
 * the directive; clicking it must fire `Analytics.externalLinkClicked` with the
 * resolved destination + the configured source. `Analytics` is faked at the DI
 * boundary so no PostHog SDK loads.
 */
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';

import { Analytics } from './analytics';
import { ExternalLinkTracker } from './external-link-tracker';

@Component({
  imports: [ExternalLinkTracker],
  template: `
    <a href="https://vendor.example.com/path" aecTrackExternalLink="vendor_detail">visit</a>
  `,
})
class Host {}

function render() {
  const analytics = { externalLinkClicked: vi.fn() };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [Host],
    providers: [{ provide: Analytics, useValue: analytics }],
  });
  const fixture = TestBed.createComponent(Host);
  fixture.detectChanges();
  const anchor = fixture.nativeElement.querySelector('a') as HTMLAnchorElement;
  return { analytics, anchor };
}

describe('ExternalLinkTracker', () => {
  it('fires external_link_clicked with the resolved destination + source on click', () => {
    const { analytics, anchor } = render();
    anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(analytics.externalLinkClicked).toHaveBeenCalledExactlyOnceWith({
      destination: 'https://vendor.example.com/path',
      source: 'vendor_detail',
    });
  });
});
