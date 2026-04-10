import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types";
import { logPageview } from "./services/analytics";
import { subscribe } from "./services/subscribe";
import { feedback } from "./services/feedback";

const app = new Hono<{ Bindings: Env }>();

app.post("/api/subscribe", cors(), subscribe);
app.post("/api/feedback", cors(), feedback);

app.all("*", async (c) => {
	logPageview(c);
	return c.env.ASSETS.fetch(c.req.raw);
});

export default app;
