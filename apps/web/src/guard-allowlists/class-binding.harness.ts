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

/** The object literal a name holds (`const X = { … }`), followed through an alias. */
function resolveObject(name: string, scope: Scope, depth = 0): string | null {
  if (depth > 3) return null;
  for (const src of scope.sources) {
    for (const assign of src.matchAll(assignment(name))) {
      const rest = src.slice(assign.index + assign[0].length);
      if (rest.startsWith('{')) return rest.slice(0, rest.indexOf('}') + 1);
      const alias = rest.match(/^([A-Za-z_$][\w$]*)\s*;/);
      if (alias) return resolveObject(alias[1]!, scope, depth + 1);
    }
  }
  const imported = scope.importFile(name);
  return imported
    ? resolveObject(name, { sources: [imported], importFile: () => '' }, depth + 1)
    : null;
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
      const prop = obj?.match(new RegExp(`\\b${member[2]}\\s*:\\s*(?:${LITERAL})`));
      if (!prop) return null;
      out.push(prop[1] ?? prop[2] ?? prop[3] ?? '');
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
  return {
    sources,
    importFile: (name) => {
      for (const s of sources) {
        const imp = s.match(
          new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*'(\\.[^']+)'`),
        );
        if (imp && skipImport?.test(imp[1]!)) return `const ${name} = '${SHARED_RECIPE}';`;
        if (imp) return safeRead(join(dirname(path), `${imp[1]}.ts`));
      }
      return '';
    },
  };
}
