import { Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { map } from 'rxjs';

import type { VendorThreadById } from '@aeci/shared';

import { ID_STYLES } from './integration-detail-styles';
import { IntegrationRowThread } from './integration-row-thread';

/**
 * `…/threads/:threadId` (AECI-1548, `STAGE_2_ATTESTATIONS_SPEC.md` §15.10): one
 * private row thread, read-only, by its id. The `portal-thread-closed` notice links
 * here. Ruled 2026-10-30: a vendor keeps read access to a thread whose row was
 * deleted, and such a thread has no integration page to sit on.
 *
 * The page names the row from the thread's `data_object` (the live claim's, else
 * its anchor snapshot) and hands the rest to `aec-integration-row-thread` in its
 * read-only mode: the messages, the close sentence, and no composer. Nothing here
 * writes. The read sets the seat's read marker on the server.
 */
@Component({
  selector: 'aec-vendor-thread-page',
  imports: [IntegrationRowThread, RouterLink],
  styles: [ID_STYLES],
  template: `
    <nav class="mt-2" i18n-aria-label="@@vendor.thread.page.breadcrumb" aria-label="Breadcrumb">
      <a routerLink="../../messages" [class]="backLinkClass" i18n="@@vendor.thread.page.back"
        >Back to Messages</a
      >
    </nav>
    <h2 class="id-h2 mt-4 break-words text-(--text-primary)" data-testid="thread-page-title">
      {{ title() }}
    </h2>
    <p class="mt-2 max-w-prose text-sm text-(--text-secondary)" i18n="@@vendor.thread.page.intro">
      A private conversation between your company and the other company on this data row. Only your
      two companies and AEC Integrations see it. This page is read-only.
    </p>
    @if (threadId(); as id) {
      <aec-integration-row-thread [threadId]="id" (threadLoaded)="thread.set($event)" />
    }
  `,
})
export class VendorThreadPage {
  private readonly route = inject(ActivatedRoute);

  protected readonly threadId = toSignal(this.route.paramMap.pipe(map((p) => p.get('threadId'))), {
    initialValue: this.route.snapshot.paramMap.get('threadId'),
  });

  protected readonly thread = signal<VendorThreadById | null>(null);

  protected readonly title = computed(() => {
    const name = this.thread()?.data_object?.name;
    return name
      ? $localize`:@@vendor.thread.page.title:Conversation about ${name}:data:`
      : $localize`:@@vendor.thread.page.titleUnnamed:Conversation about a data row`;
  });

  protected readonly backLinkClass =
    'inline-flex min-h-6 items-center gap-1 rounded-(--radius-sm) text-sm font-medium text-(--accent-primary) underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';
}
