/**
 * Site header.
 *
 * A deliberately minimal bar: a single always-visible navigation menu to the
 * left of the monogram + wordmark, over a warm Bone "shelf" that reads as
 * editorial structure rather than chrome. All navigation, search, the theme
 * toggle, and the Sign-in CTA live inside `aec-nav-menu`, so the header renders
 * identically at every breakpoint — there is no separate desktop inline nav to
 * keep in sync. (The four directory links are mirrored in the SSR footer for
 * crawlers / no-JS — the menu's overlay content is template-only; see
 * `nav-menu.ts`.)
 *
 * Spec: §16 Phase 1 ("Basic layout shell"); §3.1 (route inventory drives nav
 * placeholders); §2a (theming); §21 (a11y).
 */
import { Component } from '@angular/core';

import { Monogram } from './monogram';
import { NavMenu } from './nav-menu';

@Component({
  selector: 'aec-site-header',
  imports: [Monogram, NavMenu],
  template: `
    <header class="bg-(--surface-base)">
      <div class="mx-auto flex max-w-7xl items-center gap-3 px-8 py-5">
        <aec-nav-menu />
        <aec-monogram />
      </div>
      <div class="h-1 w-full bg-(--accent-warm)" aria-hidden="true"></div>
    </header>
  `,
})
export class SiteHeader {}
