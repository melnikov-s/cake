import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { composePresetPrompt } from "../../../src/contracts/model-presets/preset-context";
import { ModelPreset } from "../../../src/contracts/application/application-data";
import { SessionChatConfiguration } from "../../../src/contracts/conversations/conversation-data";
import { SavedDraftConfiguration } from "../../../src/contracts/project-sessions/saved-draft-data";
import { ExplicitCakeModelSelection } from "../../../src/contracts/model-presets/cake-model-selection";
import { createCakeSessionRuntimeConfigurationState } from "../../../src/services/pi/runtime/cake-session-runtime-configuration";

const first = { id: "00000000-0000-4000-8000-000000000001", prompt: "Be concise." };
const second = { id: "00000000-0000-4000-8000-000000000002", prompt: "Explain deeply." };

describe("preset context", () => {
  it("replaces inherited preset guidance for summary completions while retaining shared context", () => {
    const base = "Shared/project instructions.";
    const firstPrompt = composePresetPrompt(base, first);
    expect(composePresetPrompt(firstPrompt, first)).toBe(firstPrompt);
    const switched = composePresetPrompt(firstPrompt, second);
    expect(switched).toContain(base);
    expect(switched).toContain(second.prompt);
    expect(switched).not.toContain(first.prompt);
    expect(switched.match(/<model_preset>/g)).toHaveLength(1);
    expect(composePresetPrompt(firstPrompt, undefined).trimEnd()).toBe(base);
    expect(composePresetPrompt(base, undefined)).toBe(base);
  });
  it("decodes older presets/configurations and retains context through RPC and saved drafts", () => {
    const model = { provider: "openai", modelId: "gpt-5", thinkingLevel: "off", fastMode: false };
    expect(
      Schema.decodeUnknownSync(ModelPreset)({ ...model, id: first.id, name: "Old" }).promptFile,
    ).toBeUndefined();
    for (const schema of [
      SessionChatConfiguration,
      SavedDraftConfiguration,
      ExplicitCakeModelSelection,
    ]) {
      expect(Schema.decodeUnknownSync(schema)(model).preset).toBeUndefined();
      expect(Schema.decodeUnknownSync(schema)({ ...model, preset: first }).preset).toEqual(first);
    }
  });

  it("composes one replaceable section without changing shared/project instructions", async () => {
    const manager = SessionManager.inMemory("/project");
    const state = createCakeSessionRuntimeConfigurationState(undefined);
    state.attachSession(manager);
    type Event = { systemPromptOptions: { sections: Record<string, string> } };
    let prepare: ((event: Event) => Promise<void>) | undefined;
    const pi = {
      on: (name: string, handler: (event: Event) => Promise<void>) => {
        if (name === "before_agent_start") prepare = handler;
      },
    };
    void (state.fastModeExtension as ExtensionFactory)(pi as unknown as ExtensionAPI);
    const prompt = async () => {
      const sections = { shared: "Shared instructions.", project: "Project instructions." };
      await prepare!({ systemPromptOptions: { sections } });
      return Object.values(sections).filter(Boolean).join("\n\n");
    };
    const baseline = await prompt();
    state.setPreset(first);
    expect(await prompt()).toContain("Be concise.");
    expect(await prompt()).toContain("Shared instructions.");
    expect(await prompt()).toContain("Project instructions.");
    expect(await prompt()).toContain("shared/project instructions take precedence");
    state.setPreset(second);
    expect(await prompt()).toContain("Explain deeply.");
    expect(await prompt()).not.toContain("Be concise.");
    expect((await prompt()).match(/Preset guidance/g)).toHaveLength(1);
    const restored = createCakeSessionRuntimeConfigurationState(undefined);
    restored.attachSession(manager);
    expect(restored.preset()).toEqual(second);
    state.setPreset({ ...second, prompt: "" });
    expect(await prompt()).toBe(baseline);
    state.setPreset({ ...first, prompt: "   " });
    expect(await prompt()).toBe(baseline);
    state.setPreset(undefined);
    expect(await prompt()).toBe(baseline);
    expect(restored.preset()).toBeUndefined();
  });
});
