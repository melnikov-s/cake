import { describe, expect, it, vi } from "vitest";
import { makeClient } from "../../../src/renderer/client/ClientLive";
import { ClientError } from "../../../src/renderer/client/Client";
import type { Runtime } from "../../../src/renderer/runtime";

function controlledRuntime(execute: Runtime["execute"]): Pick<Runtime, "execute"> {
  return { execute };
}

describe("Client", () => {
  it("exposes focused command groups without observation methods", () => {
    const runtime = controlledRuntime(vi.fn(async () => undefined) as Runtime["execute"]);
    const client = makeClient(runtime);

    expect(Object.keys(client)).toEqual([
      "application",
      "windowState",
      "models",
      "modelPresets",
      "scheduledMessages",
      "projectWorkflow",
      "projectSessions",
      "cakeChats",
      "discussionSessions",
      "subagents",
      "electron",
      "filesystem",
      "workspaces",
      "managedWorktrees",
      "terminals",
      "vscode",
      "artifacts",
      "inlineWidgets",
      "foundation",
    ]);
    expect("observe" in client.scheduledMessages).toBe(false);
    expect("observe" in client.projectSessions).toBe(false);
    expect("observe" in client.cakeChats).toBe(false);
    expect("observe" in client.discussionSessions).toBe(false);
    expect("observe" in client.subagents).toBe(false);
  });

  it("passes AbortSignal to the window runtime and reports interruption stably", async () => {
    const execute = vi.fn(async () => {
      throw new Error("fiber interrupted");
    }) as Runtime["execute"];
    const client = makeClient(controlledRuntime(execute));
    const controller = new AbortController();
    controller.abort();

    const failure = await client.foundation
      .delay({ durationMs: 10_000 }, { signal: controller.signal })
      .catch((error: unknown) => error);

    expect(execute).toHaveBeenCalledWith(expect.anything(), controller.signal);
    expect(failure).toBeInstanceOf(ClientError);
    expect(failure).toMatchObject({
      _tag: "ClientError",
      kind: "interrupted",
      operation: "foundation.delay",
      message: "The operation was cancelled",
    });
  });

  it("does not expose arbitrary command rejection values", async () => {
    const execute = vi.fn(async () => {
      throw { _tag: "ModelPresetNotFoundError", id: "missing" };
    }) as Runtime["execute"];
    const client = makeClient(controlledRuntime(execute));

    const failure = await client.modelPresets.resolve("missing").catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ClientError);
    expect(failure).toMatchObject({
      kind: "rejected",
      operation: "modelPresets.resolve",
    });
  });
});
