import { bootstrapApplication } from '@angular/platform-browser';
import { registerLicense } from '@syncfusion/ej2-base';
import { AppComponent } from './app/app.component';
import { appConfig } from './app/app.config';

const syncfusionKey = (globalThis as { __SYNCFUSION_LICENSE__?: string }).__SYNCFUSION_LICENSE__;
if (syncfusionKey) registerLicense(syncfusionKey);

bootstrapApplication(AppComponent, appConfig).catch((err) => console.error(err));
