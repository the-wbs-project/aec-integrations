// ---------------------------------------------------------------------------
// LLM helpers: request building, response interpretation, SearchAPI tool
// execution. Each workflow composes these inside its run() method.
//
// Each model turn is a single synchronous request to the Anthropic Messages
// API routed through the Cloudflare AI Gateway worker binding. There is no
// batch API and no polling.
// ---------------------------------------------------------------------------
import type { Env, SearchTool } from '../env';
import {
  WEB_SEARCH_TOOL,
  searchApiToolSchema,
  emitResultTool,
  FORCE_EMIT_TOOL_CHOICE,
  MAX_TOOL_USES,
  type Tool,
  type WebSearchTool,
} from '../services/llm-tools';
import { runSerpSearch, pickOrganicResults } from '../services/search';
import {
  runMessage,
  type MessageRequestBody,
  type MessageResponse,
  type GatewayContext,
} from '../services/anthropic';

// Locally-typed message primitives — kept loose so we don't drag in an SDK.
// The Anthropic Messages API accepts these shapes verbatim and `interpretMessage`
// widens content blocks at read time.
export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | unknown[];
  is_error?: boolean;
}

export type ContentBlockParam =
  | { type: 'text'; text: string }
  | ToolUseBlock
  | ToolResultBlock
  | { type: string; [k: string]: unknown };

export interface MessageParam {
  role: 'user' | 'assistant';
  content: string | ContentBlockParam[] | unknown[];
}

export type Message = MessageResponse;

export interface OutputSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties?: boolean;
}

export interface BuildInitialRequestInput {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  outputSchema: OutputSchema;
  searchTool: SearchTool;
  maxTokens?: number;
  /** Override the default search-tool max_uses (built-in) / advertised cap (custom). */
  searchMaxUses?: number;
}

export function buildInitialRequest(input: BuildInitialRequestInput): MessageRequestBody {
  const builtIn: WebSearchTool =
    input.searchMaxUses !== undefined
      ? { type: 'web_search_20250305', name: 'web_search', max_uses: input.searchMaxUses }
      : WEB_SEARCH_TOOL;
  const tools: Tool[] = [
    input.searchTool === 'web' ? builtIn : searchApiToolSchema(5, input.searchMaxUses),
    emitResultTool(input.outputSchema),
  ];
  return {
    model: input.model,
    max_tokens: input.maxTokens ?? 8192,
    ...(supportsTemperature(input.model) ? { temperature: 0 } : {}),
    system: input.systemPrompt,
    messages: [{ role: 'user', content: input.userPrompt }],
    tools,
    tool_choice: { type: 'auto' },
  };
}

export interface BuildContinuationRequestInput {
  model: string;
  systemPrompt: string;
  outputSchema: OutputSchema;
  priorMessages: MessageParam[];
  maxTokens?: number;
  /** Override the advertised search-tool cap on continuation turns. */
  searchMaxUses?: number;
}

export function buildContinuationRequest(
  input: BuildContinuationRequestInput,
): MessageRequestBody {
  const tools: Tool[] = [
    searchApiToolSchema(5, input.searchMaxUses),
    emitResultTool(input.outputSchema),
  ];
  return {
    model: input.model,
    max_tokens: input.maxTokens ?? 8192,
    ...(supportsTemperature(input.model) ? { temperature: 0 } : {}),
    system: input.systemPrompt,
    messages: input.priorMessages,
    tools,
    tool_choice: { type: 'any' },
  };
}

/**
 * Resolve the effective search tool for a run. If the caller asked for the
 * SearchAPI custom tool but no key is configured, fall back to Anthropic's
 * built-in web_search. Logs the downgrade so it's visible in `wrangler tail`.
 */
export function resolveSearchTool(env: Env, requested: SearchTool): SearchTool {
  if (requested === 'searchapi' && !env.SEARCHAPI_API_KEY) {
    console.warn(
      '[search] SEARCHAPI_API_KEY missing — falling back to Anthropic web_search',
    );
    return 'web';
  }
  return requested;
}

export { MAX_TOOL_USES };

/**
 * Opus 4.7 rejects requests that include `temperature` (the API returns
 * "`temperature` is deprecated for this model"). Other models still accept
 * it, and we want temperature: 0 there for deterministic tool-use behavior.
 */
export function supportsTemperature(model: string): boolean {
  return !model.startsWith('claude-opus-4-7');
}

// ---------------------------------------------------------------------------
// Single-turn request — direct call to the Anthropic Messages API via the
// AI Gateway binding.
// ---------------------------------------------------------------------------

export type LlmContext = GatewayContext & {
  runId: string;
  workflow: string;
};

export async function runTurn(
  env: Env,
  ctx: LlmContext,
  request: MessageRequestBody,
): Promise<MessageResponse> {
  return runMessage(env, ctx, request);
}

/**
 * Final-turn safety net: re-issue the conversation with `emit_result` as the
 * only tool and `tool_choice` forced to it. Used when the model has either
 * exhausted its search budget or returned a text-only message without
 * emitting. Appends a synthetic user message instructing the model to emit a
 * best-effort result with `confidence: 'low'`.
 *
 * Returns the parsed `emit_result` payload, or undefined when the model
 * somehow still didn't emit (caller should treat as terminal failure).
 */
export async function runForceEmitTurn(
  env: Env,
  ctx: LlmContext,
  input: {
    model: string;
    systemPrompt: string;
    outputSchema: OutputSchema;
    priorMessages: MessageParam[];
    maxTokens?: number;
  },
): Promise<Record<string, unknown> | undefined> {
  const messages: MessageParam[] = [
    ...input.priorMessages,
    {
      role: 'user',
      content:
        "You've used your search budget. Emit `emit_result` now with what you've gathered. Setting `confidence: 'low'` and leaving any uncertain fields null is a valid result — do not refuse.",
    },
  ];
  const request: MessageRequestBody = {
    model: input.model,
    max_tokens: input.maxTokens ?? 4096,
    temperature: 0,
    system: input.systemPrompt,
    messages,
    tools: [emitResultTool(input.outputSchema)],
    tool_choice: FORCE_EMIT_TOOL_CHOICE,
  };
  const response = await runMessage(env, ctx, request);
  const interpreted = interpretMessage(response);
  logTurnSummary(ctx, -1, interpreted);
  return interpreted.emitted;
}

// ---------------------------------------------------------------------------
// Response interpretation
// ---------------------------------------------------------------------------

/**
 * One built-in web_search invocation, paired with its result. Populated for
 * Anthropic's server-side `web_search_20250305` tool. Errors come back as
 * `web_search_tool_result_error` blocks (max_uses_exceeded, too_many_requests,
 * invalid_tool_input, etc.) — captured in `error`.
 */
export interface SearchActivity {
  query: string;
  resultCount: number;
  error?: string;
}

export interface PendingSearch {
  toolUseId: string;
  query: string;
}

export interface InterpretedResult {
  /** Set when the model called emit_result — final structured answer. */
  emitted?: Record<string, unknown>;
  /**
   * All custom 'web_search' tool_use blocks emitted in this turn, in order.
   * The model can issue several in parallel; every one needs a matching
   * tool_result in the next user message or the API rejects the conversation.
   */
  pendingSearches: PendingSearch[];
  /** True when the model returned without calling any tool. */
  noTool?: boolean;
  stopReason?: string | null;
  /** Built-in web_search activity for this turn, in invocation order. */
  searches: SearchActivity[];
  /** Full assistant message — append to the conversation before next turn. */
  assistantMessage: MessageParam;
}

export function interpretMessage(message: Message): InterpretedResult {
  let emitted: Record<string, unknown> | undefined;
  const pendingSearches: PendingSearch[] = [];
  const queriesById = new Map<string, string>();
  const searches: SearchActivity[] = [];

  type WideBlock = { type: string; [k: string]: unknown };
  for (const block of message.content as WideBlock[]) {
    if (block.type === 'tool_use') {
      const tu = block as unknown as ToolUseBlock;
      if (tu.name === 'emit_result') {
        emitted = tu.input as Record<string, unknown>;
      } else if (tu.name === 'web_search') {
        const input = tu.input as { query?: unknown };
        if (typeof input.query === 'string') {
          pendingSearches.push({ toolUseId: tu.id, query: input.query });
        }
      }
    } else if (block.type === 'server_tool_use') {
      const name = block['name'];
      const id = block['id'];
      const input = block['input'] as { query?: unknown } | undefined;
      if (name === 'web_search' && typeof id === 'string' && typeof input?.query === 'string') {
        queriesById.set(id, input.query);
      }
    } else if (block.type === 'web_search_tool_result') {
      const toolUseId = block['tool_use_id'];
      const content = block['content'];
      const query = typeof toolUseId === 'string' ? (queriesById.get(toolUseId) ?? '') : '';
      if (Array.isArray(content)) {
        searches.push({ query, resultCount: content.length });
      } else if (
        content &&
        typeof content === 'object' &&
        (content as { type?: string }).type === 'web_search_tool_result_error'
      ) {
        const errorCode = (content as { error_code?: unknown }).error_code;
        searches.push({
          query,
          resultCount: 0,
          error: typeof errorCode === 'string' ? errorCode : 'unknown_error',
        });
      }
    }
  }

  return {
    emitted,
    pendingSearches,
    noTool: !emitted && pendingSearches.length === 0,
    stopReason: message.stop_reason,
    searches,
    assistantMessage: { role: 'assistant', content: message.content as ContentBlockParam[] },
  };
}

/**
 * Emit a single structured log line summarising one model turn — searches
 * issued, results returned, errors, stop reason, whether emit_result fired.
 * Cloudflare observability ties these to the worker invocation. This is the
 * canonical visibility hook for built-in web_search activity; tail
 * `wrangler tail` or filter on `[llm-turn]` in the dashboard.
 */
export function logTurnSummary(
  ctx: LlmContext,
  turn: number,
  interpreted: InterpretedResult,
): void {
  const summary = {
    runId: ctx.runId,
    workflow: ctx.workflow,
    turn,
    stopReason: interpreted.stopReason,
    emitted: Boolean(interpreted.emitted),
    searches: interpreted.searches.map((s) => ({
      query: s.query,
      resultCount: s.resultCount,
      ...(s.error ? { error: s.error } : {}),
    })),
    pendingSerps: interpreted.pendingSearches.map((s) => s.query),
  };
  console.log(`[llm-turn] ${JSON.stringify(summary)}`);
}

/**
 * Run the SearchAPI custom tool for every pending tool_use block from a
 * single assistant turn, and return one user message bundling every
 * tool_result in the same order. The Anthropic API requires a tool_result
 * for every tool_use in the prior assistant message — even when the model
 * issued multiple parallel web_search calls — so callers must pass the full
 * `interpreted.pendingSearches` list.
 */
export async function executeSearchTool(
  env: Env,
  ctx: LlmContext,
  searches: PendingSearch | PendingSearch[],
  options?: { remainingSearches?: number },
): Promise<MessageParam> {
  const list = Array.isArray(searches) ? searches : [searches];
  const blocks: ToolResultBlock[] = [];
  for (const search of list) {
    const result = await runSerpSearch(
      env,
      { q: search.query },
      { runId: ctx.runId, workflow: ctx.workflow },
    );
    let content: string;
    if (result.status !== 200) {
      content = JSON.stringify({
        error: 'search_failed',
        status: result.status,
        body: result.body,
      });
    } else {
      const organic = pickOrganicResults(result.body, 5);
      content = JSON.stringify({
        query: search.query,
        results: organic,
        cached: result.cached,
      });
    }
    blocks.push({
      type: 'tool_result',
      tool_use_id: search.toolUseId,
      content,
    });
  }
  const content: ContentBlockParam[] = [...blocks];
  if (typeof options?.remainingSearches === 'number') {
    const n = Math.max(0, options.remainingSearches);
    const hint =
      n === 0
        ? 'You have 0 searches remaining — emit emit_result with what you have.'
        : `You have ${n} search${n === 1 ? '' : 'es'} remaining. Stop searching as soon as you can call emit_result.`;
    content.push({ type: 'text', text: hint });
  }
  return { role: 'user', content };
}
