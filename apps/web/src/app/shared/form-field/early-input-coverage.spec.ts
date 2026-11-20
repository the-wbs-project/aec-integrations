/**
 * AECI-1720: every component that binds `[formField]` also imports `AecEarlyInput`,
 * so no server-rendered form loses what a visitor typed or ticked before hydration.
 * The directive's own behaviour is pinned in `early-input.component.spec.ts`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const APP_DIR = join(__dirname, '..', '..');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') ? [path] : [];
  });
}

/** The `imports: [...]` array of the component or directive decorator, if any. */
function decoratorImports(text: string): string {
  const start = text.indexOf('imports: [');
  return start < 0 ? '' : text.slice(start, text.indexOf(']', start) + 1);
}

describe('AecEarlyInput coverage (AECI-1720)', () => {
  const users = sources(APP_DIR).filter((path) =>
    /\bFormField\b/.test(decoratorImports(readFileSync(path, 'utf8'))),
  );

  it('finds the components that import FormField', () => {
    expect(users.length).toBeGreaterThan(10);
  });

  it('every component that imports FormField imports AecEarlyInput too', () => {
    const missing = users
      .filter((path) => !/\bAecEarlyInput\b/.test(decoratorImports(readFileSync(path, 'utf8'))))
      .map((path) => relative(APP_DIR, path));
    expect(missing).toEqual([]);
  });
});
