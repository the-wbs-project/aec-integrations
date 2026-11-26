/**
 * AECI-1720: two structural rules for forms that may be server-rendered.
 *
 * 1. Every component that binds `[formField]` on a text field, textarea, select or
 *    radio imports `AecEarlyInput`, so no form loses what a visitor typed before
 *    hydration. A component whose only bound control is a checkbox has nothing to carry.
 * 2. Every acceptance checkbox carries `aecConsent`, so it is disabled until the app is
 *    live. No checkbox is ever carried across hydration in any case (`isNeverCarried`,
 *    pinned in `early-input.component.spec.ts`), so a forgotten marker cannot carry a
 *    tick. This rule keeps the box from being tickable before it can work.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const APP_DIR = join(__dirname, '..', '..');

function sources(dir: string, ext: readonly string[]): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path, ext);
    if (entry.name.endsWith('.spec.ts')) return [];
    return ext.some((e) => entry.name.endsWith(e)) ? [path] : [];
  });
}

/** The `imports: [...]` array of the component or directive decorator, if any. */
function decoratorImports(text: string): string {
  const start = text.indexOf('imports: [');
  return start < 0 ? '' : text.slice(start, text.indexOf(']', start) + 1);
}

/** Every `<input …>` tag in a template source, whole. */
function inputTags(text: string): string[] {
  return [...text.matchAll(/<input\b[^>]*>/g)].map((m) => m[0]);
}

/**
 * The checkboxes that are not consent: filters, row selections and taxonomy choices.
 * Each entry is a file and a fragment of the one `<input>` tag it allows. Every other
 * checkbox must carry `aecConsent`. Add a box here only if ticking it agrees to
 * nothing.
 */
const NON_CONSENT_BOXES: readonly { file: string; tag: string; why: string }[] = [
  {
    file: 'account/profile-details/profile-details-form.ts',
    tag: 'isChosen(term.id)',
    why: 'About you: the taxonomy terms the reader works with',
  },
  {
    file: 'account/review-update-panel.html',
    tag: 'rerate()',
    why: 'review update: also change my ratings',
  },
  {
    file: 'admin/activity/activity-feed.html',
    tag: 'excludeInternal()',
    why: 'admin filter: hide internal traffic',
  },
  { file: 'admin/dmca/dmca-notices.html', tag: 'openOnly()', why: 'admin filter: open only' },
  {
    file: 'admin/reviewers/ban-pending-choice.ts',
    tag: 'ban-reject-pending',
    why: 'admin ban: also reject the pending items (AECI-1949)',
  },
  {
    file: 'admin/traffic/traffic.html',
    tag: 'excludeInternal()',
    why: 'admin filter: hide internal traffic',
  },
  {
    file: 'admin/vendors/admin-field-corrections.html',
    tag: 'terms().has(term.slug)',
    why: 'admin correction: taxonomy terms',
  },
  {
    file: 'admin/vendors/ban-term-licenses-control.html',
    tag: 'rowFor(c.productId).include',
    why: 'admin: which licenses a ban covers',
  },
  {
    file: 'admin/vendors/billing-licenses-table.html',
    tag: 'allSelected()',
    why: 'admin table: select all rows',
  },
  {
    file: 'admin/vendors/billing-licenses-table.html',
    tag: 'isSelected(row)',
    why: 'admin table: select a row',
  },
  {
    file: 'search/widgets/search-refinement-list.ts',
    tag: '',
    why: 'search facet filters (both boxes)',
  },
  {
    file: 'vendor/components/vendor-product-create.ts',
    tag: 'chosen().has(term.slug)',
    why: 'portal: taxonomy terms of a new product',
  },
  {
    file: 'vendor/components/vendor-product-facet-editor.ts',
    tag: 'row.checked',
    why: 'portal: taxonomy terms of a product',
  },
];

/** The component's template: the inline one, plus its `templateUrl` file if any. */
function templateOf(path: string): string {
  const text = readFileSync(path, 'utf8');
  const url = text.match(/templateUrl:\s*'([^']+)'/)?.[1];
  return url ? text + readFileSync(join(dirname(path), url), 'utf8') : text;
}

/** A `[formField]` on a control the directive carries: not a checkbox. */
function bindsCarriedControl(template: string): boolean {
  return [...template.matchAll(/<(input|textarea|select)\b[^>]*>/g)].some(
    (m) => /\[formField\]/.test(m[0]) && !/type="checkbox"/.test(m[0]),
  );
}

describe('AecEarlyInput coverage (AECI-1720)', () => {
  const users = sources(APP_DIR, ['.ts']).filter((path) =>
    /\bFormField\b/.test(decoratorImports(readFileSync(path, 'utf8'))),
  );

  it('finds the components that import FormField', () => {
    expect(users.length).toBeGreaterThan(10);
  });

  it('every component that binds a carried control imports AecEarlyInput too', () => {
    const missing = users
      .filter((path) => bindsCarriedControl(templateOf(path)))
      .filter((path) => !/\bAecEarlyInput\b/.test(decoratorImports(readFileSync(path, 'utf8'))))
      .map((path) => relative(APP_DIR, path));
    expect(missing).toEqual([]);
  });

  it('the claim fields and the mailing list are among them', () => {
    const carried = users
      .filter((path) => bindsCarriedControl(templateOf(path)))
      .map((path) => relative(APP_DIR, path));
    expect(carried).toContain(join('requests', 'claimant-fields.ts'));
    expect(carried).toContain(join('shared', 'mailing-list-signup', 'mailing-list-signup.ts'));
  });
});

describe('consent boxes carry aecConsent (AECI-1720)', () => {
  const boxes = sources(APP_DIR, ['.ts', '.html']).flatMap((path) =>
    inputTags(readFileSync(path, 'utf8'))
      .filter((tag) => /type="checkbox"/.test(tag))
      .map((tag) => ({ file: relative(APP_DIR, path).split(sep).join('/'), tag })),
  );
  const marked = boxes.filter((b) => /\baecConsent\b/.test(b.tag));

  it('finds the acceptance boxes, the Vendor Terms and /auth/terms ones included', () => {
    const files = marked.map((b) => b.file);
    for (const file of [
      'requests/vendor-terms-box.ts',
      'auth/terms-accept.ts',
      'vendor/components/vendor-legal-acceptance.ts',
      'vendor/components/vendor-pending-grant-card.ts',
      'vendor/components/vendor-billing-unused-warning.ts',
      'vendor/integration-detail/integration-row-thread.ts',
      'admin/vendors/grant-licenses-control.html',
      'home/home-feedback-form.ts',
    ]) {
      expect(files).toContain(file);
    }
  });

  it('every checkbox carries aecConsent unless it is on the non-consent list', () => {
    const unmarked = boxes
      .filter((b) => !/\baecConsent\b/.test(b.tag))
      .filter((b) => !NON_CONSENT_BOXES.some((n) => n.file === b.file && b.tag.includes(n.tag)))
      .map((b) => `${b.file}: ${b.tag.slice(0, 120)}`);
    expect(unmarked).toEqual([]);
  });

  it('no entry on the non-consent list is stale or names a marked box', () => {
    const stale = NON_CONSENT_BOXES.filter(
      (n) =>
        !boxes.some(
          (b) => b.file === n.file && b.tag.includes(n.tag) && !/\baecConsent\b/.test(b.tag),
        ),
    ).map((n) => `${n.file}: ${n.tag}`);
    expect(stale).toEqual([]);
  });

  it('a component with an aecConsent box imports AecConsentBox, template file included', () => {
    const missing = sources(APP_DIR, ['.ts'])
      .filter((path) => {
        const template = templateOf(path);
        const imports = decoratorImports(readFileSync(path, 'utf8'));
        return (
          inputTags(template).some((tag) => /\baecConsent\b/.test(tag)) &&
          !/\bAecConsentBox\b/.test(imports)
        );
      })
      .map((path) => relative(APP_DIR, path));
    expect(missing).toEqual([]);
  });
});
