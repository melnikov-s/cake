import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelOption } from "../../../../src/renderer/models/ModelOption";
import { applyConversationSnapshot } from "../../../../src/renderer/reducers/ConversationReducer";
import { configurationFixture } from "../chat-configuration-fixture";

afterEach(() => vi.restoreAllMocks());

describe("ChatConfigurationStore catalog derivation", () => {
  it("materializes only authenticated options and caches unchanged runtime facts", () => {
    const f = configurationFixture();
    const materialize = vi.spyOn(ModelOption.prototype, "value", "get");
    try {
      const connected = f.subject.connectedModelsByProvider;
      expect(connected.map((group) => group.models.map((model) => model.id))).toEqual([
        ["gpt-5"],
        ["claude-opus"],
      ]);
      expect(materialize).toHaveBeenCalledTimes(2);
      expect(f.subject.connectedModelsByProvider).toBe(connected);
      f.first.thinkingLevel = "high";
      f.first.streaming = true;
      expect(f.subject.connectedModelsByProvider).toBe(connected);
      expect(materialize).toHaveBeenCalledTimes(2);

      // Unauthenticated capabilities are not a dependency of the connected list.
      f.first.modelOptions[2]!.name = "Renamed disconnected model";
      expect(f.subject.connectedModelsByProvider).toBe(connected);
      f.first.modelOptions[2]!.authenticated = true;
      const authenticated = f.subject.connectedModelsByProvider;
      expect(authenticated).not.toBe(connected);
      expect(authenticated[1]!.models.map((model) => model.name)).toContain(
        "Renamed disconnected model",
      );
      applyConversationSnapshot(f.first, {
        ...f.snapshot,
        models: f.snapshot.models.map((model) => ({
          ...model,
          authenticated: true,
          availableThinkingLevels:
            model.id === "claude-opus" ? ["low", "high"] : model.availableThinkingLevels,
        })),
      });
      const capabilities = f.subject.connectedModelsByProvider;
      expect(capabilities).not.toBe(authenticated);
      expect(capabilities[1]!.models[0]!.availableThinkingLevels).toEqual(["low", "high"]);
      f.first.modelOptions[1]!.authenticated = false;
      expect(f.subject.connectedModelsByProvider[1]!.models.map((model) => model.id)).toEqual([
        "locked",
      ]);
    } finally {
      f.dispose();
    }
  });

  it("invalidates on authoritative catalog replacement without sharing runtime capabilities", () => {
    const f = configurationFixture();
    try {
      const first = f.subject.connectedModelsByProvider;
      f.state.session = f.second;
      const second = f.subject.connectedModelsByProvider;
      expect(second).toHaveLength(1);
      expect(second[0]!.models[0]).toMatchObject({
        availableThinkingLevels: ["low", "high"],
        fastMode: false,
      });
      f.state.session = f.first;
      expect(f.subject.connectedModelsByProvider[1]!.models[0]).toMatchObject({
        availableThinkingLevels: ["low", "high", "xhigh", "max"],
        fastMode: true,
      });
      applyConversationSnapshot(f.first, {
        ...f.snapshot,
        models: [{ ...f.snapshot.models[0]!, name: "Refreshed current model" }],
      });
      expect(f.subject.connectedModelsByProvider).not.toBe(first);
      expect(f.subject.connectedModelsByProvider).toHaveLength(1);
      expect(f.subject.connectedModelsByProvider[0]!.models[0]!.name).toBe(
        "Refreshed current model",
      );
      expect(f.list).not.toHaveBeenCalled();
    } finally {
      f.dispose();
    }
  });

  it("keeps the full provider-settings catalog memoized, including disconnected models", () => {
    const f = configurationFixture();
    try {
      const groups = f.subject.modelsByProvider;
      expect(groups[1]!.models.map((model) => model.id)).toEqual(["claude-opus", "locked"]);
      expect(f.subject.modelsByProvider).toBe(groups);
      f.first.modelOptions[2]!.authenticated = true;
      expect(f.subject.modelsByProvider).not.toBe(groups);
      expect(f.subject.modelsByProvider[1]!.models[1]!.authenticated).toBe(true);
    } finally {
      f.dispose();
    }
  });

  it("keeps the newest deferred catalog and name index when opens complete out of order", async () => {
    const f = configurationFixture(true);
    type Catalog = Awaited<ReturnType<typeof f.list>>;
    let resolveFirst!: (catalog: Catalog) => void;
    let resolveSecond!: (catalog: Catalog) => void;
    const first = new Promise<Catalog>((resolve) => {
      resolveFirst = resolve;
    });
    const second = new Promise<Catalog>((resolve) => {
      resolveSecond = resolve;
    });
    f.list.mockReturnValueOnce(first).mockReturnValueOnce(second);
    try {
      await f.subject.selectModel("openai/gpt-5");
      f.subject.ensureCatalog();
      f.subject.ensureCatalog();
      resolveSecond([{ ...f.snapshot.models[0]!, name: "Newest name" }]);
      await second;
      expect(f.subject.deferredModelName).toBe("Newest name");
      const newest = f.subject.connectedModelsByProvider;
      resolveFirst([{ ...f.snapshot.models[0]!, name: "Stale name" }]);
      await first;
      expect(f.subject.connectedModelsByProvider).toBe(newest);
      expect(f.subject.deferredModelName).toBe("Newest name");
    } finally {
      f.dispose();
    }
  });

  it("loads deferred catalogs only on request and preserves local first-turn configuration", async () => {
    const f = configurationFixture(true);
    try {
      expect(f.subject.connectedModelsByProvider).toEqual([]);
      expect(f.list).not.toHaveBeenCalled();
      f.subject.ensureCatalog();
      await Promise.resolve();
      const loaded = f.subject.connectedModelsByProvider;
      expect(loaded).toHaveLength(2);
      expect(f.subject.connectedModelsByProvider).toBe(loaded);
      expect(loaded.flatMap((group) => group.models).map((model) => model.id)).not.toContain(
        "locked",
      );
      await f.subject.selectPreset(f.preset);
      await f.subject.selectThinkingLevel("high");
      await f.subject.selectFastMode(false);
      expect(f.state.pending).toEqual({
        provider: "anthropic",
        modelId: "claude-opus",
        thinkingLevel: "high",
        fastMode: false,
      });
      await f.subject.selectModel("openai/gpt-5");
      expect(f.state.pending).toEqual({
        provider: "openai",
        modelId: "gpt-5",
        thinkingLevel: "high",
        fastMode: false,
      });
      expect(f.subject.deferredModelName).toBe("GPT-5");
      expect(f.setConfiguration).not.toHaveBeenCalled();
      f.list.mockResolvedValueOnce([{ ...f.snapshot.models[0]!, name: "Refreshed fallback" }]);
      f.subject.ensureCatalog();
      await Promise.resolve();
      expect(f.subject.connectedModelsByProvider).not.toBe(loaded);
      expect(f.subject.connectedModelsByProvider[0]!.models[0]!.name).toBe("Refreshed fallback");
      expect(f.subject.deferredModelName).toBe("Refreshed fallback");
    } finally {
      f.dispose();
    }
  });
});
