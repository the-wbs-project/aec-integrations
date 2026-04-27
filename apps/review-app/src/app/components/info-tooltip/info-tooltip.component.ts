import { Component, input } from '@angular/core';
import { TooltipModule } from '@syncfusion/ej2-angular-popups';

@Component({
  selector: 'app-info-tooltip',
  standalone: true,
  imports: [TooltipModule],
  templateUrl: './info-tooltip.component.html',
  styleUrl: './info-tooltip.component.scss',
})
export class InfoTooltipComponent {
  readonly tooltip = input.required<string>();
}
