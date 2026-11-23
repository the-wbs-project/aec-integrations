import { describe, expect, it } from 'vitest';

import {
  formatFollowUps,
  productRetractFollowUps,
  sitemapDirtyManualCommand,
  sitemapDirtyWranglerArgs,
  vendorRetractFollowUps,
  type RetractCliTarget,
} from './retract-followups';
import { SITEMAP_DIRTY_KEY } from './sitemap-store';

const prod: RetractCliTarget = {
  label: 'production',
  flags: ['--env', 'production', '--remote'],
  remote: true,
};
const demo: RetractCliTarget = {
  label: 'demo',
  flags: ['--env', 'demo', '--remote'],
  remote: true,
};
const local: RetractCliTarget = { label: 'local', flags: ['--local'], remote: false };

describe('sitemap dirty mark (AECI-1945)', () => {
  it('writes the key markSitemapDirty writes, on the target tier', () => {
    expect(sitemapDirtyWranglerArgs(prod, '2026-11-20T00:00:00.000Z')).toEqual([
      'kv',
      'key',
      'put',
      SITEMAP_DIRTY_KEY,
      '2026-11-20T00:00:00.000Z',
      '--binding',
      'TAXONOMY_KV',
      '--env',
      'production',
      '--remote',
    ]);
    expect(sitemapDirtyWranglerArgs(local, 'x').slice(-1)).toEqual(['--local']);
  });

  it('gives the same command the "Sitemap is stale" runbook gives', () => {
    expect(sitemapDirtyManualCommand(prod)).toBe(
      'pnpm exec wrangler kv key put sitemap:dirty "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" --binding TAXONOMY_KV --env production --remote',
    );
  });
});

describe('productRetractFollowUps', () => {
  const tags = ['product:box-2', 'index:products'];

  it('lists purge, drift, counts, then upstream on production, in that order', () => {
    const steps = productRetractFollowUps({
      target: prod,
      tags,
      cacheSkipped: false,
      sitemapMarked: true,
    });
    expect(steps).toHaveLength(4);
    expect(steps[0]).toContain('POST /admin/purge  {"tags": ["product:box-2","index:products"]}');
    expect(steps[1]).toContain('db:reconcile-algolia-drift -- --env production');
    expect(steps[1]).toContain('--apply --allow-production');
    expect(steps[2]).toContain(
      'RECONCILE_ENV=production pnpm --filter @aeci/api db:reconcile-counts',
    );
    expect(steps[3]).toContain('confirm_retractions');
    expect(steps.join('\n')).not.toContain('sitemap');
  });

  it('puts the manual sitemap command first when the CLI could not mark it', () => {
    const steps = productRetractFollowUps({
      target: prod,
      tags,
      cacheSkipped: false,
      sitemapMarked: false,
    });
    expect(steps[0]).toContain(sitemapDirtyManualCommand(prod));
  });

  it('drops the purge on --skip-cache and the upstream step off production', () => {
    const steps = productRetractFollowUps({
      target: local,
      tags,
      cacheSkipped: true,
      sitemapMarked: true,
    });
    expect(steps).toHaveLength(2);
    expect(steps[0]).toContain('db:reconcile-algolia-drift -- --local');
    expect(steps[1]).toContain('db:reconcile-counts -- --local');
  });

  it('names no reconciler on demo, which neither reconciler targets', () => {
    const steps = productRetractFollowUps({
      target: demo,
      tags,
      cacheSkipped: false,
      sitemapMarked: true,
    });
    expect(steps).toHaveLength(1);
    expect(steps[0]).toContain('POST /admin/purge');
  });
});

describe('vendorRetractFollowUps', () => {
  it('lists purge on every tier, drift, then the review-app cleanup, and no counts step', () => {
    const steps = vendorRetractFollowUps({
      target: prod,
      tags: ['vendor:acme'],
      cacheSkipped: false,
      sitemapMarked: true,
    });
    expect(steps).toHaveLength(3);
    expect(steps[0]).toContain('Run it on each tier you touched');
    expect(steps[1]).toContain('db:reconcile-algolia-drift -- --env production');
    expect(steps[2]).toContain('supabase_vendor_id');
    expect(steps.join('\n')).not.toContain('reconcile-counts');
  });
});

describe('formatFollowUps', () => {
  it('numbers the steps under one heading', () => {
    expect(formatFollowUps(['a', 'b'])).toBe('Remaining follow-ups, in run order:\n  1. a\n  2. b');
    expect(formatFollowUps([])).toBe('Nothing left to do.');
  });
});
