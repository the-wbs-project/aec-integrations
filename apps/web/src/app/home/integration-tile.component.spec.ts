import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it } from 'vitest';

import type { IntegrationListItem } from '@aeci/shared';

import { IntegrationTile } from './integration-tile';

const baseIntegration: IntegrationListItem = {
  id: '00000000-0000-4000-8000-000000030001',
  name: 'Revit → Navisworks',
  mechanism_kind: 'native',
  mechanism_name: 'Desktop Connector',
  direction: 'bidirectional',
  source: { id: 's1', slug: 'revit', name: 'Revit', logo_url: null },
  target: { id: 't1', slug: 'navisworks', name: 'Navisworks', logo_url: null },
  created_at: '2024-03-01T00:00:00.000Z',
  updated_at: '2024-06-15T00:00:00.000Z',
};

@Component({
  imports: [IntegrationTile],
  template: `<aec-integration-tile [integration]="integration()" />`,
})
class Host {
  integration = signal<IntegrationListItem>(baseIntegration);
}

function setupFixture(initial: IntegrationListItem = baseIntegration) {
  TestBed.configureTestingModule({ providers: [provideRouter([])] });
  const fixture = TestBed.createComponent(Host);
  fixture.componentInstance.integration.set(initial);
  fixture.detectChanges();
  return fixture;
}

describe('IntegrationTile', () => {
  it('renders the source → target headline as a link to the canonical pair page (AECI-294)', () => {
    const fixture = setupFixture();
    // navisworks < revit → the canonical context is navisworks.
    const link = (fixture.nativeElement as HTMLElement).querySelector(
      'a[href="/products/navisworks/integrations/revit"]',
    );
    expect(link).not.toBeNull();
    expect(link?.textContent).toContain('Revit');
    expect(link?.textContent).toContain('Navisworks');
  });

  it('renders the mechanism_kind chip and direction label', () => {
    const text = (setupFixture().nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Native');
    expect(text).toContain('Bidirectional');
  });

  it('omits the chip and direction label when both are null (no en-dash filler on a tile)', () => {
    const fixture = setupFixture({ ...baseIntegration, mechanism_kind: null, direction: null });
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).not.toContain('Native');
    expect(text).not.toContain('Bidirectional');
    expect(text).not.toContain('–');
  });

  it('renders source and target monogram fallbacks when logos are null', () => {
    const fixture = setupFixture();
    const monograms = (fixture.nativeElement as HTMLElement).querySelectorAll(
      'aec-logo-or-initial span[aria-hidden="true"]',
    );
    expect(monograms).toHaveLength(2);
    expect(monograms[0]?.textContent?.trim()).toBe('R');
    expect(monograms[1]?.textContent?.trim()).toBe('N');
  });
});
