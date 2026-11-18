import { HostAttributeToken, inject } from '@angular/core';

/**
 * AECI-1937: keep a directive's class recipe on its host from the first client
 * render, so the host never paints without it.
 *
 * THE GAP. When Angular creates an element it writes the element's static
 * classes with `setAttribute('class', …)`. That is the template's `class="mt-12"`
 * plus any static host `class`. A `[class]` host binding is applied later, in the
 * first update pass. During hydration the element is the server's node, so that
 * write replaces the server's full class list with the static part alone. The
 * recipe only comes back at the update pass. When a frame paints in between, a
 * button has no fill and a card has no frame for that frame. The button's colour
 * transition then fades the fill back in. A client-created element has the same
 * gap. An element with no static class is never touched by the write, so it
 * keeps the server's list.
 *
 * THE FIX. The directive constructor runs in the same creation pass, right after
 * that write. In the browser, `applyHostRecipe` puts the recipe back there, in
 * one `classList.add`. `dropStaleRecipe`, called from `ngOnInit`, then removes
 * any token the first update would not have written. That happens when a bound
 * input such as `[variant]` differs from the guess made at creation. `ngOnInit`
 * runs in the same update pass as the host binding, so no frame paints between
 * the two. The server does neither, so its HTML is unchanged.
 */

/**
 * Adds `recipe` to `host` when the creation pass left it without `marker`, the
 * recipe's first class. Returns the tokens it added, which `dropStaleRecipe`
 * needs. Returns none when the host still carries the marker (no static class,
 * so the server's list survived) and in the server render.
 */
export function applyHostRecipe(
  host: Element,
  marker: string,
  recipe: string,
  isBrowser: boolean,
): readonly string[] {
  if (!isBrowser || host.classList.contains(marker)) return [];
  // Code-unit order, the order Angular's class binding adds keys in, so the
  // attribute reads exactly as the server wrote it.
  const added = splitClasses(recipe)
    .filter((token) => !host.classList.contains(token))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (added.length > 0) host.classList.add(...added);
  return added;
}

/**
 * Removes the tokens `applyHostRecipe` added that the settled recipe does not
 * have. A token the caller wrote statically was never in `added`, so it stays.
 */
export function dropStaleRecipe(host: Element, added: readonly string[], recipe: string): void {
  if (added.length === 0) return;
  const settled = new Set(splitClasses(recipe));
  const stale = added.filter((token) => !settled.has(token));
  if (stale.length > 0) host.classList.remove(...stale);
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
