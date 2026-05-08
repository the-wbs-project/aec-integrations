import type { Env } from './env';
import type { AutoEnrichJob } from './services/autoEnrich/types';
import type { ProductAutoEnrichJob } from './services/productAutoEnrich/types';
import type { ReportJob } from './services/reports/types';
import type { SnapshotJob } from './services/snapshot/types';

export async function APP_SCHEDULED(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (event.cron === '0 14 * * 1') {
        const job: ReportJob = { kind: 'weekly-cost-report', triggeredBy: 'cron' };
        ctx.waitUntil(
            env.REPORTS_QUEUE.send(job).catch((err) =>
                console.error(`[scheduled] weekly-cost-report send FAILED: ${String(err)}`),
            ),
        );
    } else if (event.cron === '*/5 * * * *') {
        const job: AutoEnrichJob = {
            kind: 'vendor-auto-enrich',
            count: 10,
            model: 'claude-sonnet-4-6',
            triggeredBy: 'cron',
        };
        ctx.waitUntil(
            env.VENDOR_AUTO_ENRICH_QUEUE.send(job).catch((err) =>
                console.error(`[scheduled] vendor-auto-enrich send FAILED: ${String(err)}`),
            ),
        );
    } else if (event.cron === '*/12 * * * *') {
        const job: ProductAutoEnrichJob = {
            kind: 'product-auto-enrich',
            count: 5,
            model: 'claude-sonnet-4-6',
            triggeredBy: 'cron',
        };
        ctx.waitUntil(
            env.PRODUCT_AUTO_ENRICH_QUEUE.send(job).catch((err) =>
                console.error(`[scheduled] product-auto-enrich send FAILED: ${String(err)}`),
            ),
        );
    } else if (event.cron === '0 0 * * *') {
        const job: SnapshotJob = { kind: 'daily-stats-snapshot', triggeredBy: 'cron' };
        ctx.waitUntil(
            env.SNAPSHOTS_QUEUE.send(job).catch((err) =>
                console.error(`[scheduled] daily-stats-snapshot send FAILED: ${String(err)}`),
            ),
        );
    } else {
        console.warn(`[scheduled] unknown cron expression: ${event.cron}`);
    }
};
