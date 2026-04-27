import { Component, input } from '@angular/core';
import { TooltipModule } from '@syncfusion/ej2-angular-popups';

@Component({
  selector: 'app-info-tooltip',
  standalone: true,
  imports: [TooltipModule],
  template: `
    <ejs-tooltip [content]="tooltip()" position="TopCenter" opensOn="Hover Focus">
      <span class="info-tooltip" tabindex="0" role="img" [attr.aria-label]="tooltip()">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="16" x2="12" y2="12" />
          <line x1="12" y1="8" x2="12.01" y2="8" />
        </svg>
      </span>
    </ejs-tooltip>
  `,
  styles: `
    .info-tooltip {
      display: inline-flex;
      align-items: center;
      vertical-align: middle;
      margin-left: 4px;
      color: var(--color-text-tertiary, var(--color-text-secondary));
      cursor: help;
      line-height: 0;
    }

    .info-tooltip:hover,
    .info-tooltip:focus-visible {
      color: var(--color-text-secondary);
      outline: none;
    }

    .info-tooltip svg {
      width: 12px;
      height: 12px;
    }
  `,
})
export class InfoTooltipComponent {
  readonly tooltip = input.required<string>();
}
