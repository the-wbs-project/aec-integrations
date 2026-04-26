// ---------------------------------------------------------------------------
// T07 — Tool integration count.
// Source: artifacts/n8n-workflows/AECi-T07-IntegrationCount.json
//
// NO LLM. Sums lengths of the linked-record arrays in tool_integrations_source
// and tool_integrations_target on the tool record, then writes back a single
// rolled-up integer.
//
// Inputs (from tools table): tool_integrations_source, tool_integrations_target
// Outputs: integration_count, integration_count_checked_at
// ---------------------------------------------------------------------------
import type { CustomWorkflow } from '../types';
import { asStringArray, type AirtableRecord } from '../../services/airtable';

export const workflow: CustomWorkflow = {
  kind: 'custom',
  description: 'Sum the linked-record arrays on tool_integrations_source/target into integration_count.',
  table: 'tools',

  async run(_env, record: AirtableRecord) {
    const checkedAt = new Date().toISOString();
    const sourceLinks = asStringArray(record.fields['tool_integrations_source']);
    const targetLinks = asStringArray(record.fields['tool_integrations_target']);
    const integrationCount = sourceLinks.length + targetLinks.length;

    return {
      fields: {
        integration_count: integrationCount,
        integration_count_checked_at: checkedAt,
      },
      fieldsUpdated: ['integration_count', 'integration_count_checked_at'],
      status: 'success',
      note: `${sourceLinks.length} source + ${targetLinks.length} target = ${integrationCount}`,
    };
  },
};
