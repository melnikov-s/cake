import { createStore } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import { defaultApplicationState } from "../../../../src/domain/application/application-data";
import type { Client } from "../../../../src/renderer/client/Client";
import { GlobalLabelSettingsStore } from "../../../../src/renderer/stores/GlobalLabelSettingsStore";
import { mountWithClient } from "../mount-with-client";

describe("GlobalLabelSettingsStore", () => {
  it("projects global labels and sends global mutations", async () => {
    const mutateGlobal = vi.fn(async () => []);
    const { root, subject } = mountWithClient(createStore(GlobalLabelSettingsStore), {
      projectWorkflow: { mutateGlobal },
    } as unknown as Client);
    const state = defaultApplicationState();

    subject.applyApplicationState(1, state);
    expect(subject.labels.map((status) => status.name)).toEqual([
      "Feature",
      "Bug",
      "Maintenance",
      "Architecture",
      "UI",
      "Data",
      "Infrastructure",
      "Documentation",
      "Testing",
      "Tooling",
    ]);

    await expect(subject.addLabel("In review", "cyan")).resolves.toBe(true);
    expect(mutateGlobal).toHaveBeenCalledWith(
      {
        mutation: {
          _tag: "AddLabel",
          label: {
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
