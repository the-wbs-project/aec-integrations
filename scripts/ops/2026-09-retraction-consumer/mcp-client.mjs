#!/usr/bin/env node
//
// mcp-client.mjs — a minimal JSON-RPC client for the review-app MCP server, forked for
// the AECI-882 retraction consumer.
//
// WHY A FORK AND NOT AN IMPORT. Each ops lane is self-contained by convention
// (`scripts/ops/2026-09-stranded-row-audit/mcp-client.mjs:12-15`), and this copy has to
// diverge in the one way that matters: it is the FIRST lane that calls a WRITE tool.
//
// ─── THE ALLOW-LIST IS SPLIT IN TWO, DELIBERATELY ────────────────────────────
//
// Every previous copy of this file carried one set and one door: `callTool` refused
// anything outside a read-only allow-list, which is why `docs/CICD_PLAN.md` §7.1 used to
// call AECI_MCP_TOKEN "Read-only on our side by construction". `confirm_retractions` is a
// write, so §7.1 now says the token is read-only in the AUDIT lane and read-plus-one-write
// here. Keeping that sentence true means two sets and two doors, not one widened set:
//
//   callTool(name, args)       → READ_ONLY_TOOLS only. Anything else throws.
//   callWriteTool(name, args)  → WRITE_TOOLS only. Anything else throws.
//
// A typo in the read path can therefore never reach `confirm_retractions`, and neither
// path can reach `promote_product` or the `create_*` / `update_*` family, which the same
// server exposes and which mutate the live curation DB.
//
// The caller adds one more layer on top: `consume.mjs` only reaches `callWriteTool` from
// `confirmRetractions()`, which requires the token `verifyDeleted()` returns. See that
// file's header for why confirming before deleting is the one unrecoverable move.
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
//      keyed on `CF-Connecting-IP`, checked BEFORE auth. `post` retries 429/5xx with
//      exponential backoff and honours `Retry-After`.
//
// ONE DIVERGENCE FROM THE READ LANES' RETRY POLICY. A retry is safe for a read by
// definition. It is safe for `confirm_retractions` too, but for a different reason worth
// stating rather than assuming: the tool's own contract says already-confirmed ids are
// ignored rather than re-stamped, so a replayed confirm is a no-op. That makes the write
// idempotent, which is why it shares the same backoff.

const MCP_URL = 'https://review.aecintegrations.com/mcp';

/** Reads. Deliberately narrow: this lane needs exactly one. */
const READ_ONLY_TOOLS = new Set(['list_retractions']);

/** Writes. Deliberately narrow: this lane needs exactly one. */
const WRITE_TOOLS = new Set(['confirm_retractions']);

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

  const post = async (payload, attempt = 1) => {
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
      if (RETRY_STATUSES.has(res.status) && attempt < MAX_ATTEMPTS) {
        const after = Number(res.headers.get('retry-after'));
        const waitMs =
          Number.isFinite(after) && after > 0 ? after * 1000 : 2 ** (attempt - 1) * 1000;
        await sleep(waitMs);
        return post(payload, attempt + 1);
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

  /** Shared unwrap for both doors. The allow-list check happens before this is reached. */
  const invoke = async (name, args) => {
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
    // Double-encoded: the envelope's text IS the payload, as a JSON string. When the
    // server fails INSIDE a tool it puts a bare error string here instead, so a blind
    // JSON.parse reports a useless SyntaxError. Name the tool and echo the text.
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
      clientInfo: { name: 'aeci-ops-retraction-consumer', version: '1.0.0' },
    },
  });
  if (!sessionId) throw new Error('MCP server returned no mcp-session-id on initialize.');
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' });

  return {
    /** Door 1 — reads only. */
    async callTool(name, args) {
      if (!READ_ONLY_TOOLS.has(name)) {
        throw new Error(
          `Refusing to call MCP tool "${name}" through the READ door. ` +
            `Allowed: ${[...READ_ONLY_TOOLS].join(', ')}.`,
        );
      }
      return invoke(name, args);
    },

    /**
     * Door 2 — writes only. Reachable in this lane from exactly one place:
     * `confirmRetractions()` in consume.mjs, which requires a verification token.
     */
    async callWriteTool(name, args) {
      if (!WRITE_TOOLS.has(name)) {
        throw new Error(
          `Refusing to call MCP tool "${name}" through the WRITE door. ` +
            `Allowed: ${[...WRITE_TOOLS].join(', ')}.`,
        );
      }
      return invoke(name, args);
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
