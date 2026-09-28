/**
 * The owner edit form's field grouping (AECI-1006, AECI-1154, AECI-1155). The form
 * now serves §6.15's owned rows only; the detail page edits one field at a time
 * (§6.17.3). Moved from the retired ownership spec by AECI-1156.
 */
import { describe, expect, it } from 'vitest';

import { INTEGRATION_EDIT_FIELDS } from '@aeci/shared';

import { EDIT_GROUPS } from './vendor-integration-edit-form';

describe('EDIT_GROUPS', () => {
  it('groups exactly the editable fields, each once', () => {
    const grouped = EDIT_GROUPS.flatMap((g) => g.fields);
    expect(new Set(grouped).size).toBe(grouped.length);
    expect([...grouped].sort()).toEqual([...INTEGRATION_EDIT_FIELDS].sort());
  });

  it('offers the pricing page and never website or connection link', () => {
    const grouped = EDIT_GROUPS.flatMap((g) => g.fields as readonly string[]);
    expect(grouped).toContain('pricing_url');
    expect(grouped).not.toContain('website');
    expect(grouped).not.toContain('mechanism_url');
  });
});
