import type { JsonObject } from "@earendil-works/pi-durable-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  Harness,
  MemoryStorage,
  createRegistry,
  defineExtension,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import {
  getCurrentSystemMessage,
  getCurrentTools,
} from "@earendil-works/pi-durable-ai/utils/transcript";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { CAKE_CHAT_SESSION_ID } from "../../../../src/contracts/cake-chats/cake-chat-identity";
import { createCakeChatLocalTools } from "../../../../src/services/pi-durable/cake-chat-local-tools";
import { coordinatorSystemPrompt } from "../../../../src/services/pi-durable/coordinator-system-prompt";
import { readDurableOriginalPage } from "../../../../src/services/pi-durable/durable-chat-history";
import { durableAnswer, durableModels } from "../../../fixtures/durable-chat";

it("runs native read/edit/write on explicitly requested non-project files without project registration", async () => {
  // Only disposable fixture files, never a user's actual configuration.
  const directory = await mkdtemp(join(tmpdir(), "cake-nonproject-"));
  const path = join(directory, "example.conf");
  const note = join(directory, "result.txt");
  await writeFile(path, "enabled=false\nkeep=unchanged\n");
  const calls: Array<{ name: string; arguments: JsonObject }> = [
    { name: "read", arguments: { path } },
    {
      name: "edit",
      arguments: { path, edits: [{ oldText: "enabled=false", newText: "enabled=true" }] },
    },
    { name: "write", arguments: { path: note, content: "Changed only the requested option.\n" } },
    { name: "read", arguments: { path } },
  ];
  const { models, requests } = durableModels((_request, index) => {
    const call = calls[index - 1];
    return call
      ? durableAnswer("", [{ type: "toolCall", id: `call-${index}`, ...call }])
      : durableAnswer("Verified the requested files.");
  });
  const { active, inactive } = createCakeChatLocalTools(CAKE_CHAT_SESSION_ID);
  const registry = createRegistry();
  registry.install(defineExtension({ name: "local", tools: [...active, ...inactive] }));
  const context = BACKGROUND_CONTEXT;
  const harness = await Harness.open(
    new MemoryStorage(),
    {
      models,
      registry,
      env: () => new NodeExecutionEnv({ cwd: directory }),
    },
    context,
  );
  try {
    const root = await harness.root(context, {
      agent: {
        model: { provider: "fixture", modelId: "fixture" },
        tools: active,
        instructions: coordinatorSystemPrompt("", "/docs", false, "", true),
      },
    });
    const result = await (
      await root.submit(
        {
          type: "input",
          content: `Set enabled=true in ${path}, preserve keep=unchanged, and write a receipt to ${note}.`,
        },
        context,
      )
    ).wait(context);
    expect(result.status).toBe("done");
    expect(await readFile(path, "utf8")).toBe("enabled=true\nkeep=unchanged\n");
    expect(await readFile(note, "utf8")).toBe("Changed only the requested option.\n");
    expect(requests).toHaveLength(5);
    expect(getCurrentTools(requests[0]!.messages).map((tool) => tool.name)).toEqual([
      "read",
      "bash",
      "edit",
      "write",
    ]);
    expect(getCurrentSystemMessage(requests[0]!.messages)?.sections?.instructions).toContain(
      "No project registration required",
    );
    const history = await readDurableOriginalPage(root);
    const tools = history.parts.filter((part) => part.kind === "tool");
    expect(tools.map((part) => part.name)).toEqual(["read", "edit", "write", "read"]);
    expect(tools.every((part) => part.state === "success")).toBe(true);
    expect(tools.at(-1)?.output).toContain("enabled=true");
  } finally {
    await harness.close(context);
    await rm(directory, { recursive: true, force: true });
  }
});
