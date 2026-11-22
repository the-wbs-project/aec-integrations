import { expect } from 'vitest';

/**
 * Shared assertions for the Title-First Dialog Rule (AECI-1861, DESIGN.md). Every
 * Spartan dialog opens as a `role="alertdialog"` with focus on its title, so a
 * screen reader reads the title and the description before any button.
 *
 * Test helper, not a spec: `*.harness.ts`, so no runner collects it directly and the
 * app build excludes it (`tsconfig.app.json`).
 */

/** The open alert dialog whose `h2` reads `title`, in the CDK overlay on `document.body`. */
export function openAlertDialog(title?: string): HTMLElement | null {
  const open = [...document.body.querySelectorAll<HTMLElement>('[role="alertdialog"]')].filter(
    (d) => {
      const heading = d.querySelector('h2')?.textContent?.replace(/\s+/g, ' ').trim();
      return title === undefined ? !!heading : heading === title;
    },
  );
  return open.at(-1) ?? null;
}

/**
 * Assert that the open dialog titled `title` follows the rule: the overlay panel is a
 * modal `alertdialog`, named by its title and described by its description, and the
 * title holds focus. Returns the panel. Pass `described: false` for a dialog with no
 * `brnDialogDescription` (the admin vendor logo editor).
 */
export function expectTitleFirstDialog(
  title: string,
  { described = true }: { described?: boolean } = {},
): HTMLElement {
  const panel = openAlertDialog(title);
  expect(panel, `an open role="alertdialog" titled "${title}"`).not.toBeNull();
  expect(panel!.getAttribute('aria-modal')).toBe('true');

  const heading = panel!.querySelector<HTMLElement>('h2')!;
  expect(heading.getAttribute('tabindex')).toBe('-1');
  expect(document.activeElement, 'focus is on the dialog title').toBe(heading);
  expect(panel!.getAttribute('aria-labelledby')).toBe(heading.id);

  if (!described) return panel!;
  const descId = panel!.getAttribute('aria-describedby');
  expect(descId).toBeTruthy();
  const description = document.getElementById(descId!);
  expect(description, 'aria-describedby points at a rendered description').not.toBeNull();
  expect(description!.textContent?.trim()).not.toBe('');
  return panel!;
}
