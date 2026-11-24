/**
 * AECI-1883: the in-page half of the voice-control and switch stand-ins.
 *
 * `readControls` reads every rendered control on the page and joins two views of
 * it:
 *
 *   - From the DOM: the text a sighted user reads as its label, what it does
 *     (link target, `aria-controls`, form), its landmark, and its field facts.
 *   - From Chromium's accessibility tree, over DevTools: its role and accessible
 *     name. That is the name the platform accessibility API hands to Dragon or
 *     Voice Control, so it is the one a spoken command must match.
 *
 * The join is by DevTools backend node id. Each control gets a
 * `data-aeci-voice` attribute for the read, and it is removed after. The
 * attribute changes no style, role or name. Nothing moves focus.
 *
 * Chromium only, like the rest of the nightly's pictures and DevTools calls.
 * `docs/TESTING_STRATEGY.md` §8.4.8.
 */
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { EXCLUDED_DOM } from '../../e2e/axe-sweep';
import { linkAction, type ControlFact } from './voice-names';

const MARK = 'data-aeci-voice';

/** Roles a voice command can act on. Chromium names a `<summary>` `DisclosureTriangle`. */
const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'checkbox',
  'radio',
  'switch',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'combobox',
  'textbox',
  'searchbox',
  'slider',
  'spinbutton',
  'treeitem',
  'listbox',
  'DisclosureTriangle',
]);

/** What the page half returns per control, before the accessibility tree is joined. */
interface DomControl {
  readonly mark: number;
  readonly visibleText: string;
  readonly labelSource: ControlFact['labelSource'];
  readonly href: string | null;
  readonly controls: string | null;
  readonly submitForm: number | null;
  readonly details: number | null;
  readonly disabled: boolean;
  readonly landmark: string;
  readonly testId: string | null;
  readonly field: ControlFact['field'];
}

/** Mark every rendered control and read its DOM facts. Runs in the page. */
function markControls(mark: string): DomControl[] {
  const SELECTOR = [
    'a[href]',
    'button',
    'input:not([type="hidden"])',
    'select',
    'textarea',
    'summary',
    '[contenteditable=""]',
    '[contenteditable="true"]',
    '[tabindex]',
    ...[
      'button',
      'link',
      'checkbox',
      'radio',
      'switch',
      'tab',
      'menuitem',
      'menuitemcheckbox',
      'menuitemradio',
      'option',
      'combobox',
      'textbox',
      'searchbox',
      'slider',
      'spinbutton',
      'treeitem',
    ].map((r) => `[role="${r}"]`),
  ].join(', ');

  const LANDMARKS: ReadonlyArray<[string, string]> = [
    ['dialog, [role="dialog"], [role="alertdialog"]', 'dialog'],
    ['nav, [role="navigation"]', 'nav'],
    ['aside, [role="complementary"]', 'aside'],
    ['main, [role="main"]', 'main'],
    ['footer, [role="contentinfo"]', 'footer'],
    ['header, [role="banner"]', 'header'],
  ];
  const landmarkOf = (el: Element): string => {
    let best: Element | null = null;
    let name = 'page';
    for (const [selector, label] of LANDMARKS) {
      const found = el.closest(selector);
      if (found && (!best || best.contains(found))) {
        best = found;
        name = label;
      }
    }
    return name;
  };

  // An element hides its text from sight when it is invisible, transparent, or a
  // clipped box under 2px (the `.sr-only` pattern). Cached per element.
  const hides = new Map<Element, boolean>();
  const hidesText = (el: Element): boolean => {
    let known = hides.get(el);
    if (known !== undefined) return known;
    const s = getComputedStyle(el);
    // An inline box has no client size and does not clip, whatever its `overflow` says.
    const clipsOverflow =
      s.display !== 'inline' && (s.overflowX !== 'visible' || s.overflowY !== 'visible');
    known =
      Number.parseFloat(s.opacity) === 0 ||
      (clipsOverflow && (el.clientWidth < 2 || el.clientHeight < 2)) ||
      /^rect\(0(px)?,? 0(px)?,? 0(px)?,? 0(px)?\)$/.test(s.clip) ||
      s.clipPath.startsWith('inset(50%');
    hides.set(el, known);
    return known;
  };

  /** A text node's on-screen boxes, or none when it cannot be seen. */
  const shownRects = (node: Text): DOMRect[] => {
    const parent = node.parentElement;
    if (!parent || getComputedStyle(parent).visibility !== 'visible') return [];
    for (let a: Element | null = parent; a && a !== document.documentElement; a = a.parentElement) {
      if (hidesText(a)) return [];
    }
    const range = document.createRange();
    range.selectNodeContents(node);
    return Array.from(range.getClientRects()).filter(
      (r) =>
        r.width >= 1 &&
        r.height >= 1 &&
        r.right + window.scrollX > 0 &&
        r.bottom + window.scrollY > 0,
    );
  };

  /**
   * The text a sighted user reads inside `root`, in document order. Two pieces
   * that sit apart on screen (another line, or a gap) read as two words even
   * when the DOM has no space between them. That is how "Change" and "billing"
   * in two flex items read, and how AECI-1469's name lost the space.
   */
  const visibleTextOf = (root: Element, owner: Element): string => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let text = '';
    let last: DOMRect | null = null;
    for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
      const raw = n.data;
      if (raw.trim() === '') {
        if (text !== '' && /\s/.test(raw)) text += ' ';
        continue;
      }
      const parent = n.parentElement;
      // Text inside another control, or inside a form control in a label, is not this label.
      const control = parent?.closest(`${SELECTOR}, select, textarea, option`);
      if (control && control !== owner && root.contains(control) && control !== root) continue;
      if (parent?.closest('svg, script, style, template')) continue;
      // A hidden glyph of one or two characters is an icon, not a label: a logo's
      // initial tile, a count badge, an "i" info mark. Nobody says "click F".
      if (parent?.closest('[aria-hidden="true"]') && Array.from(raw.trim()).length <= 2) continue;
      const rects = shownRects(n);
      if (rects.length === 0) continue;
      const first = rects[0]!;
      if (last && text !== '' && !/\s$/.test(text) && !/^\s/.test(raw)) {
        const sameLine =
          Math.abs(first.top + first.height / 2 - (last.top + last.height / 2)) <
          Math.max(first.height, last.height) / 2;
        const gap = first.left - last.right;
        if (!sameLine || gap > 1) text += ' ';
      }
      text += raw;
      last = rects.at(-1)!;
    }
    return text.replace(/\s+/g, ' ').trim();
  };

  const isRendered = (el: Element): boolean => {
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility()) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  const forms = new Map<Element, number>();
  const formIndex = (form: Element): number => {
    if (!forms.has(form)) forms.set(form, forms.size);
    return forms.get(form)!;
  };
  const detailsKeys = new Map<Element, number>();

  const TEXT_FIELD = /^(text|email|tel|url|search|password|number)$/;
  const out: DomControl[] = [];
  let next = 0;
  for (const el of Array.from(document.body.querySelectorAll(SELECTOR))) {
    if (el.closest('select') && el.tagName !== 'SELECT') continue;
    if (el.closest('iframe')) continue;
    if (!isRendered(el)) continue;
    const index = next++;
    el.setAttribute(mark, String(index));
    // Kept unnarrowed: the DOM lib types a narrowed HTMLSelectElement as not an Element.
    const target: Element = el;

    let visibleText: string;
    let labelSource: DomControl['labelSource'];
    let field: DomControl['field'] = null;
    if (el instanceof HTMLInputElement && /^(submit|button|reset)$/.test(el.type)) {
      visibleText = el.value;
      labelSource = visibleText ? 'value' : 'none';
    } else if (
      el instanceof HTMLInputElement ||
      el instanceof HTMLSelectElement ||
      el instanceof HTMLTextAreaElement
    ) {
      const labels = Array.from(el.labels ?? []).filter(isRendered);
      visibleText = labels
        .map((l) => visibleTextOf(l, target))
        .filter(Boolean)
        .join(' ');
      labelSource = visibleText ? 'label' : 'none';
      const type = el instanceof HTMLTextAreaElement ? 'textarea' : el.type;
      if (el instanceof HTMLTextAreaElement || TEXT_FIELD.test(type)) {
        field = {
          type,
          autocomplete: el.getAttribute('autocomplete'),
          nameAttr: el.getAttribute('name') ?? '',
          id: el.id,
        };
      }
    } else {
      visibleText = visibleTextOf(el, el);
      labelSource = visibleText ? 'content' : 'none';
    }

    const form =
      el instanceof HTMLButtonElement && el.type === 'submit'
        ? el.form
        : el instanceof HTMLInputElement && el.type === 'submit'
          ? el.form
          : null;
    const detailsEl = el.tagName === 'SUMMARY' ? el.parentElement : null;
    if (detailsEl && !detailsKeys.has(detailsEl)) detailsKeys.set(detailsEl, detailsKeys.size);

    out.push({
      mark: index,
      visibleText,
      labelSource,
      href: el.matches('a[href], area[href]') ? (el as HTMLAnchorElement).href : null,
      controls: el.getAttribute('aria-controls'),
      submitForm: form ? formIndex(form) : null,
      details: detailsEl ? detailsKeys.get(detailsEl)! : null,
      disabled: el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true',
      landmark: landmarkOf(target),
      testId: el.closest('[data-testid]')?.getAttribute('data-testid') ?? null,
      field,
    });
  }
  return out;
}

interface DomNode {
  readonly backendNodeId: number;
  readonly attributes?: string[];
  readonly children?: DomNode[];
  readonly shadowRoots?: DomNode[];
}

interface AxNode {
  readonly ignored: boolean;
  readonly role?: { readonly value?: string };
  readonly name?: { readonly value?: string };
  readonly backendDOMNodeId?: number;
}

/** Every rendered control on the page, with its Chromium role and name. Moves no focus. */
export async function readControls(page: Page): Promise<ControlFact[]> {
  const dom = await page.evaluate(markControls, MARK);
  const cdp = await page.context().newCDPSession(page);
  try {
    // Mark value -> backend node id, from one read of the whole document.
    const { root } = (await cdp.send('DOM.getDocument', { depth: -1, pierce: false })) as {
      root: DomNode;
    };
    const backendByMark = new Map<number, number>();
    const visit = (node: DomNode): void => {
      const attrs = node.attributes ?? [];
      for (let i = 0; i < attrs.length; i += 2) {
        if (attrs[i] === MARK) backendByMark.set(Number(attrs[i + 1]), node.backendNodeId);
      }
      for (const child of node.children ?? []) visit(child);
      for (const child of node.shadowRoots ?? []) visit(child);
    };
    visit(root);

    await cdp.send('Accessibility.enable');
    const { nodes } = (await cdp.send('Accessibility.getFullAXTree')) as { nodes: AxNode[] };
    const axByBackend = new Map<number, AxNode>();
    for (const n of nodes) {
      if (n.backendDOMNodeId !== undefined && !n.ignored) axByBackend.set(n.backendDOMNodeId, n);
    }

    const origin = new URL(page.url()).origin;
    const controls: ControlFact[] = [];
    for (const d of dom) {
      const backend = backendByMark.get(d.mark);
      const ax = backend === undefined ? undefined : axByBackend.get(backend);
      // Not in the tree (inside `aria-hidden`, say): no voice command reaches it.
      const rawRole = ax?.role?.value;
      if (!ax || !rawRole || !INTERACTIVE_ROLES.has(rawRole)) continue;
      const role = rawRole === 'DisclosureTriangle' ? 'button' : rawRole;
      let action = `element ${d.mark}`;
      if (d.href !== null) action = linkAction(d.href, origin);
      else if (d.details !== null) action = `details ${d.details}`;
      else if (d.controls) action = `controls ${d.controls.split(/\s+/).sort().join(' ')}`;
      else if (d.submitForm !== null) action = `submit ${d.submitForm}`;
      controls.push({
        key: d.mark,
        role,
        name: ax.name?.value ?? '',
        visibleText: d.visibleText,
        labelSource: d.labelSource,
        action,
        disabled: d.disabled,
        landmark: d.landmark,
        testId: d.testId,
        field: d.field,
      });
    }
    return controls;
  } finally {
    await cdp.send('Accessibility.disable').catch(() => undefined);
    await cdp.detach().catch(() => undefined);
    await page.evaluate((mark) => {
      for (const el of Array.from(document.querySelectorAll(`[${mark}]`))) el.removeAttribute(mark);
    }, MARK);
  }
}

/** One target the size rule reports. */
export interface TargetSizeFinding {
  /** axe's CSS selector for the element. */
  readonly target: string;
  /**
   * `fails`: axe measured it too small with too little spacing. `review`: axe
   * could not decide, usually because another element covers part of it or its
   * content overflows. Both are reported. Neither fails the run.
   */
  readonly verdict: 'fails' | 'review';
  /** axe's reason: the size, and the spacing that was too small. */
  readonly why: string;
}

/**
 * Check 3, WCAG 2.5.8, report only: axe's `target-size` rule over the page as
 * it stands. It applies the 24 by 24 CSS px minimum, the spacing exception and
 * the inline exception. Third-party DOM the sweep excludes is excluded here too.
 */
export async function readTargetSize(page: Page): Promise<TargetSizeFinding[]> {
  let builder = new AxeBuilder({ page }).withRules(['target-size']);
  for (const { selector } of EXCLUDED_DOM) builder = builder.exclude(selector);
  const result = await builder.analyze();
  const findings: TargetSizeFinding[] = [];
  const add = (results: typeof result.violations, verdict: TargetSizeFinding['verdict']) => {
    for (const v of results) {
      for (const node of v.nodes) {
        const why = (node.failureSummary ?? '')
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l !== '' && !/^Fix (any|all) of the following:$/.test(l))
          .join(' ');
        findings.push({ target: node.target.map(String).join(' '), verdict, why });
      }
    }
  };
  add(result.violations, 'fails');
  add(result.incomplete, 'review');
  return findings.sort((a, b) => (a.target < b.target ? -1 : a.target > b.target ? 1 : 0));
}
