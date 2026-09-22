import { createStore } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import { defaultApplicationState } from "../../../../src/domain/application/application-data";
import { defaultCakePrompts } from "../../../../src/domain/application/cake-prompts";
import type { Client } from "../../../../src/renderer/client/Client";
import { CakePromptSettingsStore } from "../../../../src/renderer/stores/CakePromptSettingsStore";
import { mountWithClient } from "../mount-with-client";

function mountPrompts(setCakePrompts: Client["workspaces"]["setCakePrompts"]) {
  return mountWithClient(createStore(CakePromptSettingsStore), {
    workspaces: { setCakePrompts },
  } as unknown as Client);
}

describe("CakePromptSettingsStore", () => {
  it("persists an edited prompt and accepts the authoritative application projection", async () => {
    const defaults = defaultCakePrompts();
    const next = { ...defaults, worktreeCommit: "Commit {{target}} now." };
    const setCakePrompts = vi.fn(async () => ({ ...defaultApplicationState(), cakePrompts: next }));
    const { root, subject: store } = mountPrompts(setCakePrompts);
    store.applyApplicationState(1, defaultApplicationState());

    await store.update("worktreeCommit", next.worktreeCommit);
    expect(setCakePrompts).toHaveBeenCalledWith(
      next,
      expect.objectContaining({ signal: store.signal }),
    );

    store.applyApplicationState(2, { ...defaultApplicationState(), cakePrompts: next });
    expect(store.prompts).toEqual(next);
    root[Symbol.dispose]();
  });
});
