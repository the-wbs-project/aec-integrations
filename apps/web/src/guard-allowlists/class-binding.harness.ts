import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Reads the class string a template binding produces, statically, for the guard specs.
 * Moved here from `heading-utilities.guard.spec.ts` (AECI-1847) by AECI-2083, so the
 * heading guard and the label guard read bindings the same way. Test-only.
 */

/**
 * Where to look for a name: the component's own sources, then each file it imports
 * from by a relative path (one level), so an imported constant such as
 * `BROWSE_HEADER_CLASS` resolves too.
 */
export interface Scope {
  sources: readonly string[];
  importFile: (name: string) => string;
  /**
   * The scope of the file a name is imported from, so a property of an imported object
   * that names a constant (`label: CONSOLE_LABEL_CLASS`) resolves in that file's own
   * imports. Optional: a hand-built scope without it reads property literals only.
   */
  importScope?: (name: string) => Scope | null;
}

/** What a constant imported from a `skipImport` path resolves to: a shared recipe. */
export const SHARED_RECIPE = 'aec-shared-recipe';

/**
 * The classes `[class.name]="…"` bindings may add to an element. The condition is not
 * read: a guard treats each named class as present, because it can be.
 */
export function conditionalClasses(attrs: string): string[] {
  return [...attrs.matchAll(/\[class\.([^\]=\s]+)\]=/g)].map((m) => m[1]!);
}

/** A string literal that may span lines: '…', "…" or a template with no `${}`. */
export const LITERAL = String.raw`'([^']*)'|"([^"]*)"|\`([^\`$]*)\``;

function literalAt(text: string): string | null {
  const m = text.match(new RegExp(`^\\s*(?:${LITERAL})`));
  return m ? (m[1] ?? m[2] ?? m[3] ?? '') : null;
}

/**
 * Where a name is assigned in TypeScript: `name = …` or `name: Type = …`. Not an
 * `aria-label="…"` or `obj.label = …`, and not a template attribute such as
 * `label="…"`, which has no space before its `=` (Prettier spaces every assignment).
 */
function assignment(name: string): RegExp {
  return new RegExp(`(?<![\\w$.-])${name}\\s*(?::[^=;]+)?\\s=(?!=)\\s*`, 'g');
}

function safeRead(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

/** The string a name holds: a literal, another constant, or a constant it imports. */
function resolveName(name: string, scope: Scope, depth = 0): string | null {
  if (depth > 3) return null;
  for (const src of scope.sources) {
    // A name can be assigned more than once (a local `const label = f(x)` and the
    // class field `label = LABEL`): take the first assignment that can be read.
    for (const assign of src.matchAll(assignment(name))) {
      const rest = src.slice(assign.index + assign[0].length);
      const literal = literalAt(rest);
      if (literal !== null) return literal;
      const alias = rest.match(/^([A-Za-z_$][\w$]*)\s*;/);
      if (alias) return resolveName(alias[1]!, scope, depth + 1);
    }
  }
  const imported = scope.importFile(name);
  return imported
    ? resolveName(name, { sources: [imported], importFile: () => '' }, depth + 1)
    : null;
}

/** An object literal's text and the scope it was written in. */
interface FoundObject {
  text: string;
  scope: Scope;
}

/** The object literal a name holds (`const X = { … }`), followed through an alias. */
function resolveObject(name: string, scope: Scope, depth = 0): FoundObject | null {
  if (depth > 3) return null;
  for (const src of scope.sources) {
    for (const assign of src.matchAll(assignment(name))) {
      const rest = src.slice(assign.index + assign[0].length);
      if (rest.startsWith('{')) return { text: rest.slice(0, rest.indexOf('}') + 1), scope };
      const alias = rest.match(/^([A-Za-z_$][\w$]*)\s*;/);
      if (alias) return resolveObject(alias[1]!, scope, depth + 1);
    }
  }
  const importedScope = scope.importScope?.(name);
  if (importedScope) return resolveObject(name, importedScope, depth + 1);
  const imported = scope.importFile(name);
  return imported
    ? resolveObject(name, { sources: [imported], importFile: () => '' }, depth + 1)
    : null;
}

/**
 * One property of an object literal: a string literal, or a name (`label: X_CLASS`)
 * read in the scope the object was written in. Null when neither can be read.
 */
function resolveProperty(found: FoundObject, prop: string): string | null {
  const literal = found.text.match(new RegExp(`\\b${prop}\\s*:\\s*(?:${LITERAL})`));
  if (literal) return literal[1] ?? literal[2] ?? literal[3] ?? '';
  const named = found.text.match(new RegExp(`\\b${prop}\\s*:\\s*([A-Za-z_$][\\w$]*)\\s*[,}\\n]`));
  return named ? resolveName(named[1]!, found.scope) : null;
}

/**
 * The class string a `[class]` binding produces, or null when it cannot be read
 * statically. Reads string literals, names (`headingClass`), member reads
 * (`headerClass.title`) and `+` concatenations of those. A call (`titleClass()`), a
 * ternary or a template with `${}` is not read.
 */
export function resolveBinding(expr: string, scope: Scope): string | null {
  const parts = expr.split('+').map((p) => p.trim());
  const out: string[] = [];
  for (const part of parts) {
    const literal = literalAt(part);
    if (literal !== null && literalAt(part)!.length + 2 === part.length) {
      out.push(literal);
      continue;
    }
    const member = part.match(/^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/);
    if (member) {
      const obj = resolveObject(member[1]!, scope);
      const value = obj ? resolveProperty(obj, member[2]!) : null;
      if (value === null) return null;
      out.push(value);
      continue;
    }
    if (/^[A-Za-z_$][\w$]*$/.test(part)) {
      const value = resolveName(part, scope);
      if (value === null) return null;
      out.push(value);
      continue;
    }
    return null;
  }
  return out.join(' ');
}

/**
 * A component's sources, and a reader for the files it imports by relative path.
 * `skipImport` names import paths whose constants count as on-recipe: a name imported
 * from one resolves to {@link SHARED_RECIPE}, read but never inspected.
 */
export function scopeFor(path: string, src: string, skipImport?: RegExp): Scope {
  // An external template binds names its component class defines.
  const companion = path.endsWith('.html') ? safeRead(path.replace(/\.html$/, '.ts')) : '';
  const sources = [src, companion];
  const importPath = (name: string): string | null => {
    for (const s of sources) {
      const imp = s.match(
        new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*'(\\.[^']+)'`),
      );
      if (imp) return imp[1]!;
    }
    return null;
  };
  return {
    sources,
    importFile: (name) => {
      const from = importPath(name);
      if (from === null) return '';
      if (skipImport?.test(from)) return `const ${name} = '${SHARED_RECIPE}';`;
      return safeRead(join(dirname(path), `${from}.ts`));
    },
    // One level only, as `importFile`: the imported file's own imports resolve, theirs do not.
    importScope: (name) => {
      const from = importPath(name);
      if (from === null || skipImport?.test(from)) return null;
      const file = join(dirname(path), `${from}.ts`);
      const text = safeRead(file);
      if (!text) return null;
      const inner = scopeFor(file, text, skipImport);
      return { sources: inner.sources, importFile: inner.importFile };
    },
  };
}
