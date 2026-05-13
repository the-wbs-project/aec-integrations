import { PrismaClient } from "@prisma/client/edge";
import { withAccelerate } from "@prisma/extension-accelerate";
import { Hono } from "hono";

type Env = {
  ASSETS: Fetcher;
  DATABASE_URL: string;
};

type RowInput = {
  email?: unknown;
  country?: unknown;
  city?: unknown;
  region?: unknown;
};

class InputError extends Error {}

const app = new Hono<{ Bindings: Env }>();

function getPrisma(env: Env) {
  return new PrismaClient({
    datasourceUrl: env.DATABASE_URL,
  }).$extends(withAccelerate());
}

type AcceleratedPrisma = ReturnType<typeof getPrisma>;

async function withPrisma(
  env: Env,
  handler: (prisma: AcceleratedPrisma) => Promise<Response>,
) {
  const prisma = getPrisma(env);
  return handler(prisma);
}

function json(data: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");

  return new Response(
    JSON.stringify(data, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value,
    ),
    {
      ...init,
      headers,
    },
  );
}

function badRequest(message: string) {
  return json({ error: message }, { status: 400 });
}

function notFound(message = "Row not found") {
  return json({ error: message }, { status: 404 });
}

function parseId(value: string) {
  try {
    const id = BigInt(value);
    return id > 0n ? id : null;
  } catch {
    return null;
  }
}

function normalizeText(value: unknown, field: string, maxLength = 255) {
  if (typeof value !== "string") {
    throw new InputError(`${field} must be text`);
  }

  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new InputError(`${field} must be ${maxLength} characters or fewer`);
  }

  return trimmed.length > 0 ? trimmed : null;
}

function normalizeEmail(value: unknown) {
  const email = normalizeText(value, "email", 320);
  if (!email) {
    throw new InputError("Email is required");
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new InputError("Email must be valid");
  }

  return email.toLowerCase();
}

async function readInput(request: Request) {
  try {
    return (await request.json()) as RowInput;
  } catch {
    throw new InputError("Request body must be valid JSON");
  }
}

function createData(input: RowInput) {
  return {
    email: normalizeEmail(input.email),
    country: normalizeText(input.country ?? "", "country"),
    city: normalizeText(input.city ?? "", "city"),
    region: normalizeText(input.region ?? "", "region"),
  };
}

function updateData(input: RowInput) {
  const data: {
    email?: string;
    country?: string | null;
    city?: string | null;
    region?: string | null;
  } = {};

  if (Object.hasOwn(input, "email")) {
    data.email = normalizeEmail(input.email);
  }
  if (Object.hasOwn(input, "country")) {
    data.country = normalizeText(input.country, "country");
  }
  if (Object.hasOwn(input, "city")) {
    data.city = normalizeText(input.city, "city");
  }
  if (Object.hasOwn(input, "region")) {
    data.region = normalizeText(input.region, "region");
  }

  return data;
}

function errorResponse(error: unknown) {
  if (error instanceof InputError) {
    return badRequest(error.message);
  }

  if (error instanceof Error) {
    if (error.message.includes("Unique constraint failed")) {
      return json({ error: "That email is already on the mailing list" }, { status: 409 });
    }

    if (
      error.message.includes("Record to update not found") ||
      error.message.includes("Record to delete does not exist")
    ) {
      return notFound();
    }

    return json({ error: error.message }, { status: 500 });
  }

  return json({ error: "Unexpected error" }, { status: 500 });
}

app.get("/api/rows", (c) =>
  withPrisma(c.env, async (prisma) => {
    const rows = await prisma.mailingList.findMany({
      orderBy: { createdAt: "desc" },
      take: 100,
    });

    return json({ rows });
  }),
);

app.get("/api/prisma-now", (c) =>
  withPrisma(c.env, async (prisma) => {
    const started = performance.now();

    try {
      const rows = await prisma.$queryRaw<{ now: Date }[]>`SELECT NOW()`;
      const latencyMs = Math.round(performance.now() - started);

      console.log(`Prisma SELECT NOW() latency: ${latencyMs}ms`);

      return json({
        ok: true,
        latencyMs,
        result: rows[0] ?? null,
      });
    } catch (error) {
      const latencyMs = Math.round(performance.now() - started);
      console.error(`Prisma SELECT NOW() failed after ${latencyMs}ms`, error);

      return json(
        {
          ok: false,
          latencyMs,
          error: error instanceof Error ? error.message : "Unexpected error",
        },
        { status: 500 },
      );
    }
  }),
);

app.get("/api/rows/:id", (c) =>
  withPrisma(c.env, async (prisma) => {
    const id = parseId(c.req.param("id"));
    if (!id) {
      return badRequest("ID must be a positive integer");
    }

    const row = await prisma.mailingList.findUnique({ where: { id } });
    return row ? json({ row }) : notFound();
  }),
);

app.post("/api/rows", (c) =>
  withPrisma(c.env, async (prisma) => {
    try {
      const input = await readInput(c.req.raw);
      const row = await prisma.mailingList.create({ data: createData(input) });
      return json({ row }, { status: 201 });
    } catch (error) {
      return errorResponse(error);
    }
  }),
);

app.patch("/api/rows/:id", (c) =>
  withPrisma(c.env, async (prisma) => {
    const id = parseId(c.req.param("id"));
    if (!id) {
      return badRequest("ID must be a positive integer");
    }

    try {
      const input = await readInput(c.req.raw);
      const data = updateData(input);

      if (Object.keys(data).length === 0) {
        return badRequest("At least one editable field is required");
      }

      const row = await prisma.mailingList.update({
        where: { id },
        data,
      });

      return json({ row });
    } catch (error) {
      return errorResponse(error);
    }
  }),
);

app.delete("/api/rows/:id", (c) =>
  withPrisma(c.env, async (prisma) => {
    const id = parseId(c.req.param("id"));
    if (!id) {
      return badRequest("ID must be a positive integer");
    }

    try {
      const row = await prisma.mailingList.delete({ where: { id } });
      return json({ row });
    } catch (error) {
      return errorResponse(error);
    }
  }),
);

app.all("/api/*", () => notFound("API route not found"));

app.all("*", async (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
