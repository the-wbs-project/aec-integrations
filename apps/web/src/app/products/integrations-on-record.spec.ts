import { describe, expect, it } from 'vitest';

import { withoutTrailingFullStop } from './integrations-on-record';

/**
 * AECI-1720: the zero state's "We have not found an integrations page published by
 * {vendor}." ends in its own full stop. A vendor named "SiteLedger Inc." printed
 * "SiteLedger Inc..". The message is legal-reviewed and stays as it is; the value put
 * into it drops one trailing stop instead.
 */
describe('withoutTrailingFullStop', () => {
  it('drops the one stop a name ends in, so the sentence ends in one', () => {
    expect(withoutTrailingFullStop('SiteLedger Inc.')).toBe('SiteLedger Inc');
    expect(`published by ${withoutTrailingFullStop('SiteLedger Inc.')}.`).toBe(
      'published by SiteLedger Inc.',
    );
  });

  it('leaves a name with no trailing stop as it is', () => {
    expect(withoutTrailingFullStop('Procore')).toBe('Procore');
    expect(withoutTrailingFullStop('A.B. Systems')).toBe('A.B. Systems');
  });

  it('drops only one stop, and trailing space before it', () => {
    expect(withoutTrailingFullStop('Acme Co. ')).toBe('Acme Co');
    expect(withoutTrailingFullStop('Acme..')).toBe('Acme.');
  });
});
