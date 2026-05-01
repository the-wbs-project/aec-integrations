// ---------------------------------------------------------------------------
// Promote split-button.
//
// Three visual states driven by `status`:
//   - undefined / 'pending' / 'ready'  -> "Promote" button (sets 'promoted')
//   - 'promoted'                       -> "Promoted ✓" split-button with
//                                         "Retract" item (sets 'retracted')
//   - 'retracted'                      -> "Retracted" disabled-looking button
//
// Emits the new status on `statusChange`. Persistence is handled by the
// parent so this component stays unaware of the API surface.
// ---------------------------------------------------------------------------
import { Component, computed, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ButtonModule } from '@syncfusion/ej2-angular-buttons';
import {
  SplitButtonModule,
  type ItemModel,
} from '@syncfusion/ej2-angular-splitbuttons';
import type { PromotionStatus } from '../../types';

@Component({
  selector: 'app-promote-split-button',
  imports: [CommonModule, ButtonModule, SplitButtonModule],
  templateUrl: './promote-split-button.component.html',
  styleUrl: './promote-split-button.component.scss',
})
export class PromoteSplitButtonComponent {
  status = input<PromotionStatus | undefined>(undefined);
  disabled = input<boolean>(false);

  statusChange = output<PromotionStatus>();

  protected readonly view = computed<'promote' | 'promoted' | 'retracted'>(() => {
    const s = this.status();
    if (s === 'promoted') return 'promoted';
    if (s === 'retracted') return 'retracted';
    return 'promote';
  });

  protected readonly retractItems: ItemModel[] = [{ id: 'retract', text: 'Retract' }];
  protected readonly promoteItems: ItemModel[] = [{ id: 'promote', text: 'Promote' }];

  promote(): void {
    this.statusChange.emit('promoted');
  }

  onMenuSelect(args: { item?: ItemModel }): void {
    switch (args.item?.id) {
      case 'retract':
        this.statusChange.emit('retracted');
        return;
      case 'promote':
        this.statusChange.emit('promoted');
        return;
    }
  }
}
