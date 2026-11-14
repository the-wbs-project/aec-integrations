import { Component } from '@angular/core';

/**
 * Skip-to-main link. Must be the first focusable element in the document so
 * keyboard users can bypass header/nav with one Tab press. Hidden visually
 * via `sr-only`; revealed on focus. WCAG 2.1 AA, §21.1. It appears over the
 * Forest header, so on focus it takes a Bone fill, Forest text and a Bone ring
 * (a Forest fill or ring would vanish there).
 */
@Component({
  selector: 'aec-skip-link',
  template: `
    <a
      href="#main"
      class="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:start-3 focus:z-50 focus:px-3 focus:py-2 focus:rounded-md focus:bg-(--accent-warm) focus:text-(--accent-primary) focus:outline-3 focus:outline-offset-3 focus:outline-(--focus-ring-on-brand) focus:font-semibold"
      i18n="@@app.skipLink"
    >
      Skip to main content
    </a>
  `,
})
export class SkipLink {}
