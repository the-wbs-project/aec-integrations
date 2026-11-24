/**
 * AECI-1877 check 7b: `aria-haspopup` must name the kind of popup the trigger opens.
 *
 * A screen reader announces `aria-haspopup="true"` as a menu button. If the
 * panel it opens is a list of links with no `menu` role, the user is promised
 * arrow-key menu navigation that is not there (WCAG 4.1.2). The checklist says
 * the same of the vendor Products disclosure: it "is not announced as a menu".
 *
 * Pure, so the plain Vitest runner pins it. `haspopupFacts` in `./probe.ts`
 * reads the inputs off the page.
 */

/** The popup roles each `aria-haspopup` value promises. */
const PROMISED: Record<string, readonly string[]> = {
  true: ['menu'],
  menu: ['menu'],
  listbox: ['listbox'],
  tree: ['tree'],
  grid: ['grid'],
  dialog: ['dialog', 'alertdialog'],
};

/**
 * Why the trigger's `aria-haspopup` does not match its popup, or `null` when it
 * does or cannot be judged. `controlledRoles` are the explicit roles of the
 * elements its `aria-controls` names (`null` for an element with no role), or
 * `null` when it names none. A trigger with no `aria-controls` is judged when
 * it opens (check 7a), not here.
 */
export function haspopupMismatch(
  haspopup: string,
  controlledRoles: readonly (string | null)[] | null,
): string | null {
  const value = haspopup.trim().toLowerCase();
  if (value === '' || value === 'false') return null;
  const promised = PROMISED[value];
  if (!promised) return `aria-haspopup="${haspopup}" is not a valid value`;
  if (!controlledRoles || controlledRoles.length === 0) return null;
  if (controlledRoles.some((role) => role !== null && promised.includes(role))) return null;
  const found = controlledRoles.map((role) => role ?? 'no role').join(', ');
  return `aria-haspopup="${haspopup}" promises a ${promised.join(' or ')}, but the popup it controls has ${found}`;
}
