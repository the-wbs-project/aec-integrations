import type { Env } from "../types";

interface NotificationOptions {
	subject: string;
	bodyText: string;
	bodyHtml?: string;
}

export async function sendNotification(
	env: Env,
	opts: NotificationOptions,
): Promise<void> {
	if (!env.RESEND_API_KEY) {
		console.warn("Email notification skipped: Resend not configured");
		return;
	}

	const from = env.NOTIFICATION_FROM;
	const to = env.NOTIFICATION_TO;
	if (!from || !to) {
		console.warn("Email notification skipped: from/to not configured");
		return;
	}

	const res = await fetch("https://api.resend.com/emails", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${env.RESEND_API_KEY}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			from,
			to,
			reply_to: to,
			subject: opts.subject,
			text: opts.bodyText,
			html: opts.bodyHtml,
			headers: {
				"List-Unsubscribe": `<mailto:${to}>`,
			},
		}),
	});

	if (!res.ok) {
		const text = await res.text();
		throw new Error(`Resend error ${res.status}: ${text}`);
	}
}
