/**
 * The header search shortcut (AECI-1772): Ctrl+/ or Cmd+/ focuses the search.
 *
 * Why a modifier. WCAG 2.1.4 (Character Key Shortcuts, Level A) says a shortcut
 * made of letter, punctuation or symbol keys alone must be switchable off, be
 * remappable to include a non-printable key, or work only while its component
 * has focus. A bare "/" would need a setting that does not exist. A shortcut
 * that already needs Ctrl or Cmd is not a character key shortcut, so it meets
 * the criterion with no setting. DESIGN.md §5 "Header search" records the choice.
 */

/** `aria-keyshortcuts` for the field: both forms, so every platform is named. */
export const SEARCH_SHORTCUT_ARIA = 'Control+/ Meta+/';

/** What a dialog looks like in the DOM: the mobile menu, the account menu, any BrnDialog. */
const OPEN_DIALOG = '[role="dialog"], [role="alertdialog"], dialog[open]';

/** The elements that take typed text. Their own keys win over the shortcut. */
const TYPING_TARGET = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest(TYPING_TARGET) !== null;
}

/**
 * Whether this key event should move focus to the header search.
 *
 * It must be exactly Ctrl or Cmd (not both, not Alt) with "/". It is ignored
 * while the reader types in a field, while a dialog is open, and once something
 * else has already handled the key.
 */
export function isSearchShortcut(event: KeyboardEvent, doc: Document): boolean {
  if (event.defaultPrevented || event.isComposing) return false;
  if (event.key !== '/' && event.code !== 'Slash') return false;
  if (event.altKey || event.ctrlKey === event.metaKey) return false;
  if (isTypingTarget(event.target)) return false;
  if (doc.querySelector(OPEN_DIALOG)) return false;
  return true;
}
