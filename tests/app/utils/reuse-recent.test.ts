import { describe, expect, it } from "vitest";
import { reuseRecent } from "../../../src/utils/reuse-recent";

describe("reuseRecent", () => {
  it("shares one load within the window, including callers that arrive while it runs", async () => {
    let time = 0;
    const resolvers: Array<(value: number) => void> = [];
    const value = reuseRecent(
      60_000,
      () => new Promise<number>((resolve) => resolvers.push(resolve)),
      () => time,
    );
    const first = value();
    const concurrent = value();
    resolvers[0]?.(1);
    expect(await Promise.all([first, concurrent])).toEqual([1, 1]);
    time = 59_999;
    expect(await value()).toBe(1);
    expect(resolvers).toHaveLength(1);

    time = 60_000;
    const next = value();
    expect(resolvers).toHaveLength(2);
    resolvers[1]?.(2);
    expect(await next).toBe(2);
  });

  it("loads again immediately after a failure", async () => {
    let attempts = 0;
    const value = reuseRecent(
      60_000,
      async () => {
        attempts++;
        if (attempts === 1) throw new Error("unavailable");
        return attempts;
      },
      () => 0,
    );
    await expect(value()).rejects.toThrow("unavailable");
    expect(await value()).toBe(2);
    expect(await value()).toBe(2);
    expect(attempts).toBe(2);
  });
});
