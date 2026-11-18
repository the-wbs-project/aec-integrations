import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * AECI-1715 — `BROWSER_EVIDENCE_ENABLED` on the API Worker. It tells the
 * `browser_evidence_coverage` data-quality check that the browser report is captured on
 * this tier. Wrangler vars are not inherited across environments, so a block that loses
 * the var silently reads as off, and the check goes quiet on exactly the tier it guards.
 *
 * Production stays "false" until Privacy Policy 1.1 is in force (epic AECI-1711). The
 * deploy that turns production capture on flips this block and the web Worker's var in
 * the same change, and edits this spec.
 */
type Block = { vars?: Record<string, string> };
type Config = Block & { env: Record<string, Block> };

/**
 * Strip `//` and `/* *\/` comments outside strings. The web config has block comments,
 * and route patterns such as `example.com/*` sit inside strings, so a regex is not safe.
 */
function stripComments(source: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (inString) {
      out += c;
      if (c === '\\') out += source[++i] ?? '';
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 1;
    } else {
      out += c;
    }
  }
  return out;
}

function readConfig(relative: string): Config {
  const raw = readFileSync(join(__dirname, relative), 'utf8');
  return JSON.parse(stripComments(raw).replace(/,(\s*[}\]])/g, '$1')) as Config;
}

const api = readConfig('../wrangler.jsonc');
const web = readConfig('../../web/wrangler.jsonc');

const EXPECTED = {
  root: 'true',
  staging: 'true',
  demo: 'true',
  production: 'false',
} as const;

const blockOf = (config: Config, name: string): Block | undefined =>
  name === 'root' ? config : config.env[name];

describe('BROWSER_EVIDENCE_ENABLED in every API wrangler block', () => {
  it.each(Object.entries(EXPECTED))('is %s → "%s"', (name, value) => {
    expect(blockOf(api, name)?.vars?.BROWSER_EVIDENCE_ENABLED).toBe(value);
  });

  it('has no other environment block that could miss it', () => {
    expect(Object.keys(api.env).sort()).toEqual(['demo', 'production', 'staging']);
  });

  // The web Worker's var switches the capture (AECI-1714). This one only tells the
  // check. Where the web block declares it, the two must agree, or the check reads a
  // tier as capturing when it is not (a false alarm) or as off when it is (silence).
  it.each(Object.keys(EXPECTED))('agrees with the web Worker in the %s block', (name) => {
    const webValue = blockOf(web, name)?.vars?.BROWSER_EVIDENCE_ENABLED;
    if (webValue === undefined) return;
    expect(blockOf(api, name)?.vars?.BROWSER_EVIDENCE_ENABLED).toBe(webValue);
  });
});
