/**
 * The claim refusals' vendor-facing copy (AECI-1005, AECI-2047).
 *
 * Named `*.component.spec.ts` for the RUNNER: the messages are `$localize`, and
 * `$localize` only exists in the Angular test target.
 */
import { HttpErrorResponse } from '@angular/common/http';
import { describe, expect, it } from 'vitest';

import { claimErrorMessage } from './vendor-integration-ownership-labels';

const refusal = (code: string) =>
  new HttpErrorResponse({ status: 409, error: { error: { code, message: 'server text' } } });

describe('claimErrorMessage', () => {
  it('tells the owner AECi has to finish recording the connector first (AECI-2047)', () => {
    const message = claimErrorMessage(refusal('INTEGRATION_CONNECTOR_UNRESOLVED'));
    expect(message).toContain('has not finished recording the connector');
    expect(message).not.toContain('server text');
  });

  it('falls back to the generic message for a code it does not know', () => {
    expect(claimErrorMessage(refusal('SOMETHING_NEW'))).toBe(
      'Could not claim this integration. Try again.',
    );
  });
});
