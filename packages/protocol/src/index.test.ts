import { describe, expect, it } from "vitest";
import { desktopRequestSchema, workerEventSchema } from "./index";

describe("process protocol", () => {
  it("accepts known desktop requests", () => {
    expect(desktopRequestSchema.parse({ type: "start-demo" })).toEqual({ type: "start-demo" });
  });

  it("rejects oversized worker deltas", () => {
    const result = workerEventSchema.safeParse({
      type: "text-delta",
      requestId: crypto.randomUUID(),
      text: "x".repeat(16_385)
    });

    expect(result.success).toBe(false);
  });
});
