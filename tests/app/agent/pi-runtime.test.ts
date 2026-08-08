import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCakeRuntime,
  createFoundationRuntime,
  inspectWorkspace,
  piRuntimeVersion,
  type CakeRuntime,
  type FoundationRuntime
} from "../../../src/agent/pi-runtime";

const temporaryDirectories: string[] = [];
const runtimes: Array<FoundationRuntime | CakeRuntime> = [];

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

describe("S1 Pi runtime", () => {
  it("detects project-local executable resources before loading them", async () => {
    const directory = await createTemporaryDirectory();
    await mkdir(join(directory, ".pi", "extensions"), { recursive: true });
    await writeFile(join(directory, ".pi", "extensions", "example.ts"), "export default () => {}\n");

    expect(inspectWorkspace(directory)).toEqual({ path: directory, trustRequired: true });
  });

  it("creates and reopens an authoritative persistent Pi session", async () => {
    const directory = await createTemporaryDirectory();
    const agentDir = join(directory, "agent");
    const sessionDir = join(directory, "sessions");
    const first = await createCakeRuntime({
      cwd: directory,
      agentDir,
      sessionDir,
      trusted: false,
      requestUi: async () => undefined,
      onEvent: () => undefined
    });
    runtimes.push(first);
    const firstSnapshot = await first.snapshot();

    expect(first.sessionFile).toMatch(/\.jsonl$/);
    expect(firstSnapshot.sessionId).toBe(first.sessionId);
    expect(firstSnapshot.parts).toEqual([]);
    first.dispose();
    runtimes.splice(runtimes.indexOf(first), 1);
    await mkdir(sessionDir, { recursive: true });
    const timestamp = new Date().toISOString();
    await writeFile(first.sessionFile, [
      { type: "session", version: 3, id: first.sessionId, timestamp, cwd: directory },
      { type: "message", id: "user-1", parentId: null, timestamp, message: { role: "user", content: "Hello", timestamp: Date.now() } },
      { type: "message", id: "assistant-tools", parentId: "user-1", timestamp, message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } }], api: "anthropic-messages", provider: "anthropic", model: "fixture", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: Date.now() } },
      { type: "message", id: "tool-result", parentId: "assistant-tools", timestamp, message: { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "result" }], isError: false, timestamp: Date.now() } },
      { type: "message", id: "assistant-1", parentId: "tool-result", timestamp, message: { role: "assistant", content: [{ type: "text", text: "Hi" }], api: "anthropic-messages", provider: "anthropic", model: "fixture", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() } }
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");

    const second = await createCakeRuntime({
      cwd: directory,
      agentDir,
      sessionDir,
      trusted: false,
      requestUi: async () => undefined,
      onEvent: () => undefined
    });
    runtimes.push(second);

    expect(second.sessionId).toBe(first.sessionId);
    expect(second.sessionFile).toBe(first.sessionFile);
    const reopenedParts = (await second.snapshot()).parts;
    expect(reopenedParts.some((part) => part.kind === "text" && part.text === "Hi")).toBe(true);
    expect(reopenedParts.filter((part) => part.kind === "tool")).toEqual([
      expect.objectContaining({ id: "tool-call-1", name: "read", input: expect.stringContaining("README.md"), output: "result", state: "success" })
    ]);
    expect((await second.snapshot()).tree[0]).toMatchObject({ id: "user-1", active: true });
    await second.rename("Named session");
    expect((await second.snapshot()).sessions.find((item) => item.id === second.sessionId)?.title).toBe("Named session");
    const fork = await second.fork("user-1");
    expect(fork.sessionId).not.toBe(second.sessionId);
    expect(fork.sessionFile).toMatch(/\.jsonl$/);
    await second.navigate("user-1");
    expect((await second.snapshot()).tree[0]).toMatchObject({ id: "user-1", active: true });

    const isolated = await createCakeRuntime({
      cwd: directory,
      agentDir,
      sessionDir,
      trusted: false,
      newSession: true,
      requestUi: async () => undefined,
      onEvent: () => undefined
    });
    runtimes.push(isolated);
    expect(isolated.sessionId).not.toBe(second.sessionId);
    expect((await isolated.snapshot()).parts).toEqual([]);
  });
});
