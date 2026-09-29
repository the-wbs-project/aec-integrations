/**
 * Shared styling for the integration detail page (§6.17).
 *
 * ── WHY COMPONENT CSS AND NOT TAILWIND FOR THESE ────────────────────────────
 * `styles.css` sets `border-color` on `*` outside any cascade layer, so a layered
 * `border-(--…)` utility never reaches the element (the `.aec-nav-tab` note in
 * `styles.css`, DESIGN.md "Vendor portal"). Emulated component styles are
 * unlayered and carry an attribute selector, so they win. Every coloured border
 * on the page therefore lives here, and every component in this folder includes
 * {@link ID_STYLES}.
 *
 * Heading sizes live here for the same reason: `styles.css` sizes `h1` to `h3`
 * outside any layer, so a `text-*` utility on a heading is dead (DESIGN.md §3,
 * "The Unlayered-Heading Rule"). The classes below are unlayered too.
 *
 * Light only (AECI-226). Tokens only, no literals (AECI-597).
 */
export const ID_STYLES = `
  :host { display: block; }

  .id-h2 { font-family: var(--font-display); font-size: 1.5rem; line-height: 1.25; font-weight: 600; }
  .id-h3 { font-family: var(--font-display); font-size: 1.25rem; line-height: 1.3; font-weight: 600; }
  .id-h3-slim { font-family: var(--font-display); font-size: 1.125rem; line-height: 1.3; font-weight: 600; }
  .id-h4 {
    font-family: var(--font-body);
    font-size: 0.875rem;
    font-weight: 600;
    line-height: 1.4;
    color: var(--text-primary);
  }

  .id-card {
    border: 1px solid var(--border-default);
    border-radius: var(--radius-lg);
    background-color: var(--surface-base);
  }
  .id-well {
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
    background-color: var(--surface-raised);
  }
  .id-callout {
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-lg);
    background-color: var(--accent-warm);
  }
  .id-danger {
    border: 1px solid var(--status-error);
    border-radius: var(--radius-lg);
    background-color: var(--surface-base);
  }

  .id-pill {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    white-space: nowrap;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    background-color: var(--surface-raised);
    padding: 0.125rem 0.5rem;
    font-size: 0.8125rem;
    font-weight: 600;
    line-height: 1.25rem;
    color: var(--text-primary);
  }
  .id-pill[data-tone='ok'] {
    border-color: var(--accent-primary);
    background-color: var(--accent-primary-soft);
    color: var(--accent-primary);
  }
  .id-pill[data-tone='conflict'] {
    border-color: var(--status-error);
    background-color: var(--surface-base);
    color: var(--status-error);
  }

  .id-seg {
    display: inline-flex;
    overflow: hidden;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
  }
  .id-seg-btn + .id-seg-btn { border-inline-start: 1px solid var(--border-strong); }
  .id-seg-btn[aria-pressed='true'],
  .id-seg-btn[aria-pressed='true']:hover {
    background-color: var(--accent-primary);
    color: var(--surface-base);
  }

  .id-chip { border: 1px solid var(--border-strong); }
  .id-chip[aria-pressed='true'] {
    border-color: var(--accent-primary);
    background-color: var(--accent-primary-soft);
    color: var(--accent-primary);
  }

  .id-navlink { border-inline-start: 2px solid transparent; }
  .id-navlink[aria-current='location'] {
    border-inline-start-color: var(--accent-primary);
    color: var(--text-primary);
    background-color: var(--surface-sunken);
  }

  .id-rail { border-inline-start: 1px solid var(--border-strong); }
  .id-rail-dot {
    border: 2px solid var(--surface-base);
    background-color: var(--text-secondary);
  }

  .id-input {
    width: 100%;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    background-color: var(--surface-base);
    padding: 0.5rem 0.75rem;
    font-size: 0.875rem;
    color: var(--text-primary);
  }
  .id-input-search { padding-inline-start: 2.25rem; }
  .id-input:focus-visible { outline: 2px solid var(--accent-primary); outline-offset: 1px; }
  .id-input[aria-invalid='true'] { border-color: var(--status-error); }

  .id-btn-secondary { border: 1px solid var(--border-strong); }
  .id-icon-btn { border: 1px solid transparent; }
  .id-icon-btn-bordered { border: 1px solid var(--border-strong); }
`;

const FOCUS =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';

export const BTN_PRIMARY = `inline-flex min-h-9 items-center justify-center gap-2 rounded-(--radius-md) bg-(--accent-primary) px-4 py-2 text-sm font-semibold text-(--surface-base) transition-colors hover:bg-(--accent-primary-hover) disabled:cursor-not-allowed disabled:opacity-60 ${FOCUS}`;

export const BTN_SECONDARY = `id-btn-secondary inline-flex min-h-9 items-center justify-center gap-2 rounded-(--radius-md) bg-(--surface-base) px-3.5 py-2 text-sm font-medium text-(--text-primary) transition-colors hover:bg-(--surface-sunken) disabled:cursor-not-allowed disabled:opacity-60 ${FOCUS}`;

export const BTN_DANGER = `inline-flex min-h-9 items-center justify-center rounded-(--radius-md) bg-(--status-error) px-4 py-2 text-sm font-semibold text-(--surface-base) transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60 ${FOCUS}`;

/** A text-style action that sits on a row ("Request a change", "Claim to edit"). */
export const ROW_ACTION = `inline-flex min-h-6 items-center rounded-(--radius-sm) text-sm font-semibold text-(--accent-primary) underline-offset-4 hover:underline disabled:cursor-not-allowed disabled:opacity-60 ${FOCUS}`;

/** The pencil and other icon-only buttons: at least 32 by 32, above the 24 by 24
 *  WCAG 2.5.8 floor. */
export const ICON_BUTTON = `id-icon-btn inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-(--radius-md) text-(--text-secondary) hover:bg-(--surface-sunken) hover:text-(--text-primary) ${FOCUS}`;

export const LABEL = 'block text-sm font-semibold text-(--text-primary)';
export const HELP = 'mt-1 text-sm text-(--text-secondary)';
export const ALERT = 'text-sm font-medium text-(--status-error)';

/** The in-text link role (DESIGN.md, "The Link Treatment Rule"). */
export const IN_TEXT_LINK = `rounded-(--radius-sm) text-(--accent-primary) underline underline-offset-2 hover:text-(--accent-primary-hover) ${FOCUS}`;
