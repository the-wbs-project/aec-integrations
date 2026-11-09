/**
 * Renders the §23.1 daily data-quality results into the email digest sent to
 * the support inbox (AECI-241 / Phase 7.6). Pure: takes the check results and run
 * metadata, returns `{ subject, text, html }` — no I/O, so it unit-tests directly.
 *
 * The digest only goes out when a finding is worth reading (see
 * {@link shouldSendDataQualityDigest}). A clean run sends nothing. Liveness is
 * `job_runs` and the `aeci.data_quality.job` heartbeat, never the mail. The report
 * is **report-only** (§23.1): it never instructs remediation beyond "triage manually".
 */

import type { DataQualityCheckResult } from './data-quality';

export interface DigestOptions {
  /** Deployment env label for the subject + header (e.g. `production`). */
  env: string;
  /** When the run completed — rendered into the header. */
  generatedAt: Date;
}

export interface EmailDigest {
  subject: string;
  text: string;
  html: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Whether a run's digest is worth an email on this tier. Production sends when a
 * check found `error` or `warn` rows, or when a check failed to run. Demo sends only
 * when a check found `error` rows or failed to run: its `warn` findings repeat every
 * day and are not acted on there. Any other tier follows the production rule (staging is suppressed by
 * the registry's `envRule` anyway). `info` findings and clean runs never send. The
 * stored `job_runs` result and `/admin/system` still show every run.
 */
export function shouldSendDataQualityDigest(
  results: DataQualityCheckResult[],
  env: string,
): boolean {
  const found = (severity: DataQualityCheckResult['severity']) =>
    results.some((r) => r.error === undefined && r.count > 0 && r.severity === severity);
  const checkFailed = results.some((r) => r.error !== undefined);
  if (env === 'demo') return found('error') || checkFailed;
  return found('error') || found('warn') || checkFailed;
}

/** Sort issue checks errors-first, then by descending count, for a useful top-of-email. */
function bySeverityThenCount(a: DataQualityCheckResult, b: DataQualityCheckResult): number {
  const rank = (r: DataQualityCheckResult) =>
    r.severity === 'error' ? 0 : r.severity === 'warn' ? 1 : 2;
  return rank(a) - rank(b) || b.count - a.count;
}

export function buildDataQualityDigest(
  results: DataQualityCheckResult[],
  opts: DigestOptions,
): EmailDigest {
  const errored = results.filter((r) => r.error !== undefined);
  const withIssues = results
    .filter((r) => r.error === undefined && r.count > 0)
    .sort(bySeverityThenCount);
  const clean = results.filter((r) => r.error === undefined && r.count === 0 && !r.skipped);
  const skipped = results.filter((r) => r.error === undefined && r.skipped);
  const totalIssues = withIssues.reduce((sum, r) => sum + r.count, 0);

  const allClear = errored.length === 0 && withIssues.length === 0;
  const subject = allClear
    ? `AECi data quality (${opts.env}) — all clear`
    : `AECi data quality (${opts.env}) — ${totalIssues} issue(s) across ${withIssues.length} check(s)` +
      (errored.length > 0 ? ` + ${errored.length} check error(s)` : '');

  const summary = allClear
    ? `All ${results.length} checks clean${skipped.length ? ` (${skipped.length} skipped)` : ''}.`
    : `${totalIssues} issue(s) across ${withIssues.length} check(s)` +
      (errored.length ? `; ${errored.length} check(s) errored` : '') +
      `; ${clean.length} clean` +
      (skipped.length ? `; ${skipped.length} skipped` : '') +
      '.';

  // ── plain text ──
  const t: string[] = [
    'AECi daily data-quality report',
    `Environment: ${opts.env}`,
    `Generated: ${opts.generatedAt.toISOString()}`,
    '',
    `Summary: ${summary}`,
  ];

  if (withIssues.length > 0) {
    t.push('', '── Issues ──');
    for (const r of withIssues) {
      t.push('', `[${r.severity}] ${r.label} — ${r.count}${r.note ? ` (${r.note})` : ''}`);
      for (const line of r.sample) t.push(`  • ${line}`);
      const more = r.count - r.sample.length;
      if (more > 0) t.push(`  …and ${more} more`);
    }
  }

  if (errored.length > 0) {
    t.push('', '── Check errors ──');
    for (const r of errored) t.push(`[error] ${r.label} — failed to run: ${r.error}`);
  }

  if (clean.length > 0) {
    t.push('', '── Clean ──');
    for (const r of clean) t.push(`✓ ${r.label}`);
  }

  if (skipped.length > 0) {
    t.push('', '── Skipped ──');
    for (const r of skipped) t.push(`- ${r.label}${r.note ? ` (${r.note})` : ''}`);
  }

  t.push(
    '',
    'Report-only (§23.1): no data was modified. Triage and fix manually; the next daily run re-checks.',
  );

  // ── html ──
  const h: string[] = [
    `<h2>AECi daily data-quality report</h2>`,
    `<p><strong>Environment:</strong> ${escapeHtml(opts.env)}<br>`,
    `<strong>Generated:</strong> ${escapeHtml(opts.generatedAt.toISOString())}</p>`,
    `<p>${escapeHtml(summary)}</p>`,
  ];

  if (withIssues.length > 0) {
    h.push('<h3>Issues</h3>');
    for (const r of withIssues) {
      h.push(
        `<p><strong>[${r.severity}] ${escapeHtml(r.label)}</strong> — ${r.count}${
          r.note ? ` (${escapeHtml(r.note)})` : ''
        }</p>`,
      );
      if (r.sample.length > 0) {
        h.push('<ul>');
        for (const line of r.sample) h.push(`<li>${escapeHtml(line)}</li>`);
        const more = r.count - r.sample.length;
        if (more > 0) h.push(`<li>…and ${more} more</li>`);
        h.push('</ul>');
      }
    }
  }

  if (errored.length > 0) {
    h.push('<h3>Check errors</h3><ul>');
    for (const r of errored)
      h.push(
        `<li><strong>${escapeHtml(r.label)}</strong> — failed to run: ${escapeHtml(r.error ?? '')}</li>`,
      );
    h.push('</ul>');
  }

  if (clean.length > 0) {
    h.push('<h3>Clean</h3><ul>');
    for (const r of clean) h.push(`<li>✓ ${escapeHtml(r.label)}</li>`);
    h.push('</ul>');
  }

  if (skipped.length > 0) {
    h.push('<h3>Skipped</h3><ul>');
    for (const r of skipped)
      h.push(`<li>${escapeHtml(r.label)}${r.note ? ` (${escapeHtml(r.note)})` : ''}</li>`);
    h.push('</ul>');
  }

  h.push(
    `<p><em>Report-only (§23.1): no data was modified. Triage and fix manually; the next daily run re-checks.</em></p>`,
  );

  return { subject, text: t.join('\n'), html: h.join('\n') };
}
