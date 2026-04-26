// ---------------------------------------------------------------------------
// Workflow contract — every leaf workflow exports an object that conforms
// to this shape so the runner can treat them uniformly.
// ---------------------------------------------------------------------------
import type { Env } from '../env';
import type { AirtableRecord } from '../services/airtable';

// Re-export so workflow modules can import { Env } from '../types' uniformly.
export type { Env };

export type AirtableTableKey =
  | 'tools'
  | 'vendors'
  | 'categories'
  | 'projectPhases'
  | 'disciplines'
  | 'toolIntegrations';

/**
 * The structured-output schema each workflow expects from the model.
 * Workflows wire this into an `emit_result` tool that the model is forced
 * to call to return its answer (works alongside web_search and SerpAPI).
 */
export interface OutputSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties?: boolean;
}

export interface BuildPromptResult {
  systemPrompt: string;
  userPrompt: string;
  outputSchema: OutputSchema;
  /** Optional: cap how many turns of tool use the SerpAPI flow allows. */
  maxToolTurns?: number;
}

export interface ParseResult {
  /** Airtable fields to write back. Keys are field names, values are field values. */
  fields: Record<string, unknown>;
  /** Names of fields that were actually populated (for the run summary). */
  fieldsUpdated: string[];
  /** "success" → fully populated, "partial" → some signals missing, "error" → unable to determine. */
  status: 'success' | 'partial' | 'error';
  /** Optional human note for the run summary. */
  note?: string;
}

export type LlmWorkflowKind = 'llm';
export type CustomWorkflowKind = 'custom';

/**
 * Optional metadata that lets the runner UI render a grouped record picker
 * instead of asking for free-text record IDs. A workflow opts in by declaring
 * which field (on its `table`) it primarily writes, plus the timestamp field
 * that records when that write last happened.
 */
export interface WorkflowOptionsConfig {
  /** Field that, when empty on a record, means "missing" — needs a first run. */
  primaryField: string;
  /** ISO-timestamp field that records when primaryField was last refreshed. */
  stalenessField: string;
  /** Field used as the human label for each option (e.g. 'company_name'). */
  labelField: string;
  /** Days after which stalenessField is considered stale. Default 60. */
  staleAfterDays?: number;
}

export interface LlmWorkflow {
  kind: LlmWorkflowKind;
  description: string;
  /** Which Airtable table the input record_id belongs to. */
  table: AirtableTableKey;
  /** Optional grouped-picker config for the runner UI. */
  options?: WorkflowOptionsConfig;
  /** Build the prompt and structured output schema from a fetched record. */
  buildPrompt(record: AirtableRecord): BuildPromptResult;
  /**
   * Parse the structured output back into Airtable field updates.
   * Async + env-aware so workflows can do follow-up API calls (e.g. V02
   * verifies the LLM-emitted GitHub org via the GitHub REST API; V06 fetches
   * an RSS feed from the LLM-emitted blog URL).
   */
  parseResult(
    env: Env,
    record: AirtableRecord,
    output: Record<string, unknown>,
  ): Promise<ParseResult>;
}

export interface CustomWorkflow {
  kind: CustomWorkflowKind;
  description: string;
  table: AirtableTableKey;
  /** Optional grouped-picker config for the runner UI. */
  options?: WorkflowOptionsConfig;
  /**
   * Synchronously run the workflow against one record without involving the
   * batch API. Used for non-LLM workflows (V05 Press, V07 Score, T05 SearchDemand,
   * T07 IntegrationCount, T08 Score, V00/T00 orchestrators).
   */
  run(env: Env, record: AirtableRecord): Promise<ParseResult>;
}

export type Workflow = LlmWorkflow | CustomWorkflow;
