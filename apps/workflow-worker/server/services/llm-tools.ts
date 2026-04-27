// ---------------------------------------------------------------------------
// Standard tool schemas exposed to Claude.
//
//   - WEB_SEARCH_TOOL       → Anthropic built-in web_search_20250305 (fallback)
//   - searchApiToolSchema() → custom 'web_search' tool backed by SearchAPI.io
//   - emitResultTool()      → forced structured-output channel
//
// The model is steered to call `emit_result` exactly once at the end. Both
// search modes share the same `web_search` tool name so prompt templates
// don't have to branch.
//
// Note: we deliberately use literal object types here instead of the SDK's
// `Anthropic.Messages.WebSearchTool20250305` / `Anthropic.Messages.ToolUnion`
// names so this code isn't coupled to SDK version churn. The shapes are
// validated against the Anthropic API surface, not the SDK type tree.
// ---------------------------------------------------------------------------
import type { OutputSchema } from '../lib/llm';

export interface CustomTool {
  name: string;
  description?: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

export interface WebSearchTool {
  type: 'web_search_20250305';
  name: 'web_search';
  max_uses?: number;
}

export type Tool = CustomTool | WebSearchTool;

/**
 * Hard cap on tool calls per workflow run. Applies to both modes:
 *   - Anthropic built-in: passed as `max_uses` on the tool definition.
 *   - SearchAPI custom:    enforced by the workflow loop (MAX_TURNS already
 *     bounds it, but we re-export this constant for clarity).
 */
export const MAX_TOOL_USES = 2;

export const WEB_SEARCH_TOOL: WebSearchTool = {
  type: 'web_search_20250305',
  name: 'web_search',
  max_uses: MAX_TOOL_USES,
};

/**
 * Custom SearchAPI.io tool. Same name as the built-in web_search so the
 * prompt is identical in both modes. When the model emits a tool_use of this
 * shape, the runner executes the search server-side, then submits a follow-up
 * batch carrying the tool_result.
 */
export function searchApiToolSchema(maxResults = 5): CustomTool {
  return {
    name: 'web_search',
    description: `Run a Google search via SearchAPI.io. Returns up to ${maxResults} organic results with title, link, and snippet. Call at most ${MAX_TOOL_USES} times.`,
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query string. May include site: filters.',
        },
      },
      required: ['query'],
    },
  };
}

/**
 * The structured-output channel — workflows force the model to call this
 * exactly once with the answer payload that matches the workflow's schema.
 */
export function emitResultTool(schema: OutputSchema): CustomTool {
  return {
    name: 'emit_result',
    description:
      'Emit your final structured answer for this enrichment task. Call this exactly once after gathering enough information.',
    input_schema: {
      type: 'object',
      properties: schema.properties,
      required: schema.required,
      ...(schema.additionalProperties !== undefined
        ? { additionalProperties: schema.additionalProperties }
        : {}),
    },
  };
}
