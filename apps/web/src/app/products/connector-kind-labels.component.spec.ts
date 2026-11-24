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
  connectorWheelCaption,
  connectorZeroStatLabel,
  heroConnectsLabel,
  poweredEmptyLead,
  poweredHeading,
  poweredNavLabel,
  syncServiceEndorsementLine,
  type EndorsementInput,
} from './connector-kind-labels';
import { IntegrationStat } from './integration-stat';
import { pairFlowSentence } from './pair-direction-labels';
import { RoleBadge } from './role-badge';

describe('the Sync Service "Not offered or endorsed by" line (AECI-2043)', () => {
  const PROCORE_TECH = { id: 'v-procore', name: 'Procore Technologies' };
  const ACUMATICA = { id: 'v-acumatica', name: 'Acumatica' };
  const RIVETS = { id: 'v-rivets', name: 'Rivets' };
  const base: EndorsementInput = {
    connectorKind: 'sync_service',
    connectorProductId: 'p-rivets-sync',
    connectorVendorId: RIVETS.id,
    offeredBy: RIVETS,
    context: { productId: 'p-procore', productName: 'Procore', vendor: PROCORE_TECH },
    other: { productId: 'p-acumatica', productName: 'Acumatica', vendor: ACUMATICA },
  };

  it('names the offering vendor and both endpoint vendors', () => {
    expect(syncServiceEndorsementLine(base)).toBe(
      'Offered by Rivets. Not offered or endorsed by Procore Technologies or Acumatica.',
    );
  });

  it('renders for a Sync Service only: never on native, Integration platform or unclassified cards', () => {
    expect(
      syncServiceEndorsementLine({ ...base, connectorKind: 'integration_platform' }),
    ).toBeNull();
    expect(syncServiceEndorsementLine({ ...base, connectorKind: null })).toBeNull();
    // A native card: no connector, no kind.
    expect(
      syncServiceEndorsementLine({
        ...base,
        connectorKind: null,
        connectorProductId: null,
        connectorVendorId: null,
      }),
    ).toBeNull();
  });

  it('names a vendor once when both endpoint products come from it', () => {
    const line = syncServiceEndorsementLine({
      ...base,
      other: { productId: 'p-procore-pay', productName: 'Procore Pay', vendor: PROCORE_TECH },
    });
    expect(line).toBe('Offered by Rivets. Not offered or endorsed by Procore Technologies.');
  });

  it('names the product when an endpoint has no vendor on record', () => {
    expect(
      syncServiceEndorsementLine({
        ...base,
        other: { productId: 'p-acumatica', productName: 'Acumatica', vendor: null },
      }),
    ).toBe(
      'Offered by Rivets. Not offered or endorsed by Procore Technologies or the vendor of Acumatica.',
    );
    expect(
      syncServiceEndorsementLine({
        ...base,
        context: { productId: 'p-procore', productName: 'Procore', vendor: null },
        other: { productId: 'p-acumatica', productName: 'Acumatica', vendor: null },
      }),
    ).toBe('Offered by Rivets. Not offered or endorsed by the vendors of Procore or Acumatica.');
  });

  it('leaves out the "Offered by" sentence when the offering vendor is unknown', () => {
    expect(syncServiceEndorsementLine({ ...base, offeredBy: null })).toBe(
      'Not offered or endorsed by Procore Technologies or Acumatica.',
    );
  });

  it('never says the offering vendor does not offer it', () => {
    // An endpoint from the vendor that offers the card, or from the Sync Service's vendor.
    expect(
      syncServiceEndorsementLine({
        ...base,
        offeredBy: PROCORE_TECH,
        connectorVendorId: PROCORE_TECH.id,
      }),
    ).toBe('Offered by Procore Technologies. Not offered or endorsed by Acumatica.');
    expect(
      syncServiceEndorsementLine({
        ...base,
        offeredBy: null,
        connectorVendorId: ACUMATICA.id,
      }),
    ).toBe('Not offered or endorsed by Procore Technologies.');
    // Both endpoints from the offering vendor: no one to name, so no line.
    expect(
      syncServiceEndorsementLine({
        ...base,
        offeredBy: PROCORE_TECH,
        other: { productId: 'p-procore-pay', productName: 'Procore Pay', vendor: PROCORE_TECH },
      }),
    ).toBeNull();
  });

  it('has no line when the Sync Service is itself one of the two endpoints', () => {
    expect(
      syncServiceEndorsementLine({
        ...base,
        other: { productId: 'p-rivets-sync', productName: 'Rivets Sync', vendor: RIVETS },
      }),
    ).toBeNull();
  });
});

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

describe('the connector words the QA pass on AECI-2035 added', () => {
  it('names the wheel by kind', () => {
    expect(connectorWheelCaption('sync_service')).toBe('Products it syncs');
    expect(connectorWheelCaption('integration_platform')).toBe('Products it connects');
    expect(connectorWheelCaption(null)).toBe('Products it connects');
  });

  it('says a connector with no integration has none yet, never "Not yet connected"', () => {
    expect(connectorZeroStatLabel('sync_service')).toBe('No integrations delivered yet');
    expect(connectorZeroStatLabel('integration_platform')).toBe('No integrations powered yet');
    expect(connectorZeroStatLabel(null)).toBe('No integrations powered yet');
  });

  it('states a pair direction with both products named', () => {
    expect(pairFlowSentence('outbound', 'Procore', 'Viewpoint Vista')).toBe(
      'Procore sends to Viewpoint Vista',
    );
    expect(pairFlowSentence('inbound', 'Procore', 'Fieldwire')).toBe('Fieldwire sends to Procore');
    expect(pairFlowSentence('both', 'Procore', 'Viewpoint Vista')).toBe(
      'Procore and Viewpoint Vista sync both ways',
    );
  });

  @Component({
    imports: [IntegrationStat],
    template: `<aec-integration-stat
      [count]="0"
      [role]="role()"
      [kind]="kind()"
      variant="badge"
    />`,
  })
  class StatHost {
    readonly role = signal<string | null>(null);
    readonly kind = signal<string | null>(null);
  }

  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
  });

  it.each([
    ['application', null, 'Not yet connected'],
    ['hybrid', null, 'Not yet connected'],
    ['connector', 'sync_service', 'No integrations delivered yet'],
    ['connector', 'integration_platform', 'No integrations powered yet'],
    [null, null, 'Not yet connected'],
  ] as const)('the card stat at zero, role %s kind %s: "%s"', (role, kind, words) => {
    const fixture = TestBed.createComponent(StatHost);
    fixture.componentInstance.role.set(role);
    fixture.componentInstance.kind.set(kind);
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent?.trim()).toBe(words);
  });
});
