import { Component } from '@angular/core';

import { HomeHero } from './home-hero';

/**
 * Home page (`/`). The page is assembled in phases (Stage 1 §4.1): 4.7 hero
 * (this), then stats cards (4.8), browse grids (4.9), recently-added / trending
 * (4.10), and final assembly + meta / JSON-LD / Cache-Tag (4.11). For now it is
 * a thin shell rendering the hero as its first stacked module; later phases
 * append their modules below it.
 */
@Component({
  selector: 'app-home',
  imports: [HomeHero],
  template: ` <aec-home-hero /> `,
})
export class Home {}
