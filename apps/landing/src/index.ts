import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types";
import { logPageview } from "./services/analytics";
import { subscribe } from "./services/subscribe";

const app = new Hono<{ Bindings: Env }>();

// Security and cache headers
app.use("*", async (c, next) => {
	await next();
	c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
	c.header("X-Content-Type-Options", "nosniff");
	c.header("X-Frame-Options", "DENY");
	c.header("Referrer-Policy", "strict-origin-when-cross-origin");
	c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");

	const path = new URL(c.req.url).pathname;
	const isStatic =
		path.startsWith("/assets/") ||
		path === "/robots.txt" ||
		path === "/sitemap.xml" ||
		path === "/manifest.json" ||
		path === "/favicon-i.svg" ||
		path === "/favicon-i.ico";

	if (isStatic) {
		c.header("Cache-Control", "public, max-age=86400");
	} else {
		c.header("Cache-Control", "no-cache");
	}
});

app.post("/api/subscribe", cors(), subscribe);

app.all("*", async (c) => {
	logPageview(c);
	return c.env.ASSETS.fetch(c.req.raw);
});

export default app;
