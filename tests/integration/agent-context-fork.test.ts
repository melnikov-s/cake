import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Harness, MemoryStorage, createRegistry } from "@earendil-works/pi-durable";
import { SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { createDurableSideChats } from "../../src/services/pi-durable/durable-side-chats";
import { makeSubagentEnvironmentLive } from "../../src/layers/SubagentEnvironmentLive";
import { SubagentEnvironment } from "../../src/services/subagents/SubagentEnvironment";
import { workingDirectorySessionPath } from "../../src/services/storage/session-files";
import { projectConversationDisplay } from "../../src/services/pi/runtime/conversation-display-projection";
import { durableAnswer, durableModel, durableModels } from "../fixtures/durable-chat";

it("smoke: settled Durable context becomes private Pi history, survives reload, and never forks a human Side Chat", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cake-agent-context-"));
  const { models } = durableModels(() => durableAnswer("Retain the settled design"));
  const storage = new MemoryStorage();
  const harness = await Harness.open(storage, { models, registry: createRegistry() }, context);
  try {
    const root = await harness.root(context, {
      agent: {
        model: { provider: "fixture", modelId: "fixture" },
        instructions: "Parent coordinator instructions",
      },
    });
    await (
      await root.submit(
        { type: "input", content: "Exact source: cake://session/source?message=entry" },
        context,
      )
    ).wait(context);
    const chats = createDurableSideChats({
      root,
      harness,
      storage,
      sessionFile: join(directory, "chat.sqlite"),
      catalog: { getModel: () => durableModel },
      settings: SettingsManager.inMemory(),
      models: () => [],
      fastMode: () => false,
    });
    const inherited = await chats.taskContext();
    expect(inherited).not.toHaveProperty("sessionId");
    const sessionId = "00000000-0000-4000-8000-000000000001";
    await Effect.runPromise(
      Effect.gen(function* () {
        const environment = yield* SubagentEnvironment;
        if (!environment.seedContext) throw new Error("Missing fork capability");
        yield* environment.seedContext(directory, sessionId, inherited);
      }).pipe(
        Effect.provide(
          makeSubagentEnvironmentLive({
            homeDirectory: directory,
            agentDirectory: directory,
            sessionDirectory: join(directory, "private"),
          }),
        ),
      ),
    );
    const sessionDirectory = workingDirectorySessionPath(directory, join(directory, "private"));
    const [saved] = await SessionManager.list(directory, sessionDirectory);
    expect(saved?.id).toBe(sessionId);
    if (!saved) throw new Error("Context seed was not persisted");
    const reloaded = SessionManager.open(saved.path, sessionDirectory, directory);
    const messages = reloaded.buildSessionContext().messages;
    expect(JSON.stringify(messages)).toContain("Retain the settled design");
    expect(JSON.stringify(messages)).toContain("cake://session/source?message=entry");
    expect(messages.some((message) => message.role === "system")).toBe(false);
    // The seed is immutable history, not an accepted worker assignment or queued turn.
    expect(
      reloaded
        .getEntries()
        .some(
          (entry) => entry.type === "custom" && entry.customType === "cake.agent-context-fork/v1",
        ),
    ).toBe(true);
    const secondReload = SessionManager.open(saved.path, sessionDirectory, directory);
    expect(secondReload.buildSessionContext().messages).toEqual(messages);
    secondReload.appendMessage({
      role: "user",
      content: "Investigate the new task only",
      timestamp: 10,
    });
    const display = projectConversationDisplay(secondReload);
    expect(display.filter((part) => part.kind === "text")).toEqual([
      expect.objectContaining({ role: "user", text: "Investigate the new task only" }),
    ]);
    expect(display).toContainEqual(
      expect.objectContaining({ kind: "context", title: "Inherited context" }),
    );
    const finalReload = SessionManager.open(saved.path, sessionDirectory, directory);
    expect(finalReload.buildSessionContext().messages.slice(0, messages.length)).toEqual(messages);
    expect(projectConversationDisplay(finalReload)).toEqual(display);
  } finally {
    await harness.close(context);
    await rm(directory, { recursive: true, force: true });
  }
});
