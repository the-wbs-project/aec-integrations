import { DOCUMENT } from '@angular/common';
import { type EnvironmentProviders, inject, provideEnvironmentInitializer } from '@angular/core';

/**
 * The four console chip tones the shared ladder lacks (AECI-1813), as one
 * stylesheet only the admin console loads. `aec-chip` keeps the `tone` input and
 * the `ConsoleChipTone` type; the public bundle carries no rule for these values.
 * `positive` and `critical` repeat the ladder's `wash` and `error` looks under the
 * console's names. The rules set colour and edge only, so density still sets the
 * size. The count is the exception: a fixed 24px pill with tabular figures.
 *
 * The element is appended to `<head>` after `styles.css`, so at equal specificity
 * these rules win over the unlayered density rules there (the waiting tone's 8px
 * gap and the count's padding). The `id` makes it idempotent: the server renders
 * it once, and the browser finds it on hydration and adds nothing.
 */
export const ADMIN_CHIP_TONES_STYLE_ID = 'aec-admin-chip-tones';

export const ADMIN_CHIP_TONES_CSS = `
.aec-chip[data-tone='positive'] {
  border-color: var(--accent-primary);
  background-color: var(--accent-primary-soft);
  color: var(--accent-primary);
}
.aec-chip[data-tone='critical'] {
  border-color: var(--status-error);
  background-color: var(--surface-base);
  color: var(--status-error);
}
.aec-chip[data-tone='waiting'] {
  gap: 0.5rem;
  border-color: var(--border-strong);
  background-color: var(--surface-base);
  color: var(--text-primary);
}
.aec-chip[data-tone='waiting']::before {
  content: '';
  flex: none;
  width: 0.5rem;
  height: 0.5rem;
  border: 2px solid var(--text-secondary);
  border-radius: 50%;
}
.aec-chip[data-tone='attention'] {
  border-color: var(--border-strong);
  background-color: var(--surface-raised);
  color: var(--accent-secondary-deep);
}
.aec-chip[data-tone='count'] {
  justify-content: center;
  min-width: 1.5rem;
  height: 1.5rem;
  padding: 0 0.5rem;
  border-color: transparent;
  background-color: var(--accent-primary);
  color: var(--surface-base);
  font-size: var(--t-13);
  font-weight: 600;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}
`;

/** Adds the console tone stylesheet to the document once. Call in an injection context. */
export function useAdminChipTones(): void {
  const doc = inject(DOCUMENT);
  if (doc.getElementById(ADMIN_CHIP_TONES_STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = ADMIN_CHIP_TONES_STYLE_ID;
  style.textContent = ADMIN_CHIP_TONES_CSS;
  doc.head.appendChild(style);
}

/**
 * The same, for a route: `providers: [provideAdminChipTones()]`. The `/preview/admin-*`
 * routes render admin bodies without the shell, so each carries this.
 */
export function provideAdminChipTones(): EnvironmentProviders {
  return provideEnvironmentInitializer(useAdminChipTones);
}
