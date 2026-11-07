import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { describe, expect, it } from "vitest";
import {
  CAKE_CHAT_BASH_DEFAULT_TIMEOUT_SECONDS,
  CAKE_CHAT_BASH_MAX_TIMEOUT_SECONDS,
  CAKE_CHAT_TOOL_OUTPUT_MAX_BYTES,
  cakeChatBashTimeout,
  cakeChatScratchDirectory,
  createCakeChatBashTool,
  createCakeChatReadTool,
} from "../../../../src/services/pi-durable/cake-chat-local-tools";

function fakeApi(task = false) {
  const calls: Array<{ command: unknown; cwd?: string; timeout?: number }> = [];
  const env = {
    cwd: "/scratch",
    exec: async (command: unknown, options?: { cwd?: string; timeout?: number }) => {
      calls.push({ command, cwd: options?.cwd, timeout: options?.timeout });
      return { ok: true, value: { exitCode: 0 } };
    },
  } as unknown as ExecutionEnv;
  const api = {
    env,
    snapshot: async () => (task ? { workingDirectory: "/managed/task" } : undefined),
    output: () => undefined,
    outputWindow: undefined,
    retainedOutput: () => [],
    diagnostic: () => undefined,
  } as unknown as Parameters<ReturnType<typeof createCakeChatBashTool>["execute"]>[1];
  return { api, calls };
}

describe("Cake Chat bash guards", () => {
  it("applies a short default timeout when the model omits one", async () => {
    const { api, calls } = fakeApi();
    await createCakeChatBashTool().execute({ command: "git log -1" }, api, BACKGROUND_CONTEXT);
    expect(calls).toEqual([
      { command: "git log -1", cwd: "/scratch", timeout: CAKE_CHAT_BASH_DEFAULT_TIMEOUT_SECONDS },
    ]);
  });

  it("keeps an explicit timeout within the ceiling", async () => {
    const { api, calls } = fakeApi();
    await createCakeChatBashTool().execute(
      { command: "gh pr view", timeout: 90 },
      api,
      BACKGROUND_CONTEXT,
    );
    expect(calls[0]?.timeout).toBe(90);
  });

  it("rejects longer timeouts and points at delegation without running the command", async () => {
    const { api, calls } = fakeApi();
    await expect(
      createCakeChatBashTool().execute(
        { command: "pnpm test", timeout: CAKE_CHAT_BASH_MAX_TIMEOUT_SECONDS + 1 },
        api,
        BACKGROUND_CONTEXT,
      ),
    ).rejects.toThrow("Delegate longer work to a context-forked Side Session");
    expect(calls).toEqual([]);
    expect(() => cakeChatBashTimeout(0)).toThrow("Invalid timeout");
  });

  it("allows long verification commands only for task Side Session bindings", async () => {
    const { api, calls } = fakeApi(true);
    await createCakeChatBashTool().execute(
      { command: "pnpm test", timeout: 600 },
      api,
      BACKGROUND_CONTEXT,
    );
    expect(calls[0]?.timeout).toBe(600);
  });

  it("caps model-visible output to a tail window", () => {
    expect(createCakeChatBashTool().outputLimits).toEqual({
      maxBytes: CAKE_CHAT_TOOL_OUTPUT_MAX_BYTES,
      maxLines: 400,
      retain: "tail",
    });
  });

  it("locates Cake Chat's neutral scratch directory", () => {
    const scratch = cakeChatScratchDirectory("/home/me/.cake/pi/global-chat");
    expect(scratch).toBe("/home/me/.cake/pi/global-chat/scratch");
  });

  it("lets interrupted reads replay but never reruns an interrupted command", () => {
    expect(createCakeChatReadTool().replay).toBe("safe");
    expect(createCakeChatBashTool().replay).toBe("unsafe");
  });
});
