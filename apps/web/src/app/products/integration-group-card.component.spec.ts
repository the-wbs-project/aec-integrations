import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
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
      linkAriaLabel="View product: Agave ERP Sync (opens in a new tab)"
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

  it('opens the product page in a new tab, says so, and drops the opener handle', () => {
    const { el } = setup();
    const anchor = el.querySelector<HTMLAnchorElement>('a[href="/products/agave-erp-sync"]')!;
    expect(anchor.getAttribute('target')).toBe('_blank');
    expect(anchor.getAttribute('rel')).toBe('noopener');
    const name = anchor.getAttribute('aria-label')!;
    expect(name).toContain('opens in a new tab');
    // WCAG 2.5.3 Label in Name: the accessible name starts with the visible text,
    // so a speech-input user can say what they can read.
    expect(anchor.textContent!.trim().startsWith('View product')).toBe(true);
    expect(name.startsWith('View product')).toBe(true);
  });

  it('renders no link at all for a group with no subject page', () => {
    const { fixture, host, el } = setup();
    host.link.set(null);
    fixture.detectChanges();
    expect(el.querySelector('a')).toBeNull();
  });
});
