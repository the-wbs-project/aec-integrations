import { DatePipe, formatDate } from '@angular/common';
import {
  Component,
  LOCALE_ID,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { Title } from '@angular/platform-browser';
import { ActivatedRoute, RouterLink } from '@angular/router';

import type { AdminThreadDetail } from '@aeci/shared';

import { AecButton } from '../../shared/button/button';
import { Chip } from '../../shared/chip/chip';
import { AdminBreadcrumbStore } from '../admin-breadcrumb.store';
import { CONSOLE_LABEL_CLASS, CONSOLE_PANEL_CLASS } from '../console/console-table';
import { adminStatusTone } from '../console/status-tones';
import { ADMIN_DETAIL_FALLBACK_LABELS } from '../admin-nav';
import { isStatus } from '../http-status';
import { threadStateLabel, threadSubject } from './admin-thread-labels';
import { AdminThreadsApi } from './admin-threads-api';
import {
  CONSOLE_FACTS_CLASS,
  CONSOLE_FACT_VALUE_CLASS,
  CONSOLE_FOREST_LINK_CLASS,
} from '../console/console-detail';

/**
 * `/admin/threads/:id` — one private row thread, read-only. AECI-1539,
 * `ADMIN_PANEL_SPEC.md` §5.19, `STAGE_2_ATTESTATIONS_SPEC.md` §15.12.
 *
 * Every message, oldest first, **the text of a deleted one included**: AECi may
 * read it until the 2-year delete (§15.3). A deleted message is marked with the
 * day it was deleted, because the two companies no longer see it and an operator
 * quoting it back to them must know that.
 *
 * Message text is plain text: interpolated, never bound as HTML, never linked.
 * Nothing here writes. AECi answers a help request by email, outside the product.
 */
@Component({
  selector: 'aec-thread-detail',
  imports: [AecButton, Chip, DatePipe, RouterLink],
  templateUrl: './thread-detail.html',
})
export class ThreadDetail {
  private readonly api = inject(AdminThreadsApi);
  private readonly route = inject(ActivatedRoute);
  private readonly breadcrumbs = inject(AdminBreadcrumbStore);
  private readonly titleSvc = inject(Title);
  private readonly locale = inject(LOCALE_ID);

  protected readonly threadId = signal(this.route.snapshot.paramMap.get('id') ?? '');
  protected readonly thread = signal<AdminThreadDetail | null>(null);
  protected readonly loading = signal(true);
  protected readonly loadFailed = signal(false);
  protected readonly notFound = signal(false);

  protected readonly stateLabel = threadStateLabel;

  // AECI-2111: the console's detail page (mock-up 14).
  protected readonly panelClass = CONSOLE_PANEL_CLASS;
  protected readonly labelClass = CONSOLE_LABEL_CLASS;
  protected readonly factsClass = CONSOLE_FACTS_CLASS;
  protected readonly valueClass = CONSOLE_FACT_VALUE_CLASS;
  protected readonly inlineLinkClass = CONSOLE_FOREST_LINK_CLASS;

  /** Open is live, closed is quiet (`ADMIN_STATUS_TONES`). */
  protected stateTone(thread: AdminThreadDetail) {
    return adminStatusTone(thread.closed_reason ? 'closed' : 'threadOpen');
  }

  /** The data row the thread is about, or the trail's own word before the fetch. */
  protected readonly headingLabel = computed(() => {
    const thread = this.thread();
    if (!thread) return ADMIN_DETAIL_FALLBACK_LABELS['threads'] ?? '';
    const subject = threadSubject(thread);
    const a = thread.vendor_a.name;
    const b = thread.vendor_b.name;
    return $localize`:@@admin.threads.detail.heading:${subject}:SUBJECT: between ${a}:A: and ${b}:B:`;
  });

  constructor() {
    this.titleSvc.setTitle(
      $localize`:@@admin.threads.detail.metaTitle:Row thread · Admin · AEC Integrations`,
    );
    afterNextRender(() => {
      void this.load();
    });
    // Feed the shell's breadcrumb, as the claim detail does (AECI-777).
    effect(() => {
      if (this.thread()) this.breadcrumbs.publish(this.threadId(), this.headingLabel());
    });
  }

  /** One translatable sentence: when the author deleted it, and what the companies see. */
  protected deletedLine(at: string): string {
    const date = formatDate(at, 'medium', this.locale, 'UTC');
    return $localize`:@@admin.threads.detail.deleted:Deleted by its author on ${date}:DATE:. The two companies see "Message deleted".`;
  }

  protected retry(): void {
    void this.load();
  }

  private async load(): Promise<void> {
    const id = this.threadId();
    if (!id) {
      this.notFound.set(true);
      this.loading.set(false);
      return;
    }
    this.loading.set(true);
    this.loadFailed.set(false);
    this.notFound.set(false);
    try {
      const { thread } = await this.api.getThread(id);
      this.thread.set(thread);
    } catch (err) {
      if (isStatus(err, 404)) this.notFound.set(true);
      else this.loadFailed.set(true);
      this.thread.set(null);
    } finally {
      this.loading.set(false);
    }
  }
}
