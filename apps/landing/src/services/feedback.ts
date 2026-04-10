import type { Context } from "hono";
import type { Env } from "../types";

interface FeedbackBody {
	features?: string;
	tools?: string;
	email?: string;
	subscribe?: boolean;
}

export async function feedback(c: Context<{ Bindings: Env }>) {
	const body = await c.req.json<FeedbackBody>();
	const features = body.features?.trim() || null;
	const tools = body.tools?.trim() || null;

	if (!features && !tools) {
		return c.json({ error: "Please share at least one suggestion." }, 400);
	}

	const email = body.email?.trim().toLowerCase() || null;
	if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
		return c.json({ error: "Please enter a valid email address." }, 400);
	}

	const cf = c.req.raw.cf as Record<string, unknown> | undefined;
	const subscribe = Boolean(body.subscribe);

	const row = {
		features,
		tools,
		email,
		subscribed: subscribe,
		country: cf?.country ?? null,
		city: cf?.city ?? null,
		region: cf?.region ?? null,
		timezone: cf?.timezone ?? null,
		referrer: c.req.header("referer") ?? null,
	};

	const res = await fetch(`${c.env.SUPABASE_URL}/rest/v1/feedback`, {
		method: "POST",
		headers: {
			apikey: c.env.SUPABASE_PUBLISHABLE_KEY,
			Authorization: `Bearer ${c.env.SUPABASE_PUBLISHABLE_KEY}`,
			"Content-Type": "application/json",
			Prefer: "return=minimal",
		},
		body: JSON.stringify(row),
	});

	if (!res.ok) {
		const text = await res.text();
		console.error("Supabase error:", res.status, text);
		return c.json({ error: "Something went wrong. Please try again." }, 500);
	}

	// Also add to mailing list if they opted in and provided an email
	if (subscribe && email) {
		const url = new URL(c.req.url);
		const subRow = {
			email,
			country: cf?.country ?? null,
			city: cf?.city ?? null,
			region: cf?.region ?? null,
			timezone: cf?.timezone ?? null,
			as_organization: cf?.asOrganization ? String(cf.asOrganization) : null,
			asn: cf?.asn ? Number(cf.asn) : null,
			metro_code: cf?.metroCode ? Number(cf.metroCode) : null,
			utm_source: url.searchParams.get("utm_source") ?? null,
			utm_medium: url.searchParams.get("utm_medium") ?? null,
			utm_campaign: url.searchParams.get("utm_campaign") ?? null,
			referrer: c.req.header("referer") ?? null,
		};

		// Best-effort — don't fail the feedback submission if this errors
		await fetch(`${c.env.SUPABASE_URL}/rest/v1/mailing_list`, {
			method: "POST",
			headers: {
				apikey: c.env.SUPABASE_PUBLISHABLE_KEY,
				Authorization: `Bearer ${c.env.SUPABASE_PUBLISHABLE_KEY}`,
				"Content-Type": "application/json",
				Prefer: "return=minimal",
			},
			body: JSON.stringify(subRow),
		}).catch(() => {});
	}

	return c.json({ success: true }, 201);
}
