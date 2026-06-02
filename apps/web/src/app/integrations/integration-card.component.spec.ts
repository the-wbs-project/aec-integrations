import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it } from 'vitest';

import type { IntegrationListItem } from '@aeci/shared';

import { IntegrationCard } from './integration-card';

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
  imports: [IntegrationCard],
  template: `
    <table>
      <tbody>
        <tr aec-integration-card [integration]="integration()"></tr>
      </tbody>
    </table>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
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

describe('IntegrationCard', () => {
  it('renders the source → target headline as a link to /integrations/:id', () => {
    const fixture = setupFixture();
    const link = (fixture.nativeElement as HTMLElement).querySelector(
      'a[href="/integrations/00000000-0000-4000-8000-000000030001"]',
    );
    expect(link?.textContent).toContain('Revit');
    expect(link?.textContent).toContain('Navisworks');
  });

  it('renders the mechanism_kind label in the second cell', () => {
    const fixture = setupFixture();
    const cells = (fixture.nativeElement as HTMLElement).querySelectorAll('td');
    expect(cells[1]?.textContent).toContain('Native');
  });

  it('renders the direction label in the third cell', () => {
    const fixture = setupFixture();
    const cells = (fixture.nativeElement as HTMLElement).querySelectorAll('td');
    expect(cells[2]?.textContent).toContain('Bidirectional');
  });

  it('renders an en-dash placeholder when direction is null', () => {
    const fixture = setupFixture({ ...baseIntegration, direction: null });
    const placeholder = (fixture.nativeElement as HTMLElement).querySelector(
      'span[aria-label="Direction not listed"]',
    );
    expect(placeholder?.textContent?.trim()).toBe('–');
  });

  it('renders an en-dash placeholder when mechanism_kind is null (AECI-115, no native fallback)', () => {
    const fixture = setupFixture({ ...baseIntegration, mechanism_kind: null });
    const placeholder = (fixture.nativeElement as HTMLElement).querySelector(
      'span[aria-label="Mechanism not listed"]',
    );
    expect(placeholder?.textContent?.trim()).toBe('–');
  });
});
