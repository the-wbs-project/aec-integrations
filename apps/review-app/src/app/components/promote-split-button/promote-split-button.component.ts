// ---------------------------------------------------------------------------
// Promote split-button.
//
// Four visual states driven by `status`:
//   - undefined / 'pending' / 'ready'  -> "Promote" split button (primary
//                                         click sets 'promoted'; menu offers
//                                         "Reject")
//   - 'promoted'                       -> "Promoted ✓" split-button with
//                                         "Retract" and "Reject" menu items
//   - 'retracted'                      -> "Retracted" split-button with
//                                         "Promote" and "Reject" menu items
//   - 'rejected'                       -> "Rejected" split-button with
//                                         "Promote" menu item
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

  protected readonly view = computed<
    'promote' | 'promoted' | 'retracted' | 'rejected'
  >(() => {
    const s = this.status();
    if (s === 'promoted') return 'promoted';
    if (s === 'retracted') return 'retracted';
    if (s === 'rejected') return 'rejected';
    return 'promote';
  });

  protected readonly promoteMenuItems: ItemModel[] = [
    { id: 'reject', text: 'Reject' },
  ];
  protected readonly promotedMenuItems: ItemModel[] = [
    { id: 'retract', text: 'Retract' },
    { id: 'reject', text: 'Reject' },
  ];
  protected readonly retractedMenuItems: ItemModel[] = [
    { id: 'promote', text: 'Promote' },
    { id: 'reject', text: 'Reject' },
  ];
  protected readonly rejectedMenuItems: ItemModel[] = [
    { id: 'promote', text: 'Promote' },
  ];

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
      case 'reject':
        this.statusChange.emit('rejected');
        return;
    }
  }
}
