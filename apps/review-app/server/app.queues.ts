import type { Env } from './env';
import { runVendorAutoEnrich } from './services/autoEnrich/runAutoEnrich';
import { AUTO_ENRICH_QUEUE_NAME, type AutoEnrichJob } from './services/autoEnrich/types';
import type { ReportJob } from './services/reports/types';
import { runWeeklyCostReport } from './services/reports/weeklyCostReport';

export async function APP_QUEUE(batch: MessageBatch<ReportJob | AutoEnrichJob>, env: Env): Promise<void> {
    for (const message of batch.messages) {
        try {
            if (batch.queue === AUTO_ENRICH_QUEUE_NAME) {
                const body = message.body as AutoEnrichJob;
                if (body.kind === 'vendor-auto-enrich') {
                    await runVendorAutoEnrich(env, {
                        count: body.count,
                        model: body.model,
                        triggeredBy: body.triggeredBy,
                    });
                } else {
                    console.warn(
                        `[queue:${batch.queue}] SKIPPED message id=${message.id} — unrecognized body.kind="${(body as { kind?: string })?.kind ?? '<missing>'}"`,
                    );
                }
            } else {
                const body = message.body as ReportJob;
                if (body.kind === 'weekly-cost-report') {
                    await runWeeklyCostReport(env, { lookbackDays: body.lookbackDays });
                } else {
                    console.warn(
                        `[queue:${batch.queue}] SKIPPED message id=${message.id} — unrecognized body.kind="${(body as { kind?: string })?.kind ?? '<missing>'}"`,
                    );
                }
            }
            message.ack();
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            const errStack = err instanceof Error ? err.stack : undefined;
            console.error(
                `[queue:${batch.queue}] job FAILED id=${message.id} attempts=${message.attempts}: ${errMsg}${errStack ? `\n${errStack}` : ''}`,
            );
            message.retry();
        }
    }
};
