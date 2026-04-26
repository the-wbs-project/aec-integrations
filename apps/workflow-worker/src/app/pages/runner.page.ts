import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import {
  DropDownListModule,
  MultiSelectAllModule,
} from '@syncfusion/ej2-angular-dropdowns';
import { TextBoxModule } from '@syncfusion/ej2-angular-inputs';
import { ButtonModule } from '@syncfusion/ej2-angular-buttons';
import {
  WorkflowClient,
  type OptionsResponse,
  type RunStatus,
} from '../services/workflow-client';
import { WORKFLOWS } from '../workflows';

interface PickerItem {
  id: string;
  label: string;
  group: string;
}

interface Choice<T extends string> {
  value: T;
  label: string;
}

@Component({
  selector: 'page-runner',
  standalone: true,
  imports: [
    FormsModule,
    RouterLink,
    MultiSelectAllModule,
    DropDownListModule,
    TextBoxModule,
    ButtonModule,
  ],
  template: `
    <p><a routerLink="/">← All workflows</a></p>
    <h1>{{ meta?.title ?? slug }}</h1>
    <p class="blurb">{{ meta?.blurb }}</p>

    <form (submit)="$event.preventDefault(); start()">
      @if (optionsLoading()) {
        <p>Loading records…</p>
      } @else if (pickerItems(); as items) {
        <label>
          Records
          <ejs-multiselect
            [dataSource]="items"
            [fields]="pickerFields"
            mode="CheckBox"
            [enableGroupCheckBox]="true"
            [showSelectAll]="false"
            [allowFiltering]="true"
            [(ngModel)]="selectedIds"
            name="records"
            placeholder="Pick records to run">
          </ejs-multiselect>
        </label>
        <p class="hint">
          <a href="javascript:void(0)" (click)="loadOptions(true)">Refresh list</a>
        </p>
      } @else {
        <label>
          Record IDs (comma-separated)
          <ejs-textbox
            [(ngModel)]="recordIdsInput"
            name="recordIds"
            placeholder="rec... ,rec...">
          </ejs-textbox>
        </label>
      }

      <label>
        Model
        <ejs-dropdownlist
          [dataSource]="modelChoices"
          [fields]="choiceFields"
          [(ngModel)]="model"
          name="model">
        </ejs-dropdownlist>
      </label>

      <label>
        Search tool
        <ejs-dropdownlist
          [dataSource]="searchToolChoices"
          [fields]="choiceFields"
          [(ngModel)]="searchTool"
          name="searchTool">
        </ejs-dropdownlist>
      </label>

      @if (searchTool === 'serpapi') {
        <label>
          SerpAPI provider
          <ejs-dropdownlist
            [dataSource]="searchProviderChoices"
            [fields]="choiceFields"
            [(ngModel)]="searchProvider"
            name="searchProvider">
          </ejs-dropdownlist>
        </label>
      }

      <button ejs-button type="submit" isPrimary="true" [disabled]="busy()">
        {{ busy() ? 'Starting…' : 'Start run' }}
      </button>
    </form>

    @if (errorMsg()) {
      <p class="error">{{ errorMsg() }}</p>
    }

    @if (status(); as s) {
      <section class="status">
        <h2>Run {{ s.runId }} · {{ s.status }}</h2>
        <p>
          step {{ s.step }} · started {{ s.startedAt }}
          @if (s.finishedAt) { · finished {{ s.finishedAt }} }
        </p>
        <ul class="records">
          @for (r of s.records; track r.recordId) {
            <li>
              <code>{{ r.recordId }}</code>
              · {{ r.status }}
              · turns {{ r.turns }}
              @if (r.fieldsUpdated?.length) {
                · updated [{{ r.fieldsUpdated!.join(', ') }}]
              }
              @if (r.error) {
                · <span class="error">{{ r.error }}</span>
              }
            </li>
          }
        </ul>
      </section>
    }
  `,
  styles: [`
    h1 { margin: 8px 0 0; font-size: 22px; }
    .blurb { color: #555; margin: 0 0 16px; }
    form { display: grid; gap: 12px; max-width: 520px; background: #fff; border: 1px solid #e5e5e5; border-radius: 8px; padding: 16px; }
    label { display: grid; gap: 4px; font-size: 14px; color: #444; }
    .error { color: #c0392b; }
    .hint { font-size: 12px; color: #666; margin: -4px 0 0; }
    .status { margin-top: 24px; background: #fff; border: 1px solid #e5e5e5; border-radius: 8px; padding: 16px; }
    .records { list-style: none; padding: 0; margin: 0; display: grid; gap: 6px; }
    .records li { font-size: 14px; }
    code { background: #f0f0f0; padding: 1px 6px; border-radius: 4px; }
  `],
})
export class RunnerPage implements OnInit, OnDestroy {
  private route = inject(ActivatedRoute);
  private client = inject(WorkflowClient);
  slug = (this.route.snapshot.data['workflow'] as string) ?? '';
  meta = WORKFLOWS.find((w) => w.slug === this.slug);

  recordIdsInput = '';
  selectedIds: string[] = [];
  model = 'claude-haiku-4-5-20251001';
  searchTool: 'web' | 'serpapi' = 'web';
  searchProvider: 'searchapi' | 'serpapi' = 'searchapi';
  busy = signal(false);
  status = signal<RunStatus | null>(null);
  errorMsg = signal<string | null>(null);
  optionsLoading = signal(false);
  pickerItems = signal<PickerItem[] | null>(null);

  /** Map of `__all:<key>` sentinel → real record IDs in that group. */
  private groupExpansion = new Map<string, string[]>();
  pickerFields = { text: 'label', value: 'id', groupBy: 'group' };
  choiceFields = { text: 'label', value: 'value' };

  modelChoices: Choice<string>[] = [
    { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
    { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
    { value: 'claude-opus-4-7', label: 'Claude Opus 4.7' },
  ];
  searchToolChoices: Choice<'web' | 'serpapi'>[] = [
    { value: 'web', label: 'Anthropic web_search (default)' },
    { value: 'serpapi', label: 'Custom SerpAPI tool' },
  ];
  searchProviderChoices: Choice<'searchapi' | 'serpapi'>[] = [
    { value: 'searchapi', label: 'SearchAPI.io' },
    { value: 'serpapi', label: 'SerpAPI.com' },
  ];

  private pollHandle: ReturnType<typeof setInterval> | null = null;

  ngOnInit(): void {
    this.loadOptions(false);
  }

  ngOnDestroy(): void {
    this.stopPolling();
  }

  loadOptions(refresh: boolean): void {
    this.optionsLoading.set(true);
    this.client.getOptions(this.slug, refresh).subscribe({
      next: (res) => {
        this.optionsLoading.set(false);
        this.pickerItems.set(this.flattenOptions(res));
        this.selectedIds = [];
      },
      error: () => {
        this.optionsLoading.set(false);
        this.pickerItems.set(null);
      },
    });
  }

  private flattenOptions(res: OptionsResponse): PickerItem[] | null {
    if (!res.supported) return null;
    this.groupExpansion.clear();
    const items: PickerItem[] = [];
    for (const group of res.groups) {
      if (group.records.length === 0) continue;
      const allId = `__all:${group.key}`;
      const allLabel = `All — ${group.label} (${group.records.length})`;
      this.groupExpansion.set(allId, group.records.map((r) => r.id));
      items.push({ id: allId, label: allLabel, group: group.label });
      for (const r of group.records) {
        items.push({ id: r.id, label: r.label, group: group.label });
      }
    }
    return items;
  }

  start(): void {
    this.errorMsg.set(null);
    this.status.set(null);

    let ids: string[];
    if (this.pickerItems()) {
      const expanded = new Set<string>();
      for (const sel of this.selectedIds) {
        const group = this.groupExpansion.get(sel);
        if (group) {
          for (const id of group) expanded.add(id);
        } else {
          expanded.add(sel);
        }
      }
      ids = [...expanded];
    } else {
      ids = this.recordIdsInput
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }

    if (ids.length === 0) {
      this.errorMsg.set('Pick at least one record.');
      return;
    }
    this.busy.set(true);
    this.client
      .startRun(this.slug, {
        record_ids: ids,
        model: this.model,
        search_tool: this.searchTool,
        search_provider: this.searchProvider,
      })
      .subscribe({
        next: (res) => {
          this.busy.set(false);
          this.startPolling(res.runId);
        },
        error: (err) => {
          this.busy.set(false);
          this.errorMsg.set(err?.error?.error ?? 'Failed to start run.');
        },
      });
  }

  private startPolling(runId: string): void {
    this.stopPolling();
    const tick = () => {
      this.client.getStatus(runId).subscribe({
        next: (s) => {
          this.status.set(s);
          if (s.status === 'completed' || s.status === 'failed') this.stopPolling();
        },
        error: (err) => {
          this.errorMsg.set(err?.error?.error ?? 'Failed to load status.');
          this.stopPolling();
        },
      });
    };
    tick();
    this.pollHandle = setInterval(tick, 3000);
  }

  private stopPolling(): void {
    if (this.pollHandle) clearInterval(this.pollHandle);
    this.pollHandle = null;
  }
}
