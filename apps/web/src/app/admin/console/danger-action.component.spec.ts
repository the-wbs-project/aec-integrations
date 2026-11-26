/**
 * AECI-2104: the danger form's extensions. The busy label, the length rule, the
 * two-step confirm, the error that holds a link, the optional warning, Cancel's own
 * words and the opener's description. The original contract stays pinned in
 * `console-pieces.component.spec.ts`. Named `.component.spec.ts` so it runs under
 * `ng test` (TestBed).
 */
import { Component, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AdminDangerAction, type AdminDangerConfirmStep } from './danger-action';

const STEP: AdminDangerConfirmStep = {
  continueLabel: 'Continue to removal',
  title: 'Remove this review permanently?',
  body: 'Removal is final.',
  editLabel: 'Edit the reason',
};

@Component({
  imports: [AdminDangerAction],
  template: `
    <p id="remove-help">Removing takes the review off the page.</p>
    <aec-admin-danger-action
      id="a"
      openerLabel="Remove from the page"
      confirmLabel="Remove permanently"
      [warning]="warning()"
      reasonLabel="Why you are removing it"
      [reasonRequired]="reasonRequired()"
      reasonHelp="Shown to the reviewer."
      [busyLabel]="busyLabel()"
      [maxLength]="maxLength()"
      [lengthMessage]="lengthMessage()"
      [confirmStep]="step()"
      [cancelLabel]="cancelLabel()"
      [openerDescribedBy]="describedBy()"
      [openerDisabled]="openerDisabled()"
      [noteLabel]="noteLabel()"
      noteHelp="Only admins see it."
      [noteMaxLength]="1000"
      [(note)]="note"
      [error]="error()"
      [errorTemplate]="useRich() ? lastSeat : null"
      [busy]="busy()"
      [(open)]="open"
      (confirmed)="reasons.push($event)"
      (cancelled)="cancels = cancels + 1"
    >
      @if (facts()) {
        <p dangerFacts>3 open product proposals will be discarded.</p>
      }
    </aec-admin-danger-action>
    <ng-template #lastSeat
      >This is the last seat. Use Suspend on its
      <a href="/admin/vendors/v1">vendor page</a>.</ng-template
    >
    <aec-admin-danger-action
      id="b"
      openerLabel="Suspend"
      confirmLabel="Suspend and send"
      warning="This locks every seat out."
      reasonLabel="Reason"
      reasonRequired="Enter a reason."
      [confirmStep]="step()"
    />
  `,
})
class Host {
  readonly warning = signal<string | null>('Removal takes the review off the page.');
  readonly reasonRequired = signal<string | null>('Write a reason before you confirm.');
  readonly busyLabel = signal<string | null>(null);
  readonly maxLength = signal<number | null>(null);
  readonly lengthMessage = signal<string | null>(null);
  readonly step = signal<AdminDangerConfirmStep | null>(null);
  readonly cancelLabel = signal<string | null>(null);
  readonly describedBy = signal<string | null>(null);
  readonly openerDisabled = signal(false);
  readonly noteLabel = signal<string | null>(null);
  readonly note = signal('');
  readonly facts = signal(false);
  readonly error = signal<string | null>(null);
  readonly useRich = signal(false);
  readonly busy = signal(false);
  readonly open = signal(false);
  readonly reasons: string[] = [];
  cancels = 0;
}

async function setup(configure: (host: Host) => void = () => undefined) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
  const fixture = TestBed.createComponent(Host);
  configure(fixture.componentInstance);
  document.body.appendChild(fixture.nativeElement);
  await fixture.whenStable();
  const root = fixture.nativeElement as HTMLElement;
  const settle = async () => {
    TestBed.tick();
    await fixture.whenStable();
    await new Promise((r) => setTimeout(r));
    TestBed.tick();
  };
  const a = root.querySelector<HTMLElement>('#a')!;
  const button = (text: string, scope: HTMLElement = a) =>
    [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.replace(/\s+/g, ' ').trim() === text,
    );
  const area = () => a.querySelector<HTMLTextAreaElement>('textarea')!;
  const type = (value: string) => {
    area().value = value;
    area().dispatchEvent(new Event('input'));
  };
  const alert = () => a.querySelector<HTMLElement>('[role="alert"]');
  const stepBox = () => a.querySelector<HTMLElement>('[role="group"]');
  const status = () => a.querySelector<HTMLElement>('[role="status"]')!;
  const escape = (el: Element) =>
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  const openForm = async () => {
    button('Remove from the page')!.click();
    await settle();
  };
  return {
    root,
    a,
    host: fixture.componentInstance,
    settle,
    button,
    area,
    type,
    alert,
    stepBox,
    status,
    escape,
    openForm,
  };
}

const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim();

describe('AdminDangerAction extensions (AECI-2104)', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => document.body.replaceChildren());

  describe('busy label', () => {
    it('reads the busy label while busy, says it once, and restores the label after', async () => {
      const { host, settle, button, type, status, openForm } = await setup((h) =>
        h.busyLabel.set('Removing…'),
      );
      await openForm();
      expect(text(status())).toBe('');
      type('Breaks the guidelines');
      button('Remove permanently')!.click();
      host.busy.set(true);
      await settle();
      const confirm = button('Removing…')!;
      expect(confirm.disabled).toBe(true);
      expect(button('Remove permanently')).toBeUndefined();
      expect(text(status())).toBe('Removing…');
      host.busy.set(false);
      await settle();
      expect(button('Remove permanently')!.disabled).toBe(false);
      expect(text(status())).toBe('');
    });

    it('keeps the confirm label while busy when no busy label is given', async () => {
      const { host, settle, button, status, openForm } = await setup();
      await openForm();
      host.busy.set(true);
      await settle();
      expect(button('Remove permanently')!.disabled).toBe(true);
      expect(text(status())).toBe('');
    });
  });

  describe('length rule', () => {
    const limited = (h: Host) => {
      h.maxLength.set(10);
      h.lengthMessage.set('Enter a reason between 1 and 10 characters.');
    };

    it('refuses a trimmed reason over the limit like an empty one, and focuses the field', async () => {
      const { host, settle, button, area, type, alert, openForm } = await setup(limited);
      await openForm();
      type('12345678901');
      button('Remove permanently')!.click();
      await settle();
      expect(host.reasons).toEqual([]);
      expect(text(alert())).toBe('Enter a reason between 1 and 10 characters.');
      expect(area().getAttribute('aria-invalid')).toBe('true');
      expect(area().getAttribute('aria-describedby')).toContain(alert()!.id);
      expect(document.activeElement).toBe(area());
    });

    it('takes exactly the limit, and measures the reason after trimming', async () => {
      const { host, settle, button, type, alert, openForm } = await setup(limited);
      await openForm();
      type('   1234567890   ');
      button('Remove permanently')!.click();
      await settle();
      expect(alert()).toBeNull();
      expect(host.reasons).toEqual(['1234567890']);
    });

    it('still refuses an empty reason with the required message', async () => {
      const { settle, button, type, alert, openForm } = await setup(limited);
      await openForm();
      type('    ');
      button('Remove permanently')!.click();
      await settle();
      expect(text(alert())).toBe('Write a reason before you confirm.');
    });

    it('clears the refusal once the reason fits, and waits for the next confirm to refuse again', async () => {
      const { settle, button, type, alert, openForm } = await setup(limited);
      await openForm();
      type('12345678901');
      button('Remove permanently')!.click();
      await settle();
      type('1234567890');
      await settle();
      expect(alert()).toBeNull();
      type('');
      await settle();
      expect(alert()).toBeNull();
    });

    it('caps the field natively when there is no message, and never with one', async () => {
      const capped = await setup((h) => h.maxLength.set(500));
      await capped.openForm();
      expect(capped.area().getAttribute('maxlength')).toBe('500');
      document.body.replaceChildren();
      const ruled = await setup(limited);
      await ruled.openForm();
      expect(ruled.area().hasAttribute('maxlength')).toBe(false);
    });
  });

  describe('two-step confirm', () => {
    const twoStep = (h: Host) => {
      h.step.set(STEP);
      h.busyLabel.set('Removing…');
    };

    it('checks the reason on step one with a secondary button that emits nothing', async () => {
      const { host, settle, button, alert, stepBox, openForm } = await setup(twoStep);
      await openForm();
      const next = button('Continue to removal')!;
      expect(next.getAttribute('data-variant')).toBe('secondary');
      expect(button('Remove permanently')).toBeUndefined();
      next.click();
      await settle();
      expect(text(alert())).toBe('Write a reason before you confirm.');
      expect(stepBox()).toBeNull();
      expect(host.reasons).toEqual([]);
    });

    it('locks the reason on step two and moves focus to the named step, not the danger button', async () => {
      const { root, host, settle, button, area, type, stepBox, openForm } = await setup(twoStep);
      await openForm();
      type('  Breaks the guidelines  ');
      button('Continue to removal')!.click();
      await settle();
      expect(host.reasons).toEqual([]);
      const box = stepBox()!;
      expect(document.activeElement).toBe(box);
      expect(text(root.querySelector(`#${box.getAttribute('aria-labelledby')}`))).toBe(
        'Remove this review permanently?',
      );
      expect(text(root.querySelector(`#${box.getAttribute('aria-describedby')}`))).toBe(
        'Removal is final.',
      );
      expect(area().readOnly).toBe(true);
      expect(area().value).toBe('  Breaks the guidelines  ');
      // The warning still leads the locked field's description.
      const first = area().getAttribute('aria-describedby')!.split(' ')[0];
      expect(text(root.querySelector(`#${first}`))).toBe('Removal takes the review off the page.');
      expect(button('Remove permanently')!.getAttribute('data-variant')).toBe('danger');
      expect(button('Continue to removal')).toBeUndefined();
    });

    it('edits the reason back on step one, kept and focused', async () => {
      const { settle, button, area, type, stepBox, openForm } = await setup(twoStep);
      await openForm();
      type('Breaks the guidelines');
      button('Continue to removal')!.click();
      await settle();
      button('Edit the reason')!.click();
      await settle();
      expect(stepBox()).toBeNull();
      expect(area().readOnly).toBe(false);
      expect(area().value).toBe('Breaks the guidelines');
      expect(document.activeElement).toBe(area());
      type('Breaks the guidelines twice');
      button('Continue to removal')!.click();
      await settle();
      expect(area().value).toBe('Breaks the guidelines twice');
    });

    it('emits the trimmed reason once, only from step two', async () => {
      const { host, settle, button, type, openForm } = await setup(twoStep);
      await openForm();
      type('  Breaks the guidelines  ');
      button('Continue to removal')!.click();
      await settle();
      const confirm = button('Remove permanently')!;
      confirm.click();
      confirm.click();
      await settle();
      expect(host.reasons).toEqual(['Breaks the guidelines']);
    });

    it('ignores a second press of step one before step two has rendered', async () => {
      const { a, host, settle, button, type, stepBox, openForm } = await setup(twoStep);
      await openForm();
      type('Breaks the guidelines');
      const form = a.querySelector('form')!;
      button('Continue to removal')!.click();
      form.requestSubmit();
      await settle();
      expect(host.reasons).toEqual([]);
      expect(stepBox()).not.toBeNull();
    });

    it('closes on Escape from either step and returns focus to the opener', async () => {
      const { host, settle, button, area, type, stepBox, escape, openForm } = await setup(twoStep);
      const opener = button('Remove from the page')!;
      await openForm();
      escape(area());
      await settle();
      expect(host.open()).toBe(false);
      expect(document.activeElement).toBe(opener);
      await openForm();
      type('Breaks the guidelines');
      button('Continue to removal')!.click();
      await settle();
      escape(stepBox()!);
      await settle();
      expect(host.open()).toBe(false);
      expect(host.cancels).toBe(2);
      expect(document.activeElement).toBe(opener);
      // Opening again starts on step one with an empty reason.
      await openForm();
      expect(stepBox()).toBeNull();
      expect(area().value).toBe('');
    });

    it('keeps a failed final press on step two, with focus on the error, and lets it retry', async () => {
      const { host, settle, button, area, type, alert, stepBox, openForm } = await setup(twoStep);
      await openForm();
      type('Breaks the guidelines');
      button('Continue to removal')!.click();
      await settle();
      button('Remove permanently')!.click();
      host.busy.set(true);
      await settle();
      expect(button('Removing…')!.disabled).toBe(true);
      // Busy keeps Edit focusable but inert (DESIGN.md: busy never sets aria-disabled).
      expect(button('Edit the reason')!.disabled).toBe(false);
      host.busy.set(false);
      host.error.set('Something went wrong. Please try again.');
      await settle();
      expect(text(alert())).toBe('Something went wrong. Please try again.');
      expect(document.activeElement).toBe(alert());
      expect(stepBox()).not.toBeNull();
      expect(area().readOnly).toBe(true);
      expect(area().getAttribute('aria-invalid')).toBe('true');
      host.error.set(null);
      button('Remove permanently')!.click();
      await settle();
      expect(host.reasons).toEqual(['Breaks the guidelines', 'Breaks the guidelines']);
    });

    it('takes a template body for a sentence with a value in it', async () => {
      @Component({
        imports: [AdminDangerAction],
        template: `
          <ng-template #body
            ><span>Northbeam can never reply to this review again.</span></ng-template
          >
          <aec-admin-danger-action
            openerLabel="Remove"
            confirmLabel="Remove permanently"
            reasonLabel="Reason"
            reasonRequired="Enter a reason."
            [confirmStep]="{
              continueLabel: 'Continue',
              title: 'Remove this reply permanently?',
              body: body,
              editLabel: 'Edit the reason',
            }"
          />
        `,
      })
      class TemplateHost {}
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
      const fixture = TestBed.createComponent(TemplateHost);
      document.body.appendChild(fixture.nativeElement);
      await fixture.whenStable();
      const root = fixture.nativeElement as HTMLElement;
      const settle = async () => {
        TestBed.tick();
        await fixture.whenStable();
        await new Promise((r) => setTimeout(r));
        TestBed.tick();
      };
      root.querySelector<HTMLButtonElement>('button')!.click();
      await settle();
      const area = root.querySelector('textarea')!;
      area.value = 'Off topic';
      area.dispatchEvent(new Event('input'));
      root.querySelector('form')!.requestSubmit();
      await settle();
      const box = root.querySelector('[role="group"]')!;
      expect(text(root.querySelector(`#${box.getAttribute('aria-describedby')}`))).toBe(
        'Northbeam can never reply to this review again.',
      );
    });
  });

  describe('rich error', () => {
    it('renders the template in the one alert, focuses it, and keeps the link usable', async () => {
      const { host, settle, area, alert, openForm } = await setup();
      await openForm();
      host.useRich.set(true);
      await settle();
      const el = alert()!;
      expect(text(el)).toBe('This is the last seat. Use Suspend on its vendor page.');
      expect(el.getAttribute('tabindex')).toBe('-1');
      // The error row is a flex line: the sentence and its link must be one item.
      expect(el.children).toHaveLength(1);
      expect(el.children[0].querySelector('a')).not.toBeNull();
      expect(el.querySelector('a')?.getAttribute('href')).toBe('/admin/vendors/v1');
      expect(document.activeElement).toBe(el);
      expect(area().getAttribute('aria-describedby')!.split(' ')).toContain(el.id);
      // As with a string error (AECI-1813), the field is marked invalid.
      expect(area().getAttribute('aria-invalid')).toBe('true');
    });

    it('gives the reason refusal and the string error priority over the template', async () => {
      const { host, settle, button, alert, openForm } = await setup((h) => h.useRich.set(true));
      await openForm();
      button('Remove permanently')!.click();
      await settle();
      expect(text(alert())).toBe('Write a reason before you confirm.');
      expect(document.querySelectorAll('#a [role="alert"]')).toHaveLength(1);
      host.error.set('Something went wrong.');
      await settle();
      expect(text(alert())).toBe('Write a reason before you confirm.');
    });
  });

  describe('warning, Cancel and the opener', () => {
    it('renders no warning box when there is none, and the help leads the description', async () => {
      const { root, area, openForm } = await setup((h) => h.warning.set(null));
      await openForm();
      const ids = area().getAttribute('aria-describedby')!.split(' ');
      expect(ids).toHaveLength(1);
      expect(text(root.querySelector(`#${ids[0]}`))).toBe('Shown to the reviewer.');
    });

    it('takes an empty reason when the form states the reason is optional', async () => {
      const { host, settle, button, area, alert, openForm } = await setup((h) =>
        h.reasonRequired.set(null),
      );
      await openForm();
      expect(area().required).toBe(false);
      button('Remove permanently')!.click();
      await settle();
      expect(alert()).toBeNull();
      expect(host.reasons).toEqual(['']);
    });

    it('marks the reason required whenever a required message is given', async () => {
      const { area, openForm } = await setup();
      await openForm();
      expect(area().required).toBe(true);
    });

    it("uses the caller's Cancel words and still cancels", async () => {
      const { host, settle, button, openForm } = await setup((h) => h.cancelLabel.set('Keep it'));
      await openForm();
      expect(button('Cancel')).toBeUndefined();
      button('Keep it')!.click();
      await settle();
      expect(host.open()).toBe(false);
    });

    it('lets a sentence beside the opener describe it', async () => {
      const { button } = await setup((h) => h.describedBy.set('remove-help'));
      expect(button('Remove from the page')!.getAttribute('aria-describedby')).toBe('remove-help');
    });
  });

  describe('note, facts and a blocked opener', () => {
    it('collects an optional note beside the reason, locks it on step two and clears it on open', async () => {
      const { a, host, settle, button, type, openForm } = await setup((h) => {
        h.noteLabel.set('Internal note (optional)');
        h.step.set(STEP);
      });
      await openForm();
      const note = a.querySelector<HTMLTextAreaElement>('textarea:not([required])')!;
      expect(note.getAttribute('maxlength')).toBe('1000');
      expect(text(a.querySelector(`#${note.getAttribute('aria-describedby')}`))).toBe(
        'Only admins see it.',
      );
      type('Off topic');
      note.value = 'Second report';
      note.dispatchEvent(new Event('input'));
      expect(host.note()).toBe('Second report');
      button('Continue to removal')!.click();
      await settle();
      expect(note.readOnly).toBe(true);
      button('Edit the reason')!.click();
      await settle();
      expect(note.readOnly).toBe(false);
      expect(note.value).toBe('Second report');
      button('Continue to removal')!.click();
      await settle();
      button('Remove permanently')!.click();
      await settle();
      expect(host.reasons).toEqual(['Off topic']);
      host.open.set(false);
      await settle();
      await openForm();
      expect(host.note()).toBe('');
    });

    it('accepts an empty note and renders no note field without a label', async () => {
      const blank = await setup();
      await blank.openForm();
      expect(blank.a.querySelectorAll('textarea')).toHaveLength(1);
      document.body.replaceChildren();
      const { host, settle, button, type, openForm } = await setup((h) =>
        h.noteLabel.set('Internal note (optional)'),
      );
      await openForm();
      type('Off topic');
      button('Remove permanently')!.click();
      await settle();
      expect(host.reasons).toEqual(['Off topic']);
      expect(host.note()).toBe('');
    });

    it('projects read-only facts between the warning and the reason', async () => {
      const { a, openForm } = await setup((h) => h.facts.set(true));
      await openForm();
      const form = a.querySelector('form')!;
      const order = [...form.children].map(
        (el) => el.tagName + (el.hasAttribute('dangerFacts') ? '+facts' : ''),
      );
      expect(order.slice(0, 3)).toEqual(['P', 'P+facts', 'DIV']);
      expect(text(form.querySelector('[dangerFacts]'))).toBe(
        '3 open product proposals will be discarded.',
      );
    });

    it('keeps a blocked opener shut, described by the reason it is blocked', async () => {
      const { host, settle, button } = await setup((h) => {
        h.openerDisabled.set(true);
        h.describedBy.set('remove-help');
      });
      const opener = button('Remove from the page')!;
      // Reachable by keyboard, so the reason it is blocked can be heard.
      expect(opener.disabled).toBe(false);
      expect(opener.getAttribute('aria-disabled')).toBe('true');
      expect(opener.getAttribute('aria-describedby')).toBe('remove-help');
      opener.focus();
      expect(document.activeElement).toBe(opener);
      opener.click();
      await settle();
      expect(host.open()).toBe(false);
      host.openerDisabled.set(false);
      await settle();
      expect(opener.hasAttribute('aria-disabled')).toBe(false);
      opener.click();
      await settle();
      expect(host.open()).toBe(true);
    });
  });

  describe('a running request keeps its form (review must-fix)', () => {
    const running = async () => {
      const t = await setup((h) => {
        h.step.set(STEP);
        h.busyLabel.set('Removing…');
      });
      await t.openForm();
      t.type('Breaks the guidelines');
      t.button('Continue to removal')!.click();
      await t.settle();
      t.button('Remove permanently')!.click();
      t.host.busy.set(true);
      await t.settle();
      return t;
    };

    it('marks the form busy without disabling Cancel or Edit', async () => {
      const { a, button } = await running();
      expect(a.querySelector('form')!.getAttribute('aria-busy')).toBe('true');
      for (const name of ['Cancel', 'Edit the reason']) {
        expect(button(name)!.disabled).toBe(false);
        expect(button(name)!.hasAttribute('aria-disabled')).toBe(false);
      }
    });

    it('ignores Cancel while busy, then shows the failure in the open form', async () => {
      const { host, settle, button, alert, stepBox } = await running();
      const cancel = button('Cancel')!;
      cancel.focus();
      cancel.click();
      await settle();
      expect(host.open()).toBe(true);
      expect(host.cancels).toBe(0);
      expect(document.activeElement).toBe(cancel);
      host.busy.set(false);
      host.error.set('Something went wrong. Please try again.');
      await settle();
      expect(stepBox()).not.toBeNull();
      expect(document.activeElement).toBe(alert());
    });

    it('ignores Escape while busy and still keeps it from the page', async () => {
      const { root, host, settle, stepBox, escape } = await running();
      let reachedPage = false;
      const listen = () => (reachedPage = true);
      root.addEventListener('keydown', listen);
      escape(stepBox()!);
      await settle();
      root.removeEventListener('keydown', listen);
      expect(host.open()).toBe(true);
      expect(host.cancels).toBe(0);
      expect(reachedPage).toBe(false);
    });

    it('ignores the opener while busy', async () => {
      const { host, settle, button } = await running();
      button('Remove from the page')!.click();
      await settle();
      expect(host.open()).toBe(true);
    });

    it('ignores Edit while busy', async () => {
      const { settle, button, area, stepBox } = await running();
      button('Edit the reason')!.click();
      await settle();
      expect(stepBox()).not.toBeNull();
      expect(area().readOnly).toBe(true);
    });
  });

  describe('attempts, opens and stale errors', () => {
    it('takes a retry after a parent refuses in its handler with the same error, never going busy', async () => {
      const { host, settle, button, type, alert, openForm } = await setup();
      await openForm();
      type('Off topic');
      const refuse = () => host.error.set('That review was already moderated.');
      for (let i = 0; i < 3; i++) {
        button('Remove permanently')!.click();
        refuse();
        await settle();
        expect(document.activeElement).toBe(alert());
      }
      expect(host.reasons).toEqual(['Off topic', 'Off topic', 'Off topic']);
    });

    it('starts clean when the parent opens it, and keeps the draft after a close by the opener', async () => {
      const { a, host, settle, button, area, type, alert, openForm } = await setup((h) =>
        h.noteLabel.set('Internal note (optional)'),
      );
      await openForm();
      type('Kept reason');
      const note = a.querySelector<HTMLTextAreaElement>('textarea:not([required])')!;
      note.value = 'Kept note';
      note.dispatchEvent(new Event('input'));
      // The opener closes and reopens: nothing typed is lost.
      button('Remove from the page')!.click();
      await settle();
      expect(host.open()).toBe(false);
      await openForm();
      expect(area().value).toBe('Kept reason');
      expect(host.note()).toBe('Kept note');
      // Cancel discards, and a parent open starts clean.
      button('Cancel')!.click();
      await settle();
      host.open.set(true);
      await settle();
      expect(area().value).toBe('');
      expect(host.note()).toBe('');
      // A refusal does not survive a close and a parent open.
      button('Remove permanently')!.click();
      await settle();
      expect(alert()).not.toBeNull();
      host.open.set(false);
      await settle();
      host.open.set(true);
      await settle();
      expect(alert()).toBeNull();
    });

    it('discards the draft after a close by the parent (success)', async () => {
      const { host, settle, button, area, type, openForm } = await setup();
      await openForm();
      type('Off topic');
      button('Remove permanently')!.click();
      host.open.set(false);
      await settle();
      await openForm();
      expect(area().value).toBe('');
    });

    it('does not show an error from before step two beside the new confirmation', async () => {
      const { host, settle, button, type, alert, stepBox, openForm } = await setup((h) =>
        h.step.set(STEP),
      );
      await openForm();
      type('Off topic');
      button('Continue to removal')!.click();
      await settle();
      button('Remove permanently')!.click();
      host.error.set('Something went wrong. Please try again.');
      await settle();
      button('Edit the reason')!.click();
      await settle();
      expect(alert()).not.toBeNull();
      button('Continue to removal')!.click();
      await settle();
      expect(stepBox()).not.toBeNull();
      expect(alert()).toBeNull();
      // A failure of this attempt shows again, even with the same words.
      button('Remove permanently')!.click();
      host.busy.set(true);
      await settle();
      host.busy.set(false);
      await settle();
      expect(document.activeElement).toBe(alert());
    });

    it('puts the help between the label and the field', async () => {
      const { a, openForm } = await setup();
      await openForm();
      const group = a.querySelector('textarea')!.parentElement!;
      expect([...group.children].map((el) => el.tagName)).toEqual(['LABEL', 'P', 'TEXTAREA']);
      expect(text(group.children[1])).toBe('Shown to the reviewer.');
    });
  });

  it('gives two instances on one page their own ids, step ids included', async () => {
    const { root, settle, button, type, openForm } = await setup((h) => h.step.set(STEP));
    const b = root.querySelector<HTMLElement>('#b')!;
    await openForm();
    type('Off topic');
    button('Continue to removal')!.click();
    button('Suspend', b)!.click();
    await settle();
    const area = b.querySelector('textarea')!;
    area.value = 'Fraud';
    area.dispatchEvent(new Event('input'));
    button('Continue to removal', b)!.click();
    await settle();
    const ids = [...root.querySelectorAll('[id]')].map((el) => el.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(root.querySelectorAll('[role="group"]')).toHaveLength(2);
  });
});
