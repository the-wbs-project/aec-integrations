import { DatePipe } from '@angular/common';
import { Component, input } from '@angular/core';

import type { TerminationStatement } from '@aeci/shared';

import { CONSOLE_TABLE } from '../console/console-table';
import { formatCents } from './vendor-suspension-model';

let nextId = 0;

/**
 * The itemized statement of one termination, as the vendor was sent it (AECI-1623). Read
 * only: `vendor_suspensions.statement` is frozen when Terminate commits.
 */
@Component({
  selector: 'aec-suspension-statement',
  imports: [DatePipe],
  templateUrl: './suspension-statement.html',
})
export class SuspensionStatement {
  readonly statement = input.required<TerminationStatement>();

  protected readonly t = CONSOLE_TABLE;
  /** The payments table's caption id: one per statement, since the history can show several. */
  protected readonly captionId = `aec-suspension-statement-${nextId++}-caption`;

  protected money(cents: number): string {
    return formatCents(cents, this.statement().currency);
  }
}
