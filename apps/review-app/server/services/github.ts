// ---------------------------------------------------------------------------
// GitHub REST client — used by V02 (vendor GitHub enrichment) to verify an
// org and aggregate repo statistics.
// ---------------------------------------------------------------------------
import type { Env } from '../env';

const API = 'https://api.github.com';
const API_VERSION = '2022-11-28';

export interface GithubOrg {
  login: string;
  blog?: string;
  html_url: string;
}

export interface GithubRepo {
  name: string;
  description: string | null;
  html_url: string;
  stargazers_count: number;
  pushed_at: string;
  archived: boolean;
  fork: boolean;
}

function authHeaders(env: Env): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': API_VERSION,
    'User-Agent': 'aeci-review',
  };
  if (env.GITHUB_TOKEN) headers['Authorization'] = `Bearer ${env.GITHUB_TOKEN}`;
  return headers;
}

export async function getOrg(env: Env, login: string): Promise<GithubOrg | null> {
  const res = await fetch(`${API}/orgs/${encodeURIComponent(login)}`, { headers: authHeaders(env) });
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text().catch(() => '<unreadable>');
    throw new Error(`GitHub getOrg(${login}) failed: ${res.status} ${body}`);
  }
  return (await res.json()) as GithubOrg;
}

export async function listOrgRepos(env: Env, login: string, maxPages = 5): Promise<GithubRepo[]> {
  const repos: GithubRepo[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const url = `${API}/orgs/${encodeURIComponent(login)}/repos?per_page=100&page=${page}&type=public`;
    const res = await fetch(url, { headers: authHeaders(env) });
    if (!res.ok) {
      const body = await res.text().catch(() => '<unreadable>');
      throw new Error(`GitHub listOrgRepos(${login}) page=${page} failed: ${res.status} ${body}`);
    }
    const page_repos = (await res.json()) as GithubRepo[];
    if (page_repos.length === 0) break;
    repos.push(...page_repos);
    if (page_repos.length < 100) break;
  }
  return repos;
}
