import { createStore } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import { defaultApplicationState } from "../../../../src/domain/application/application-data";
import type { Client } from "../../../../src/renderer/client/Client";
import { GlobalStatusSettingsStore } from "../../../../src/renderer/stores/GlobalStatusSettingsStore";
import { mountWithClient } from "../mount-with-client";

describe("GlobalStatusSettingsStore", () => {
  it("projects global statuses and sends global mutations", async () => {
    const mutateGlobal = vi.fn(async () => []);
    const { root, subject } = mountWithClient(createStore(GlobalStatusSettingsStore), {
      projectWorkflow: { mutateGlobal },
    } as unknown as Client);
    const state = defaultApplicationState();

    subject.applyApplicationState(1, state);
    expect(subject.statuses.map((status) => status.name)).toEqual([
      "Feature",
      "Bug",
      "Research",
      "Chore",
    ]);

    await expect(subject.addStatus("In review", "cyan")).resolves.toBe(true);
    expect(mutateGlobal).toHaveBeenCalledWith(
      {
        mutation: {
          _tag: "AddColumn",
          column: {
            id: expect.any(String),
            name: "In review",
            color: "cyan",
          },
        },
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    root[Symbol.dispose]();
  });
});
