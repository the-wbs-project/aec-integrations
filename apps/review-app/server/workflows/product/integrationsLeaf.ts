// ---------------------------------------------------------------------------
// Shared leaf-runner for the integrations-discovery sub-orchestrator.
//
// Every per-source leaf (website, ipaas, marketplaces, g2, github, web) emits
// a normalized list of IntegrationCandidate. This helper centralizes:
//   • the standard LLM turn loop with executeSearchTool (mirrors marketplace.ts)
//   • the output schema for IntegrationCandidate[]
//   • parsing + filtering of low-confidence emissions
//   • writing `integrations_<source>_candidates{,_checked_at}` to the product
// ---------------------------------------------------------------------------
import type { WorkflowStep } from 'cloudflare:workers';
import type { Env } from '../../env';
import { checkpoint } from '../../lib/checkpoint';
import {
  buildContinuationRequest,
  buildInitialRequest,
  executeSearchTool,
  interpretMessage,
  logTurnSummary,
  runForceEmitTurn,
  runTurn,
  type LlmContext,
  type MessageParam,
  type OutputSchema,
} from '../../lib/llm';
import {
  asString,
  getRecord,
  updateRecord,
  type AirtableRecord,
} from '../../services/airtable';
import type {
  Confidence,
  EvidenceSource,
  IntegrationCandidate,
} from '../../services/integrationCandidates';

const MAX_TURNS = 5;
const VALID_KINDS = [
  'native',
  'iPaaS',
  'marketplace-app',
  'api',
  'webhook',
  'partner',
] as const;
const VALID_DIRECTION = ['one-way', 'bidirectional'] as const;
const VALID_CONFIDENCE: Confidence[] = ['high', 'medium', 'low'];

/** Output schema shared by every leaf. */
export const CANDIDATES_OUTPUT_SCHEMA: OutputSchema = {
  type: 'object',
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          targetName: { type: 'string' },
          targetWebsite: { type: 'string' },
          targetVendorName: { type: 'string' },
          mechanismKind: { type: 'string', enum: [...VALID_KINDS] },
          mechanismName: { type: 'string' },
          direction: { type: 'string', enum: [...VALID_DIRECTION] },
          evidenceUrl: { type: 'string' },
          notes: { type: 'string' },
          confidence: { type: 'string', enum: VALID_CONFIDENCE },
        },
        required: ['targetName', 'evidenceUrl', 'confidence'],
      },
    },
    confidence: { type: 'string', enum: VALID_CONFIDENCE },
  },
  required: ['candidates', 'confidence'],
};

export function parseCandidates(
  emitted: Record<string, unknown>,
  source: EvidenceSource,
): IntegrationCandidate[] {
  const raw = emitted['candidates'];
  if (!Array.isArray(raw)) return [];
  const out: IntegrationCandidate[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const targetName = asString(e['targetName']);
    const evidenceUrl = asString(e['evidenceUrl']);
    const confidence = asString(e['confidence']) as Confidence | undefined;
    if (!targetName || !evidenceUrl || !confidence) continue;
    if (!VALID_CONFIDENCE.includes(confidence)) continue;
    const kind = asString(e['mechanismKind']);
    const direction = asString(e['direction']);
    out.push({
      targetName,
      targetWebsite: asString(e['targetWebsite']),
      targetVendorName: asString(e['targetVendorName']),
      mechanismKind:
        kind && (VALID_KINDS as readonly string[]).includes(kind) ? kind : undefined,
      mechanismName: asString(e['mechanismName']),
      direction:
        direction && (VALID_DIRECTION as readonly string[]).includes(direction)
          ? (direction as 'one-way' | 'bidirectional')
          : undefined,
      evidenceUrl,
      evidenceSource: source,
      notes: asString(e['notes']),
      confidence,
    });
  }
  return out;
}

export interface LeafResult {
  fields: Record<string, unknown>;
  fieldsUpdated: string[];
  status: 'success';
  note: string;
  candidates: IntegrationCandidate[];
}

export interface LeafConfig {
  source: EvidenceSource;
  /** The prompt builder receives the source product record. */
  buildPrompt(record: AirtableRecord): {
    systemPrompt: string;
    userPrompt: string;
  };
  /** Optional pre-LLM step that fetches/scrapes inputs and may enrich the prompt. */
  preFetch?: (
    env: Env,
    step: WorkflowStep,
    record: AirtableRecord,
  ) => Promise<{
    extraSystemContext?: string;
    extraUserContext?: string;
    /** Candidates derived without the LLM (e.g. github topic match). */
    deterministicCandidates?: IntegrationCandidate[];
    /** When true, bypass the LLM entirely and write deterministicCandidates only. */
    skipLlm?: boolean;
  }>;
  /**
   * Optional candidate post-filter. Receives the raw LLM output for this leaf
   * plus any deterministic candidates from preFetch and may filter, dedupe, or
   * reject entries that fail leaf-specific validation.
   */
  postFilter?(candidates: IntegrationCandidate[]): IntegrationCandidate[];
}

/** Field name on the product record that stores this leaf's candidates blob. */
export function candidatesField(source: EvidenceSource): string {
  return `integrations_${source}_candidates`;
}
export function candidatesCheckedField(source: EvidenceSource): string {
  return `integrations_${source}_candidates_checked_at`;
}

export async function runLeaf(
  env: Env,
  step: WorkflowStep,
  ctx: LlmContext,
  recordId: string,
  model: string,
  searchTool: 'searchapi' | 'web',
  config: LeafConfig,
): Promise<LeafResult> {
  const record = await checkpoint(step, 'fetch-record', () =>
    getRecord(env, 'products', recordId),
  );

  const pre = config.preFetch
    ? await checkpoint(step, 'pre-fetch', () => config.preFetch!(env, step, record))
    : undefined;

  let llmCandidates: IntegrationCandidate[] = [];

  if (!pre?.skipLlm) {
    const { systemPrompt, userPrompt } = config.buildPrompt(record);
    const fullSystem = pre?.extraSystemContext
      ? `${systemPrompt}\n\n${pre.extraSystemContext}`
      : systemPrompt;
    const fullUser = pre?.extraUserContext
      ? `${userPrompt}\n\n${pre.extraUserContext}`
      : userPrompt;

    let messages: MessageParam[] = [{ role: 'user', content: fullUser }];
    let response = await checkpoint(step, 'llm-turn-0', () =>
      runTurn(
        env,
        ctx,
        buildInitialRequest({
          model,
          systemPrompt: fullSystem,
          userPrompt: fullUser,
          outputSchema: CANDIDATES_OUTPUT_SCHEMA,
          searchTool,
        }),
      ),
    );

    let emitted: Record<string, unknown> | undefined;
    for (let turn = 0; turn < MAX_TURNS && !emitted; turn++) {
      const interpreted = interpretMessage(response);
      logTurnSummary(ctx, turn, interpreted);
      messages = [...messages, interpreted.assistantMessage];

      if (interpreted.emitted) {
        emitted = interpreted.emitted;
        break;
      }
      if (interpreted.pendingSearches.length > 0 && searchTool === 'searchapi') {
        const toolResult = await checkpoint(step, `serp-${turn}`, () =>
          executeSearchTool(env, ctx, interpreted.pendingSearches),
        );
        messages = [...messages, toolResult];
        response = await checkpoint(step, `llm-turn-${turn + 1}`, () =>
          runTurn(
            env,
            ctx,
            buildContinuationRequest({
              model,
              systemPrompt: fullSystem,
              outputSchema: CANDIDATES_OUTPUT_SCHEMA,
              priorMessages: messages,
            }),
          ),
        );
        continue;
      }
      // Force-emit fallback so leaves don't fail the orchestrator just
      // because the model returned text instead of calling emit_result.
      emitted = await checkpoint(step, `force-emit-${turn}`, () =>
        runForceEmitTurn(env, ctx, {
          model,
          systemPrompt: fullSystem,
          outputSchema: CANDIDATES_OUTPUT_SCHEMA,
          priorMessages: messages,
        }),
      );
      break;
    }

    if (emitted) {
      llmCandidates = parseCandidates(emitted, config.source);
    }
  }

  const allCandidates = [
    ...(pre?.deterministicCandidates ?? []),
    ...llmCandidates,
  ];
  const filtered = config.postFilter ? config.postFilter(allCandidates) : allCandidates;
  const checkedAt = new Date().toISOString();
  const fields = {
    [candidatesField(config.source)]: JSON.stringify(filtered),
    [candidatesCheckedField(config.source)]: checkedAt,
  };

  await checkpoint(step, 'write-fields', () =>
    updateRecord(env, 'products', recordId, fields),
  );

  return {
    fields,
    fieldsUpdated: Object.keys(fields),
    status: 'success',
    note: `Found ${filtered.length} candidate${filtered.length === 1 ? '' : 's'} via ${config.source}`,
    candidates: filtered,
  };
}
