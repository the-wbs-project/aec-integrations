import { describe, expect, it } from 'vitest';

import {
  DATA_FLOW_CORRECTION_FIELD,
  INTEGRATION_EDIT_FIELDS,
  PRODUCT_OVERRIDE_FIELDS,
  VENDOR_OVERRIDE_FIELDS,
} from '@aeci/shared';

import { correctionLabel, hasCorrectionLabel } from './correction-labels';

/**
 * Runs under `ng test` (`.component.spec.ts`) because `$localize` is provided by the
 * Angular unit-test pipeline. Pure functions, no TestBed.
 *
 * AECI-1666: the provenance panel names every correction by field. A field the server can
 * lock but this map does not know would render its wire name ("trade_slugs") on a public
 * page, so the map must cover every lockable field.
 */
describe('correctionLabel', () => {
  it.each([
    ...VENDOR_OVERRIDE_FIELDS,
    ...PRODUCT_OVERRIDE_FIELDS,
    ...INTEGRATION_EDIT_FIELDS,
    'logo_url',
    'mechanism_url',
    // AECI-2139: AECi's correction of one data flow.
    DATA_FLOW_CORRECTION_FIELD,
  ])('names %s', (field) => {
    expect(hasCorrectionLabel(field)).toBe(true);
    expect(correctionLabel(field)).not.toBe(field);
    expect(correctionLabel(field).length).toBeGreaterThan(0);
  });

  it('follows the page wording, not the portal wording', () => {
    expect(correctionLabel('phase_slugs')).toBe('Project phases');
    expect(correctionLabel('pricing_model')).toBe('Price');
    expect(correctionLabel('tool_integrations_url')).toBe('Integrations page');
  });

  it('names a data flow correction without naming its data type (AECI-2139)', () => {
    expect(correctionLabel('data_flow')).toBe('A data flow');
  });

  it('reads a pre-AECI-1310 ownership row as Ownership', () => {
    expect(correctionLabel('public_private')).toBe('Ownership');
  });

  it('renders an unknown field as-is rather than blank', () => {
    expect(correctionLabel('not_a_field')).toBe('not_a_field');
    expect(correctionLabel('toString')).toBe('toString');
  });
});
