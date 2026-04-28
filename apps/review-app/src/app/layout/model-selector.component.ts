// ---------------------------------------------------------------------------
// Tab-scoped model picker. Sits in the app bar to the left of the
// notifications bell. Selection lives in ModelService and resets to Haiku
// on refresh — see model.service.ts for rationale.
// ---------------------------------------------------------------------------
import { Component, inject } from '@angular/core';
import {
  DropDownListModule,
  type ChangeEventArgs,
} from '@syncfusion/ej2-angular-dropdowns';
import { ModelService } from '../services/model.service';

@Component({
  selector: 'app-model-selector',
  standalone: true,
  imports: [DropDownListModule],
  templateUrl: './model-selector.component.html',
  styleUrl: './model-selector.component.scss',
})
export class ModelSelectorComponent {
  protected readonly model = inject(ModelService);

  protected readonly fields = { text: 'label', value: 'id' };

  protected onChange(args: ChangeEventArgs): void {
    const value = args.value;
    if (typeof value === 'string') this.model.select(value);
  }
}
