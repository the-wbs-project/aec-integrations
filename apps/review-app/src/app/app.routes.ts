import { Routes } from '@angular/router';
import { authGuard } from './guards/auth.guard';

export const routes: Routes = [
  {
    path: 'login',
    loadComponent: () =>
      import('./pages/login/login.component').then((m) => m.LoginComponent),
  },
  {
    path: 'forgot-password',
    loadComponent: () =>
      import('./pages/forgot-password/forgot-password.component').then(
        (m) => m.ForgotPasswordComponent
      ),
  },
  {
    path: 'reset-password',
    loadComponent: () =>
      import('./pages/reset-password/reset-password.component').then(
        (m) => m.ResetPasswordComponent
      ),
  },
  {
    path: '',
    canActivate: [authGuard],
    children: [
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
        pathMatch: 'full',
        redirectTo: 'tools/:id/details',
      },
      {
        path: 'tools/:id/:tab',
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
        pathMatch: 'full',
        redirectTo: 'vendors/:id/details',
      },
      {
        path: 'vendors/:id/:tab',
        loadComponent: () =>
          import('./pages/vendor-detail/vendor-detail.component').then(
            (m) => m.VendorDetailComponent
          ),
      },
      {
        path: 'runs',
        loadComponent: () => import('./pages/runs/runs.page').then((m) => m.RunsPage),
      },
    ],
  },
];
