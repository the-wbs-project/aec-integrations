/**
 * AECI-2213 — the portal's shared row Actions menu. A `BrnPopover` of plain buttons,
 * not an Aria or CDK menu (ADR 0010, amendment 2026-10-16).
 *
 * What these pin: the labelled trigger with `aria-haspopup` / `aria-expanded`; the
 * list of items in order, with no `role="menu"`; focus moving into the menu and staying
 * there (the focus trap); Escape closing it with focus back on the trigger; a pick
 * focusing the trigger before it closes, then emitting the id.
 */
import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RowActionsMenu, type RowAction } from './row-actions-menu';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve));

const ACTIONS: readonly RowAction[] = [
  { id: 'change', label: 'Change direction' },
  { id: 'history', label: 'View history' },
  { id: 'remove', label: 'Remove row', destructive: true },
];

const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe('RowActionsMenu', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
  });

  afterEach(() => {
    document.querySelectorAll('.cdk-overlay-container').forEach((el) => el.remove());
    document.querySelectorAll('aec-row-actions-menu').forEach((el) => el.remove());
  });

  function render(): { fixture: ComponentFixture<RowActionsMenu>; picked: string[] } {
    const fixture = TestBed.createComponent(RowActionsMenu);
    fixture.componentRef.setInput('label', 'Actions for Invoices');
    fixture.componentRef.setInput('actions', ACTIONS);
    fixture.componentRef.setInput('testId', 'menu');
    const picked: string[] = [];
    fixture.componentInstance.picked.subscribe((id) => picked.push(id));
    fixture.detectChanges();
    document.body.appendChild(fixture.nativeElement as HTMLElement);
    return { fixture, picked };
  }

  async function settle(fixture: ComponentFixture<unknown>): Promise<void> {
    for (let i = 0; i < 3; i++) {
      fixture.detectChanges();
      await flush();
    }
    await fixture.whenStable();
  }

  /** Spartan closes after its 100 ms `closeDelay`. */
  async function closed(fixture: ComponentFixture<unknown>): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 150));
    await settle(fixture);
  }

  /** As a keyboard user opens it: focus on the trigger, then activate it. */
  async function open(fixture: ComponentFixture<unknown>): Promise<void> {
    q('menu-trigger')!.focus();
    q('menu-trigger')!.click();
    await settle(fixture);
  }

  it('is one labelled icon button that announces a popup', () => {
    render();
    const trigger = q('menu-trigger')!;
    expect(trigger.getAttribute('aria-label')).toBe('Actions for Invoices');
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
    expect(trigger.textContent?.trim()).toBe('');
    expect(q('menu-menu')).toBeNull();
  });

  it('opens a labelled list of buttons in order, with no role="menu"', async () => {
    const { fixture } = render();
    await open(fixture);
    expect(q('menu-trigger')!.getAttribute('aria-expanded')).toBe('true');
    const menu = q('menu-menu')!;
    expect(menu.getAttribute('aria-label')).toBe('Actions for Invoices');
    expect(document.querySelector('[role="menu"]')).toBeNull();
    const items = [...menu.querySelectorAll('button')];
    expect(items.map((b) => b.textContent!.trim())).toEqual([
      'Change direction',
      'View history',
      'Remove row',
    ]);
    expect(items.every((b) => b.getAttribute('tabindex') === null)).toBe(true);
    expect(q('menu-remove')!.className).toContain('--status-error');
  });

  it('moves focus into the menu and keeps it there (focus trap)', async () => {
    const { fixture } = render();
    await open(fixture);
    const panel = q('menu-menu')!.closest('.cdk-overlay-pane')!;
    expect(panel.contains(document.activeElement)).toBe(true);
    // The CDK focus trap's anchors bracket the content, so Tab wraps inside it.
    expect(panel.parentElement!.querySelectorAll('.cdk-focus-trap-anchor').length).toBeGreaterThan(
      0,
    );
  });

  it('closes on Escape and hands focus back to the trigger', async () => {
    const { fixture } = render();
    await open(fixture);
    const item = q('menu-change')!;
    item.focus();
    item.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await closed(fixture);
    expect(q('menu-menu')).toBeNull();
    expect(document.activeElement).toBe(q('menu-trigger'));
  });

  it('focuses the trigger, closes, then emits the picked id', async () => {
    const { fixture, picked } = render();
    await open(fixture);
    q('menu-history')!.click();
    expect(document.activeElement).toBe(q('menu-trigger'));
    expect(picked).toEqual(['history']);
    await closed(fixture);
    expect(q('menu-menu')).toBeNull();
  });
});
