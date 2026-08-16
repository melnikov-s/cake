import { describe, expect, it, vi } from "vitest";
import { KeyedSerialExecutor } from "../../../src/main/keyed-serial-executor";

describe("KeyedSerialExecutor", () => {
  it("continues a key after failure and does not block a different key", async () => {
    const executor = new KeyedSerialExecutor<string>();
    let release!: () => void;
    const first = executor.run("same", () => new Promise<void>((resolve) => { release = resolve; }));
    const second = vi.fn(async () => "second");
    const queued = executor.run("same", second);
    await expect(executor.run("other", async () => "other")).resolves.toBe("other");
    expect(second).not.toHaveBeenCalled();
    release();
    await first;
    await expect(queued).resolves.toBe("second");

    await expect(executor.run("same", async () => { throw new Error("failed"); })).rejects.toThrow("failed");
    await expect(executor.run("same", async () => "recovered")).resolves.toBe("recovered");
  });
});
