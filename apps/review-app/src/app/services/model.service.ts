// ---------------------------------------------------------------------------
// Selected LLM model for runs the user kicks off from this tab.
//
// Intentionally NOT persisted: refreshing the page resets to the default
// (Haiku) so a session-scoped pick of Opus can't accidentally bleed into
// future visits and rack up API spend.
// ---------------------------------------------------------------------------
import { Injectable, signal } from '@angular/core';

export interface ModelOption {
  id: string;
  label: string;
}

export const MODEL_OPTIONS: ModelOption[] = [
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { id: 'claude-opus-4-7', label: 'Opus 4.7' },
];

export const DEFAULT_MODEL = MODEL_OPTIONS[0].id;

@Injectable({ providedIn: 'root' })
export class ModelService {
  private readonly _selected = signal<string>(DEFAULT_MODEL);
  readonly selected = this._selected.asReadonly();

  readonly options = MODEL_OPTIONS;

  select(id: string): void {
    if (MODEL_OPTIONS.some((m) => m.id === id)) {
      this._selected.set(id);
    }
  }
}
