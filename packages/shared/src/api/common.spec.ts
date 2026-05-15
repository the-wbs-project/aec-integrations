import { describe, expect, it } from "vitest";

import {
  ApiErrorSchema,
  PaginationQuerySchema,
  SortOrderSchema,
} from "./common";

describe("ApiErrorSchema", () => {
  it("parses a minimal valid envelope", () => {
    const parsed = ApiErrorSchema.parse({
      error: { code: "NOT_FOUND", message: "Resource not found" },
      trace_id: "abc-123",
    });

    expect(parsed.error.code).toBe("NOT_FOUND");
    expect(parsed.error.message).toBe("Resource not found");
    expect(parsed.error.field).toBeUndefined();
    expect(parsed.trace_id).toBe("abc-123");
  });

  it("parses an envelope with optional field and structured details", () => {
    const parsed = ApiErrorSchema.parse({
      error: {
        code: "VALIDATION_FAILED",
        message: "Invalid input",
        field: "email",
        details: { issues: [{ path: ["email"], code: "invalid_string" }] },
      },
      trace_id: "trace-xyz",
    });

    expect(parsed.error.field).toBe("email");
    expect(parsed.error.details).toEqual({
      issues: [{ path: ["email"], code: "invalid_string" }],
    });
  });

  it("rejects when trace_id is missing", () => {
    const result = ApiErrorSchema.safeParse({
      error: { code: "INTERNAL_ERROR", message: "boom" },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("trace_id");
    }
  });

  it("rejects when error.code is not a string", () => {
    const result = ApiErrorSchema.safeParse({
      error: { code: 500, message: "boom" },
      trace_id: "t-1",
    });

    expect(result.success).toBe(false);
  });
});

describe("PaginationQuerySchema", () => {
  it("coerces string query params to numbers and applies defaults", () => {
    const parsed = PaginationQuerySchema.parse({ limit: "5" });
    expect(parsed.limit).toBe(5);
    expect(parsed.offset).toBe(0);
  });

  it("rejects limit > 100", () => {
    const result = PaginationQuerySchema.safeParse({ limit: 200 });
    expect(result.success).toBe(false);
  });

  it("rejects negative offset", () => {
    const result = PaginationQuerySchema.safeParse({ offset: -1 });
    expect(result.success).toBe(false);
  });
});

describe("SortOrderSchema", () => {
  it("accepts asc and desc", () => {
    expect(SortOrderSchema.parse("asc")).toBe("asc");
    expect(SortOrderSchema.parse("desc")).toBe("desc");
  });

  it("rejects other values", () => {
    expect(SortOrderSchema.safeParse("DESC").success).toBe(false);
  });
});
