interface Env {
	ANALYTICS: AnalyticsEngineDataset;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		// Log the pageview to Analytics Engine (non-blocking)
		try {
			const url = new URL(request.url);
			const cf = (request as any).cf as IncomingRequestCfProperties | undefined;

			env.ANALYTICS.writeDataPoint({
				indexes: [url.pathname],
				blobs: [
					request.headers.get("referer") ?? "",
					request.headers.get("user-agent") ?? "",
					cf?.country ?? "",
					cf?.city ?? "",
					cf?.region ?? "",
					String(cf?.asOrganization ?? ""),
					String(cf?.asn ?? ""),
					url.searchParams.get("utm_source") ?? "",
					url.searchParams.get("utm_medium") ?? "",
					url.searchParams.get("utm_campaign") ?? "",
				],
				doubles: [cf?.metroCode ? Number(cf.metroCode) : 0],
			});
		} catch {
			// Analytics should never break the request
		}

		// Pass through to static assets
		return env.ASSETS.fetch(request);
	},
} satisfies ExportedHandler<Env & { ASSETS: Fetcher }>;
