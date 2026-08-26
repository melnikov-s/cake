import { z } from "zod";

/** A zero-based position in a workspace document. */
export const sourcePositionSchema = z.object({
  line: z.number().int().nonnegative().max(10_000_000),
  column: z.number().int().nonnegative().max(10_000_000).optional(),
});

/**
 * A workspace-relative source location. Ranges are inclusive by line; when an
 * end column is present it follows VS Code's exclusive-end range convention.
 */
export const sourceRangeSchema = z.object({
  start: sourcePositionSchema,
  end: sourcePositionSchema.optional(),
});

export const sourceLocationSchema = z.object({
  path: z.string().trim().min(1).max(8_192),
  range: sourceRangeSchema.optional(),
  symbol: z.string().trim().min(1).max(1_024).optional(),
  documentVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
});

export type SourcePosition = z.infer<typeof sourcePositionSchema>;
export type SourceRange = z.infer<typeof sourceRangeSchema>;
export type SourceLocation = z.infer<typeof sourceLocationSchema>;
