import { DOCUMENT, isPlatformBrowser } from '@angular/common';
import {
  type EnvironmentProviders,
  HostAttributeToken,
  PLATFORM_ID,
  Service,
  inject,
  provideAppInitializer,
} from '@angular/core';

/**
 * AECI-1937: keep a directive's class recipe on its host from the first client
 * render.
 *
 * THE GAP. When Angular creates an element it writes the element's static
 * classes with `setAttribute('class', …)`. That is the template's `class="mt-12"`
 * plus any static host `class`. A `[class]` host binding is applied later, in the
 * first update pass. During hydration the element is the server's node, so that
 * write replaces the server's full class list with the static part alone, and
 * the recipe only comes back at the update pass. A style read or a frame can
 * land in that gap. The button then resolves with no fill, and its colour
 * transition fades the fill back in. That is how the AECI-1922 e2e read a
 * part-transparent Forest. A client-created element has the same gap. An
 * element with no static class is never touched by the write, so a server node
 * keeps its list.
 *
 * THE FIX. The directive constructor runs in the same creation pass, right after
 * that write. In the browser, `applyHostRecipe` puts recipe classes back there,
 * in one `classList.add`:
 *
 * - On a server node it puts back the recipe classes the server wrote. They are
 *   read before hydration starts, by `provideServerHostClasses`.
 * - On a client-created node, inputs are not set yet. It adds only the classes
 *   that every still-possible value of the inputs that decide the look would
 *   produce. A bound input such as `[variant]` is not an attribute, so every
 *   value is possible and its fill waits for the binding. This never shows a
 *   wrong variant: a bound secondary button is never Forest, not even for a frame.
 *   Each directive says which inputs count as unknown without an attribute.
 *
 * `dropStaleRecipe`, called from `ngOnInit`, removes an added class the client's
 * first update would not write. That happens when a visitor-state input differs
 * between the server and the browser, or when an input assumed static is bound.
 * `ngOnInit` runs in the same update pass as the host binding. The server render
 * does neither, so its HTML is unchanged.
 *
 * Plain template elements have the same gap. Their rule is in
 * `ANGULAR_STYLE_GUIDE.md` §10: one class binding, no static class beside it.
 * Do not extend this helper to them (AECI-1938).
 */

/** What a directive tells `applyHostRecipe` about its recipe. */
export interface HostRecipe {
  /** The recipe's first class. A host that still has it lost nothing. */
  readonly marker: string;
  /** Every class the recipe can produce, for any input values. */
  readonly universe: ReadonlySet<string>;
  /** The classes every input combination still possible at creation produces. */
  readonly certain: readonly string[];
}

/**
 * The class lists of the guarded hosts as the server wrote them, read once
 * before hydration rewrites any of them. Each list is taken once, by its host.
 */
@Service()
export class ServerHostClasses {
  private readonly lists = new WeakMap<Element, string>();

  record(root: ParentNode, selector: string): void {
    for (const el of Array.from(root.querySelectorAll(selector))) {
      this.lists.set(el, el.getAttribute('class') ?? '');
    }
  }

  take(host: Element): string | null {
    const list = this.lists.get(host);
    if (list === undefined) return null;
    this.lists.delete(host);
    return list;
  }
}

/**
 * Reads the server's class list of every element carrying one of `attributes`
 * (the directive selectors, lower-cased as the HTML has them). An app
 * initializer runs before the root component is created, so before hydration.
 */
export function provideServerHostClasses(attributes: readonly string[]): EnvironmentProviders {
  return provideAppInitializer(() => {
    if (!isPlatformBrowser(inject(PLATFORM_ID))) return;
    const selector = attributes.map((name) => `[${name}][class]`).join(',');
    inject(ServerHostClasses).record(inject(DOCUMENT), selector);
  });
}

/**
 * Puts recipe classes back on `host` when the creation pass left it without
 * `recipe.marker`. Returns the classes it added, which `dropStaleRecipe` needs.
 * Adds nothing when the host still has the marker, and nothing in the server
 * render.
 */
export function applyHostRecipe(
  host: Element,
  recipe: HostRecipe,
  server: ServerHostClasses | null,
  isBrowser: boolean,
): readonly string[] {
  if (!isBrowser) return [];
  const serverList = server?.take(host) ?? null;
  if (host.classList.contains(recipe.marker)) return [];
  const wanted =
    serverList === null
      ? recipe.certain
      : splitClasses(serverList).filter((token) => recipe.universe.has(token));
  // Code-unit order, the order Angular's class binding adds keys in, so the
  // attribute reads as the server wrote it.
  const added = wanted
    .filter((token) => !host.classList.contains(token))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (added.length > 0) host.classList.add(...added);
  return added;
}

/**
 * Removes the classes `applyHostRecipe` added that the settled recipe does not
 * have. A class the caller wrote statically was never in `added`, so it stays.
 */
export function dropStaleRecipe(host: Element, added: readonly string[], recipe: string): void {
  if (added.length === 0) return;
  const settled = new Set(splitClasses(recipe));
  const stale = added.filter((token) => !settled.has(token));
  if (stale.length > 0) host.classList.remove(...stale);
}

/**
 * The `HostRecipe` for a set of possible recipes, one per input combination still
 * possible. `all` is every combination, for the universe.
 */
export function hostRecipe(
  marker: string,
  possible: readonly string[],
  all: readonly string[],
): HostRecipe {
  const lists = possible.map(splitClasses);
  const certain =
    lists.length === 0 ? [] : lists[0].filter((t) => lists.every((l) => l.includes(t)));
  return { marker, universe: new Set(all.flatMap(splitClasses)), certain };
}

/**
 * A static attribute on the host, read in the constructor before inputs are set.
 * A bound input (`[variant]="…"`) is not an attribute, so it reads `null`.
 */
export function staticHostAttribute(name: string): string | null {
  return inject(new HostAttributeToken(name), { optional: true });
}

function splitClasses(value: string): string[] {
  return value.split(/\s+/).filter((token) => token.length > 0);
}
