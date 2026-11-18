import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  INTEGRATION_TABLE_CONNECTION_CELL_CLASS,
  INTEGRATION_TABLE_FIRST_CELL_CLASS,
  INTEGRATION_TABLE_LINK_CELL_CLASS,
  INTEGRATION_TABLE_META_CLASS,
  INTEGRATION_TABLE_ROW_CLASS,
  INTEGRATION_TABLE_ROW_LINK_CLASS,
} from './integration-table-recipe';

/**
 * AECI-1924: the hub tables of "Integrations it powers" take the Integrations table's
 * recipe. `ProductIntegrationRow` keeps its classes as static attributes (see the recipe
 * file), so this guard holds its literals to the shared strings. A change to one without
 * the other fails here.
 */
describe('the integration table recipe', () => {
  const row = readFileSync(
    join(process.cwd(), 'src/app/products/product-integration-row.ts'),
    'utf8',
  ).replace(/\s+/g, ' ');

  it.each([
    ['row', INTEGRATION_TABLE_ROW_CLASS],
    ['first cell', INTEGRATION_TABLE_FIRST_CELL_CLASS],
    ['meta line', INTEGRATION_TABLE_META_CLASS],
    ['Connection cell', INTEGRATION_TABLE_CONNECTION_CELL_CLASS],
    ['link cell', INTEGRATION_TABLE_LINK_CELL_CLASS],
    ['row link', INTEGRATION_TABLE_ROW_LINK_CLASS],
  ])('ProductIntegrationRow draws the %s from the shared string', (_, classes) => {
    expect(row).toContain(classes);
  });
});
