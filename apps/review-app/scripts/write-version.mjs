// Stamp a build identifier into public/version.json so the SPA can detect
// when a new version has been deployed and prompt users to refresh.
//
// Resolution order for the version string:
//   1. CF_PAGES_COMMIT_SHA / GITHUB_SHA env vars (CI / Cloudflare Pages)
//   2. `git rev-parse --short HEAD` if a git repo is available
//   3. Fallback: current epoch ms (always changes per build)
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outFile = resolve(here, '..', 'public', 'version.json');

function resolveCommit() {
  const fromEnv = process.env.CF_PAGES_COMMIT_SHA || process.env.GITHUB_SHA;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim().slice(0, 12);
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

const builtAt = new Date().toISOString();
const commit = resolveCommit();
// Version string changes on every build (commit SHA may not, e.g. rebuild
// without a new commit), so include the build timestamp to guarantee a new
// value per deploy. Format: "<sha>-<epoch>" or just "<epoch>" if no git.
const version = commit ? `${commit}-${Date.now()}` : String(Date.now());

const payload = {
  version,
  commit,
  builtAt,
};

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify(payload, null, 2) + '\n');
console.log(`[write-version] ${outFile} → ${payload.version} (${payload.builtAt})`);
