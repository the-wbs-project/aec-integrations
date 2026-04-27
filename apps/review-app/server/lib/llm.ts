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
  MAX_TOOL_USES,
  type Tool,
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
}

export function buildInitialRequest(input: BuildInitialRequestInput): MessageRequestBody {
  const tools: Tool[] = [
    input.searchTool === 'web' ? WEB_SEARCH_TOOL : searchApiToolSchema(),
    emitResultTool(input.outputSchema),
  ];
  return {
    model: input.model,
    max_tokens: input.maxTokens ?? 8192,
    temperature: 0,
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
}

export function buildContinuationRequest(
  input: BuildContinuationRequestInput,
): MessageRequestBody {
  const tools: Tool[] = [searchApiToolSchema(), emitResultTool(input.outputSchema)];
  return {
    model: input.model,
    max_tokens: input.maxTokens ?? 8192,
    temperature: 0,
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

export interface InterpretedResult {
  /** Set when the model called emit_result — final structured answer. */
  emitted?: Record<string, unknown>;
  /** Set when the model called the custom 'web_search' tool. */
  pendingSearch?: { toolUseId: string; query: string };
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
  let pendingSearch: { toolUseId: string; query: string } | undefined;
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
          pendingSearch = { toolUseId: tu.id, query: input.query };
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
    pendingSearch,
    noTool: !emitted && !pendingSearch,
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
    pendingSerp: interpreted.pendingSearch?.query,
  };
  console.log(`[llm-turn] ${JSON.stringify(summary)}`);
}

/**
 * Run the SearchAPI custom tool for one tool_use block. Returns the
 * tool_result message that gets appended before the next turn.
 */
export async function executeSearchTool(
  env: Env,
  ctx: LlmContext,
  search: { toolUseId: string; query: string },
): Promise<MessageParam> {
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
  const toolResult: ToolResultBlock = {
    type: 'tool_result',
    tool_use_id: search.toolUseId,
    content,
  };
  return { role: 'user', content: [toolResult] };
}
