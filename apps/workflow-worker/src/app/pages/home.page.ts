import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { WORKFLOWS } from '../workflows';

@Component({
  selector: 'page-home',
  standalone: true,
  imports: [RouterLink],
  template: `
    <h1>Workflows</h1>
    <p class="lead">Pick a workflow to run against one or more Airtable records.</p>

    <h2>Vendor enrichment</h2>
    <ul class="cards">
      @for (w of vendorWorkflows; track w.slug) {
        <li class="card">
          <a [routerLink]="['/run', w.slug]" class="title">{{ w.title }}</a>
          <p class="blurb">{{ w.blurb }}</p>
        </li>
      }
    </ul>

    <h2>Tool enrichment</h2>
    <ul class="cards">
      @for (w of toolWorkflows; track w.slug) {
        <li class="card">
          <a [routerLink]="['/run', w.slug]" class="title">{{ w.title }}</a>
          <p class="blurb">{{ w.blurb }}</p>
        </li>
      }
    </ul>
  `,
  styles: [`
    h1 { margin: 0 0 4px; font-size: 24px; }
    h2 { margin: 24px 0 12px; font-size: 16px; color: #555; text-transform: uppercase; letter-spacing: 0.04em; }
    .lead { color: #555; margin: 0 0 24px; }
    .cards { list-style: none; padding: 0; margin: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; }
    .card { background: #fff; border: 1px solid #e5e5e5; border-radius: 8px; padding: 14px 16px; }
    .title { font-weight: 600; text-decoration: none; color: #1a1a1a; }
    .title:hover { color: #2c5fd9; }
    .blurb { margin: 4px 0 0; color: #555; font-size: 14px; }
  `],
})
export class HomePage {
  vendorWorkflows = WORKFLOWS.filter((w) => w.family === 'vendor');
  toolWorkflows = WORKFLOWS.filter((w) => w.family === 'tool');
}
