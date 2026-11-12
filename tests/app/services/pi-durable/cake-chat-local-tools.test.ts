import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { describe, expect, it } from "vitest";
import {
  CAKE_CHAT_BASH_DEFAULT_TIMEOUT_SECONDS,
  CAKE_CHAT_BASH_MAX_TIMEOUT_SECONDS,
  CAKE_CHAT_TOOL_OUTPUT_MAX_BYTES,
  cakeChatBashTimeout,
  createCakeChatBashTool,
  createCakeChatReadTool,
  createCakeChatMutationTools,
  createCakeChatLocalTools,
} from "../../../../src/services/pi-durable/cake-chat-local-tools";
import { cakeChatScratchDirectory } from "../../../../src/services/pi-durable/cake-chat-directories";
import {
  CAKE_CHAT_SESSION_ID,
  SESSION_ASSISTANT_ID,
} from "../../../../src/contracts/cake-chats/cake-chat-identity";

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

describe("Cake Chat mutation exposure", () => {
  it("activates native edit/write only for Global Chat; Project Chat and companion keep read/bash", () => {
    expect(createCakeChatLocalTools(CAKE_CHAT_SESSION_ID).active.map((tool) => tool.name)).toEqual([
      "read",
      "bash",
      "edit",
      "write",
    ]);
    for (const sessionId of [`project-chat:${"a".repeat(64)}`, SESSION_ASSISTANT_ID]) {
      const { active, inactive } = createCakeChatLocalTools(sessionId);
      expect(active.map((tool) => tool.name)).toEqual(["read", "bash"]);
      expect(inactive.map((tool) => tool.name)).toEqual(["edit", "write"]);
    }
  });

  it.each(["edit", "write"])(
    "rejects %s for Project Chat even if inherited declarations name it",
    async (name) => {
      const { api, calls } = fakeApi();
      const tools = createCakeChatMutationTools(`project-chat:${"a".repeat(64)}`);
      const tool = tools.find((item) => item.name === name)!;
      await expect(
        tool.execute(
          { path: "/outside/file", content: "change", edits: [{ oldText: "old", newText: "new" }] },
          api,
          BACKGROUND_CONTEXT,
        ),
      ).rejects.toThrow("Project Chat cannot edit files");
      expect(calls).toEqual([]);
    },
  );

  it.each(["edit", "write"])("rejects %s for legacy managed investigation forks", async (name) => {
    const { api, calls } = fakeApi(true);
    const tool = createCakeChatMutationTools(CAKE_CHAT_SESSION_ID).find(
      (item) => item.name === name,
    )!;
    await expect(
      tool.execute(
        {
          path: "/managed/task/file",
          content: "change",
          edits: [{ oldText: "old", newText: "new" }],
        },
        api,
        BACKGROUND_CONTEXT,
      ),
    ).rejects.toThrow("Investigation forks remain read-only");
    expect(calls).toEqual([]);
  });

  it("retains explicit task authorization, protected-file policy, and unsafe replay", () => {
    for (const tool of createCakeChatMutationTools(CAKE_CHAT_SESSION_ID)) {
      expect(tool.replay).toBe("unsafe");
      expect(tool.description).toContain("explicitly user-authorized non-project edits");
      expect(tool.description).toContain(
        "Never modify project checkouts, Cake/Pi managed settings or credentials",
      );
      expect(tool.description).toContain("not sandboxes");
    }
  });
});

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
    ).rejects.toThrow(
      "Delegate project code changes to a fresh Project Session via sessions.create",
    );
    expect(calls).toEqual([]);
    expect(() => cakeChatBashTimeout(0)).toThrow("Invalid timeout");
  });

  it("advertises task-based delegation rather than blanket context forks", () => {
    const description = createCakeChatBashTool().description;
    expect(description).toContain(
      "code changes to a fresh independent Project Session via sessions.create",
    );
    expect(description).toContain("read-only context fork via sessions.fork");
    expect(description).toContain(
      "explicitly authorized private subagent for an explicitly requested different model or unhelpful context",
    );
    expect(description).toContain("does not authorize code changes");
  });

  it("allows long investigation commands only for managed context-fork bindings", async () => {
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
