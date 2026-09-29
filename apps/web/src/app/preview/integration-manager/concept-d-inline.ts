import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
  signal,
  viewChild,
} from '@angular/core';

import { ImAbout, ImLinks, ImRequests, ImRetire, ImShared } from './im-sections';
import { BTN_PRIMARY, BTN_SECONDARY, IM_STYLES } from './im-ui';
import { ImRowSummary } from './im-row-summary';
import {
  VIEWER,
  isConnector,
  isOwner,
  openOwnerRequest,
  publicPageHref,
  type ImIntegration,
} from './integration-manager.fixtures';
import { IntegrationManagerStore } from './integration-manager.store';

/**
 * Concept D, "Organized inline". The minimal change: keep today's inline
 * expansion, but give the expanded body clearly headed cards (About, What's
 * shared with a count, Your links, Change requests with history) and one action
 * bar at the foot, so Chris can see how far reorganizing alone gets.
 *
 * The cards carry no buttons of their own except the per-row answers. Every other
 * action sits in the bar, and opens its form inside the card it belongs to.
 */
@Component({
  selector: 'aec-im-concept-d',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ImAbout, ImLinks, ImRequests, ImRetire, ImShared, ImRowSummary],
  styles: [IM_STYLES],
  template: `
    <h2 class="im-h2 text-(--text-primary)">Integrations</h2>
    <p class="mt-1 max-w-prose text-sm text-(--text-secondary)">
      Every product {{ viewer }} connects to. Open one to check what is shared and fix anything that
      is wrong.
    </p>

    <ul class="mt-6 list-none space-y-3 p-0">
      @for (i of store.integrations(); track i.id) {
        <li class="im-card overflow-hidden">
          <h3 class="m-0">
            <button
              type="button"
              [attr.aria-expanded]="expanded() === i.id"
              [attr.aria-controls]="'im-d-panel-' + i.id"
              (click)="toggle(i.id)"
              class="flex w-full cursor-pointer items-center gap-4 px-5 py-4 text-start font-body text-base font-normal transition-colors hover:bg-(--surface-sunken) focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--accent-primary)"
              [attr.data-testid]="'toggle-' + i.id"
            >
              <aec-im-row-summary class="flex-1" [integration]="i" />
              <svg
                aria-hidden="true"
                class="h-5 w-5 shrink-0 text-(--text-secondary) transition-transform"
                [class.rotate-180]="expanded() === i.id"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="m6 9 6 6 6-6" />
              </svg>
            </button>
          </h3>

          @if (expanded() === i.id) {
            <div
              [id]="'im-d-panel-' + i.id"
              role="region"
              [attr.aria-label]="i.other.name"
              class="space-y-4 border-t border-(--border-default) bg-(--surface-raised) p-5"
            >
              <div class="grid gap-4 xl:grid-cols-[3fr_2fr]">
                <section class="im-card p-5" [attr.aria-labelledby]="'im-d-about-' + i.id">
                  <h4 [id]="'im-d-about-' + i.id" class="im-h4">About this integration</h4>
                  <div class="mt-3"><aec-im-about [integration]="i" [actions]="false" /></div>
                </section>
                <section class="im-card p-5" [attr.aria-labelledby]="'im-d-links-' + i.id">
                  <h4 [id]="'im-d-links-' + i.id" class="im-h4">Your links</h4>
                  <div class="mt-2">
                    <aec-im-links [integration]="i" [actions]="false" idSuffix="-d" />
                  </div>
                </section>
              </div>

              <section class="im-card p-5" [attr.aria-labelledby]="'im-d-shared-' + i.id">
                <h4 [id]="'im-d-shared-' + i.id" class="im-h4">
                  What's shared ({{ i.flows.length }})
                </h4>
                <div class="mt-2"><aec-im-shared [integration]="i" /></div>
              </section>

              <section #requests class="im-card p-5" [attr.aria-labelledby]="'im-d-req-' + i.id">
                <h4 [id]="'im-d-req-' + i.id" class="im-h4">Change requests</h4>
                <div class="mt-2">
                  <aec-im-requests
                    [integration]="i"
                    [actions]="false"
                    [subLevel]="5"
                    idSuffix="-d"
                  />
                </div>
              </section>

              @if (i.owner.state === 'you-claimed') {
                <aec-im-retire [integration]="i" />
              }

              <div
                role="group"
                [attr.aria-label]="'Actions for ' + i.other.name"
                class="im-card flex flex-wrap items-center gap-3 p-4"
              >
                @if (ownerButton(i); as b) {
                  <button type="button" [class]="b.primary ? primary : secondary" (click)="b.run()">
                    {{ b.label }}
                  </button>
                }
                @if (!isOwner(i) && !i.retired) {
                  <button type="button" [class]="secondary" (click)="requestCorrection(i)">
                    Request a correction
                  </button>
                }
                @if (!connector(i) && !i.retired) {
                  <button type="button" [class]="secondary" (click)="editLinks(i)">
                    Edit your links
                  </button>
                }
                <a
                  [href]="publicHref(i)"
                  target="_blank"
                  rel="noopener"
                  class="ms-auto inline-flex items-center gap-1 text-sm font-medium text-(--accent-primary) hover:underline"
                >
                  View public page
                  <svg
                    aria-hidden="true"
                    class="h-3.5 w-3.5"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path d="M15 3h6v6M10 14 21 3M21 14v7H3V3h7" />
                  </svg>
                  <span class="sr-only">(opens in a new tab)</span>
                </a>
              </div>
            </div>
          }
        </li>
      }
    </ul>
  `,
})
export class ConceptDInline {
  protected readonly store = inject(IntegrationManagerStore);
  private readonly requestsEl = viewChild<ElementRef<HTMLElement>>('requests');

  protected readonly viewer = VIEWER.product;
  protected readonly primary = BTN_PRIMARY;
  protected readonly secondary = BTN_SECONDARY;
  /** One open at a time; Navisworks starts open, as in the screenshot. */
  protected readonly expanded = signal<string | null>('navisworks');

  protected toggle(id: string): void {
    this.expanded.set(this.expanded() === id ? null : id);
    this.store.requestFormFor.set(null);
    this.store.editingLinksFor.set(null);
  }

  protected isOwner(i: ImIntegration): boolean {
    return isOwner(i);
  }
  protected connector(i: ImIntegration): boolean {
    return isConnector(i);
  }
  protected publicHref(i: ImIntegration): string {
    return publicPageHref(i);
  }

  protected ownerButton(
    i: ImIntegration,
  ): { label: string; primary: boolean; run: () => void } | null {
    if (i.retired) return null;
    switch (i.owner.state) {
      case 'you-unclaimed':
        return {
          label: 'Claim this integration',
          primary: true,
          run: () => this.store.claim(i.id),
        };
      case 'none':
        return openOwnerRequest(i)
          ? null
          : {
              label: 'Ask to be recorded as the owner',
              primary: false,
              run: () => this.requestCorrection(i, true),
            };
      default:
        return null;
    }
  }

  protected requestCorrection(i: ImIntegration, owner = false): void {
    this.store.editingLinksFor.set(null);
    this.store.requestFormFor.set({ id: i.id, field: owner ? 'owner' : null });
    requestAnimationFrame(() =>
      this.requestsEl()?.nativeElement.scrollIntoView({ block: 'start' }),
    );
  }

  protected editLinks(i: ImIntegration): void {
    this.store.requestFormFor.set(null);
    this.store.editingLinksFor.set(i.id);
  }
}
