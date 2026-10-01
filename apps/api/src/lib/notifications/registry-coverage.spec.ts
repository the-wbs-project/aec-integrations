/**
 * Every sender names a notification registry entry (AECI-1199).
 *
 * This is an INVARIANT test: it encodes a decision, not behaviour. The registry at
 * `lib/notifications/registry.ts` is the one list of everything AECi sends, and the
 * list is only true while no sender can ship without an entry. The types already
 * demand an id at each seam. This scan closes the gaps the types cannot see: a new
 * Resend call that bypasses the transport, a raw `'notification.sent'` audit row, a
 * Linear mutation sent through `linearGraphql` directly, and a registry entry nothing
 * sends any more.
 *
 * Asserted over module SOURCE because behaviour cannot see the absence of a thing.
 * Modelled on `routes/banned-at-writers.spec.ts` (the walk and the non-vacuous floor)
 * and `packages/shared/src/version-diff.consult-sites.spec.ts` (match the CALL form,
 * not the bare name). Comments are stripped first, so prose that names a sender is
 * not a call.
 *
 * **The `sendEmail` name collision.** `routes/vendor-seat-invites.ts` takes an
 * injected seat-invite callback as a parameter named `sendEmail`. That is not the
 * cron transport. So a `sendEmail(` call counts only in a file that imports
 * `sendEmail` from the `email` module, and an aliased import of either transport is
 * itself a violation, because it would hide calls from this rule.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { NOTIFICATIONS, type NotificationEntry } from './registry';

/** Vitest runs with cwd = apps/api. */
const SRC = join(process.cwd(), 'src');

const REGISTRY_FILE = 'lib/notifications/registry.ts';
const FIX_HINT = 'Add an entry to apps/api/src/lib/notifications/registry.ts and name its id here.';

const ENTRIES = Object.entries(NOTIFICATIONS) as Array<[string, NotificationEntry]>;
const sendsEmail = (e: NotificationEntry) => e.channel === 'email' || e.channel === 'email+portal';
const TRANSACTIONAL_IDS = new Set(
  ENTRIES.filter(([id, e]) => sendsEmail(e) && !id.startsWith('digest-')).map(([id]) => id),
);
const DIGEST_IDS = new Set(
  ENTRIES.filter(([id, e]) => sendsEmail(e) && id.startsWith('digest-')).map(([id]) => id),
);
const LINEAR_IDS = new Set(ENTRIES.filter(([, e]) => e.channel === 'linear').map(([id]) => id));

/** The Linear mutations that notify people. Any other constant holding one is a violation. */
const NOTIFYING_MUTATIONS = [
  'ISSUE_CREATE_MUTATION',
  'COMMENT_CREATE_MUTATION',
  'ISSUE_UPDATE_MUTATION',
] as const;
const MUTATION_TEXT = /\b(issueCreate|commentCreate|issueUpdate)\s*\(/g;

interface Source {
  /** Path relative to `src/`, POSIX separators. */
  rel: string;
  source: string;
}

interface Violation {
  rel: string;
  line: number;
  rule: string;
  detail: string;
}

interface ScanResult {
  violations: Violation[];
  counts: { transactional: number; digest: number; ledgerWrites: number; linearWrites: number };
}

// ─── A tokenizer just good enough to skip strings, templates, regexes, comments ─

/** The previous significant character after which a `/` starts a regex literal. */
const REGEX_PREFIX = new Set([...'(,=:[!&|?{};+-*%<>~^', '']);

function skipString(src: string, start: number): number {
  const quote = src[start];
  let j = start + 1;
  while (j < src.length) {
    const c = src[j]!;
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (quote === '`') {
      if (c === '`') return j + 1;
      if (c === '$' && src[j + 1] === '{') {
        j = skipBalanced(src, j + 1, '{', '}');
        continue;
      }
    } else {
      if (c === quote) return j + 1;
      if (c === '\n') return j;
    }
    j++;
  }
  return j;
}

function skipRegex(src: string, start: number): number {
  let j = start + 1;
  let inClass = false;
  while (j < src.length) {
    const c = src[j]!;
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (c === '\n') return j;
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) {
      j++;
      while (j < src.length && /[a-z]/.test(src[j]!)) j++;
      return j;
    }
    j++;
  }
  return j;
}

/** Index just past the bracket that closes the one at `openIdx`. */
function skipBalanced(src: string, openIdx: number, open: string, close: string): number {
  let depth = 0;
  let j = openIdx;
  let prev = '';
  while (j < src.length) {
    const c = src[j]!;
    if (c === "'" || c === '"' || c === '`') {
      j = skipString(src, j);
      prev = c;
      continue;
    }
    if (c === '/' && src[j + 1] !== '/' && src[j + 1] !== '*' && REGEX_PREFIX.has(prev)) {
      j = skipRegex(src, j);
      prev = '/';
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return j + 1;
    }
    if (!/\s/.test(c)) prev = c;
    j++;
  }
  return j;
}

/** Comments become spaces. Strings, regexes and line numbers are kept. */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  let prev = '';
  while (i < src.length) {
    const c = src[i]!;
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') {
        out += ' ';
        i++;
      }
      continue;
    }
    if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const end = skipString(src, i);
      out += src.slice(i, end);
      i = end;
      prev = c;
      continue;
    }
    if (c === '/' && REGEX_PREFIX.has(prev)) {
      const end = skipRegex(src, i);
      out += src.slice(i, end);
      i = end;
      prev = '/';
      continue;
    }
    out += c;
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out;
}

const blank = (s: string) => s.replace(/[^\n]/g, ' ');
const lineOf = (src: string, idx: number) => src.slice(0, idx).split('\n').length;

/** Every `name(` call in `src`, with its argument text. Declarations are skipped. */
function callsOf(src: string, name: string): Array<{ index: number; end: number; args: string }> {
  const out: Array<{ index: number; end: number; args: string }> = [];
  const pattern = new RegExp(`(?<![\\w$])${name}\\s*(?:<[^>()]*>)?\\s*\\(`, 'g');
  for (const match of src.matchAll(pattern)) {
    const before = src.slice(Math.max(0, match.index - 20), match.index);
    if (/\bfunction\s*$/.test(before)) continue;
    const open = match.index + match[0].length - 1;
    const end = skipBalanced(src, open, '(', ')');
    out.push({ index: match.index, end, args: src.slice(open + 1, end - 1) });
  }
  return out;
}

const quoted = (text: string) =>
  [...text.matchAll(/'([^'\n]*)'|"([^"\n]*)"/g)].map((m) => m[1] ?? m[2]!);

/** The value expression of `key:` in an object literal's text, up to the next top-level comma. */
function propertyValue(args: string, key: string): string | null {
  const match = args.match(new RegExp(`(?<![\\w$.])${key}\\s*:\\s*`));
  if (!match || match.index === undefined) return null;
  const start = match.index + match[0].length;
  let j = start;
  while (j < args.length) {
    const c = args[j]!;
    if (c === "'" || c === '"' || c === '`') j = skipString(args, j);
    else if (c === '(') j = skipBalanced(args, j, '(', ')');
    else if (c === '{') j = skipBalanced(args, j, '{', '}');
    else if (c === '[') j = skipBalanced(args, j, '[', ']');
    else if (c === ',' || c === '}' || c === '\n') break;
    else j++;
  }
  return args.slice(start, j).trim();
}

/** A value that names registry ids by literal: at least one, and every literal is one. */
function namesIds(value: string | null, allowed: ReadonlySet<string>): boolean {
  if (!value) return false;
  const literals = quoted(value);
  return literals.length > 0 && literals.every((id) => allowed.has(id));
}

// ─── The scan ────────────────────────────────────────────────────────────────

function scanSources(sources: readonly Source[]): ScanResult {
  const violations: Violation[] = [];
  const counts = { transactional: 0, digest: 0, ledgerWrites: 0, linearWrites: 0 };
  const flag = (rel: string, src: string, idx: number, rule: string, detail: string) =>
    violations.push({ rel, line: lineOf(src, idx), rule, detail });

  for (const { rel, source } of sources) {
    const src = stripComments(source);

    // An aliased transport import would hide its calls from every rule below.
    for (const m of src.matchAll(
      /import\s*(?:type\s*)?\{[^}]*\b(sendEmail|sendTransactionalEmail)\s+as\b/g,
    )) {
      flag(rel, src, m.index, 'aliased-transport', `${m[1]} is imported under another name`);
    }

    // 1. `sendTransactionalEmail(…, { template: '<id>' })`.
    for (const call of callsOf(src, 'sendTransactionalEmail')) {
      counts.transactional++;
      if (!namesIds(propertyValue(call.args, 'template'), TRANSACTIONAL_IDS)) {
        flag(
          rel,
          src,
          call.index,
          'sendTransactionalEmail',
          'template does not name a registry email id',
        );
      }
    }

    // 2. The cron transport, only where `sendEmail` is the import from the email module.
    const importsTransport =
      /import\s*\{[^}]*(?<![\w$])sendEmail(?![\w$])[^}]*\}\s*from\s*['"][^'"]*\/email['"]/.test(
        src,
      );
    if (importsTransport) {
      for (const call of callsOf(src, 'sendEmail')) {
        counts.digest++;
        if (!namesIds(propertyValue(call.args, 'notification'), DIGEST_IDS)) {
          flag(
            rel,
            src,
            call.index,
            'sendEmail',
            'notification does not name a registry digest id',
          );
        }
      }
    }

    // 3. `notification.sent` audit rows. The literal belongs only to the constant.
    for (const m of src.matchAll(/['"`]notification\.sent['"`]/g)) {
      const lineStart = src.lastIndexOf('\n', m.index) + 1;
      if (!/export const NOTIFICATION_SENT_ACTION\s*=\s*$/.test(src.slice(lineStart, m.index))) {
        flag(
          rel,
          src,
          m.index,
          'notification.sent',
          "a raw 'notification.sent' bypasses NOTIFICATION_SENT_ACTION",
        );
      }
    }
    const withoutImports = src.replace(
      /import\s*(?:type\s*)?\{[^}]*\}\s*from\s*['"][^'"]+['"]/g,
      blank,
    );
    for (const m of withoutImports.matchAll(/(?<![\w$])NOTIFICATION_SENT_ACTION(?![\w$])/g)) {
      const before = withoutImports.slice(Math.max(0, m.index - 80), m.index);
      if (/export const\s*$/.test(before)) continue;
      // The two read-only uses: the attestation suppression read and the vendor feed.
      if (/eq\(\s*auditLog\.action\s*,\s*$/.test(before)) continue;
      if (!/\baction\s*:\s*$/.test(before)) {
        flag(
          rel,
          src,
          m.index,
          'NOTIFICATION_SENT_ACTION',
          'a use that is neither a known read nor an `action:` write',
        );
        continue;
      }
      counts.ledgerWrites++;
      const fnStart =
        [...withoutImports.slice(0, m.index).matchAll(/\bfunction\s+[\w$]+/g)].at(-1)?.index ?? 0;
      const nextFn = withoutImports.slice(m.index).search(/\bfunction\s+[\w$]+/);
      const body = withoutImports.slice(
        fnStart,
        nextFn === -1 ? withoutImports.length : m.index + nextFn,
      );
      const takesId = /\bnotification\s*:\s*[^,)=]*NotificationId\b/.test(body);
      if (!takesId || !/\bnotificationId\b/.test(body)) {
        flag(
          rel,
          src,
          m.index,
          'NOTIFICATION_SENT_ACTION',
          'the writing builder must take `notification: …NotificationId` and record it as metadata.notificationId',
        );
      }
    }

    // 4. Linear mutations that notify people. The GraphQL text may live only in one of
    //    the scanned constants, and each constant only travels through
    //    `linearNotificationWrite(<id>, …)`.
    const declaration = /const\s+([A-Z_]+)\s*=\s*`([^`]*)`/g;
    for (const m of src.matchAll(declaration)) {
      if (![...m[2]!.matchAll(MUTATION_TEXT)].length) continue;
      if (!(NOTIFYING_MUTATIONS as readonly string[]).includes(m[1]!)) {
        flag(
          rel,
          src,
          m.index,
          'linear-mutation',
          `${m[1]} holds a notifying mutation under an unscanned name`,
        );
      }
    }
    const outsideDeclarations = src.replace(declaration, blank);
    for (const m of outsideDeclarations.matchAll(MUTATION_TEXT)) {
      // GraphQL text in a string on this line, not an identifier that happens to match.
      const lineStart = outsideDeclarations.lastIndexOf('\n', m.index) + 1;
      if (/[`'"]/.test(outsideDeclarations.slice(lineStart, m.index))) {
        flag(
          rel,
          src,
          m.index,
          'linear-mutation',
          'notifying GraphQL text outside a scanned mutation constant',
        );
      }
    }
    const writes = callsOf(outsideDeclarations, 'linearNotificationWrite');
    for (const name of NOTIFYING_MUTATIONS) {
      for (const m of outsideDeclarations.matchAll(
        new RegExp(`(?<![\\w$])${name}(?![\\w$])`, 'g'),
      )) {
        counts.linearWrites++;
        const call = writes.find((w) => w.index < m.index && m.index < w.end);
        const firstArg = call?.args.split(',')[0]?.trim() ?? '';
        const named = namesIds(firstArg, LINEAR_IDS) || /(?:^|\.)notification$/.test(firstArg);
        if (!call || !named) {
          flag(
            rel,
            src,
            m.index,
            'linear-mutation',
            `${name} must be sent through linearNotificationWrite(<linear registry id>, …)`,
          );
        }
      }
    }
  }
  return { violations, counts };
}

function sourceFiles(dir: string, acc: Source[] = []): Source[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'test') continue;
      sourceFiles(full, acc);
      continue;
    }
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.spec.ts')) continue;
    acc.push({
      rel: full.slice(SRC.length + 1).replaceAll('\\', '/'),
      source: readFileSync(full, 'utf8'),
    });
  }
  return acc;
}

const format = (v: Violation) => `${v.rel}:${v.line} [${v.rule}] ${v.detail}. ${FIX_HINT}`;

// ─── The invariant ───────────────────────────────────────────────────────────

describe('every sender names a notification registry entry', () => {
  const files = sourceFiles(SRC);
  const { violations, counts } = scanSources(files);

  it('scans a non-trivial tree and finds the known senders (the scan is not vacuous)', () => {
    expect(files.length).toBeGreaterThan(100);
    // The 19 per-template calls in lib/email.ts. Was 22: AECI-1204 replaced the five
    // per-finding attestation senders with the two digests.
    expect(counts.transactional).toBeGreaterThanOrEqual(19);
    // The two cron digests in scheduled.ts.
    expect(counts.digest).toBeGreaterThanOrEqual(2);
    // Seven builders: the attestation ledger, claim, contest, claim_added, update,
    // retire and create.
    expect(counts.ledgerWrites).toBeGreaterThanOrEqual(7);
    // Request issue, duplicate comment, contest issue, resolution update and comment.
    expect(counts.linearWrites).toBeGreaterThanOrEqual(5);
  });

  it('finds no sender that names no registry id', () => {
    expect(violations.map(format)).toEqual([]);
  });

  it('has no dead entries: every id the app sends appears as a literal at a sender', () => {
    const corpus = files
      .filter((f) => f.rel !== REGISTRY_FILE)
      .map((f) => stripComments(f.source))
      .join('\n');
    const dead = ENTRIES.filter(([, e]) => e.trigger.kind !== 'supabase')
      .map(([id]) => id)
      .filter((id) => !corpus.includes(`'${id}'`));
    expect(dead, 'registry ids no code sends. Delete the entry or restore the sender.').toEqual([]);
  });
});

// ─── The scan catches what it claims to (planted violations) ──────────────────

describe('registry coverage scan self-test', () => {
  const scan = (source: string, rel = 'lib/planted.ts') => scanSources([{ rel, source }]);
  const rules = (source: string, rel?: string) => scan(source, rel).violations.map((v) => v.rule);

  it('flags a transactional send with an unregistered template', () => {
    const source = `
      export function sendNew(c) {
        return sendTransactionalEmail(c, { to: 'a@b.com', template: 'brand-new-thing', subject: 's' });
      }`;
    expect(rules(source)).toEqual(['sendTransactionalEmail']);
  });

  it('flags a transactional send whose template is not a literal', () => {
    expect(rules(`sendTransactionalEmail(c, { to, template: someVar, subject });`)).toEqual([
      'sendTransactionalEmail',
    ]);
  });

  it('accepts a registered template, and a variant defaulting to one', () => {
    expect(
      rules(`sendTransactionalEmail(c, { to, template: 'review-submitted', subject });`),
    ).toEqual([]);
    expect(
      rules(
        `sendTransactionalEmail(c, { to, template: opts.notification ?? 'vendor-seat-invite' });`,
      ),
    ).toEqual([]);
  });

  it('flags a digest send with no registry id', () => {
    const source = `
      import { sendEmail } from './lib/email';
      await sendEmail(env, { from: 'x', to: ['a@b.com'], subject: 's', text: 't' });`;
    expect(rules(source)).toEqual(['sendEmail']);
  });

  it('does not mistake the seat-invite callback parameter named sendEmail for the transport', () => {
    const source = `
      export function createHandler(dbFor = getDb, sendEmail: SendSeatInviteEmail = noop) {
        return async (c) => { c.executionCtx.waitUntil(sendEmail(c, { to: email, token })); };
      }`;
    expect(rules(source, 'routes/vendor-seat-invites.ts')).toEqual([]);
  });

  it('flags an aliased transport import', () => {
    expect(rules(`import { sendEmail as mail } from '../lib/email';`)).toEqual([
      'aliased-transport',
    ]);
  });

  it('ignores a sender named only in a comment', () => {
    expect(rules(`// sendTransactionalEmail(c, { template: 'nope' })\nconst x = 1;`)).toEqual([]);
  });

  it('flags a notification.sent builder that takes no registry id', () => {
    const source = `
      export function newNotificationAudit(actor, metadata) {
        return { actorId: null, action: NOTIFICATION_SENT_ACTION, metadata };
      }`;
    expect(rules(source)).toEqual(['NOTIFICATION_SENT_ACTION']);
  });

  it('accepts a builder that takes the id and records it', () => {
    const source = `
      export function okAudit(notification: PortalNotificationId, actor, metadata) {
        return { action: NOTIFICATION_SENT_ACTION, metadata: { notificationId: notification, ...metadata } };
      }`;
    expect(rules(source)).toEqual([]);
  });

  it('allows the read form and flags a raw notification.sent literal', () => {
    expect(rules(`db.select().where(eq(auditLog.action, NOTIFICATION_SENT_ACTION));`)).toEqual([]);
    expect(rules(`const row = { action: 'notification.sent' };`)).toEqual(['notification.sent']);
  });

  it('flags a notifying Linear mutation sent around the registry seam', () => {
    const source = `
      const ISSUE_CREATE_MUTATION = \`mutation X { issueCreate(input: $input) { success } }\`;
      await linearGraphql(apiKey, ISSUE_CREATE_MUTATION, {}, fetchImpl);`;
    expect(rules(source)).toEqual(['linear-mutation']);
  });

  it('flags a notifying mutation under an unscanned constant name', () => {
    const source = 'const NEW_COMMENT = `mutation Y { commentCreate(input: $input) { success } }`;';
    expect(rules(source)).toEqual(['linear-mutation']);
  });

  it('accepts a Linear write that names a registry id', () => {
    const source = `
      const COMMENT_CREATE_MUTATION = \`mutation Y { commentCreate(input: $input) { success } }\`;
      await linearNotificationWrite<P>('linear-request-duplicate-comment', apiKey, COMMENT_CREATE_MUTATION, {}, f);
      await linearNotificationWrite<P>(input.notification, apiKey, COMMENT_CREATE_MUTATION, {}, f);`;
    expect(rules(source)).toEqual([]);
  });

  it('prints a failure that points at the registry', () => {
    const [violation] = scan(`sendTransactionalEmail(c, { template: 'nope' });`).violations;
    expect(format(violation!)).toContain('apps/api/src/lib/notifications/registry.ts');
  });
});
