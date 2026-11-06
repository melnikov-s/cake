/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TurnId } from "../../../src/contracts/conversations/conversation-data";
import {
  serializeModelReference,
  splitModelReferences,
} from "../../../src/contracts/model-presets/model-reference";
import type { Client } from "../../../src/renderer/client/Client";
import type { ComposerInputElement } from "../../../src/renderer/lib/composer-input-element";
import {
  configurationModel,
  configurationSnapshot,
  renderChatConfiguration,
} from "./chat-configuration-workflow-fixture";
import { queuedUserPart } from "./conversation-session-workflow-fixture";

const preset = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Sol",
  provider: "openai",
  modelId: "gpt-5",
  thinkingLevel: "high" as const,
  fastMode: true,
  prompt: "Be precise",
};
const model = {
  provider: "openai",
  modelId: "gpt-5",
  thinkingLevel: "high" as const,
  fastMode: true,
};
const input = () => screen.getByRole<ComposerInputElement>("combobox", { name: "Message" });
afterEach(cleanup);

describe("inline model reference workflow", () => {
  it("inserts a preset at selection, edits that reference with the shared picker, and never changes the session model", async () => {
    const setConfiguration = vi.fn();
    const showComposerContextMenu = vi.fn(async () => "insert-model" as const);
    using fixture = renderChatConfiguration({
      models: [configurationModel({ fastMode: true })],
      presets: [preset],
      client: {
        electron: { showComposerContextMenu },
        sessionChats: { applyConfiguration: setConfiguration },
      },
    });
    await fixture.user.type(input(), "Use this for review");
    input().setSelectionRange(4, 8);
    fireEvent.contextMenu(input(), { clientX: 10, clientY: 20 });
    const dialog = await screen.findByRole("dialog", { name: "Model reference" });
    await fixture.user.click(within(dialog).getByRole("button", { name: /Sol/ }));
    expect(fixture.chatStore.draft).toBe(
      `Use ${serializeModelReference({ ...model, preset: { id: preset.id, prompt: preset.prompt }, presetName: "Sol" })} for review`,
    );
    expect(showComposerContextMenu).toHaveBeenCalledWith(
      expect.objectContaining({ selection: "this", canInsertModel: true, canReword: true }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    await fixture.user.click(screen.getByRole("button", { name: /Edit model reference: Sol/ }));
    const edit = await screen.findByRole("dialog", { name: "Model reference" });
    await fixture.user.click(within(edit).getByRole("button", { name: "Medium" }));
    const selection = splitModelReferences(fixture.chatStore.draft).find(
      (part) => part.model,
    )?.model;
    expect(selection).toMatchObject({
      thinkingLevel: "medium",
      fastMode: true,
      preset: { id: preset.id },
      presetName: "Sol",
    });
    expect(setConfiguration).not.toHaveBeenCalled();
  });

  it("inserts an explicit model with effort and Fast, then edits just its Fast setting", async () => {
    using fixture = renderChatConfiguration({
      models: [configurationModel({ fastMode: true })],
      client: { electron: { showComposerContextMenu: async () => "insert-model" } },
    });
    fireEvent.contextMenu(input(), { clientX: 10, clientY: 20 });
    const dialog = await screen.findByRole("dialog", { name: "Model reference" });
    await fixture.user.click(within(dialog).getByRole("button", { name: "GPT-5 gpt-5" }));
    await fixture.user.click(within(dialog).getByRole("button", { name: "High" }));
    await fixture.user.click(within(dialog).getByRole("switch", { name: "Fast mode" }));
    await fixture.user.click(within(dialog).getByRole("button", { name: "Apply" }));
    expect(splitModelReferences(fixture.chatStore.draft)[0]?.model).toEqual(model);
    await fixture.user.click(screen.getByRole("button", { name: /Edit model reference/ }));
    const edit = await screen.findByRole("dialog", { name: "Model reference" });
    await fixture.user.click(within(edit).getByRole("switch", { name: "Fast mode" }));
    expect(splitModelReferences(fixture.chatStore.draft)[0]?.model).toEqual({
      ...model,
      fastMode: false,
    });
  });

  it("edits queued model-reference text in the popup without altering its serialized reference", async () => {
    const updateQueuedMessage = vi.fn<Client["sessionChats"]["updateQueuedMessage"]>(async () => ({
      steering: [],
      followUp: [],
    }));
    using fixture = renderChatConfiguration({
      models: [configurationModel()],
      client: { sessionChats: { updateQueuedMessage } },
    });
    const text = `Use ${serializeModelReference(model)} for this task.`;
    fixture.publish({
      ...configurationSnapshot("first", [configurationModel()]),
      streaming: true,
      parts: [queuedUserPart(text)],
    });
    await fixture.user.click(screen.getByRole("button", { name: /^Edit queued prompt:/ }));
    const popup = screen.getByRole("dialog", { name: "Queued message" });
    const editor = within(popup).getByRole<HTMLTextAreaElement>("textbox");
    expect(editor.value).toBe(text);
    await fixture.user.type(editor, " Revised.");
    await fixture.user.click(within(popup).getByRole("button", { name: "Save" }));
    expect(updateQueuedMessage.mock.calls[0]?.[0]).toMatchObject({ text: text + " Revised." });
    expect(input().value).toBe("");
  });
  it("keeps multiple chips and text through draft reload, failed send and retry", async () => {
    const text = `Use ${serializeModelReference(model)} then\n${serializeModelReference({ ...model, thinkingLevel: "off", fastMode: false })} for tests.`;
    const original = renderChatConfiguration({ models: [configurationModel({ fastMode: true })] });
    act(() => original.chatStore.setDraft(text));
    const saved = original.snapshot();
    original[Symbol.dispose]();
    const prompt = vi
      .fn()
      .mockRejectedValueOnce(new Error("Admission failed"))
      .mockResolvedValue(TurnId.make("00000000-0000-4000-8000-000000000002"));
    using restored = renderChatConfiguration({
      snapshot: saved,
      models: [configurationModel({ fastMode: true })],
      client: { sessionChats: { prompt } },
    });
    expect(restored.chatStore.draft).toBe(text);
    expect(screen.getAllByRole("button", { name: /Edit model reference/ })).toHaveLength(2);
    await restored.user.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByText("Admission failed");
    expect(restored.chatStore.draft).toBe(text);
    expect(input().value).toBe(text);
    await restored.user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(prompt).toHaveBeenCalledTimes(2));
    expect(prompt.mock.calls.map(([request]) => request.text)).toEqual([text, text]);
    expect(restored.chatStore.draft).toBe("");
  });
});
