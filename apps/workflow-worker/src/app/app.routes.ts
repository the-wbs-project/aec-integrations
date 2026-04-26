import { Routes } from '@angular/router';
import { WORKFLOWS } from './workflows';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./pages/home.page').then((m) => m.HomePage),
  },
  // One route per workflow. Each route loads the same RunnerPage but with a
  // different :workflow input binding, satisfying "each workflow is its own
  // page" with explicit URLs.
  ...WORKFLOWS.map((w) => ({
    path: `run/${w.slug}`,
    loadComponent: () => import('./pages/runner.page').then((m) => m.RunnerPage),
    data: { workflow: w.slug },
  })),
  { path: '**', redirectTo: '' },
];
