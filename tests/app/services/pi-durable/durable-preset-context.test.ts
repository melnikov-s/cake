import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, defineExtension, type Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { getCurrentSystemMessage } from "@earendil-works/pi-durable-ai/utils/transcript";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openDurableChatEngine } from "../../../../src/services/pi-durable/durable-chat-engine";
import {
  PresetContextDoc,
  presetContextSection,
} from "../../../../src/services/pi-durable/durable-preset-context";
import { durableModels } from "../../../fixtures/durable-chat";

async function fixture(storage: Storage) {
  const registry = createRegistry();
  registry.install(defineExtension({ name: "preset", sections: [presetContextSection] }));
  const models = durableModels();
  const engine = await openDurableChatEngine({
    storage,
    models: models.models,
    registry,
    agent: {
      model: { provider: "fixture", modelId: "fixture" },
      instructions: "Shared and project instructions.",
    },
    settings: { contextRetentionMs: 0 },
    memory: { budget: () => 4_000, summarize: async () => "summary" },
    onChanged() {},
    onReport() {},
  });
  return {
    engine,
    async set(preset?: { id: string; prompt?: string }) {
      await engine.root.commit(async (tx) => {
        const state = await tx.doc(PresetContextDoc, engine.root.id);
        if (preset) state.preset = preset;
        else delete state.preset;
      }, BACKGROUND_CONTEXT);
    },
    async prompt() {
      const input = await engine.root.submit(
        { type: "input", content: "Continue" },
        BACKGROUND_CONTEXT,
      );
      await input.wait(BACKGROUND_CONTEXT);
      return getCurrentSystemMessage(models.requests.at(-1)!.messages)?.sections;
    },
  };
}

it("persists selected guidance through SQLite reopen and replaces/clears it on the same model", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cake-preset-"));
  const database = join(directory, "chat.sqlite");
  let current = await fixture(await openNodeSqliteStorage(database));
  try {
    const baseline = await current.prompt();
    const first = { id: "00000000-0000-4000-8000-000000000001", prompt: "Be concise." };
    await current.set(first);
    expect((await current.prompt())?.model_preset).toContain(first.prompt);
    await current.engine.close();
    current = await fixture(await openNodeSqliteStorage(database));
    expect((await current.prompt())?.model_preset).toContain(first.prompt);
    await current.set({ id: "00000000-0000-4000-8000-000000000002", prompt: "Explain deeply." });
    const second = await current.prompt();
    expect(second?.model_preset).toContain("Explain deeply.");
    expect(second?.model_preset).not.toContain(first.prompt);
    expect(second?.instructions).toBe(baseline?.instructions);
    await current.set({ ...first, prompt: "" });
    expect(await current.prompt()).toEqual(baseline);
    await current.set();
    expect(await current.prompt()).toEqual(baseline);
  } finally {
    await current.engine.close();
    await rm(directory, { recursive: true, force: true });
  }
});
