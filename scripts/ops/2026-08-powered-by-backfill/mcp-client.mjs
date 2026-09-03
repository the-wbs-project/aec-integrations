#!/usr/bin/env node
//
// mcp-client.mjs — a minimal JSON-RPC client for the review-app MCP server.
//
// WHY THIS EXISTS. The curation catalog is upstream of this repo and has no REST
// surface documented here (docs/REVIEW_APP_PROMOTE_API.md is one-directional: it is
// the contract for the review app pushing INTO us). The sibling strand audit
// (scripts/ops/2026-08-promote-strand-audit/audit.mjs) reads the Airtable base
// directly instead — but that needs AIRTABLE_TOKEN, which is deliberately NOT in this
// repo's environment. AECI_MCP_TOKEN is (.mcp.json + the Conductor keychain), and the
// MCP server exposes exactly the two reads this sweep needs, already joined:
//
//   list_integrations → `supabaseId`            (the D1 integrations.id — the join key)
//                       `poweredByProduct.id`   (an Airtable rec id)
//   get_product       → `supabaseId`            (the D1 products.id for that rec id)
//
// So this file speaks MCP rather than adding a second credential.
//
// TRANSPORT NOTES, all of which cost an afternoon to rediscover:
//   1. It is Streamable HTTP, so the handshake is three calls, not one: `initialize`,
//      then read the `mcp-session-id` RESPONSE HEADER, then `notifications/initialized`
//      (a notification — no id, no reply). Skipping the third makes tools/call fail.
//   2. Responses come back SSE-framed (`content-type: text/event-stream`) even for a
//      single reply, so the body is `event: message\ndata: {...}` — not bare JSON.
//   3. The tool payload is DOUBLE-encoded: the JSON-RPC envelope's
//      `result.content[0].text` is itself a JSON *string* that must be parsed again.
//
// READ-ONLY BY CONSTRUCTION. `callTool` refuses any tool name that is not on the
// allow-list below. The same server exposes promote_product and the create_*/update_*
// family, which mutate the live curation DB and push into production — an ops sweep
// has no business being one typo away from those.

const MCP_URL = 'https://review.aecintegrations.com/mcp';

// Every tool this ops lane is permitted to call. Additive only, and read tools only.
const READ_ONLY_TOOLS = new Set([
  'list_integrations',
  'get_integration',
  'list_products',
  'get_product',
  'list_vendors',
  'get_vendor',
]);

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
 * Complete the MCP handshake and return a session whose `callTool` returns the parsed
 * tool payload. One session per process; the server keys state on `mcp-session-id`.
 */
export async function openMcpSession({ url = MCP_URL, token = requireMcpToken() } = {}) {
  let nextId = 1;
  let sessionId = null;

  const post = async (payload) => {
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

  await post({
    jsonrpc: '2.0',
    id: nextId++,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'aeci-ops-powered-by-backfill', version: '1.0.0' },
    },
  });
  if (!sessionId) throw new Error('MCP server returned no mcp-session-id on initialize.');
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' });

  return {
    /** Call a read tool and return its payload, already unwrapped and parsed. */
    async callTool(name, args) {
      if (!READ_ONLY_TOOLS.has(name)) {
        throw new Error(
          `Refusing to call MCP tool "${name}" — this ops client is read-only. ` +
            `Allowed: ${[...READ_ONLY_TOOLS].join(', ')}.`,
        );
      }
      const result = await post({
        jsonrpc: '2.0',
        id: nextId++,
        method: 'tools/call',
        params: { name, arguments: args },
      });
      const text = result?.content?.[0]?.text;
      if (typeof text !== 'string') {
        throw new Error(`MCP ${name} returned no text content: ${JSON.stringify(result)}`);
      }
      // Double-encoded: the envelope's text IS the payload, as a JSON string.
      return JSON.parse(text);
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

/**
 * Bounded-concurrency map. Not the Worker connection-limit rule (this is Node, not
 * workerd) — it is here so a few hundred get_product calls do not open a few hundred
 * sockets against the review app at once.
 */
export async function mapWithConcurrency(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
