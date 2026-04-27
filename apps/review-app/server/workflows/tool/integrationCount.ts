// ---------------------------------------------------------------------------
// T07 — Tool integration count.
// Source: artifacts/n8n-workflows/AECi-T07-IntegrationCount.json
//
// NO LLM. Sums lengths of the linked-record arrays in tool_integrations_source
// and tool_integrations_target on the tool record, then writes back a single
// rolled-up integer.
// ---------------------------------------------------------------------------
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { ErrorCapturingWorkflow } from '../../lib/error-capturing-workflow';
import type { Env } from '../../env';
import { checkpoint } from '../../lib/checkpoint';
import type { RunParams, WorkflowMeta } from '../../lib/workflow-meta';
import { getRecord, updateRecord, asStringArray } from '../../services/airtable';

export const meta: WorkflowMeta = {
  slug: 'tool-integration-count',
  description:
    'Sum the linked-record arrays on tool_integrations_source/target into integration_count.',
  table: 'tools',
};

export class ToolIntegrationCountWorkflow extends ErrorCapturingWorkflow {
  override async runImpl(event: WorkflowEvent<RunParams>, step: WorkflowStep) {
    const { recordId } = event.payload;

    const record = await checkpoint(step, 'fetch-record', () =>
      getRecord(this.env, 'tools', recordId),
    );

    const sourceLinks = asStringArray(record.fields['tool_integrations_source']);
    const targetLinks = asStringArray(record.fields['tool_integrations_target']);
    const integrationCount = sourceLinks.length + targetLinks.length;

    const fields = {
      integration_count: integrationCount,
      integration_count_checked_at: new Date().toISOString(),
    };

    await checkpoint(step, 'write-fields', () =>
      updateRecord(this.env, 'tools', recordId, fields),
    );

    return {
      fields,
      fieldsUpdated: ['integration_count', 'integration_count_checked_at'],
      status: 'success' as const,
      note: `${sourceLinks.length} source + ${targetLinks.length} target = ${integrationCount}`,
    };
  }
}
