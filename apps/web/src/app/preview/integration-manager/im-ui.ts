import { ChangeDetectionStrategy, Component, input } from '@angular/core';

import type { Tone } from './integration-manager.fixtures';

/**
 * Shared styling for the integration-manager preview.
 *
 * Coloured borders live in component CSS, not in Tailwind utilities. styles.css
 * sets border-color on every element outside any cascade layer, so a layered
 * border-color utility never reaches the element (the .aec-nav-tab note in
 * styles.css). Emulated component styles are unlayered and carry an attribute
 * selector, so they win. Every component in this folder includes IM_STYLES.
 *
 * Heading sizes live here too, for the same reason: styles.css sizes h1 to h3
 * outside any layer, so a text-* utility on a heading is dead.
 */
export const IM_STYLES = `
  :host { display: block; }

  .im-h1 { font-family: var(--font-display); font-size: 1.5rem; line-height: 1.25; }
  .im-h2 { font-family: var(--font-display); font-size: 1.5rem; line-height: 1.25; }
  .im-h3 { font-family: var(--font-display); font-size: 1.125rem; line-height: 1.3; }
  .im-h4 {
    font-family: var(--font-body);
    font-size: 0.875rem;
    font-weight: 600;
    line-height: 1.4;
    color: var(--text-primary);
  }

  .im-card {
    border: 1px solid var(--border-default);
    border-radius: var(--radius-lg);
    background-color: var(--surface-base);
  }
  .im-well {
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
    background-color: var(--surface-raised);
  }
  .im-callout {
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-lg);
    background-color: var(--accent-warm);
  }
  .im-danger {
    border: 1px solid var(--status-error);
    border-radius: var(--radius-lg);
    background-color: var(--surface-base);
  }
  .im-selected {
    border-color: var(--accent-primary);
    background-color: var(--accent-primary-soft);
  }

  .im-pill {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    white-space: nowrap;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    background-color: var(--surface-raised);
    padding: 0 0.5rem;
    font-size: 0.875rem;
    font-weight: 600;
    line-height: 1.5rem;
    color: var(--text-primary);
  }
  .im-pill[data-tone='ok'] {
    border-color: var(--accent-primary);
    background-color: var(--accent-primary-soft);
    color: var(--accent-primary);
  }
  .im-pill[data-tone='conflict'] {
    border-color: var(--status-error);
    background-color: var(--surface-base);
    color: var(--status-error);
  }

  .im-choice[aria-pressed='true'],
  .im-choice[aria-pressed='true']:hover {
    border-color: var(--accent-primary);
    background-color: var(--accent-primary);
    color: var(--surface-base);
  }
  .im-choice[aria-pressed='true']:focus-visible { outline-color: var(--accent-primary); }

  .im-seg {
    display: inline-flex;
    overflow: hidden;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
  }
  .im-seg-btn + .im-seg-btn { border-inline-start: 1px solid var(--border-strong); }
  .im-seg-btn[aria-pressed='true'],
  .im-seg-btn[aria-pressed='true']:hover {
    background-color: var(--accent-primary);
    color: var(--surface-base);
  }
  .im-chip { border: 1px solid var(--border-strong); }
  .im-chip[aria-pressed='true'] {
    border-color: var(--accent-primary);
    background-color: var(--accent-primary-soft);
    color: var(--accent-primary);
  }

  .im-tab { border-bottom: 2px solid transparent; }
  .im-tab[aria-selected='true'] { border-bottom-color: var(--accent-primary); color: var(--text-primary); }

  .im-navlink { border-inline-start: 2px solid transparent; }
  .im-navlink[aria-current='true'] {
    border-inline-start-color: var(--accent-primary);
    color: var(--text-primary);
    background-color: var(--surface-sunken);
  }

  .im-rail { border-inline-start: 1px solid var(--border-strong); }
  .im-rail-dot {
    border: 2px solid var(--surface-base);
    background-color: var(--text-tertiary);
  }

  .im-input {
    width: 100%;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    background-color: var(--surface-base);
    padding: 0.5rem 0.75rem;
    font-size: 0.875rem;
    color: var(--text-primary);
  }
  .im-input-search { padding-inline-start: 2.25rem; }
  .im-input:focus-visible { outline: 2px solid var(--accent-primary); outline-offset: 1px; }
`;

const FOCUS =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';

export const BTN_PRIMARY = `inline-flex items-center justify-center gap-2 rounded-(--radius-md) bg-(--accent-primary) px-4 py-2 text-sm font-semibold text-(--surface-base) transition-colors hover:bg-(--accent-primary-hover) disabled:cursor-not-allowed disabled:opacity-60 ${FOCUS}`;

export const BTN_SECONDARY = `inline-flex items-center justify-center gap-2 rounded-(--radius-md) border border-(--border-strong) bg-(--surface-base) px-3.5 py-2 text-sm font-medium text-(--text-primary) transition-colors hover:bg-(--surface-sunken) ${FOCUS}`;

export const BTN_SMALL = `im-choice inline-flex items-center justify-center rounded-(--radius-md) border border-(--border-strong) bg-(--surface-base) px-2.5 py-1 text-xs font-medium text-(--text-primary) transition-colors hover:bg-(--surface-sunken) ${FOCUS}`;

export const BTN_LINK = `inline-flex items-center gap-1 rounded-(--radius-sm) text-sm font-medium text-(--accent-primary) underline-offset-4 hover:underline ${FOCUS}`;

export const BTN_DANGER = `inline-flex items-center justify-center rounded-(--radius-md) bg-(--status-error) px-4 py-2 text-sm font-semibold text-(--surface-base) transition-opacity hover:opacity-90 ${FOCUS}`;

export const LABEL = 'block text-sm font-semibold text-(--text-primary)';
export const HELP = 'mt-1 text-xs text-(--text-secondary)';

/** One status as a pill: tone is carried by the words and a shape, never colour alone. */
@Component({
  selector: 'aec-im-pill',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [IM_STYLES, ':host { display: inline-flex; }'],
  template: `
    <span class="im-pill" [attr.data-tone]="tone()">
      @switch (tone()) {
        @case ('ok') {
          <svg
            aria-hidden="true"
            class="h-3 w-3"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="3"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M20 6 9 17l-5-5" />
          </svg>
        }
        @case ('conflict') {
          <svg
            aria-hidden="true"
            class="h-3 w-3"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="3"
            stroke-linecap="round"
          >
            <path d="M7 7l10 10M17 7L7 17" />
          </svg>
        }
        @case ('attention') {
          <span aria-hidden="true" class="h-2 w-2 rounded-full bg-(--accent-secondary-deep)"></span>
        }
        @default {
          <span aria-hidden="true" class="h-2 w-2 rounded-full bg-(--text-tertiary)"></span>
        }
      }
      {{ label() }}
    </span>
  `,
})
export class ImPill {
  readonly label = input.required<string>();
  readonly tone = input.required<Tone>();
}

/** The two-product mark: two initials joined by a connector line. Decorative. */
@Component({
  selector: 'aec-im-pair-mark',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [IM_STYLES, ':host { display: inline-flex; }'],
  template: `
    <span aria-hidden="true" class="flex items-center">
      <span
        [class]="
          (small() ? 'h-6 w-6' : 'h-9 w-9') +
          ' im-well flex items-center justify-center font-display text-sm font-semibold text-(--accent-primary)'
        "
        >{{ initial(left()) }}</span
      >
      <span class="h-px w-3 bg-(--border-strong)"></span>
      <span
        [class]="
          (small() ? 'h-6 w-6' : 'h-9 w-9') +
          ' im-well flex items-center justify-center font-display text-sm font-semibold text-(--text-primary)'
        "
        >{{ initial(right()) }}</span
      >
    </span>
  `,
})
export class ImPairMark {
  readonly left = input.required<string>();
  readonly small = input(false);
  readonly right = input.required<string>();
  protected initial(name: string): string {
    return name.charAt(0).toUpperCase();
  }
}
