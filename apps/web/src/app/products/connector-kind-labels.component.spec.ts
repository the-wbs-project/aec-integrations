/**
 * AECI-2037 — the public label split. One helper owns the words for each connector
 * kind, and the role chip reads it. A `.component.spec.ts` because `$localize` is set
 * up only in the Angular test pipeline.
 */
import { Component, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import type { ConnectorKind, ProductRole } from '@aeci/shared';

import {
  connectorKindLabel,
  connectorMetaDescription,
  heroConnectsLabel,
  poweredEmptyLead,
  poweredHeading,
  poweredNavLabel,
} from './connector-kind-labels';
import { RoleBadge } from './role-badge';

describe('connector kind labels (AECI-2037)', () => {
  it('names each kind, and a blank kind reads Connector', () => {
    expect(connectorKindLabel('integration_platform')).toBe('Integration platform');
    expect(connectorKindLabel('sync_service')).toBe('Sync Service');
    expect(connectorKindLabel(null)).toBe('Connector');
  });

  it('heads the powered section by kind', () => {
    expect(poweredHeading('integration_platform', 4)).toBe('Integrations it powers (4)');
    expect(poweredHeading('sync_service', 8)).toBe('Integrations it delivers (8)');
    expect(poweredHeading(null, 2)).toBe('Integrations it powers (2)');
    expect(poweredNavLabel('integration_platform')).toBe('Integrations it powers');
    expect(poweredNavLabel('sync_service')).toBe('Integrations it delivers');
    expect(poweredNavLabel(null)).toBe('Integrations it powers');
  });

  it('names the kind in the empty state', () => {
    expect(poweredEmptyLead('integration_platform')).toBe(
      'No integrations are recorded as running on this integration platform yet.',
    );
    expect(poweredEmptyLead('sync_service')).toBe(
      'No integrations are recorded for this Sync Service yet.',
    );
    expect(poweredEmptyLead(null)).toBe(
      'No integrations are recorded as running on this connector yet.',
    );
  });

  it('a Sync Service syncs in the hero line; the other two connect', () => {
    expect(heroConnectsLabel('sync_service', 1)).toBe(
      'Syncs 1 product in the AEC Integrations catalog',
    );
    expect(heroConnectsLabel('sync_service', 6)).toBe(
      'Syncs 6 products in the AEC Integrations catalog',
    );
    expect(heroConnectsLabel('integration_platform', 6)).toBe(
      'Connects 6 products in the AEC Integrations catalog',
    );
    expect(heroConnectsLabel(null, 1)).toBe('Connects 1 product in the AEC Integrations catalog');
  });

  it('varies the meta description by kind, and NULL keeps the original', () => {
    expect(connectorMetaDescription('integration_platform', 'MindCloud', 12)).toBe(
      'MindCloud is an integration platform for 12 construction and AEC products. See the integrations it powers and reviews from the teams using them.',
    );
    expect(connectorMetaDescription('sync_service', 'Agave', 3)).toBe(
      'Agave is a Sync Service that syncs 3 construction and AEC products. See the integrations it delivers and reviews from the teams using them.',
    );
    expect(connectorMetaDescription(null, 'Kroo', 5)).toBe(
      'Kroo connects 5 construction and AEC products. See the integrations it powers and reviews from the teams using them.',
    );
  });
});

@Component({
  imports: [RoleBadge],
  template: `<aec-role-badge [role]="role()" [kind]="kind()" />`,
})
class Host {
  readonly role = signal<ProductRole>('connector');
  readonly kind = signal<string | null | undefined>(null);
}

describe('RoleBadge reads the connector kind (AECI-2037)', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
  });

  function render(role: ProductRole, kind: ConnectorKind | string | null | undefined): string {
    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.role.set(role);
    fixture.componentInstance.kind.set(kind);
    fixture.detectChanges();
    return (fixture.nativeElement as HTMLElement).textContent?.trim() ?? '';
  }

  it.each([
    ['integration_platform', 'Integration platform'],
    ['sync_service', 'Sync Service'],
    [null, 'Connector'],
    [undefined, 'Connector'],
    ['not_a_kind', 'Connector'],
  ])('a connector with kind %s reads %s', (kind, label) => {
    expect(render('connector', kind)).toBe(label);
  });

  it('a hybrid keeps "Hybrid" whatever its kind', () => {
    expect(render('hybrid', 'sync_service')).toBe('Hybrid');
  });

  it('an application renders nothing, even with a stray kind', () => {
    expect(render('application', 'sync_service')).toBe('');
  });
});
