import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideRouter, RouterLink } from '@angular/router';
import { describe, expect, it } from 'vitest';

import { IntegrationGroupCard } from './integration-group-card';

/**
 * AECI-841 — the shared collapsible group card.
 *
 * The load-bearing assertion here is the one about a COLLAPSED card: its content
 * stays in the DOM. Every row inside these cards is an indexable internal link
 * to a pair page and the crawler walks them, so a future refactor that swaps
 * `[hidden]` for an `@if` has to fail a test rather than fail in production.
 */
@Component({
  imports: [IntegrationGroupCard],
  template: `
    <aec-integration-group-card
      headingId="card-heading"
      heading="Agave ERP Sync"
      logoName="Agave ERP Sync"
      countLabel="12 connections"
      [link]="link()"
      linkLabel="View product"
      linkAriaLabel="View product: Agave ERP Sync"
      [expanded]="expanded()"
      (toggled)="toggles.set(toggles() + 1)"
    >
      <p id="card-body">Twelve rows live here</p>
    </aec-integration-group-card>
  `,
})
class Host {
  expanded = signal(true);
  link = signal<string | null>('/products/agave-erp-sync');
  toggles = signal(0);
}

function setup() {
  TestBed.configureTestingModule({ providers: [provideRouter([])] });
  const fixture = TestBed.createComponent(Host);
  fixture.detectChanges();
  return { fixture, host: fixture.componentInstance, el: fixture.nativeElement as HTMLElement };
}

describe('IntegrationGroupCard', () => {
  it('names the disclosure button with the group heading and its size', () => {
    const { el } = setup();
    const button = el.querySelector('h3#card-heading button');
    expect(button).not.toBeNull();
    expect(button!.textContent).toContain('Agave ERP Sync');
    expect(button!.textContent).toContain('12 connections');
  });

  // AECI-1117: at 375px the count and the "View product" link took the whole
  // bar and the name truncated to zero width. jsdom does no layout, so this pins
  // the classes that let the bar wrap on its own width and the name wrap in place.
  it('lets the header wrap and never truncates the group name', () => {
    const { el } = setup();
    const bar = el.querySelector('h3#card-heading')!.parentElement!;
    expect(bar.classList).toContain('flex-wrap');
    expect(el.querySelector('h3#card-heading')!.classList).toContain('basis-72');
    const name = [...el.querySelectorAll('h3 button span')].find(
      (s) => s.textContent?.trim() === 'Agave ERP Sync',
    )!;
    expect(name).toBeDefined();
    expect(name.classList).not.toContain('truncate');
    expect(name.classList).toContain('break-words');
  });

  it('wires aria-expanded and aria-controls at the panel it controls', () => {
    const { el } = setup();
    const button = el.querySelector('button')!;
    expect(button.getAttribute('aria-expanded')).toBe('true');
    const panelId = button.getAttribute('aria-controls');
    expect(panelId).toBe('card-heading-panel');
    const panel = el.querySelector('#' + panelId);
    expect(panel).not.toBeNull();
    expect(panel!.getAttribute('role')).toBe('region');
    expect(panel!.getAttribute('aria-labelledby')).toBe('card-heading');
  });

  it('KEEPS the projected content in the DOM when collapsed, and only hides it', () => {
    const { fixture, host, el } = setup();
    host.expanded.set(false);
    fixture.detectChanges();

    const panel = el.querySelector('#card-heading-panel')!;
    expect(panel.hasAttribute('hidden')).toBe(true);
    // The crawler / SSR invariant: hidden, never removed.
    expect(el.querySelector('#card-body')).not.toBeNull();
    expect(el.querySelector('button')!.getAttribute('aria-expanded')).toBe('false');
  });

  it('is not hidden when expanded', () => {
    const { el } = setup();
    expect(el.querySelector('#card-heading-panel')!.hasAttribute('hidden')).toBe(false);
  });

  it('emits toggled on header click and lets the owner decide the new state', () => {
    const { fixture, host, el } = setup();
    el.querySelector('button')!.click();
    fixture.detectChanges();
    expect(host.toggles()).toBe(1);
    // Controlled: the card did NOT close itself.
    expect(el.querySelector('#card-heading-panel')!.hasAttribute('hidden')).toBe(false);
  });

  it('renders the product link OUTSIDE the button, since a link cannot nest in one', () => {
    const { el } = setup();
    const anchor = el.querySelector<HTMLAnchorElement>('a[href="/products/agave-erp-sync"]');
    expect(anchor).not.toBeNull();
    expect(anchor!.closest('button')).toBeNull();
  });

  // AECI-1125: the link used to open a new tab as "a lookup, not a
  // destination", against DESIGN.md's Link Treatment Rule. It is now an ordinary
  // in-app link, so a later edit that puts the new tab back has to fail here.
  it('is an ordinary in-app link: routerLink, same tab, no new-tab cue', () => {
    const { fixture, el } = setup();
    const anchor = el.querySelector<HTMLAnchorElement>('a[href="/products/agave-erp-sync"]')!;
    expect(anchor.hasAttribute('target')).toBe(false);
    expect(anchor.hasAttribute('rel')).toBe(false);
    expect(anchor.querySelector('aec-new-tab-icon')).toBeNull();
    expect(anchor.textContent).not.toContain('new tab');
    // An in-app path, navigated by the router rather than a document load.
    expect(anchor.getAttribute('href')!.startsWith('/')).toBe(true);
    const routed = fixture.debugElement
      .queryAll(By.directive(RouterLink))
      .map((d) => d.nativeElement as HTMLElement);
    expect(routed).toContain(anchor);
  });

  it('names the product in the link and starts the name with the visible text', () => {
    const { el } = setup();
    const anchor = el.querySelector<HTMLAnchorElement>('a[href="/products/agave-erp-sync"]')!;
    const name = anchor.getAttribute('aria-label')!;
    expect(name).toBe('View product: Agave ERP Sync');
    // WCAG 2.5.3 Label in Name: the accessible name starts with the visible text,
    // so a speech-input user can say what they can read.
    expect(anchor.textContent!.trim()).toBe('View product');
    expect(name.startsWith(anchor.textContent!.trim())).toBe(true);
  });

  it('renders no link at all for a group with no subject page', () => {
    const { fixture, host, el } = setup();
    host.link.set(null);
    fixture.detectChanges();
    expect(el.querySelector('a')).toBeNull();
  });
});
