import { ChangeDetectionStrategy, Component } from '@angular/core';

/**
 * Skip-to-main link. Must be the first focusable element in the document so
 * keyboard users can bypass header/nav with one Tab press. Hidden visually
 * via `sr-only`; revealed on focus. WCAG 2.1 AA, §21.1.
 */
@Component({
  selector: 'aec-skip-link',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <a
      href="#main"
      class="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:px-3 focus:py-2 focus:rounded-md focus:bg-(--accent-primary) focus:text-(--surface-base) focus:outline-2 focus:outline-offset-2 focus:outline-(--accent-primary) focus:font-medium"
      i18n="@@app.skipLink"
    >
      Skip to main content
    </a>
  `,
})
export class SkipLink {}
