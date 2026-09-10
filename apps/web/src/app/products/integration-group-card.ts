import { Component, computed, input, output } from '@angular/core';

import { LogoOrInitial } from '../shared/logo-or-initial/logo-or-initial';

/**
 * AECI-841 — the collapsible group card both product-detail integration
 * sections are built from.
 *
 * One card = one group: a hub in `#powered-integrations` (§12.3), or a lane in
 * `#integrations` (§13.3). The bordered card with the tinted header bar is the
 * shape Addendum B shipped; this component is that shape extracted, given a
 * disclosure control, and pointed at both sections so the two finally read as
 * siblings rather than as two takes on the same idea.
 *
 * ── WHY NOT THE ANGULAR ARIA ACCORDION ──────────────────────────────────────────
 * `DESIGN.md` §5 names `@angular/aria` as the behavior provider for accordions,
 * and this component is the standing exception. `AccordionPanel` renders its
 * content through `DeferredContent`, which creates the embedded view inside an
 * `afterRenderEffect` — and Angular documents `afterRenderEffect` as running
 * **only on the client** (`guide/signals/effect#server-side-rendering-caveats`).
 * `preserveContent` does not help: it only stops the view being destroyed after
 * it has been created, and on the server it never is.
 *
 * On this page that is not a cosmetic difference. The rows inside these cards
 * are every internal link from a product page to its pair pages, they are what
 * the `internal-link-graph` crawler walks, and the endpoint table's
 * `@defer (on viewport; hydrate on viewport)` block depends on those rows being
 * SSR-rendered. An Aria panel would ship an empty `<section>` to the crawler and
 * pop the whole list in after hydration.
 *
 * So this is the WAI-ARIA disclosure pattern written out: heading wrapping a
 * `<button aria-expanded aria-controls>`, panel as a named `role="region"`,
 * hidden with the `hidden` attribute. **The content is in the DOM in every
 * state.** Collapsing hides it from sighted readers and from the accessibility
 * tree; it never removes it from the document. Do not "optimize" that into an
 * `@if` — see ADR 0010's 2026-09-10 amendment.
 *
 * ── WHY THE PRODUCT LINK SITS OUTSIDE THE HEADING BUTTON ────────────────────────
 * §12.3 and §13.3 both specify the group name as a link: the return path from an
 * endpoint page into the connector's hub, and back. A link cannot nest inside a
 * button, and the header itself is now the disclosure control, so the link moved
 * to a compact trailing anchor in the same bar. Both targets survive; only the
 * one that carries the name changed.
 *
 * **It opens in a new tab, deliberately.** A reader on a product page who wants
 * to know what Agave ERP Sync is has not finished with the page they are on —
 * the link is a lookup, not a destination, and the same reasoning the admin
 * console's "View Page" button records. So: a plain `href` rather than
 * `routerLink` (a router navigation is pointless once the browser is opening a
 * new context), `rel="noopener"` because the new context would otherwise get a
 * handle on this one, and the new tab is **announced in the accessible name**
 * rather than left to be discovered. The name is built to START with the visible
 * "View product" text, so it satisfies WCAG 2.5.3 Label in Name and a speech-input
 * user can say what they can read.
 *
 * Fully controlled: the card renders `expanded()` and emits `toggled`. The owning
 * section holds the collapsed set, because an active filter has to be able to
 * open a group the reader had closed, and only the section knows the query.
 */
@Component({
  selector: 'aec-integration-group-card',
  imports: [LogoOrInitial],
  // A custom element is `display: inline` by default, so a parent's `space-y-*`
  // margin would land on an inline box and be dropped. Same fix, same reason as
  // `ProductPoweredHub`.
  host: { class: 'block' },
  template: `
    <section class="overflow-hidden rounded-(--radius-lg) border border-(--border-default)">
      <div
        class="flex items-center gap-x-3 border-b border-(--border-default)
          bg-(--surface-sunken) pe-4"
      >
        <h3 [id]="headingId()" class="min-w-0 flex-1">
          <button
            type="button"
            [attr.aria-expanded]="expanded()"
            [attr.aria-controls]="panelId()"
            (click)="toggled.emit()"
            class="flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-start
              text-(--text-primary) transition-colors hover:text-(--accent-primary)
              focus-visible:outline-2 focus-visible:-outline-offset-2
              focus-visible:outline-(--accent-primary)"
          >
            <svg
              aria-hidden="true"
              class="h-4 w-4 shrink-0 transition-transform"
              [class.rotate-180]="expanded()"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
            @if (logoName(); as name) {
              <aec-logo-or-initial [src]="logoSrc()" [name]="name" size="sm" />
            }
            <!-- text-lg = 1.125rem, the Serif-Floor Rule's minimum for the display
                 face (DESIGN.md §3). The size lives on the SPAN because
                 styles.css declares h3 { font-size: 1.25rem } OUTSIDE any cascade
                 layer, and unlayered rules beat every Tailwind utility, so a
                 text-* utility on the h3 itself is silently dead. See DESIGN.md
                 §3 "The Unlayered-Heading Rule". -->
            <span class="min-w-0 flex-1 truncate text-lg">{{ heading() }}</span>
            @if (countLabel(); as count) {
              <span class="shrink-0 text-xs font-normal text-(--text-secondary)">{{ count }}</span>
            }
          </button>
        </h3>
        @if (link(); as target) {
          <a
            [href]="target"
            target="_blank"
            rel="noopener"
            [attr.aria-label]="linkAriaLabel()"
            class="inline-flex shrink-0 items-center gap-1 rounded-(--radius-sm) text-xs
              text-(--accent-primary) underline underline-offset-4 focus-visible:outline-2
              focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
            >{{ linkLabel() }}
            <!-- Lucide arrow-up-right. Sighted readers get no domain change to
                 hint at the new tab, so the cue has to be drawn. Screen readers
                 hear it from the accessible name instead. -->
            <svg
              aria-hidden="true"
              class="h-3 w-3 shrink-0 rtl:-scale-x-100"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M7 7h10v10" />
              <path d="M7 17 17 7" />
            </svg>
          </a>
        }
      </div>

      <!-- The panel keeps NO display utility, so the hidden attribute is the
           only thing deciding its box. A flex or grid utility here would beat
           the browser's [hidden] display:none rule and the card would never
           close. -->
      <div
        [id]="panelId()"
        role="region"
        [attr.aria-labelledby]="headingId()"
        [hidden]="!expanded()"
      >
        <ng-content />
      </div>
    </section>
  `,
})
export class IntegrationGroupCard {
  /** DOM id of the card's `<h3>`; the panel is named by it and derives its own. */
  readonly headingId = input.required<string>();
  /** The group's subject, as a noun phrase. Named `heading` rather than `title`
   *  so it can never be confused with the native `title` attribute on the host. */
  readonly heading = input.required<string>();
  /** Logo source for the subject, when it has one. */
  readonly logoSrc = input<string | null>(null);
  /** Subject name for the logo's initial fallback. `null` renders no logo at
   *  all, which is the hubless "Other connections" card. */
  readonly logoName = input<string | null>(null);
  /** Localized group size, e.g. "12 connections" or "3 of 12" under a filter.
   *  Built by the section so the i18n ids stay where the copy is. */
  readonly countLabel = input<string>('');
  /** Href for the subject's own page, or `null` for no link. A path, not
   *  RouterLink commands: the anchor opens a new tab, so there is no in-app
   *  navigation for the router to take part in. */
  readonly link = input<string | null>(null);
  /** Visible link text. */
  readonly linkLabel = input<string>('');
  /** Full accessible name for the link. The visible text repeats on every card,
   *  and the new tab has to be announced; both are the caller's to phrase, so
   *  the i18n ids stay with the copy. Must begin with `linkLabel` (WCAG 2.5.3). */
  readonly linkAriaLabel = input<string>('');
  /** Controlled disclosure state. */
  readonly expanded = input<boolean>(true);
  /** Emitted on header click; the owning section flips its collapsed set. */
  readonly toggled = output<void>();

  protected readonly panelId = computed(() => this.headingId() + '-panel');
}
