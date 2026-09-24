#!/usr/bin/env node
//
// mcp-client.mjs — a minimal JSON-RPC client for the review-app MCP server, forked for
// the AECI-1064 connector-attribution re-promote.
//
// WHY A FORK AND NOT AN IMPORT. Each ops lane is self-contained by convention. This copy
// takes the two-door shape from scripts/ops/2026-09-retraction-consumer/mcp-client.mjs,
// because it is the second lane that calls a WRITE tool, and that write is
// `promote_product`: it publishes to production.
//
// ─── TWO DOORS ────────────────────────────────────────────────────────────────
//
//   callTool(name, args)       → READ_ONLY_TOOLS only. Anything else throws.
//   callWriteTool(name, args)  → WRITE_TOOLS only. Anything else throws.
//
// `repromote.mjs` reaches `callWriteTool` from exactly one place: `promoteOne()` in the
// `apply` subcommand, behind `--confirm-count`. The manifest, preflight, dry-run and
// verify subcommands never open the write door.
//
// ─── THE WRITE DOOR NEVER RETRIES ─────────────────────────────────────────────
//
// The read door retries 429/5xx with backoff, as every copy of this file does. The write
// door does not. A retried `promote_product` is exactly the AECI-1095 shape: the second
// call finds the first call's pending marker, re-collects that job, and reports `ok`
// having sent nothing. A 429 or 5xx on the write is surfaced and the run stops.
//
// TRANSPORT NOTES, carried verbatim from the audit lane because each one cost an
// afternoon to rediscover:
//   1. It is Streamable HTTP, so the handshake is three calls, not one: `initialize`,
//      then read the `mcp-session-id` RESPONSE HEADER, then `notifications/initialized`
//      (a notification — no id, no reply). Skipping the third makes tools/call fail.
//   2. Responses come back SSE-framed (`content-type: text/event-stream`) even for a
//      single reply, so the body is `event: message\ndata: {...}` — not bare JSON.
//   3. The tool payload is DOUBLE-encoded: the JSON-RPC envelope's
//      `result.content[0].text` is itself a JSON *string* that must be parsed again.
//   4. The server RATE-LIMITS (429 `{"error":"rate_limited"}`) at 100 requests / 10 s
//      keyed on `CF-Connecting-IP`, checked BEFORE auth.

const MCP_URL = 'https://review.aecintegrations.com/mcp';

/** Reads this lane needs. `get_promote_status` finishes a pending job but publishes nothing new. */
const READ_ONLY_TOOLS = new Set([
  'list_integrations',
  'list_products',
  'get_product',
  'get_promote_status',
]);

/** Writes. Exactly one, reachable only from `apply`. */
const WRITE_TOOLS = new Set(['promote_product']);

/** Throws a usage-shaped error when the token is missing, naming where it comes from. */
export function requireMcpToken() {
  const token = process.env.AECI_MCP_TOKEN;
  if (!token) {
    throw new Error(
      'AECI_MCP_TOKEN is not set. It is injected from the Conductor keychain\n' +
        '  (.conductor/settings.local.toml → [environment_variables]) and is the same\n' +
        '  bearer .mcp.json uses for the `aeci-review` server. Export it and re-run.',
    );
  }
  return token;
}

/**
 * Pull every `data:` payload out of an SSE body. A single JSON body (should the server
 * ever stop framing) parses as one entry, so callers do not care which they got.
 */
function parseSseFrames(body) {
  const trimmed = body.trim();
  if (!trimmed.startsWith('event:') && !trimmed.startsWith('data:')) return [JSON.parse(trimmed)];
  return trimmed
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => JSON.parse(line.slice('data:'.length).trim()));
}

/**
 * Complete the MCP handshake and return a session with the two doors described in the
 * header. One session per process; the server keys state on `mcp-session-id`.
 */
export async function openMcpSession({ url = MCP_URL, token = requireMcpToken() } = {}) {
  let nextId = 1;
  let sessionId = null;

  const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
  const MAX_ATTEMPTS = 6;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const post = async (payload, { retry = true } = {}, attempt = 1) => {
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      // Both, because the server picks the framing and we accept either.
      Accept: 'application/json, text/event-stream',
    };
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;

    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
    // The session id is only ever on the `initialize` response.
    if (!sessionId) sessionId = res.headers.get('mcp-session-id');

    if (!res.ok) {
      const detail = await res.text();
      if (retry && RETRY_STATUSES.has(res.status) && attempt < MAX_ATTEMPTS) {
        const after = Number(res.headers.get('retry-after'));
        const waitMs =
          Number.isFinite(after) && after > 0 ? after * 1000 : 2 ** (attempt - 1) * 1000;
        await sleep(waitMs);
        return post(payload, { retry }, attempt + 1);
      }
      throw new Error(`MCP ${payload.method} → ${res.status} ${res.statusText}: ${detail}`);
    }
    // A notification gets a 202 with an empty body — nothing to parse.
    if (payload.id === undefined) {
      await res.text();
      return null;
    }

    const frames = parseSseFrames(await res.text());
    const envelope = frames.find((f) => f.id === payload.id) ?? frames[0];
    if (envelope?.error) {
      throw new Error(
        `MCP ${payload.method} error ${envelope.error.code}: ${envelope.error.message}`,
      );
    }
    return envelope?.result;
  };

  /**
   * Shared unwrap for both doors. A tool that fails INSIDE the server returns
   * `isError: true` with a bare message instead of JSON. That comes back as
   * `{ isError: true, message }` so the caller can record it and stop, rather than a
   * SyntaxError that loses the text.
   */
  const invoke = async (name, args, opts) => {
    const result = await post(
      { jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } },
      opts,
    );
    const text = result?.content?.[0]?.text;
    if (typeof text !== 'string') {
      throw new Error(`MCP ${name} returned no text content: ${JSON.stringify(result)}`);
    }
    if (result.isError) return { isError: true, message: text };
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`MCP ${name} returned a non-JSON payload: ${text.slice(0, 300)}`);
    }
  };

  await post({
    jsonrpc: '2.0',
    id: nextId++,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'aeci-ops-connector-attribution-repromote', version: '1.0.0' },
    },
  });
  if (!sessionId) throw new Error('MCP server returned no mcp-session-id on initialize.');
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' });

  return {
    /** Door 1 — reads only, retried. */
    async callTool(name, args) {
      if (!READ_ONLY_TOOLS.has(name)) {
        throw new Error(
          `Refusing to call MCP tool "${name}" through the READ door. ` +
            `Allowed: ${[...READ_ONLY_TOOLS].join(', ')}.`,
        );
      }
      const out = await invoke(name, args, { retry: true });
      if (out?.isError) throw new Error(`MCP ${name} failed: ${out.message.slice(0, 300)}`);
      return out;
    },

    /** Door 2 — writes only, never retried. Reachable from `promoteOne()` in repromote.mjs. */
    async callWriteTool(name, args) {
      if (!WRITE_TOOLS.has(name)) {
        throw new Error(
          `Refusing to call MCP tool "${name}" through the WRITE door. ` +
            `Allowed: ${[...WRITE_TOOLS].join(', ')}.`,
        );
      }
      return invoke(name, args, { retry: false });
    },
  };
}

/**
 * Drain an offset-paginated list tool. The server caps `limit` at 200 and reports the
 * unpaginated `total`, which is also the reconciliation number we print.
 */
export async function listAll(session, tool, args = {}, pageSize = 200) {
  const rows = [];
  let total;
  for (let offset = 0; ; offset += pageSize) {
    const page = await session.callTool(tool, { ...args, limit: pageSize, offset });
    total = page.total;
    rows.push(...page.data);
    if (rows.length >= total || page.data.length === 0) break;
  }
  return { rows, total };
}
