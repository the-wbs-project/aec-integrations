// ---------------------------------------------------------------------------
// Notification bell — anchored top-right of the shell header.
//
// Shows the in-flight count as a Syncfusion Badge over a bell icon. Clicking
// the bell opens a dropdown panel of the latest 25 runs (RunsService.runs).
// Clicking a row opens a Syncfusion Dialog with the full status / error /
// output for that run.
// ---------------------------------------------------------------------------
import { Component, computed, inject, signal } from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { ButtonModule } from '@syncfusion/ej2-angular-buttons';
import { DialogModule } from '@syncfusion/ej2-angular-popups';
import { RunsService, type RecentRunRow } from '../services/runs.service';
import { WORKFLOWS } from '../workflows';

@Component({
  selector: 'app-notifications-bell',
  imports: [CommonModule, RouterLink, ButtonModule, DialogModule, DatePipe],
  templateUrl: './notifications-bell.component.html',
  styleUrl: './notifications-bell.component.scss',
})
export class NotificationsBellComponent {
  private readonly runsService = inject(RunsService);

  protected readonly runs = this.runsService.runs;
  protected readonly inFlight = this.runsService.inFlightCount;
  protected readonly open = signal(false);
  protected readonly selected = signal<RecentRunRow | null>(null);

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

  select(run: RecentRunRow): void {
    this.selected.set(run);
    this.open.set(false);
  }

  workflowTitle(slug: string): string {
    return WORKFLOWS.find((w) => w.slug === slug)?.title ?? slug;
  }
}
