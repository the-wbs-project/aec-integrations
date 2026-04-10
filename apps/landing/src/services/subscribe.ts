import type { Context } from "hono";
import type { Env } from "../types";

interface SubscribeBody {
	email?: string;
}

export async function subscribe(c: Context<{ Bindings: Env }>) {
	const body = await c.req.json<SubscribeBody>();
	const email = body.email?.trim().toLowerCase();

	if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
		return c.json({ error: "A valid email address is required." }, 400);
	}

	const cf = c.req.raw.cf as Record<string, unknown> | undefined;
	const url = new URL(c.req.url);

	const row = {
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

	const res = await fetch(`${c.env.SUPABASE_URL}/rest/v1/mailing_list`, {
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
		if (res.status === 409 || text.includes("duplicate") || text.includes("unique")) {
			return c.json({ error: "This email is already on the list." }, 409);
		}
		console.error("Supabase error:", res.status, text);
		return c.json({ error: "Something went wrong. Please try again." }, 500);
	}

	return c.json({ success: true }, 201);
}
