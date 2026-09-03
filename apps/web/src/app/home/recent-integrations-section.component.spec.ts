import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it } from 'vitest';

import type { IntegrationListItem } from '@aeci/shared';

import { RecentIntegrationsSection } from './recent-integrations-section';

function makeIntegration(n: number): IntegrationListItem {
  return {
    id: `00000000-0000-4000-8000-0000000300${String(n).padStart(2, '0')}`,
    name: `Source ${n} → Target ${n}`,
    mechanism_kind: 'native',
    mechanism_name: null,
    direction: 'one-way',
    source: { id: `s${n}`, slug: `source-${n}`, name: `Source ${n}`, logo_url: null },
    target: { id: `t${n}`, slug: `target-${n}`, name: `Target ${n}`, logo_url: null },
    via: null,
    created_at: '2024-03-01T00:00:00.000Z',
    updated_at: '2024-06-15T00:00:00.000Z',
  };
}

@Component({
  imports: [RecentIntegrationsSection],
  template: `<aec-recent-integrations-section [integrations]="integrations()" />`,
})
class Host {
  integrations = signal<readonly IntegrationListItem[]>([]);
}

function setupFixture(initial: readonly IntegrationListItem[]) {
  TestBed.configureTestingModule({ providers: [provideRouter([])] });
  const fixture = TestBed.createComponent(Host);
  fixture.componentInstance.integrations.set(initial);
  fixture.detectChanges();
  return fixture;
}

describe('RecentIntegrationsSection', () => {
  it('renders one tile per integration', () => {
    const fixture = setupFixture([makeIntegration(1), makeIntegration(2), makeIntegration(3)]);
    const tiles = (fixture.nativeElement as HTMLElement).querySelectorAll('aec-integration-tile');
    expect(tiles).toHaveLength(3);
    // Heading present and no empty note.
    expect((fixture.nativeElement as HTMLElement).querySelector('h2')?.textContent).toContain(
      'Recently added integrations',
    );
    expect((fixture.nativeElement as HTMLElement).textContent).not.toContain(
      'No integrations added yet',
    );
  });

  it('renders the bordered empty note and no tiles when the list is empty', () => {
    const fixture = setupFixture([]);
    expect(
      (fixture.nativeElement as HTMLElement).querySelectorAll('aec-integration-tile'),
    ).toHaveLength(0);
    // Heading still renders so the section stays navigable.
    expect((fixture.nativeElement as HTMLElement).querySelector('h2')?.textContent).toContain(
      'Recently added integrations',
    );
    expect((fixture.nativeElement as HTMLElement).textContent).toContain(
      'No integrations added yet',
    );
  });
});
