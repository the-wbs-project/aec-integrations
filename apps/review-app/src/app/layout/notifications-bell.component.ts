// ---------------------------------------------------------------------------
// Notification bell — anchored top-right of the shell header.
//
// Shows the in-flight count as a Syncfusion Badge over a bell icon. Clicking
// the bell opens a dropdown panel of the latest 25 runs (RunsService.runs).
// Clicking a row opens a Syncfusion Dialog with the full status / error /
// output for that run.
// ---------------------------------------------------------------------------
import { Component, ElementRef, HostListener, computed, inject, signal } from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { ButtonModule } from '@syncfusion/ej2-angular-buttons';
import { RunsService, type RecentRunRow } from '../services/runs.service';
import { WORKFLOWS } from '../workflows';
import { RunDetailDialogComponent } from '../components/run-detail-dialog/run-detail-dialog.component';

@Component({
  selector: 'app-notifications-bell',
  imports: [CommonModule, RouterLink, ButtonModule, DatePipe, RunDetailDialogComponent],
  templateUrl: './notifications-bell.component.html',
  styleUrl: './notifications-bell.component.scss',
})
export class NotificationsBellComponent {
  private readonly runsService = inject(RunsService);
  private readonly host = inject(ElementRef<HTMLElement>);

  protected readonly runs = this.runsService.runs;
  protected readonly inFlight = this.runsService.inFlightCount;
  protected readonly open = signal(false);

  // Track the open dialog by id, then resolve against the live runs list so
  // the dialog updates as new run-* events arrive over the WebSocket.
  protected readonly selectedId = signal<string | null>(null);
  protected readonly selected = computed<RecentRunRow | null>(() => {
    const id = this.selectedId();
    if (!id) return null;
    return this.runs().find((r) => r.runId === id) ?? null;
  });

  protected readonly bellLabel = computed(() => {
    const n = this.inFlight();
    if (n === 0) return 'Recent runs (none in flight)';
    return `Recent runs (${n} in flight)`;
  });

  constructor() {
    this.runsService.start();
  }

  toggle(): void {
    this.open.update((v) => !v);
    if (this.open()) this.runsService.refresh();
  }

  close(): void {
    this.open.set(false);
  }

  @HostListener('document:pointerdown', ['$event'])
  onDocumentPointerDown(event: PointerEvent): void {
    if (!this.open()) return;
    const target = event.target as Node | null;
    if (target && !this.host.nativeElement.contains(target)) {
      this.open.set(false);
    }
  }

  select(run: RecentRunRow): void {
    this.selectedId.set(run.runId);
    this.open.set(false);
  }

  onDialogClosed(): void {
    this.selectedId.set(null);
  }

  workflowTitle(slug: string): string {
    return WORKFLOWS.find((w) => w.slug === slug)?.title ?? slug;
  }
}
