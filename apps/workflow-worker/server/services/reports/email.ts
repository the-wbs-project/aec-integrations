// ---------------------------------------------------------------------------
// Build + send the weekly cost report via the Workers `send_email` binding.
//
// The Cloudflare `EmailMessage` API expects a fully-formed RFC 5322 message
// (including headers + body). We hand-build a minimal multipart/alternative
// payload — text + HTML — without pulling in a MIME library.
// ---------------------------------------------------------------------------
import { EmailMessage } from 'cloudflare:email';
import type { Env } from '../../env';
import type { CostSummary, WorkflowCostRow } from './types';

export interface ReportData {
  windowStartIso: string;
  windowEndIso: string;
  gateway: CostSummary;
  searchapi: CostSummary;
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(4)}`;
}

function costPerCall(calls: number, costUsd: number): number {
  return calls > 0 ? costUsd / calls : 0;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderTextSection(title: string, summary: CostSummary): string {
  const lines: string[] = [`== ${title} ==`];
  if (summary.rows.length === 0) {
    lines.push('  (no calls in window)');
  } else {
    const w = (s: string, n: number) => s.padEnd(n);
    lines.push(
      `  ${w('Workflow', 32)} ${w('Calls', 8)} ${w('Cost', 12)} ${w('Cost/Call', 12)}`,
    );
    for (const row of summary.rows) {
      lines.push(
        `  ${w(row.workflow, 32)} ${w(String(row.calls), 8)} ${w(fmtUsd(row.costUsd), 12)} ${fmtUsd(costPerCall(row.calls, row.costUsd))}`,
      );
    }
    if (summary.unattributedCalls > 0) {
      lines.push(
        `  ${w('(unattributed)', 32)} ${w(String(summary.unattributedCalls), 8)} ${w(fmtUsd(summary.unattributedCostUsd), 12)} ${fmtUsd(costPerCall(summary.unattributedCalls, summary.unattributedCostUsd))}`,
      );
    }
    lines.push(
      `  ${'-'.repeat(32)} ${'-'.repeat(8)} ${'-'.repeat(12)} ${'-'.repeat(12)}`,
    );
    lines.push(
      `  ${''.padEnd(32, ' ').replace(/\s/g, ' ')} ${String(summary.totalCalls).padEnd(8)} ${fmtUsd(summary.totalCostUsd).padEnd(12)} ${fmtUsd(costPerCall(summary.totalCalls, summary.totalCostUsd))}`,
    );
  }
  if (summary.notes.length > 0) {
    lines.push('  Notes:');
    for (const n of summary.notes) lines.push(`    - ${n}`);
  }
  return lines.join('\n');
}

function renderHtmlSection(title: string, summary: CostSummary): string {
  const rowsHtml: string[] = [];
  for (const row of summary.rows) {
    rowsHtml.push(
      `<tr><td>${escapeHtml(row.workflow)}</td><td style="text-align:right">${row.calls}</td><td style="text-align:right">${fmtUsd(row.costUsd)}</td><td style="text-align:right">${fmtUsd(costPerCall(row.calls, row.costUsd))}</td></tr>`,
    );
  }
  if (summary.unattributedCalls > 0) {
    rowsHtml.push(
      `<tr style="color:#888"><td><em>(unattributed)</em></td><td style="text-align:right">${summary.unattributedCalls}</td><td style="text-align:right">${fmtUsd(summary.unattributedCostUsd)}</td><td style="text-align:right">${fmtUsd(costPerCall(summary.unattributedCalls, summary.unattributedCostUsd))}</td></tr>`,
    );
  }
  const totalRow = `<tr style="font-weight:bold;border-top:2px solid #333"><td>Total</td><td style="text-align:right">${summary.totalCalls}</td><td style="text-align:right">${fmtUsd(summary.totalCostUsd)}</td><td style="text-align:right">${fmtUsd(costPerCall(summary.totalCalls, summary.totalCostUsd))}</td></tr>`;
  const notesHtml =
    summary.notes.length > 0
      ? `<ul style="margin:8px 0 0 0;padding-left:20px;color:#666;font-size:12px">${summary.notes.map((n) => `<li>${escapeHtml(n)}</li>`).join('')}</ul>`
      : '';
  const tableBody =
    rowsHtml.length === 0
      ? `<tr><td colspan="4" style="color:#888"><em>No calls in window.</em></td></tr>${totalRow}`
      : `${rowsHtml.join('')}${totalRow}`;

  return `<section style="margin-bottom:24px">
    <h2 style="margin:0 0 8px 0;font-size:16px">${escapeHtml(title)}</h2>
    <table style="border-collapse:collapse;width:100%;font-size:13px">
      <thead>
        <tr style="background:#f5f5f5">
          <th style="text-align:left;padding:6px 8px">Workflow</th>
          <th style="text-align:right;padding:6px 8px">Calls</th>
          <th style="text-align:right;padding:6px 8px">Total Cost</th>
          <th style="text-align:right;padding:6px 8px">Cost / Call</th>
        </tr>
      </thead>
      <tbody>${tableBody.replace(/<td/g, '<td style="padding:4px 8px;border-bottom:1px solid #eee"')}</tbody>
    </table>
    ${notesHtml}
  </section>`;
}

interface CombinedTotals {
  rows: WorkflowCostRow[];
  totalCalls: number;
  totalCostUsd: number;
}

function combineTotals(a: CostSummary, b: CostSummary): CombinedTotals {
  const map = new Map<string, { calls: number; costUsd: number }>();
  const merge = (s: CostSummary) => {
    for (const r of s.rows) {
      const cur = map.get(r.workflow) ?? { calls: 0, costUsd: 0 };
      cur.calls += r.calls;
      cur.costUsd += r.costUsd;
      map.set(r.workflow, cur);
    }
    if (s.unattributedCalls > 0) {
      const cur = map.get('(unattributed)') ?? { calls: 0, costUsd: 0 };
      cur.calls += s.unattributedCalls;
      cur.costUsd += s.unattributedCostUsd;
      map.set('(unattributed)', cur);
    }
  };
  merge(a);
  merge(b);
  const rows = Array.from(map.entries())
    .map(([workflow, v]) => ({ workflow, calls: v.calls, costUsd: v.costUsd }))
    .sort((x, y) => y.costUsd - x.costUsd || x.workflow.localeCompare(y.workflow));
  const totalCalls = a.totalCalls + b.totalCalls;
  const totalCostUsd = a.totalCostUsd + b.totalCostUsd;
  return { rows, totalCalls, totalCostUsd };
}

function renderTextCombined(combined: CombinedTotals): string {
  const lines: string[] = ['== Combined (AI Gateway + SearchAPI) =='];
  const w = (s: string, n: number) => s.padEnd(n);
  lines.push(`  ${w('Workflow', 32)} ${w('Calls', 8)} ${w('Cost', 12)} ${w('Cost/Call', 12)}`);
  for (const r of combined.rows) {
    lines.push(
      `  ${w(r.workflow, 32)} ${w(String(r.calls), 8)} ${w(fmtUsd(r.costUsd), 12)} ${fmtUsd(costPerCall(r.calls, r.costUsd))}`,
    );
  }
  lines.push(`  ${'-'.repeat(32)} ${'-'.repeat(8)} ${'-'.repeat(12)} ${'-'.repeat(12)}`);
  lines.push(
    `  ${w('Total', 32)} ${w(String(combined.totalCalls), 8)} ${w(fmtUsd(combined.totalCostUsd), 12)} ${fmtUsd(costPerCall(combined.totalCalls, combined.totalCostUsd))}`,
  );
  return lines.join('\n');
}

function renderHtmlCombined(combined: CombinedTotals): string {
  const rowsHtml = combined.rows
    .map(
      (r) =>
        `<tr><td>${escapeHtml(r.workflow)}</td><td style="text-align:right">${r.calls}</td><td style="text-align:right">${fmtUsd(r.costUsd)}</td><td style="text-align:right">${fmtUsd(costPerCall(r.calls, r.costUsd))}</td></tr>`,
    )
    .join('');
  const totalRow = `<tr style="font-weight:bold;border-top:2px solid #333"><td>Total</td><td style="text-align:right">${combined.totalCalls}</td><td style="text-align:right">${fmtUsd(combined.totalCostUsd)}</td><td style="text-align:right">${fmtUsd(costPerCall(combined.totalCalls, combined.totalCostUsd))}</td></tr>`;
  return `<section>
    <h2 style="margin:0 0 8px 0;font-size:16px">Combined (AI Gateway + SearchAPI)</h2>
    <table style="border-collapse:collapse;width:100%;font-size:13px">
      <thead>
        <tr style="background:#f5f5f5">
          <th style="text-align:left;padding:6px 8px">Workflow</th>
          <th style="text-align:right;padding:6px 8px">Calls</th>
          <th style="text-align:right;padding:6px 8px">Total Cost</th>
          <th style="text-align:right;padding:6px 8px">Cost / Call</th>
        </tr>
      </thead>
      <tbody>${(rowsHtml + totalRow).replace(/<td/g, '<td style="padding:4px 8px;border-bottom:1px solid #eee"')}</tbody>
    </table>
  </section>`;
}

export function renderReport(data: ReportData): { subject: string; text: string; html: string } {
  const subject = `Weekly AI cost report — ${data.windowStartIso.slice(0, 10)} to ${data.windowEndIso.slice(0, 10)}`;
  const combined = combineTotals(data.gateway, data.searchapi);

  const text = [
    `Weekly AI cost report`,
    `Window: ${data.windowStartIso} → ${data.windowEndIso}`,
    '',
    renderTextSection('AI Gateway (Anthropic via Cloudflare)', data.gateway),
    '',
    renderTextSection('SearchAPI.io', data.searchapi),
    '',
    renderTextCombined(combined),
  ].join('\n');

  const html = `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:#222;max-width:720px;margin:0 auto;padding:16px">
    <h1 style="margin:0 0 4px 0;font-size:20px">Weekly AI cost report</h1>
    <div style="color:#666;font-size:12px;margin-bottom:16px">Window: ${escapeHtml(data.windowStartIso)} → ${escapeHtml(data.windowEndIso)}</div>
    ${renderHtmlSection('AI Gateway (Anthropic via Cloudflare)', data.gateway)}
    ${renderHtmlSection('SearchAPI.io', data.searchapi)}
    ${renderHtmlCombined(combined)}
  </body></html>`;

  return { subject, text, html };
}

// ---------------------------------------------------------------------------
// MIME assembly + send
// ---------------------------------------------------------------------------

function makeBoundary(): string {
  // Random-enough boundary, no need for cryptographic strength.
  const r = Math.random().toString(36).slice(2);
  return `=_aeci_${Date.now().toString(36)}_${r}`;
}

function buildMime(args: {
  fromAddress: string;
  fromName: string;
  to: string;
  replyTo: string;
  subject: string;
  text: string;
  html: string;
  messageId: string;
  date: string;
}): string {
  const boundary = makeBoundary();
  const fromHeader = `${args.fromName} <${args.fromAddress}>`;
  const headers = [
    `From: ${fromHeader}`,
    `To: ${args.to}`,
    `Reply-To: ${args.replyTo}`,
    `Subject: ${args.subject}`,
    `Message-ID: <${args.messageId}>`,
    `Date: ${args.date}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  const body = [
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="utf-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    args.text,
    `--${boundary}`,
    'Content-Type: text/html; charset="utf-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    args.html,
    `--${boundary}--`,
    '',
  ];
  return [...headers, ...body].join('\r\n');
}

export async function sendReport(env: Env, data: ReportData): Promise<void> {
  const { subject, text, html } = renderReport(data);
  const messageId = `${crypto.randomUUID()}@${env.REPORT_FROM.split('@')[1] ?? 'aecintegrations.com'}`;
  const raw = buildMime({
    fromAddress: env.REPORT_FROM,
    fromName: env.REPORT_FROM_NAME,
    to: env.REPORT_TO,
    replyTo: env.REPORT_REPLY_TO,
    subject,
    text,
    html,
    messageId,
    date: new Date().toUTCString(),
  });
  const message = new EmailMessage(env.REPORT_FROM, env.REPORT_TO, raw);
  await env.REPORT_EMAIL.send(message);
}
