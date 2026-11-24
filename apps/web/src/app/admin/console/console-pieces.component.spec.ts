/**
 * The shared console pieces (AECI-1813): the disclosure button, the inline
 * control form and the danger pattern. Named `.component.spec.ts` so it runs
 * under `ng test` (TestBed).
 */
import { Component, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { CONSOLE_TABLE } from './console-table';
import { AdminDangerAction } from './danger-action';
import { AdminDisclosureButton } from './disclosure-button';
import { AdminInlineControl } from './inline-control';
import { ADMIN_STATUS_TONES, adminStatusTone } from './status-tones';

@Component({
  imports: [AdminDisclosureButton, AdminInlineControl, AdminDangerAction],
  template: `
    <aec-admin-disclosure-button
      [expanded]="rowOpen()"
      controls="row-x"
      label="Open the review of Fieldline"
      (toggled)="rowOpen.set(!rowOpen())"
    />

    <aec-admin-inline-control
      label="Billing email"
      help="Plan emails go here."
      type="email"
      value="billing@example.com"
      [error]="saveError()"
      [(open)]="editing"
      (saved)="saved.set($event)"
      >billing&#64;example.com</aec-admin-inline-control
    >

    <aec-admin-danger-action
      openerLabel="Suspend"
      confirmLabel="Suspend and send the notice"
      warning="This locks every seat out at once."
      reasonLabel="Reason"
      reasonRequired="Enter a reason."
      reasonHelp="The vendor never sees it."
      [(open)]="suspending"
      (confirmed)="reason.set($event)"
    />
  `,
})
class Host {
  readonly rowOpen = signal(false);
  readonly editing = signal(false);
  readonly saveError = signal<string | null>(null);
  readonly saved = signal<string | null>(null);
  readonly suspending = signal(false);
  readonly reason = signal<string | null>(null);
}

async function setup() {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
  const fixture = TestBed.createComponent(Host);
  document.body.appendChild(fixture.nativeElement);
  await fixture.whenStable();
  const root = fixture.nativeElement as HTMLElement;
  const settle = async () => {
    TestBed.tick();
    await fixture.whenStable();
  };
  const button = (scope: string, text: string) =>
    [...root.querySelectorAll<HTMLButtonElement>(`${scope} button`)].find((b) =>
      b.textContent?.replace(/\s+/g, ' ').trim().startsWith(text),
    )!;
  return { fixture, root, host: fixture.componentInstance, settle, button };
}

describe('console pieces (AECI-1813)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  describe('AdminDisclosureButton', () => {
    it('is a named 44px ghost icon button wired to its detail row', async () => {
      const { root, host, settle } = await setup();
      const btn = root.querySelector<HTMLButtonElement>('aec-admin-disclosure-button button')!;
      expect(btn.getAttribute('data-variant')).toBe('ghost');
      expect(btn.className).toContain('size-11');
      expect(btn.getAttribute('aria-controls')).toBe('row-x');
      expect(btn.getAttribute('aria-expanded')).toBe('false');
      expect(btn.textContent?.trim()).toBe('Open the review of Fieldline');
      btn.click();
      await settle();
      expect(host.rowOpen()).toBe(true);
      expect(btn.getAttribute('aria-expanded')).toBe('true');
    });
  });

  describe('AdminInlineControl', () => {
    it('shows the label, the value and a compact secondary Change', async () => {
      const { root, button } = await setup();
      const ctl = root.querySelector('aec-admin-inline-control')!;
      expect(ctl.textContent).toContain('Billing email');
      expect(ctl.textContent).toContain('billing@example.com');
      const change = button('aec-admin-inline-control', 'Change');
      expect(change.getAttribute('data-variant')).toBe('secondary');
      expect(change.className).toContain('px-4');
      expect(change.getAttribute('aria-expanded')).toBe('false');
      expect(ctl.querySelector<HTMLFormElement>('form')!.hidden).toBe(true);
    });

    it('wires the help into aria-describedby from first render', async () => {
      const { root } = await setup();
      const input = root.querySelector<HTMLInputElement>('aec-admin-inline-control input')!;
      const help = root.querySelector(`#${input.getAttribute('aria-describedby')}`);
      expect(help?.textContent?.trim()).toBe('Plan emails go here.');
    });

    it('opens with the value, focuses the field and emits it on Save', async () => {
      const { root, host, settle, button } = await setup();
      button('aec-admin-inline-control', 'Change').click();
      await settle();
      const input = root.querySelector<HTMLInputElement>('aec-admin-inline-control input')!;
      expect(host.editing()).toBe(true);
      expect(input.value).toBe('billing@example.com');
      expect(document.activeElement).toBe(input);
      const save = button('aec-admin-inline-control', 'Save');
      expect(save.getAttribute('data-variant')).toBe('primary');
      const cancel = button('aec-admin-inline-control', 'Cancel');
      expect(cancel.getAttribute('data-variant')).toBe('ghost');
      input.value = 'new@example.com';
      input.dispatchEvent(new Event('input'));
      save.click();
      await settle();
      expect(host.saved()).toBe('new@example.com');
    });

    it('shows the error and joins its id to the help', async () => {
      const { root, host, settle, button } = await setup();
      button('aec-admin-inline-control', 'Change').click();
      host.saveError.set('Enter a valid email address.');
      await settle();
      const input = root.querySelector<HTMLInputElement>('aec-admin-inline-control input')!;
      expect(input.getAttribute('aria-invalid')).toBe('true');
      const ids = input.getAttribute('aria-describedby')!.split(' ');
      expect(ids).toHaveLength(2);
      expect(root.querySelector(`#${ids[1]}`)?.getAttribute('role')).toBe('alert');
    });

    it('returns focus to Change on Cancel', async () => {
      const { host, settle, button } = await setup();
      const change = button('aec-admin-inline-control', 'Change');
      change.click();
      await settle();
      button('aec-admin-inline-control', 'Cancel').click();
      await settle();
      expect(host.editing()).toBe(false);
      expect(document.activeElement).toBe(change);
    });
  });

  describe('AdminDangerAction', () => {
    it('opens from a secondary button and confirms with the danger button', async () => {
      const { root, settle, button } = await setup();
      const opener = button('aec-admin-danger-action', 'Suspend');
      expect(opener.getAttribute('data-variant')).toBe('secondary');
      opener.click();
      await settle();
      const form = root.querySelector<HTMLFormElement>('aec-admin-danger-action form')!;
      expect(form.hidden).toBe(false);
      expect(form.textContent).toContain('This locks every seat out at once.');
      expect(form.querySelector('p')!.className).toContain('bg-(--accent-warm)');
      const confirm = button('aec-admin-danger-action', 'Suspend and send');
      expect(confirm.getAttribute('data-variant')).toBe('danger');
      expect(button('aec-admin-danger-action', 'Cancel').getAttribute('data-variant')).toBe(
        'ghost',
      );
    });

    it('refuses an empty reason and emits the trimmed one', async () => {
      const { root, host, settle, button } = await setup();
      button('aec-admin-danger-action', 'Suspend').click();
      await settle();
      button('aec-admin-danger-action', 'Suspend and send').click();
      await settle();
      expect(host.reason()).toBeNull();
      const area = root.querySelector<HTMLTextAreaElement>('aec-admin-danger-action textarea')!;
      expect(area.getAttribute('aria-invalid')).toBe('true');
      expect(
        root.querySelector('aec-admin-danger-action [role="alert"]')?.textContent?.trim(),
      ).toBe('Enter a reason.');
      area.value = '  Identity not proven  ';
      area.dispatchEvent(new Event('input'));
      button('aec-admin-danger-action', 'Suspend and send').click();
      await settle();
      expect(host.reason()).toBe('Identity not proven');
    });

    it('returns focus to the opener on Cancel', async () => {
      const { settle, button } = await setup();
      const opener = button('aec-admin-danger-action', 'Suspend');
      opener.click();
      await settle();
      button('aec-admin-danger-action', 'Cancel').click();
      await settle();
      expect(document.activeElement).toBe(opener);
    });
  });

  describe('the status map and the table recipe', () => {
    it('maps every status to one of the seven tones', () => {
      const tones = new Set(Object.values(ADMIN_STATUS_TONES));
      expect([...tones].sort()).toEqual(
        ['attention', 'count', 'critical', 'neutral', 'positive', 'quiet', 'waiting'].sort(),
      );
      expect(adminStatusTone('pending')).toBe('waiting');
      expect(adminStatusTone('banned')).toBe('critical');
      expect(adminStatusTone('caveat')).toBe('attention');
    });

    it('keeps the header off sticky and the region free of shadow, radius and fill', () => {
      expect(CONSOLE_TABLE.head).not.toMatch(/\bsticky\b/);
      expect(CONSOLE_TABLE.region).not.toMatch(/\b(shadow|rounded|bg-)/);
      expect(CONSOLE_TABLE.head).toContain('text-t-13');
      expect(CONSOLE_TABLE.num).toContain('tabular-nums');
      // Two alignments in one list would be decided by stylesheet order.
      for (const classes of Object.values(CONSOLE_TABLE)) {
        expect(classes.includes('text-start') && classes.includes('text-end')).toBe(false);
      }
    });
  });
});
