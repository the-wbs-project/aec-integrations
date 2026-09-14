import { describe, expect, it } from 'vitest';

import {
  EMAIL_LOGO_URL,
  escapeHtml,
  renderEmailHtml,
  renderEmailText,
  type EmailLayout,
} from './email-layout';

const BASE: EmailLayout = {
  preheader: 'A short preview line.',
  heading: 'Your claim is approved',
  blocks: ['First block.', 'Second block.'],
  cta: { label: 'Go to your vendor portal', url: 'https://www.aecintegrations.com/vendor' },
  note: 'Small print.',
};

describe('renderEmailHtml — the shell', () => {
  it('renders the 600px card with the border-strong hairline and no shadow', () => {
    const html = renderEmailHtml(BASE);
    expect(html).toContain('max-width:600px');
    expect(html).toContain('border:1px solid #d4d4d8');
    expect(html).toContain('border-radius:6px');
    // Borders-not-shadows (DESIGN.md §4) — a box-shadow here is an AI-design tell.
    expect(html).not.toContain('box-shadow');
  });

  it('declares light only, matching the Stage 1 app rule (AECI-226)', () => {
    const html = renderEmailHtml(BASE);
    expect(html).toContain('<meta name="color-scheme" content="light only" />');
    expect(html).toContain('<meta name="supported-color-schemes" content="light only" />');
  });

  it('hides the preheader from the body but ships it for the message list', () => {
    const html = renderEmailHtml(BASE);
    expect(html).toContain('mso-hide:all');
    expect(html).toContain('A short preview line.');
  });

  it('uses tables and inline styles, never flex, grid or classes', () => {
    const html = renderEmailHtml(BASE);
    expect(html).toContain('role="presentation"');
    expect(html).not.toContain('display:flex');
    expect(html).not.toContain('display:grid');
    expect(html).not.toContain('class=');
  });
});

describe('renderEmailHtml — the logo band', () => {
  it('points at the hardcoded production URL, never a per-tier host', () => {
    const html = renderEmailHtml(BASE);
    expect(html).toContain(`src="${EMAIL_LOGO_URL}"`);
    expect(EMAIL_LOGO_URL).toBe('https://www.aecintegrations.com/branding/email-logo-banner.png');
    // Non-prod is behind Cloudflare Access, so a staging URL would 403 in a mail client.
    expect(html).not.toContain('staging.aecintegrations.com');
    expect(html).not.toContain('demo.aecintegrations.com');
  });

  it('is a PNG — Outlook and Gmail do not render SVG at all', () => {
    expect(EMAIL_LOGO_URL.endsWith('.png')).toBe(true);
  });

  it('degrades to legible alt text on Forest when images are blocked', () => {
    const html = renderEmailHtml(BASE);
    expect(html).toContain('alt="AEC Integrations"');
    // The band's own <td> carries the fill and Bone type, so the alt renders inside it.
    expect(html).toContain('bgcolor="#1e3a2f"');
    expect(html).toContain('color:#f5f2ea');
  });

  it('still names the sender in text, because images are routinely blocked', () => {
    const html = renderEmailHtml(BASE);
    // The wordmark row: Forest text on the white card, below the band.
    expect(html).toContain('color:#1e3a2f">AEC Integrations</td>');
  });
});

describe('renderEmailHtml — the CTA', () => {
  it('fills with Forest, per the Forest-Anchor Rule', () => {
    const html = renderEmailHtml(BASE);
    expect(html).toContain('background-color:#1e3a2f;color:#ffffff');
    expect(html).toContain('>Go to your vendor portal</a>');
  });

  it('ships the VML twin so the button renders in Outlook for Windows', () => {
    const html = renderEmailHtml(BASE);
    expect(html).toContain('<!--[if mso]>');
    expect(html).toContain('v:roundrect');
    expect(html).toContain('fillcolor="#1E3A2F"');
    expect(html).toContain('<!--[if !mso]><!-- -->');
  });

  it('repeats the URL as paste-able text, because gateways strip buttons', () => {
    const html = renderEmailHtml(BASE);
    expect(html).toContain('Or paste this into your browser:');
    expect(html).toContain('word-break:break-all');
    // Once in the anchor, once in the VML, once in the paste-able block.
    expect(html.split('https://www.aecintegrations.com/vendor').length - 1).toBe(3);
  });

  it('renders no button and no paste-able block when there is no CTA', () => {
    const html = renderEmailHtml({ ...BASE, cta: undefined });
    expect(html).not.toContain('v:roundrect');
    expect(html).not.toContain('Or paste this into your browser:');
    expect(html).not.toContain('/vendor');
  });
});

describe('renderEmailHtml — the detail table (AECI-924)', () => {
  const ROWS = [
    ['Claimed', 'Globex Inc (vendor)'],
    ['Submitter', 'ops@globex.com'],
    ['Linear issue', 'https://linear.app/aec-integrations/issue/AECI-1'],
  ] as const;

  it('renders every row as a label and a value', () => {
    const html = renderEmailHtml({ ...BASE, table: ROWS });
    expect(html).toContain('Claimed');
    expect(html).toContain('Globex Inc (vendor)');
    expect(html).toContain('ops@globex.com');
  });

  it('separates rows with the border-strong hairline, never a border="1" grid', () => {
    const html = renderEmailHtml({ ...BASE, table: ROWS });
    expect(html).toContain('border-top:1px solid #d4d4d8');
    // The unstyled grid `opsTable()` drew is the thing this migration exists to remove.
    expect(html).not.toContain('border="1"');
  });

  it('links a value that is a bare URL, so an operator does not copy-paste by hand', () => {
    const html = renderEmailHtml({ ...BASE, table: ROWS });
    expect(html).toContain(
      '<a href="https://linear.app/aec-integrations/issue/AECI-1" style="color:#1e3a2f;text-decoration:underline">',
    );
  });

  it('leaves a value that merely mentions a URL unlinked', () => {
    const html = renderEmailHtml({
      ...BASE,
      table: [['Linear issue', 'not created yet, see https://linear.app']],
    });
    expect(html).not.toContain('<a href="not created yet');
    expect(html).toContain('not created yet, see https://linear.app');
  });

  it('escapes both halves, because these rows carry submitter-supplied text', () => {
    const html = renderEmailHtml({
      ...BASE,
      table: [['Name & role', '<script>alert(1)</script>']],
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('Name &amp; role');
  });

  it('renders no table markup at all when there are no rows', () => {
    expect(renderEmailHtml({ ...BASE, table: [] })).toBe(renderEmailHtml(BASE));
  });
});

describe('renderEmailHtml — escaping', () => {
  it('escapes the heading, the CTA and the note', () => {
    const html = renderEmailHtml({
      preheader: '<img onerror=x>',
      heading: 'A & B <script>',
      blocks: ['plain'],
      cta: { label: '<b>go</b>', url: 'https://example.com/?a=1&b="2"' },
      note: '"quoted" & <tagged>',
    });
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>go</b>');
    expect(html).toContain('A &amp; B &lt;script&gt;');
    expect(html).toContain('&quot;quoted&quot; &amp; &lt;tagged&gt;');
    expect(html).toContain('a=1&amp;b=&quot;2&quot;');
  });

  it('passes blocks through as HTML, which is what lets a caller bold a name', () => {
    const html = renderEmailHtml({ ...BASE, blocks: ['<strong>Autodesk</strong> is live.'] });
    expect(html).toContain('<strong>Autodesk</strong> is live.');
  });
});

describe('renderEmailText', () => {
  it('spells out the CTA URL, because text/plain has no other way to carry it', () => {
    const text = renderEmailText(BASE);
    expect(text).toContain('Go to your vendor portal: https://www.aecintegrations.com/vendor');
  });

  it('orders heading, blocks, CTA, then note', () => {
    const text = renderEmailText(BASE);
    expect(text.split('\n\n')).toEqual([
      'Your claim is approved',
      'First block.',
      'Second block.',
      'Go to your vendor portal: https://www.aecintegrations.com/vendor',
      'Small print.',
    ]);
  });

  it('carries no sign-off, so no em dash — the footer wordmark names the sender', () => {
    const text = renderEmailText(BASE);
    expect(text).not.toContain('The AEC Integrations team');
    expect(text).not.toContain('—');
  });

  it('omits the CTA line entirely when there is no link to offer', () => {
    const text = renderEmailText({ ...BASE, cta: undefined });
    expect(text).not.toContain('http');
  });

  it('emits the table as one `Key: value` block between the blocks and the CTA', () => {
    const text = renderEmailText({
      ...BASE,
      table: [
        ['Claimed', 'Globex Inc (vendor)'],
        ['Submitter', 'ops@globex.com'],
      ],
    });
    // Byte-for-byte what `opsText()` produced, which is why migrating a template
    // leaves its text part and the specs that assert on it unchanged.
    expect(text.split('\n\n')).toEqual([
      'Your claim is approved',
      'First block.',
      'Second block.',
      'Claimed: Globex Inc (vendor)\nSubmitter: ops@globex.com',
      'Go to your vendor portal: https://www.aecintegrations.com/vendor',
      'Small print.',
    ]);
  });
});

describe('escapeHtml', () => {
  it('escapes the four entities that break an attribute or a tag', () => {
    expect(escapeHtml('&<>"')).toBe('&amp;&lt;&gt;&quot;');
  });

  it('escapes the ampersand first, so entities are not double-escaped', () => {
    expect(escapeHtml('a & <b>')).toBe('a &amp; &lt;b&gt;');
  });
});
