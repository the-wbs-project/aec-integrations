// ---------------------------------------------------------------------------
// Anthropic Messages API wrapper that routes through the Cloudflare AI Gateway
// using the Workers `AI` binding (`env.AI.gateway(id).run(...)`).
//
// Every call is synchronous — no Anthropic batch API, no polling — so workflow
// turns map 1:1 to a single fetch through the gateway.
// ---------------------------------------------------------------------------
import type { Env } from '../env';

const ANTHROPIC_VERSION = '2023-06-01';

export interface MessageRequestBody {
  model: string;
  max_tokens: number;
  temperature?: number;
  system?: string;
  messages: unknown[];
  tools?: unknown[];
  tool_choice?: { type: 'auto' | 'any' };
}

/** Subset of the Anthropic Messages API response we read in this app. */
export interface MessageResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: unknown[];
  stop_reason: string | null;
  stop_sequence: string | null;
  usage?: { input_tokens: number; output_tokens: number };
}

export interface GatewayContext {
  runId?: string;
  workflow?: string;
}

export async function runMessage(
  env: Env,
  ctx: GatewayContext,
  body: MessageRequestBody,
): Promise<MessageResponse> {
  const headers: Record<string, string> = {
    'anthropic-version': ANTHROPIC_VERSION,
    'Content-Type': 'application/json',
  };

  const metadata: Record<string, string> = {};
  if (ctx.runId) metadata['runId'] = ctx.runId;
  if (ctx.workflow) metadata['workflow'] = ctx.workflow;
  const hasMetadata = Object.keys(metadata).length > 0;

  const response = await env.AI.gateway(env.AI_GATEWAY_ID).run(
    {
      provider: 'anthropic',
      endpoint: 'v1/messages',
      headers,
      query: body,
    },
    hasMetadata ? { gateway: { id: env.AI_GATEWAY_ID, metadata } } : undefined,
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Anthropic via AI Gateway failed (${response.status}): ${text}`);
  }
  return (await response.json()) as MessageResponse;
}
