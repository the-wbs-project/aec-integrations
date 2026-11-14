import { Component, signal } from '@angular/core';
import { DeferBlockBehavior, DeferBlockState, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { beforeEach, describe, expect, it } from 'vitest';

import type { TaxonomyTermWithCount } from '@aeci/shared';

import { type BrowseMenuModel, EMPTY_BROWSE_MENU } from '../core/taxonomy/browse-menu-model';
import { TaxonomyNavStore } from '../core/taxonomy/taxonomy-nav.store';

import { BROWSE_PANEL_ID, BrowseMenu, isBrowseSection } from './browse-menu';

function term(slug: string, name: string, count: number): TaxonomyTermWithCount {
  return { id: slug, slug, name, description: null, display_order: 0, product_count: count };
}

const MENU: BrowseMenuModel = {
  totalProducts: 486,
  keyCategories: [term('ai', 'AI', 69), term('project-management', 'Project Management', 1)],
  categories: [term('field', 'Field Management', 54)],
  phases: [term('design', 'Design', 40)],
  audiences: [term('owners', 'Owners', 30)],
  trades: [term('hvac', 'HVAC', 12)],
};

@Component({ template: '' })
class BlankPage {}

@Component({
  imports: [BrowseMenu],
  template: `<aec-browse-menu /><button type="button" id="outside">Outside</button>`,
})
class Host {}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function render(menu: BrowseMenuModel = MENU) {
  TestBed.configureTestingModule({
    // The panel body is a `@defer` block. Render it on demand, as the browser
    // does once the panel opens or the page goes idle.
    deferBlockBehavior: DeferBlockBehavior.Manual,
    providers: [
      provideRouter([{ path: '**', component: BlankPage }]),
      { provide: TaxonomyNavStore, useValue: { browse: signal(menu) } },
    ],
  });
  const fixture = TestBed.createComponent(Host);
  fixture.autoDetectChanges();
  const root = fixture.nativeElement as HTMLElement;
  document.body.appendChild(root);
  for (const block of await fixture.getDeferBlocks()) await block.render(DeferBlockState.Complete);
  // The terms wait for the first browser render (`BrowsePanel.ready`).
  await fixture.whenStable();
  fixture.detectChanges();
  return {
    fixture,
    root,
    host: root.querySelector<HTMLElement>('aec-browse-menu')!,
    trigger: root.querySelector<HTMLAnchorElement>('a[aria-controls]')!,
    panel: () => root.querySelector<HTMLElement>(`#${BROWSE_PANEL_ID}`)!,
    settle: async () => {
      fixture.detectChanges();
      await fixture.whenStable();
    },
  };
}

describe('BrowseMenu', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('is a link to /products that controls a closed panel, with no aria-haspopup', async () => {
    const { trigger, panel } = await render();
    expect(trigger.textContent?.trim()).toBe('Browse');
    expect(trigger.getAttribute('href')).toBe('/products');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger.getAttribute('aria-controls')).toBe(BROWSE_PANEL_ID);
    // Disclosure navigation, not an ARIA menu (DESIGN.md §5).
    expect(trigger.hasAttribute('aria-haspopup')).toBe(false);
    expect(panel().hidden).toBe(true);
    expect(panel().querySelector('[role="menu"], [role="menuitem"]')).toBeNull();
  });

  it('renders the five columns in order, each list named by its overline', async () => {
    const { panel } = await render();
    const labels = Array.from(panel().querySelectorAll('.aec-overline')).map((p) =>
      p.textContent?.trim(),
    );
    expect(labels).toEqual([
      'Explore',
      'Key categories',
      'Categories',
      'Phases',
      'Audiences',
      'Trades',
    ]);
    for (const list of Array.from(panel().querySelectorAll('ul'))) {
      const id = list.getAttribute('aria-labelledby')!;
      expect(panel().querySelector(`#${id}`), id).not.toBeNull();
    }
    const hrefs = Array.from(panel().querySelectorAll('a')).map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual([
      '/products',
      '/categories/ai',
      '/categories/project-management',
      '/categories/field',
      '/categories',
      '/phases/design',
      '/phases',
      '/audiences/owners',
      '/audiences',
      '/trades/hvac',
      '/trades',
    ]);
    expect(panel().textContent).toContain('See all categories');
    expect(panel().textContent).toContain(
      'Key categories are chosen by AEC Integrations. Other lists show most products first. Phases in project order.',
    );
  });

  it('prints counts in words, singular and plural', async () => {
    const { panel } = await render();
    const all = panel().querySelector('a[href="/products"]')!;
    expect(all.textContent?.replace(/\s+/g, ' ').trim()).toBe('All products 486 products');
    const pm = panel().querySelector('a[href="/categories/project-management"]')!;
    expect(pm.textContent?.replace(/\s+/g, ' ').trim()).toBe('Project Management 1 product');
  });

  it('renders "All products" with no count when the API omits the total', async () => {
    const { panel } = await render({ ...MENU, totalProducts: undefined });
    const all = panel().querySelector('a[href="/products"]')!;
    expect(all.textContent?.trim()).toBe('All products');
    expect(all.textContent).not.toContain('undefined');
  });

  it('keeps every index link when the taxonomy fetch has not landed or failed', async () => {
    const { panel } = await render(EMPTY_BROWSE_MENU);
    const hrefs = Array.from(panel().querySelectorAll('a')).map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['/products', '/categories', '/phases', '/audiences', '/trades']);
  });

  it('opens on hover after the intent delay, and closes after the grace when the pointer leaves', async () => {
    const { host, trigger, panel, settle } = await render();
    host.dispatchEvent(new MouseEvent('mouseenter'));
    await settle();
    // Not yet: a pointer passing over "Browse" does not flash the panel.
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    await pause(100);
    await settle();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(panel().hidden).toBe(false);

    host.dispatchEvent(new MouseEvent('mouseleave'));
    await pause(100);
    await settle();
    // Still open inside the grace: the pointer can cross the gap to the panel.
    expect(panel().hidden).toBe(false);
    host.dispatchEvent(new MouseEvent('mouseenter'));
    await pause(300);
    await settle();
    expect(panel().hidden).toBe(false);

    host.dispatchEvent(new MouseEvent('mouseleave'));
    await pause(320);
    await settle();
    expect(panel().hidden).toBe(true);
  });

  it('opens on the down arrow and moves focus to "All products"', async () => {
    const { trigger, panel, settle } = await render();
    trigger.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
    );
    await settle();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(panel().querySelector('a[href="/products"]'));
  });

  it('Escape inside closes and returns focus to "Browse"', async () => {
    const { trigger, panel, settle } = await render();
    trigger.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
    );
    await settle();
    document.activeElement!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    await settle();
    expect(panel().hidden).toBe(true);
    expect(document.activeElement).toBe(trigger);
  });

  it('Escape elsewhere on the page closes a hover-opened panel', async () => {
    const { host, root, panel, settle } = await render();
    host.dispatchEvent(new MouseEvent('mouseenter'));
    await pause(100);
    await settle();
    expect(panel().hidden).toBe(false);
    root
      .querySelector('#outside')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    expect(panel().hidden).toBe(true);
  });

  it('closes when focus leaves, but not on a press inside the panel (Safari click)', async () => {
    const { trigger, panel, settle } = await render();
    trigger.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
    );
    await settle();
    const first = panel().querySelector<HTMLAnchorElement>('a[href="/categories/ai"]')!;
    first.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    first.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
    await settle();
    expect(panel().hidden).toBe(false);

    first.dispatchEvent(new Event('pointerup', { bubbles: true }));
    first.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
    await settle();
    expect(panel().hidden).toBe(true);
  });

  it('closes after a destination is chosen', async () => {
    const { trigger, panel, settle } = await render();
    trigger.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
    );
    await settle();
    panel().querySelector<HTMLAnchorElement>('a[href="/trades/hvac"]')!.click();
    await settle();
    expect(panel().hidden).toBe(true);
    expect(TestBed.inject(Router).url).toBe('/trades/hvac');
  });

  it('draws the Clay cue only while open', async () => {
    const { trigger, settle } = await render();
    const cue = trigger.querySelector('[data-browse-cue]')!;
    expect(cue.getAttribute('aria-hidden')).toBe('true');
    expect(cue.classList).toContain('scale-x-0');
    trigger.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
    );
    await settle();
    expect(cue.classList).not.toContain('scale-x-0');
    expect(cue.className).toContain('bg-(--accent-secondary)');
  });

  it('pins panel destinations at weight 400 and gives them a Forest ring', async () => {
    const { panel } = await render();
    for (const link of Array.from(panel().querySelectorAll('a'))) {
      expect(link.className, link.getAttribute('href')!).toContain(
        'focus-visible:outline-(--accent-primary)',
      );
      expect(link.className).not.toContain('font-medium');
      expect(link.className).not.toContain('font-semibold');
    }
    for (const text of Array.from(panel().querySelectorAll('a > span:first-child'))) {
      expect(text.className).toContain('font-normal');
    }
  });
});

describe('isBrowseSection', () => {
  it.each([
    ['/products', true],
    ['/products/procore?tab=reviews', true],
    ['/categories#top', true],
    ['/audiences/owners', true],
    ['/trades', true],
    ['/phases/design', true],
    ['/', false],
    ['/productsx', false],
    ['/vendors/autodesk', false],
    ['/docs/trust/how-ranking-works', false],
  ])('%s → %s', (url, expected) => {
    expect(isBrowseSection(url)).toBe(expected);
  });
});
