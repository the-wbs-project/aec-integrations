/**
 * The Plans page's `plans-actions` widget statement, as a pure function (AECI-1619):
 * the pointer to the public vendor program page under the intro
 * (`VENDOR_PROGRAM_PAGE_SPEC.md` section 10). `docs-page.ts` renders it with the link,
 * and the Plans snapshot (`plans-snapshot.ts`) prints it as Markdown, both from here.
 * The button beside it is navigation only and is not part of the snapshot.
 *
 * One message with a link placeholder pair, so a translator sees the whole sentence.
 * The placeholders are filled with sentinels and split, which gives the text before,
 * inside and after the link. No Angular import. `$localize` runs on each call.
 */

/** Where the pointer links. */
export const VENDOR_PROGRAM_PATH = '/vendor-program';

const START = '\u0000start\u0000';
const END = '\u0000end\u0000';

/** The sentence, cut at its link. */
export interface PlansVendorProgramPointer {
  readonly before: string;
  readonly link: string;
  readonly after: string;
}

/** The pointer sentence in the active locale. */
export function plansVendorProgramPointer(): PlansVendorProgramPointer {
  const text = $localize`:@@app.docs.plans.vendorProgram:For a short overview of what AEC Integrations offers vendors, see ${START}:START_LINK:the vendor program${END}:CLOSE_LINK:.`;
  const [before = '', rest = ''] = text.split(START);
  const [link = '', after = ''] = rest.split(END);
  return { before, link, after };
}
