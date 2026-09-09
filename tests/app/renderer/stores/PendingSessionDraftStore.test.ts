import { createStore, mount } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import { PendingSessionDraftStore } from "../../../../src/renderer/stores/PendingSessionDraftStore";

describe("PendingSessionDraftStore", () => {
  it("owns saved-draft creation and activation lifecycle", async () => {
    const attachment = {
      kind: "image" as const,
      name: "plan.png",
      mimeType: "image/png",
      data: "image",
    };
    const staged = { text: "", attachments: [attachment] };
    const create = vi.fn(async () => true);
    const configureActivation = vi.fn();
    const store = mount(
      createStore(PendingSessionDraftStore, {
        sessionId: () => "draft-1",
        isDeferred: () => true,
        create,
        activate: () => staged,
        configureActivation,
        creationChoice: () => ({ kind: "draft" as const }),
      }),
    );

    expect(await store.create("", [attachment])).toBe(true);
    expect(create).toHaveBeenCalledWith("draft-1", "", [attachment]);
    expect(configureActivation).toHaveBeenCalledWith({ kind: "current" });
    expect(store.takeForActivation({ kind: "current" })).toEqual(staged);
    store[Symbol.dispose]();
  });

  it("owns editing and saved-draft projection independently of delivery", async () => {
    const prompt = { text: "# Plan", attachments: [] };
    const update = vi.fn(async () => true);
    const store = mount(
      createStore(PendingSessionDraftStore, {
        sessionId: () => "draft-1",
        prompt: () => prompt,
        update,
      }),
    );

    expect(store.parts()).toEqual([expect.objectContaining({ text: "# Plan", draft: true })]);
    expect(store.beginEdit("draft:draft-1")).toEqual(prompt);
    expect(store.parts()).toBeUndefined();
    expect(await store.update("Edited", [])).toBe(true);
    expect(update).toHaveBeenCalledWith("draft-1", "Edited", []);
    expect(store.editing).toBe(false);
    store[Symbol.dispose]();
  });
});
