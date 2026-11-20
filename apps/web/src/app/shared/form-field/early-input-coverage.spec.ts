/**
 * AECI-1720: two structural rules for forms that may be server-rendered.
 *
 * 1. Every component that binds `[formField]` on a text field, textarea, select or
 *    radio imports `AecEarlyInput`, so no form loses what a visitor typed before
 *    hydration. A component whose only bound control is a checkbox has nothing to carry.
 * 2. Every acceptance checkbox carries `aecConsent`, so it is disabled until the app is
 *    live. No checkbox is ever carried across hydration in any case (`isNeverCarried`,
 *    pinned in `early-input.component.spec.ts`), so a forgotten marker cannot carry a
 *    tick. This rule keeps the box from being tickable before it can work.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const APP_DIR = join(__dirname, '..', '..');

function sources(dir: string, ext: readonly string[]): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path, ext);
    if (entry.name.endsWith('.spec.ts')) return [];
    return ext.some((e) => entry.name.endsWith(e)) ? [path] : [];
  });
}

/** The `imports: [...]` array of the component or directive decorator, if any. */
function decoratorImports(text: string): string {
  const start = text.indexOf('imports: [');
  return start < 0 ? '' : text.slice(start, text.indexOf(']', start) + 1);
}

/** Every `<input …>` tag in a template source, whole. */
function inputTags(text: string): string[] {
  return [...text.matchAll(/<input\b[^>]*>/g)].map((m) => m[0]);
}

/** A checkbox whose bindings or test id name an acceptance or a consent. */
const ACCEPTANCE = /accept|consent/i;

/** The component's template: the inline one, plus its `templateUrl` file if any. */
function templateOf(path: string): string {
  const text = readFileSync(path, 'utf8');
  const url = text.match(/templateUrl:\s*'([^']+)'/)?.[1];
  return url ? text + readFileSync(join(dirname(path), url), 'utf8') : text;
}

/** A `[formField]` on a control the directive carries: not a checkbox. */
function bindsCarriedControl(template: string): boolean {
  return [...template.matchAll(/<(input|textarea|select)\b[^>]*>/g)].some(
    (m) => /\[formField\]/.test(m[0]) && !/type="checkbox"/.test(m[0]),
  );
}

describe('AecEarlyInput coverage (AECI-1720)', () => {
  const users = sources(APP_DIR, ['.ts']).filter((path) =>
    /\bFormField\b/.test(decoratorImports(readFileSync(path, 'utf8'))),
  );

  it('finds the components that import FormField', () => {
    expect(users.length).toBeGreaterThan(10);
  });

  it('every component that binds a carried control imports AecEarlyInput too', () => {
    const missing = users
      .filter((path) => bindsCarriedControl(templateOf(path)))
      .filter((path) => !/\bAecEarlyInput\b/.test(decoratorImports(readFileSync(path, 'utf8'))))
      .map((path) => relative(APP_DIR, path));
    expect(missing).toEqual([]);
  });

  it('the claim fields and the mailing list are among them', () => {
    const carried = users
      .filter((path) => bindsCarriedControl(templateOf(path)))
      .map((path) => relative(APP_DIR, path));
    expect(carried).toContain(join('requests', 'claimant-fields.ts'));
    expect(carried).toContain(join('shared', 'mailing-list-signup', 'mailing-list-signup.ts'));
  });
});

describe('consent boxes carry aecConsent (AECI-1720)', () => {
  const boxes = sources(APP_DIR, ['.ts', '.html']).flatMap((path) =>
    inputTags(readFileSync(path, 'utf8'))
      .filter((tag) => /type="checkbox"/.test(tag) && ACCEPTANCE.test(tag))
      .map((tag) => ({ file: relative(APP_DIR, path), tag })),
  );

  it('finds the acceptance boxes, the Vendor Terms and /auth/terms ones included', () => {
    const files = boxes.map((b) => b.file);
    expect(files).toContain(join('requests', 'vendor-terms-box.ts'));
    expect(files).toContain(join('auth', 'terms-accept.ts'));
    expect(files).toContain(join('vendor', 'components', 'vendor-legal-acceptance.ts'));
    expect(files).toContain(join('vendor', 'components', 'vendor-pending-grant-card.ts'));
  });

  it('every acceptance checkbox carries aecConsent', () => {
    const unmarked = boxes.filter((b) => !/\baecConsent\b/.test(b.tag)).map((b) => b.file);
    expect(unmarked).toEqual([]);
  });

  it('a component with an aecConsent box imports AecConsentBox', () => {
    const missing = sources(APP_DIR, ['.ts'])
      .filter((path) => {
        const text = readFileSync(path, 'utf8');
        return (
          inputTags(text).some((tag) => /\baecConsent\b/.test(tag)) &&
          !/\bAecConsentBox\b/.test(decoratorImports(text))
        );
      })
      .map((path) => relative(APP_DIR, path));
    expect(missing).toEqual([]);
  });
});
