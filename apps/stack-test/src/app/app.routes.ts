import { Routes } from '@angular/router';

import { entitiesResolver, entityResolver } from './resolvers';

export const routes: Routes = [
  {
    path: '',
    pathMatch: 'full',
    loadComponent: () => import('./home/home.component').then((m) => m.HomeComponent),
  },
  {
    path: 'cached/:id',
    resolve: { entity: entityResolver },
    loadComponent: () =>
      import('./cached/cached.component').then((m) => m.CachedComponent),
  },
  {
    path: 'admin',
    pathMatch: 'full',
    resolve: { entities: entitiesResolver },
    loadComponent: () =>
      import('./admin/admin-list.component').then((m) => m.AdminListComponent),
  },
  {
    path: 'admin/purge',
    loadComponent: () =>
      import('./admin/purge.component').then((m) => m.PurgeComponent),
  },
  {
    path: 'admin/:id',
    resolve: { entity: entityResolver },
    loadComponent: () =>
      import('./admin/edit.component').then((m) => m.EditComponent),
  },
];
