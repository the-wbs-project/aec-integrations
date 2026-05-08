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
        path: 'products',
        loadComponent: () =>
          import('./pages/products-list/products-list.component').then(
            (m) => m.ProductsListComponent
          ),
      },
      {
        path: 'products/:id',
        pathMatch: 'full',
        redirectTo: 'products/:id/details',
      },
      {
        path: 'products/:id/:tab',
        loadComponent: () =>
          import('./pages/product-detail/product-detail.component').then(
            (m) => m.ProductDetailComponent
          ),
      },
      // Legacy /tools redirects — preserve external bookmarks pointing at the
      // old route names. Safe to remove after a transition window.
      { path: 'tools', pathMatch: 'full', redirectTo: 'products' },
      { path: 'tools/:id', pathMatch: 'full', redirectTo: 'products/:id/details' },
      { path: 'tools/:id/:tab', redirectTo: 'products/:id/:tab' },
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
        path: 'search',
        loadComponent: () =>
          import('./pages/search/search.page').then((m) => m.SearchPage),
      },
      {
        path: 'runs',
        loadComponent: () => import('./pages/runs/runs.page').then((m) => m.RunsPage),
      },
      {
        path: 'prompts',
        loadComponent: () =>
          import('./pages/prompts/prompts.component').then(
            (m) => m.PromptsComponent
          ),
      },
    ],
  },
];
