/**
 * The datatool single-page UI — inline HTML served from the Worker. Two panels
 * (Copy, Seed reviews) plus a standalone Reindex control, a dry-run-first flow,
 * typed confirmation, and a production double-confirm. The client script is
 * nonce'd (CSP in index.ts) and deliberately uses no template literals so the
 * ONLY interpolation in this module is `${nonce}`.
 */

import { ENV_IDS } from './targets';

function envOptions(selected: string): string {
  return ENV_IDS.map(
    (e) => `<option value="${e}"${e === selected ? ' selected' : ''}>${e}</option>`,
  ).join('');
}

export function renderUi(nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AECi datatool</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif; color: #1c1917; background: #fafaf9; }
  header { padding: 16px 24px; border-bottom: 1px solid #e7e5e4; background: #fff; }
  header h1 { margin: 0; font-size: 18px; }
  header p { margin: 4px 0 0; color: #78716c; font-size: 13px; }
  main { max-width: 880px; margin: 0 auto; padding: 24px; display: grid; gap: 20px; }
  section { background: #fff; border: 1px solid #e7e5e4; border-radius: 10px; padding: 20px; }
  section h2 { margin: 0 0 14px; font-size: 15px; }
  .row { display: flex; flex-wrap: wrap; gap: 12px; align-items: end; margin-bottom: 12px; }
  label { display: block; font-size: 12px; color: #57534e; margin-bottom: 4px; font-weight: 600; }
  select, input[type=text], input[type=number] { padding: 8px 10px; border: 1px solid #d6d3d1; border-radius: 6px; font: inherit; background: #fff; }
  input[type=text] { min-width: 200px; }
  button { padding: 8px 14px; border: 1px solid #d6d3d1; border-radius: 6px; background: #fff; font: inherit; font-weight: 600; cursor: pointer; }
  button:hover { background: #f5f5f4; }
  button.primary { background: #1c1917; color: #fff; border-color: #1c1917; }
  button.danger { background: #b91c1c; color: #fff; border-color: #b91c1c; }
  .confirm { background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 12px; margin: 12px 0; }
  .hint { font-family: ui-monospace, monospace; font-size: 12px; color: #92400e; }
  pre { background: #1c1917; color: #e7e5e4; padding: 14px; border-radius: 8px; overflow: auto; font-size: 12px; max-height: 360px; margin: 12px 0 0; }
  .muted { color: #78716c; font-size: 13px; }
  .checkline { display: flex; align-items: center; gap: 6px; }
  .checkline label { margin: 0; font-weight: 400; color: #1c1917; }
</style>
</head>
<body>
<header>
  <h1>AECi datatool</h1>
  <p>Internal — clone D1 data env→env, seed reviews, reindex search. Behind Cloudflare Access. Writes are dry-run by default.</p>
</header>
<main>
  <section>
    <h2>Auth</h2>
    <div class="row">
      <div>
        <label for="token">Tool token (optional — only needed outside Access, e.g. local dev / curl)</label>
        <input type="text" id="token" placeholder="leave blank when using Cloudflare Access" autocomplete="off">
      </div>
    </div>
  </section>

  <section>
    <h2>Copy data (full clone → replace)</h2>
    <p class="muted">Makes the destination an exact mirror of the source — every table, including reviews/auth/analytics. Destructive on the destination.</p>
    <div class="row">
      <div><label for="copy-source">Source</label><select id="copy-source">${envOptions('preview')}</select></div>
      <div><label for="copy-dest">Destination</label><select id="copy-dest">${envOptions('staging')}</select></div>
      <button id="copy-dry" class="primary">Dry run</button>
    </div>
    <div class="confirm">
      <label for="copy-confirm">Type the destination DB name to execute: <span class="hint" id="copy-confirm-hint"></span></label>
      <input type="text" id="copy-confirm" placeholder="aeci-app-…" autocomplete="off">
      <div class="checkline" id="copy-prod-wrap" style="display:none; margin-top:8px;">
        <input type="checkbox" id="copy-prod"><label for="copy-prod">I understand this overwrites PRODUCTION</label>
      </div>
      <div class="checkline" style="margin-top:8px;">
        <input type="checkbox" id="copy-refresh" checked><label for="copy-refresh">Reindex search + purge cache after</label>
      </div>
      <div style="margin-top:10px;"><button id="copy-exec" class="danger">Execute copy</button></div>
    </div>
    <pre id="copy-out">No run yet.</pre>
  </section>

  <section>
    <h2>Seed reviews</h2>
    <p class="muted">Generate ~150–200 deterministic anonymous reviews against the target's products. Idempotent (re-runs replace the seeded set).</p>
    <div class="row">
      <div><label for="seed-target">Target</label><select id="seed-target">${envOptions('staging')}</select></div>
      <div><label for="seed-seed">Seed</label><input type="number" id="seed-seed" value="24301"></div>
      <div class="checkline"><input type="radio" name="seed-action" value="apply" id="seed-apply-r" checked><label for="seed-apply-r">Apply</label></div>
      <div class="checkline"><input type="radio" name="seed-action" value="teardown" id="seed-teardown-r"><label for="seed-teardown-r">Teardown</label></div>
      <button id="seed-dry" class="primary">Dry run</button>
    </div>
    <div class="confirm">
      <label for="seed-confirm">Type the target DB name to execute: <span class="hint" id="seed-confirm-hint"></span></label>
      <input type="text" id="seed-confirm" placeholder="aeci-app-…" autocomplete="off">
      <div class="checkline" id="seed-prod-wrap" style="display:none; margin-top:8px;">
        <input type="checkbox" id="seed-prod"><label for="seed-prod">I understand this targets PRODUCTION</label>
      </div>
      <div class="checkline" style="margin-top:8px;">
        <input type="checkbox" id="seed-refresh" checked><label for="seed-refresh">Reindex search + purge cache after</label>
      </div>
      <div style="margin-top:10px;"><button id="seed-exec" class="danger">Execute</button></div>
    </div>
    <pre id="seed-out">No run yet.</pre>
  </section>

  <section>
    <h2>Prune orphaned integrations</h2>
    <p class="muted">Delete <strong>stranded</strong> integration rows (+ their claims/attestations) that no Airtable record points at — they surface as duplicate mechanism cards on the public pair pages. Paste the ids from the ops runbook's <code>orphan-ids.txt</code>. Three guards run first and <strong>block</strong> the delete unless all read zero — a tripped guard can be overridden only by acknowledging it by name with a reason, which the dry run will offer below. Recomputes <code>integration_count</code> and reindexes automatically.</p>
    <div class="row">
      <div><label for="prune-target">Target</label><select id="prune-target">${envOptions('staging')}</select></div>
      <button id="prune-dry" class="primary">Dry run</button>
    </div>
    <div class="row" style="display:block;">
      <label for="prune-ids">Integration ids (one per line, or comma separated)</label>
      <textarea id="prune-ids" rows="6" style="width:100%; padding:8px 10px; border:1px solid #d6d3d1; border-radius:6px; font:12px/1.5 ui-monospace, monospace;" placeholder="0399b4ba-7881-414a-9b6e-6189043e71df&#10;1aafcfd0-e0d9-450f-af04-d5c2dd92c90a"></textarea>
    </div>
    <div class="confirm">
      <p class="muted" style="margin:0 0 8px;"><strong>Save <code>rollbackSql</code> from the dry run before executing.</strong> D1 has no undo and this Worker cannot write files.</p>
      <label for="prune-confirm">Type the target DB name to execute: <span class="hint" id="prune-confirm-hint"></span></label>
      <input type="text" id="prune-confirm" placeholder="aeci-app-…" autocomplete="off">
      <div class="checkline" id="prune-prod-wrap" style="display:none; margin-top:8px;">
        <input type="checkbox" id="prune-prod"><label for="prune-prod">I understand this deletes from PRODUCTION</label>
      </div>
      <div id="prune-ack-wrap" style="display:none; margin-top:8px;">
        <p class="muted" style="margin:0 0 6px;"><strong>Guards tripped — these rows are not redundant copies.</strong> Stop unless an editorial ruling has retracted the content. To proceed, tick every tripped guard and record why.</p>
        <div id="prune-ack-guards"></div>
        <label for="prune-ack-reason" style="margin-top:8px;">Reason (logged with your identity — a prune writes no <code>audit_log</code> row, so this is the only record)</label>
        <textarea id="prune-ack-reason" rows="3" style="width:100%; padding:8px 10px; border:1px solid #d6d3d1; border-radius:6px; font:12px/1.5 ui-monospace, monospace;" placeholder="AECI-593: curator ruled 2026-08-09 that the bar is a purpose-built mechanism; both edges deleted in Airtable."></textarea>
      </div>
      <div class="checkline" style="margin-top:8px;">
        <input type="checkbox" id="prune-refresh" checked><label for="prune-refresh">Reindex search + purge cache after</label>
      </div>
      <div style="margin-top:10px;"><button id="prune-exec" class="danger">Execute prune</button></div>
    </div>
    <pre id="prune-out">No run yet.</pre>
  </section>

  <section>
    <h2>Reindex search (no data change)</h2>
    <p class="muted">Rebuild a target env's Algolia indexes from its current D1 (clear + repopulate, promoted-only) and purge its cache. Use after a CLI seed or to recover a drifted index.</p>
    <div class="row">
      <div><label for="reindex-target">Target</label><select id="reindex-target">${envOptions('staging')}</select></div>
      <button id="reindex-run" class="primary">Reindex now</button>
    </div>
    <pre id="reindex-out">No run yet.</pre>
  </section>
</main>

<script nonce="${nonce}">
function $(id){ return document.getElementById(id); }
function tokenHeaders(){ var t = $('token').value.trim(); return t ? { 'Authorization': 'Bearer ' + t } : {}; }
function show(id, obj){ $(id).textContent = (typeof obj === 'string') ? obj : JSON.stringify(obj, null, 2); }
async function post(path, body, outId){
  show(outId, 'Running…');
  try {
    var res = await fetch(path, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, tokenHeaders()), body: JSON.stringify(body) });
    var json = await res.json();
    show(outId, json);
    return json;
  } catch (e) { show(outId, 'Request failed: ' + e); return null; }
}
function dbName(env){ return 'aeci-app-' + env; }
function sync(){
  $('copy-confirm-hint').textContent = dbName($('copy-dest').value);
  $('seed-confirm-hint').textContent = dbName($('seed-target').value);
  $('prune-confirm-hint').textContent = dbName($('prune-target').value);
  $('copy-prod-wrap').style.display = ($('copy-dest').value === 'production') ? 'flex' : 'none';
  $('seed-prod-wrap').style.display = ($('seed-target').value === 'production') ? 'flex' : 'none';
  $('prune-prod-wrap').style.display = ($('prune-target').value === 'production') ? 'flex' : 'none';
}
function seedAction(){ return document.querySelector('input[name=seed-action]:checked').value; }
function seedVal(){ var v = parseInt($('seed-seed').value, 10); return isNaN(v) ? undefined : v; }
function copyDry(){ return post('/api/copy', { source: $('copy-source').value, dest: $('copy-dest').value, dryRun: true }, 'copy-out'); }
function copyExec(){ return post('/api/copy', { source: $('copy-source').value, dest: $('copy-dest').value, dryRun: false, confirmName: $('copy-confirm').value, prodConfirm: $('copy-prod').checked, refresh: $('copy-refresh').checked }, 'copy-out'); }
function seedDry(){ return post('/api/seed', { target: $('seed-target').value, action: seedAction(), seed: seedVal(), dryRun: true }, 'seed-out'); }
function seedExec(){ return post('/api/seed', { target: $('seed-target').value, action: seedAction(), seed: seedVal(), dryRun: false, confirmName: $('seed-confirm').value, prodConfirm: $('seed-prod').checked, refresh: $('seed-refresh').checked }, 'seed-out'); }
function reindexRun(){ return post('/api/reindex', { target: $('reindex-target').value }, 'reindex-out'); }
// The acknowledgment UI is driven BY the dry run: you cannot tick a guard the plan
// did not report, which is the browser-side half of the route's exact-match rule.
function pruneRenderAck(json){
  var wrap = $('prune-ack-wrap'), host = $('prune-ack-guards');
  var blocked = (json && json.blocked) || [], guards = (json && json.guards) || {};
  host.textContent = '';
  if (!blocked.length) { wrap.style.display = 'none'; return; }
  blocked.forEach(function(g){
    var line = document.createElement('div'); line.className = 'checkline';
    var cb = document.createElement('input');
    cb.type = 'checkbox'; cb.id = 'prune-ack-' + g; cb.setAttribute('data-guard', g);
    var lb = document.createElement('label');
    lb.htmlFor = cb.id; lb.textContent = 'Acknowledge ' + g + ' (' + (guards[g] || 0) + ')';
    line.appendChild(cb); line.appendChild(lb); host.appendChild(line);
  });
  wrap.style.display = 'block';
}
function pruneAck(){
  return Array.prototype.slice.call(document.querySelectorAll('#prune-ack-guards input[type=checkbox]'))
    .filter(function(cb){ return cb.checked; })
    .map(function(cb){ return cb.getAttribute('data-guard'); });
}
async function pruneDry(){
  pruneRenderAck(await post('/api/prune-integrations', { target: $('prune-target').value, ids: $('prune-ids').value, dryRun: true }, 'prune-out'));
}
function pruneExec(){
  var body = { target: $('prune-target').value, ids: $('prune-ids').value, dryRun: false, confirmName: $('prune-confirm').value, prodConfirm: $('prune-prod').checked, refresh: $('prune-refresh').checked };
  var ack = pruneAck();
  if (ack.length) { body.acknowledgeGuards = ack; body.acknowledgeReason = $('prune-ack-reason').value; }
  return post('/api/prune-integrations', body, 'prune-out');
}
document.addEventListener('DOMContentLoaded', function(){
  $('copy-dry').onclick = copyDry; $('copy-exec').onclick = copyExec;
  $('seed-dry').onclick = seedDry; $('seed-exec').onclick = seedExec;
  $('reindex-run').onclick = reindexRun;
  $('prune-dry').onclick = pruneDry; $('prune-exec').onclick = pruneExec;
  $('copy-dest').onchange = sync; $('seed-target').onchange = sync; $('prune-target').onchange = sync;
  sync();
});
</script>
</body>
</html>`;
}
