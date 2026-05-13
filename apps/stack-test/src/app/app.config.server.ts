import { mergeApplicationConfig, ApplicationConfig } from '@angular/core';
import { provideServerRendering, withRoutes } from '@angular/ssr';
import { appConfig } from './app.config';
import { serverRoutes } from './app.routes.server';
import { DataService } from './data.service';
import { ServerDataService } from './data.service.server';

const serverConfig: ApplicationConfig = {
  providers: [
    provideServerRendering(withRoutes(serverRoutes)),
    { provide: DataService, useClass: ServerDataService },
  ]
};

export const config = mergeApplicationConfig(appConfig, serverConfig);
