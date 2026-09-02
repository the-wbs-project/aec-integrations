/**
 * Compact header search — the icon-collapsed form of `aec-search-autocomplete`,
 * mounted for the `lg`–`xl` band only.
 *
 * Why it exists: search used to be unreachable between 1024px and 1279px. The
 * hamburger overlay (`nav-menu.ts`) carries a search box but is `lg:hidden`;
 * the inline header box in `site-header.ts` is `hidden xl:block`. The two
 * breakpoints never met, so a 256px-wide band rendered no search affordance at
 * all. Widening the inline box down to `lg` doesn't work — at 1024px the row
 * has only ~30–70px of slack after the wordmark, four taxonomy flyouts, "More",
 * and the auth control, and the box is `w-52` (208px). A 36px icon fits; the
 * box does not.
 *
 * So this is the third mount of the SAME component, at the third width:
 *   below `lg`  → inside the hamburger overlay (`nav-menu.ts`, `w-full`)
 *   `lg`–`xl`   → here, behind an icon (`w-full` inside a 22rem panel)
 *   `xl`+       → inline in the header row (`site-header.ts`, `w-52`)
 * The host class owns that band (`hidden lg:block xl:hidden`) so the parent
 * can't mis-wire it, and the three `inputId`s stay distinct so no two search
 * inputs ever share an id.
 *
 * The overlay is `BrnPopover` — the same primitive as `nav-menu.ts` and
 * `user-menu.ts`: CDK overlay, focus trap, Escape close, focus return to the
 * trigger, and automatic `aria-haspopup`/`aria-expanded`/`aria-controls`. Its
 * `autoFocus: 'first-tabbable'` default lands focus on the search input as the
 * panel opens, which is the whole point of the affordance.
 *
 * Nesting the autocomplete inside a popover is already proven: the hamburger
 * overlay does exactly this. It matters here because the autocomplete's own
 * suggestion listbox is a SEPARATE `cdkConnectedOverlay` living outside this
 * panel's DOM — clicking a suggestion is therefore an "outside" pointer event.
 * `BRN_POPOVER_DIALOG_DEFAULT_OPTIONS` sets `hasBackdrop: false` and inherits
 * `closeOnOutsidePointerEvents: false`, so that click cannot tear the panel down
 * before the selection commits. Do not switch this popover to a backdrop or to
 * outside-click-close without re-checking that path. Focus never leaves the
 * input either (the listbox is `focusMode="activedescendant"`), so the focus
 * trap and the listbox don't fight.
 *
 * SSR-safe: the panel lives in an `ng-template` that only mounts in the CDK
 * overlay on click, so the server renders just the static, visitor-state-neutral
 * icon button — nothing per-visitor reaches cached HTML.
 *
 * The glyph is the canonical Lucide `search` inlined as SVG with
 * `stroke="currentColor"` so it themes via `--text-primary` (DESIGN.md: Lucide
 * icons exclusively).
 *
 * Spec: DESIGN.md §5 (Navigation); §21 (a11y); AECI-144 (the autocomplete).
 */
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { BrnPopover, BrnPopoverContent, BrnPopoverTrigger } from '@spartan-ng/brain/popover';

import { SearchAutocomplete } from '../search/search-autocomplete';
import type { AutocompleteSuggestion } from '../search/autocomplete-mapping';

import { navigateToSearchQuery, navigateToSuggestion } from './search-submit';

@Component({
  selector: 'aec-search-trigger',
  changeDetection: ChangeDetectionStrategy.OnPush,
  // The `lg`–`xl` band is this component's entire reason to exist, so it owns
  // the visibility rather than the parent: below `lg` the hamburger carries
  // search, at `xl`+ the inline box does.
  host: { class: 'hidden lg:block xl:hidden' },
  imports: [BrnPopover, BrnPopoverContent, BrnPopoverTrigger, SearchAutocomplete],
  template: `
    <button
      brnPopoverTrigger
      [brnPopoverTriggerFor]="panel"
      type="button"
      class="inline-flex h-9 w-9 cursor-pointer items-center justify-center rounded-md border border-(--border-default) bg-(--surface-raised) text-(--text-primary) transition-colors hover:border-(--border-strong) hover:bg-(--surface-sunken) hover:text-(--accent-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
      i18n-aria-label="@@app.header.search.toggle.aria"
      aria-label="Open search"
    >
      <svg
        aria-hidden="true"
        class="h-5 w-5"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <circle cx="11" cy="11" r="8" />
        <path d="m21 21-4.3-4.3" />
      </svg>
    </button>

    <brn-popover #panel="brnPopover" class="contents" align="end" [sideOffset]="8">
      <ng-template brnPopoverContent>
        <div
          class="w-[min(92vw,22rem)] rounded-md border border-(--border-default) bg-(--surface-raised) p-2 shadow-lg"
        >
          <aec-search-autocomplete
            class="block"
            inputId="header-search-compact"
            inputClass="w-full"
            (querySubmitted)="onSearchQuery($event); panel.close()"
            (suggestionChosen)="onSuggestion($event); panel.close()"
          />
        </div>
      </ng-template>
    </brn-popover>
  `,
})
export class SearchTrigger {
  private readonly router = inject(Router);

  protected onSearchQuery(query: string): void {
    navigateToSearchQuery(this.router, query);
  }

  protected onSuggestion(suggestion: AutocompleteSuggestion): void {
    navigateToSuggestion(this.router, suggestion);
  }
}
