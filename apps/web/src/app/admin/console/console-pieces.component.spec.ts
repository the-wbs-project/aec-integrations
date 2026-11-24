/**
 * The shared console pieces (AECI-1813): the disclosure button, the inline
 * control form and the danger pattern. Named `.component.spec.ts` so it runs
 * under `ng test` (TestBed).
 */
import { Component, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
      label="Review of Fieldline"
      (toggled)="rowOpen.set(!rowOpen())"
    />

    <p id="row-y-head">Vendor record updated</p>
    <aec-admin-disclosure-button
      id="labelled"
      withLabel
      [label]="null"
      [expanded]="diffOpen()"
      controls="diff-y"
      describedBy="row-y-head"
      (toggled)="diffOpen.set(!diffOpen())"
    >
      @if (diffOpen()) {
        <span>Hide changes</span>
      } @else {
        <span>Show changes</span>
      }
    </aec-admin-disclosure-button>

    <div id="controls">
      <aec-admin-inline-control
        label="Billing email"
        help="Plan emails go here."
        type="email"
        value="billing@example.com"
        [error]="saveError()"
        [busy]="saving()"
        [(open)]="editing"
        (saved)="onSave($event)"
        >billing&#64;example.com</aec-admin-inline-control
      >
      <aec-admin-inline-control label="Legal name" value="Acme">Acme</aec-admin-inline-control>
    </div>

    <aec-admin-danger-action
      openerLabel="Suspend"
      confirmLabel="Suspend and send the notice"
      warning="This locks every seat out at once."
      reasonLabel="Reason"
      reasonRequired="Enter a reason."
      reasonHelp="The vendor never sees it."
      [error]="dangerError()"
      [busy]="dangerBusy()"
      [(open)]="suspending"
      (confirmed)="onConfirm($event)"
    />
  `,
})
class Host {
  readonly rowOpen = signal(false);
  readonly diffOpen = signal(false);
  readonly editing = signal(false);
  readonly saveError = signal<string | null>(null);
  readonly saving = signal(false);
  readonly saves: string[] = [];
  readonly suspending = signal(false);
  readonly dangerError = signal<string | null>(null);
  readonly dangerBusy = signal(false);
  readonly reasons: string[] = [];
  onSave(value: string): void {
    this.saves.push(value);
  }
  onConfirm(reason: string): void {
    this.reasons.push(reason);
  }
}

/** An icon-only disclosure whose label is empty: no accessible name (AECI-1729). */
@Component({
  imports: [AdminDisclosureButton],
  template: `<aec-admin-disclosure-button [expanded]="false" controls="row-z" [label]="label" />`,
})
class NamelessHost {
  label = '';
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
    await new Promise((r) => setTimeout(r));
    TestBed.tick();
  };
  const button = (scope: string, text: string) =>
    [...root.querySelectorAll<HTMLButtonElement>(`${scope} button`)].find((b) =>
      b.textContent?.replace(/\s+/g, ' ').trim().startsWith(text),
    )!;
  const ictl = 'aec-admin-inline-control:first-of-type';
  const danger = 'aec-admin-danger-action';
  const escape = (el: Element) =>
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  return {
    fixture,
    root,
    host: fixture.componentInstance,
    settle,
    button,
    ictl,
    danger,
    escape,
  };
}

describe('console pieces (AECI-1813)', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => document.body.replaceChildren());

  describe('AdminDisclosureButton', () => {
    it('keeps one verb-free name and reports its state with aria-expanded', async () => {
      const { root, host, settle } = await setup();
      const btn = root.querySelector<HTMLButtonElement>('aec-admin-disclosure-button button')!;
      expect(btn.getAttribute('aria-controls')).toBe('row-x');
      expect(btn.getAttribute('aria-expanded')).toBe('false');
      expect(btn.textContent?.trim()).toBe('Review of Fieldline');
      btn.click();
      await settle();
      expect(host.rowOpen()).toBe(true);
      expect(btn.getAttribute('aria-expanded')).toBe('true');
      // The name does not change with the state, so it never says "Open" when open.
      expect(btn.textContent?.trim()).toBe('Review of Fieldline');
    });

    it('icon-only by default: the label is visually hidden and nothing describes it', async () => {
      const { root } = await setup();
      const btn = root.querySelector<HTMLButtonElement>('aec-admin-disclosure-button button')!;
      expect(btn.querySelector('.sr-only')?.textContent).toBe('Review of Fieldline');
      expect(btn.hasAttribute('aria-describedby')).toBe(false);
      expect(btn.getAttribute('type')).toBe('button');
    });

    it('logs a dev-mode error for an icon-only disclosure with an empty label (AECI-1729)', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        TestBed.resetTestingModule();
        TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
        const fixture = TestBed.createComponent(NamelessHost);
        await fixture.whenStable();
        expect(error).toHaveBeenCalledWith(expect.stringContaining('needs a non-empty label'));
      } finally {
        error.mockRestore();
      }
    });

    it('logs nothing for a named icon-only disclosure or a labelled one', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        await setup();
        expect(error).not.toHaveBeenCalledWith(
          expect.stringContaining('aec-admin-disclosure-button'),
        );
      } finally {
        error.mockRestore();
      }
    });

    it('withLabel shows the projected words as the name, described by describedBy (AECI-1729)', async () => {
      const { root, host, settle } = await setup();
      const btn = root.querySelector<HTMLButtonElement>('#labelled button')!;
      expect(btn.querySelector('.sr-only')).toBeNull();
      expect(btn.textContent?.trim()).toBe('Show changes');
      expect(btn.getAttribute('aria-describedby')).toBe('row-y-head');
      expect(btn.getAttribute('aria-controls')).toBe('diff-y');
      expect(btn.getAttribute('aria-expanded')).toBe('false');
      btn.click();
      await settle();
      expect(host.diffOpen()).toBe(true);
      expect(btn.getAttribute('aria-expanded')).toBe('true');
      expect(btn.textContent?.trim()).toBe('Hide changes');
    });
  });

  describe('AdminInlineControl', () => {
    it('shows the label, the value and a secondary Change that opens the form', async () => {
      const { root, button, ictl } = await setup();
      const ctl = root.querySelector(ictl)!;
      expect(ctl.textContent).toContain('Billing email');
      expect(ctl.textContent).toContain('billing@example.com');
      const change = button(ictl, 'Change');
      expect(change.getAttribute('data-variant')).toBe('secondary');
      expect(change.getAttribute('aria-expanded')).toBe('false');
      expect(ctl.querySelector<HTMLFormElement>('form')!.hidden).toBe(true);
    });

    it('wires the help into aria-describedby from first render', async () => {
      const { root, ictl } = await setup();
      const input = root.querySelector<HTMLInputElement>(`${ictl} input`)!;
      const help = root.querySelector(`#${input.getAttribute('aria-describedby')}`);
      expect(help?.textContent?.trim()).toBe('Plan emails go here.');
    });

    it('gives each instance its own ids', async () => {
      const { root } = await setup();
      const ids = [...root.querySelectorAll('#controls [id]')].map((el) => el.id);
      expect(ids.length).toBeGreaterThan(4);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('opens with the value, focuses the field and emits the trimmed value on Save', async () => {
      const { root, host, settle, button, ictl } = await setup();
      button(ictl, 'Change').click();
      await settle();
      const input = root.querySelector<HTMLInputElement>(`${ictl} input`)!;
      expect(host.editing()).toBe(true);
      expect(input.value).toBe('billing@example.com');
      expect(document.activeElement).toBe(input);
      expect(button(ictl, 'Save').getAttribute('data-variant')).toBe('primary');
      expect(button(ictl, 'Cancel').getAttribute('data-variant')).toBe('ghost');
      input.value = '  new@example.com  ';
      input.dispatchEvent(new Event('input'));
      button(ictl, 'Save').click();
      await settle();
      expect(host.saves).toEqual(['new@example.com']);
    });

    it('emits once per attempt: a second Save before the parent answers, or while busy, does nothing', async () => {
      const { host, settle, button, ictl } = await setup();
      button(ictl, 'Change').click();
      await settle();
      button(ictl, 'Save').click();
      button(ictl, 'Save').click();
      await settle();
      expect(host.saves).toHaveLength(1);
      host.saving.set(true);
      await settle();
      button(ictl, 'Save').click();
      await settle();
      expect(host.saves).toHaveLength(1);
      // The parent answers with an error: the next attempt goes through.
      host.saving.set(false);
      host.saveError.set('Enter a valid email address.');
      await settle();
      button(ictl, 'Save').click();
      await settle();
      expect(host.saves).toHaveLength(2);
    });

    it('moves focus to the error on a failure and joins its id to the help', async () => {
      const { root, host, settle, button, ictl } = await setup();
      button(ictl, 'Change').click();
      await settle();
      host.saveError.set('Enter a valid email address.');
      await settle();
      const input = root.querySelector<HTMLInputElement>(`${ictl} input`)!;
      expect(input.getAttribute('aria-invalid')).toBe('true');
      const ids = input.getAttribute('aria-describedby')!.split(' ');
      expect(ids).toHaveLength(2);
      const error = root.querySelector(`#${ids[1]}`)!;
      expect(error.getAttribute('role')).toBe('alert');
      expect(document.activeElement).toBe(error);
    });

    it('returns focus to Change when the parent closes it after a save', async () => {
      const { host, settle, button, ictl } = await setup();
      const change = button(ictl, 'Change');
      change.click();
      await settle();
      button(ictl, 'Save').click();
      await settle();
      host.editing.set(false);
      await settle();
      expect(document.activeElement).toBe(change);
    });

    it('returns focus to Change on Cancel and on Escape', async () => {
      const { root, host, settle, button, ictl, escape } = await setup();
      const change = button(ictl, 'Change');
      change.click();
      await settle();
      button(ictl, 'Cancel').click();
      await settle();
      expect(host.editing()).toBe(false);
      expect(document.activeElement).toBe(change);
      change.click();
      await settle();
      escape(root.querySelector(`${ictl} input`)!);
      await settle();
      expect(host.editing()).toBe(false);
      expect(document.activeElement).toBe(change);
    });
  });

  describe('AdminDangerAction', () => {
    it('opens from a secondary button and confirms with the danger button', async () => {
      const { root, settle, button, danger } = await setup();
      const opener = button(danger, 'Suspend');
      expect(opener.getAttribute('data-variant')).toBe('secondary');
      opener.click();
      await settle();
      const form = root.querySelector<HTMLFormElement>(`${danger} form`)!;
      expect(form.hidden).toBe(false);
      expect(button(danger, 'Suspend and send').getAttribute('data-variant')).toBe('danger');
      expect(button(danger, 'Cancel').getAttribute('data-variant')).toBe('ghost');
    });

    it('names the warning first in the reason field description, so it is heard on open', async () => {
      const { root, settle, button, danger } = await setup();
      button(danger, 'Suspend').click();
      await settle();
      const area = root.querySelector<HTMLTextAreaElement>(`${danger} textarea`)!;
      expect(document.activeElement).toBe(area);
      const [first, second] = area.getAttribute('aria-describedby')!.split(' ');
      expect(root.querySelector(`#${first}`)?.textContent?.trim()).toBe(
        'This locks every seat out at once.',
      );
      expect(root.querySelector(`#${second}`)?.textContent?.trim()).toBe(
        'The vendor never sees it.',
      );
    });

    it('refuses an empty reason and emits the trimmed one, once per attempt', async () => {
      const { root, host, settle, button, danger } = await setup();
      button(danger, 'Suspend').click();
      await settle();
      button(danger, 'Suspend and send').click();
      await settle();
      expect(host.reasons).toEqual([]);
      const area = root.querySelector<HTMLTextAreaElement>(`${danger} textarea`)!;
      expect(area.getAttribute('aria-invalid')).toBe('true');
      expect(root.querySelector(`${danger} [role="alert"]`)?.textContent?.trim()).toBe(
        'Enter a reason.',
      );
      area.value = '  Identity not proven  ';
      area.dispatchEvent(new Event('input'));
      button(danger, 'Suspend and send').click();
      button(danger, 'Suspend and send').click();
      await settle();
      expect(host.reasons).toEqual(['Identity not proven']);
      host.dangerBusy.set(true);
      await settle();
      button(danger, 'Suspend and send').click();
      await settle();
      expect(host.reasons).toHaveLength(1);
    });

    it('moves focus to the parent error on a failure', async () => {
      const { root, host, settle, button, danger } = await setup();
      button(danger, 'Suspend').click();
      await settle();
      host.dangerError.set('The vendor changed. Reload the page.');
      await settle();
      const error = root.querySelector(`${danger} [role="alert"]`)!;
      expect(error.textContent?.trim()).toBe('The vendor changed. Reload the page.');
      expect(document.activeElement).toBe(error);
    });

    it('returns focus to the opener on Cancel, on Escape and after a parent close', async () => {
      const { root, host, settle, button, danger, escape } = await setup();
      const opener = button(danger, 'Suspend');
      opener.click();
      await settle();
      button(danger, 'Cancel').click();
      await settle();
      expect(document.activeElement).toBe(opener);
      opener.click();
      await settle();
      escape(root.querySelector(`${danger} textarea`)!);
      await settle();
      expect(host.suspending()).toBe(false);
      expect(document.activeElement).toBe(opener);
      opener.click();
      await settle();
      host.suspending.set(false);
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

    it('never lets an undelivered legal notice or an unconfirmed email read as quiet', () => {
      for (const key of ['dropped', 'noRecipients', 'noticeExpired', 'emailUnconfirmed'] as const) {
        expect(adminStatusTone(key)).not.toBe('quiet');
      }
      expect(adminStatusTone('unknown')).toBe('quiet');
      expect(adminStatusTone('expired')).toBe('quiet');
    });

    it('keeps the header off sticky, the region bare and one alignment per part', () => {
      expect(CONSOLE_TABLE.head).not.toMatch(/\bsticky\b/);
      expect(CONSOLE_TABLE.region).not.toMatch(/\b(shadow|rounded|bg-)/);
      // Two alignments in one list would be decided by stylesheet order.
      for (const classes of Object.values(CONSOLE_TABLE)) {
        expect(classes.includes('text-start') && classes.includes('text-end')).toBe(false);
      }
    });
  });
});
