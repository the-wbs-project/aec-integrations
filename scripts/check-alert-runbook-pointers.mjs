#!/usr/bin/env node
/**
 * Runbook-pointer gate for observability/posthog/alerts.json (AECI-1940).
 *
 * Every alert carries a `runbook` string. It names a doc, and usually a heading
 * in it, in the form `docs/runbooks/alerts.md — 'Heading text'`. An operator
 * reads that string and searches the doc for the heading. A pointer that names
 * a heading the doc does not have sends them nowhere. Six did, until AECI-1940.
 *
 * The rules, checked for every alert:
 *   1. `runbook` is a non-empty string.
 *   2. Every `docs/....md` path it names exists.
 *   3. Every `<path> — '<heading>'` names a real ATX heading in that file. The
 *      match is exact after trimming and dropping backticks, because a search
 *      for the pointer text has to land on the heading.
 *   4. A `<path> §<words>` pointer is refused. That form has no end marker, so
 *      it cannot be checked. Write `<path> — '<heading>'` instead.
 *
 * `pnpm lint` runs this, beside the NOTIFICATIONS.md drift check that also reads
 * alerts.json. No network, no PostHog: the `runbook` field never reaches PostHog
 * (observability/posthog/apply.sh does not send it), so a fix here needs no apply.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// A path may sit in backticks, the way this repo usually writes one (`docs/x.md`).
const DOC_PATH = /(?:^|[\s(;`])((?:docs|observability)\/[A-Za-z0-9_./-]*\.md)/g;
const QUOTED_POINTER = /((?:docs|observability)\/[A-Za-z0-9_./-]*\.md)`?\s*[—–-]\s*'([^']+)'/g;
const SECTION_POINTER = /((?:docs|observability)\/[A-Za-z0-9_./-]*\.md)`?\s*§/g;
const ATX_HEADING = /^#{1,6}\s+(.+?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;

/** Heading text as a reader searches for it: no backticks, single spaces. */
export function normalizeHeading(text) {
  return text.replaceAll('`', '').replace(/\s+/g, ' ').trim();
}

/** Every ATX heading (`#` to `######`) in a Markdown file, outside fenced code. */
export function headingsOf(markdown) {
  const out = new Set();
  let fenced = false;
  for (const line of markdown.split('\n')) {
    if (FENCE.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const m = line.match(ATX_HEADING);
    if (m) out.add(normalizeHeading(m[1]));
  }
  return out;
}

/**
 * Checks every alert's `runbook` pointer.
 * @param {{ alerts: Array<{ key?: string, runbook?: unknown }> }} alertsJson
 * @param {(path: string) => string | null} readDoc  repo-relative path → contents, or null when absent
 * @returns {string[]} one message per broken pointer; empty when all resolve
 */
export function checkRunbookPointers(alertsJson, readDoc) {
  if (!Array.isArray(alertsJson?.alerts)) return ['alerts.json has no "alerts" array'];
  const errors = [];
  const headingCache = new Map();
  const headings = (path) => {
    if (!headingCache.has(path)) {
      const text = readDoc(path);
      headingCache.set(path, text === null ? null : headingsOf(text));
    }
    return headingCache.get(path);
  };
  alertsJson.alerts.forEach((alert, i) => {
    const label = alert.key ?? `alerts[${i}]`;
    const runbook = alert.runbook;
    if (typeof runbook !== 'string' || runbook.trim() === '') {
      errors.push(`${label}: no runbook pointer`);
      return;
    }
    for (const [, path] of runbook.matchAll(DOC_PATH)) {
      if (headings(path) === null) errors.push(`${label}: ${path} does not exist`);
    }
    for (const [, path] of runbook.matchAll(SECTION_POINTER)) {
      errors.push(`${label}: "${path} §…" cannot be checked. Write ${path} — 'Heading' instead`);
    }
    for (const [, path, heading] of runbook.matchAll(QUOTED_POINTER)) {
      const found = headings(path);
      if (found === null) continue; // already reported as a missing file
      if (!found.has(normalizeHeading(heading))) {
        errors.push(`${label}: ${path} has no heading '${heading}'`);
      }
    }
  });
  return errors;
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const alertsJson = JSON.parse(
    readFileSync(join(root, 'observability/posthog/alerts.json'), 'utf8'),
  );
  const readDoc = (path) => {
    const abs = join(root, path);
    return existsSync(abs) ? readFileSync(abs, 'utf8') : null;
  };
  const errors = checkRunbookPointers(alertsJson, readDoc);
  if (errors.length > 0) {
    console.error('observability/posthog/alerts.json has runbook pointers that do not resolve:');
    for (const e of errors) console.error(`  - ${e}`);
    console.error("Point each one at a real heading: docs/<file>.md — 'Exact heading text'.");
    process.exit(1);
  }
  console.log(`alerts.json: all ${alertsJson.alerts.length} runbook pointers resolve.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
