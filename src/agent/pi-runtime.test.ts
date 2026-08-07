import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFoundationRuntime, piRuntimeVersion, type FoundationRuntime } from "./pi-runtime";

const temporaryDirectories: string[] = [];
const runtimes: FoundationRuntime[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) runtime.dispose();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createTemporaryDirectory() {
  const path = await mkdtemp(join(tmpdir(), "cake-pi-runtime-"));
  temporaryDirectories.push(path);
  return path;
}

describe("Pi 0.84.0 foundation contract", () => {
  it("creates an in-memory session, binds extension UI, and projects session events", async () => {
    const directory = await createTemporaryDirectory();
    const requestConfirm = vi.fn(async () => true);
    const events: Array<{ type: string; text?: string; sessionId?: string }> = [];
    const runtime = await createFoundationRuntime({
      cwd: directory,
      agentDir: join(directory, "agent"),
      requestConfirm,
      onEvent: (event) => events.push(event)
    });
    runtimes.push(runtime);

    expect(piRuntimeVersion).toBe("0.84.0");
    expect(runtime.sessionFile).toBeUndefined();
    expect(runtime.sessionId).toBeTruthy();

    await runtime.run();

    expect(requestConfirm).toHaveBeenCalledWith(
      "Pi extension confirmation",
      expect.stringContaining("Pi extension"),
      undefined
    );
    expect(events.find((event) => event.type === "session-ready")?.sessionId).toBe(runtime.sessionId);
    expect(events.filter((event) => event.type === "text-delta").map((event) => event.text).join(""))
      .toBe("Pi session boundary is alive.");
  });

  it("disposes idempotently and rejects later runs", async () => {
    const directory = await createTemporaryDirectory();
    const runtime = await createFoundationRuntime({
      cwd: directory,
      agentDir: join(directory, "agent"),
      requestConfirm: async () => false,
      onEvent: () => undefined
    });

    runtime.dispose();
    runtime.dispose();

    await expect(runtime.run()).rejects.toThrow("disposed");
  });
});
