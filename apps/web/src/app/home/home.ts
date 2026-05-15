import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  selector: 'app-home',
  template: `<p i18n="@@home.placeholder">AEC Integrations — coming soon.</p>`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Home {}
