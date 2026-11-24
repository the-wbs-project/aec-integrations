import { CONSOLE_CAPTION_CLASS, CONSOLE_PANEL_CLASS } from '../console/console-table';
import {
  CHOICE_INPUT_CLASS,
  FIELD_ERROR_CLASS,
  FIELD_HINT_CLASS,
  FIELD_INPUT_CLASS,
} from '../../shared/form-field/form-field-classes';
import {
  CONSOLE_LOAD_FAILED_CLASS,
  CONSOLE_NEUTRAL_BOX_CLASS,
  CONSOLE_NOTICE_CLASS,
  CONSOLE_STATUS_LINE_CLASS,
  CONSOLE_TEXT_LINK_CLASS,
} from '../console/console-detail';

/**
 * Class constants the three `/admin/legal` sections share (AECI-2128, mock-up 14): the
 * legal versions, "Who has accepted" and the litigation holds. The panel, label and
 * caption are the console's own (`admin/console/`), the fields the shared field recipe.
 * These are the few looks the recipe does not name. Labels bind `FIELD_LABEL_CLASS`
 * directly, because the label guard reads a flat property, not an object member.
 */
export const LEGAL_CLASSES = {
  /** The intro under a heading: 14px secondary, capped for reading. */
  caption: `${CONSOLE_CAPTION_CLASS} max-w-[64ch]`,
  /** A card on the page: the flat console panel, its parts 16px apart. */
  panel: `${CONSOLE_PANEL_CLASS} grid gap-4`,
  /**
   * A cautionary box (mock-up 14 `.warnbox`): Bone fill, a strong edge, control radius.
   * An open litigation hold, a moved date.
   */
  notice: CONSOLE_NOTICE_CLASS,
  /** A neutral box: publishing turned off on this tier. Sunken, hairline, control radius. */
  neutralBox: CONSOLE_NEUTRAL_BOX_CLASS,
  /** The bold first line inside a box. */
  boxTitle: 'font-semibold text-(--text-primary)',
  /** A `dl` of label and value pairs side by side; the term column sizes to its longest term. */
  pairs: 'grid gap-x-6 gap-y-2 text-t-14 sm:grid-cols-[max-content_minmax(0,1fr)]',
  /** A pair's value. */
  pairValue: 'text-(--text-primary) wrap-anywhere',
  /** A count's value. */
  countValue: 'tabular-nums text-(--text-primary)',
  /** A released hold: the flat console panel, its three lines 4px apart. */
  releasedPanel: `${CONSOLE_PANEL_CLASS} grid gap-1 text-t-14`,
  /** A bulleted list of short lines. */
  list: 'grid list-disc gap-1 ps-6 text-t-14 text-(--text-primary)',
  /** A block of lines 4px apart (a list under its small label). */
  stack: 'grid gap-1',
  /** A block of form fields, 24px apart, under a hairline. */
  form: 'grid gap-6 border-t border-(--border-default) pt-4',
  /** The same form as its own panel (place a hold). */
  panelForm: `${CONSOLE_PANEL_CLASS} grid max-w-[40rem] gap-6`,
  /** An inline form inside a box: fields 16px apart. */
  inlineForm: 'grid max-w-[36rem] gap-4',
  /** One field: label, hint, control, error. */
  field: 'grid gap-2',
  /** A radio group's legend sits over its options. */
  fieldset: 'm-0 grid gap-2 border-0 p-0',
  /** A radio group's options. */
  choices: 'flex flex-wrap gap-x-6 gap-y-2',
  /** One radio option: a 44px row. */
  choice: 'flex min-h-11 items-center gap-2 text-t-14 text-(--text-primary)',
  choiceInput: CHOICE_INPUT_CLASS,
  input: FIELD_INPUT_CLASS,
  inputMono: `${FIELD_INPUT_CLASS} font-mono`,
  hint: `${FIELD_HINT_CLASS} max-w-[64ch]`,
  error: FIELD_ERROR_CLASS,
  /** A refused write or a load failure, beside the control that failed. */
  failedText: 'text-t-14 font-semibold text-(--text-primary)',
  /** A loading or empty line. */
  statusLine: CONSOLE_STATUS_LINE_CLASS,
  /** A load failure: the sentence, then its Try again button. */
  loadFailed: CONSOLE_LOAD_FAILED_CLASS,
  /** The button row at the foot of a form or a card. */
  actions: 'flex flex-wrap items-center gap-3',
  /** A link inside running text: the text's own ink, underlined. */
  inlineLink: CONSOLE_TEXT_LINK_CLASS,
} as const;
