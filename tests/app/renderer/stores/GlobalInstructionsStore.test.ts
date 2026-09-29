import { createStore } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import { defaultApplicationState } from "../../../../src/domain/application/application-data";
import type { Client } from "../../../../src/renderer/client/Client";
import { GlobalInstructionsStore } from "../../../../src/renderer/stores/GlobalInstructionsStore";
import { mountWithClient } from "../mount-with-client";

describe("GlobalInstructionsStore", () => {
  it("loads projected instructions and saves a replacement through the workspace client", async () => {
    const setGlobalCustomInstructions = vi.fn(async () => defaultApplicationState());
    const { root, subject } = mountWithClient(createStore(GlobalInstructionsStore), {
      workspaces: { setGlobalCustomInstructions },
    } as unknown as Client);

    subject.applyApplicationState(1, {
      ...defaultApplicationState(),
      globalCustomInstructions: "Original preference",
    });
    expect(subject.instructions).toBe("Original preference");
    await subject.update("  New preference  ");
    expect(setGlobalCustomInstructions).toHaveBeenCalledWith("New preference", expect.anything());
    subject.applyApplicationState(2, {
      ...defaultApplicationState(),
      globalCustomInstructions: "New preference",
    });
    expect(subject.instructions).toBe("New preference");
    root[Symbol.dispose]();
  });
});
