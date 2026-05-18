import { z } from 'zod';

/**
 * Canonical error envelope returned by the API Worker for every non-2xx
 * response. Defined in docs/API_CONTRACTS.md §3.3. The Phase 2 centralized
 * error middleware will produce values that satisfy this schema; consumers
 * (SSR Worker) parse against it when they need runtime-safe error handling.
 */
export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    field: z.string().optional(),
    details: z.unknown().optional(),
  }),
  trace_id: z.string(),
});

export type ApiError = z.infer<typeof ApiErrorSchema>;

/**
 * Common pagination query — every list endpoint accepts these as query params.
 * `z.coerce.number()` lets endpoints feed `URLSearchParams` directly without
 * pre-parsing. See docs/API_CONTRACTS.md §3.1.
 */
export const PaginationQuerySchema = z.object({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;

export type PaginatedResponse<T> = {
  data: T[];
  total: number;
  offset: number;
  limit: number;
};

export const SortOrderSchema = z.enum(['asc', 'desc']);
export type SortOrder = z.infer<typeof SortOrderSchema>;
