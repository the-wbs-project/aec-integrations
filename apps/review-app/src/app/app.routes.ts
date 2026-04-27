import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    pathMatch: 'full',
    loadComponent: () =>
      import('./pages/dashboard/dashboard.page').then((m) => m.DashboardPage),
  },
  {
    path: 'tools',
    loadComponent: () =>
      import('./pages/tools-list/tools-list.component').then(
        (m) => m.ToolsListComponent
      ),
  },
  {
    path: 'tools/new',
    loadComponent: () =>
      import('./pages/tool-create/tool-create.component').then(
        (m) => m.ToolCreateComponent
      ),
  },
  {
    path: 'tools/:id',
    loadComponent: () =>
      import('./pages/tool-detail/tool-detail.component').then(
        (m) => m.ToolDetailComponent
      ),
  },
  {
    path: 'vendors',
    loadComponent: () =>
      import('./pages/vendors-list/vendors-list.component').then(
        (m) => m.VendorsListComponent
      ),
  },
  {
    path: 'vendors/:id',
    loadComponent: () =>
      import('./pages/vendor-detail/vendor-detail.component').then(
        (m) => m.VendorDetailComponent
      ),
  },
  {
    path: 'runs',
    loadComponent: () => import('./pages/runs/runs.page').then((m) => m.RunsPage),
  },
];
