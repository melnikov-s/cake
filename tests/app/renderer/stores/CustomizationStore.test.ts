import { createStore } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import type { CustomizationState } from "../../../../src/plugin/plugin-contract";
import type { RendererClient } from "../../../../src/renderer/client/RendererClient";
import { CustomizationStore } from "../../../../src/renderer/stores/CustomizationStore";
import { mountWithRendererClient } from "../mount-with-renderer-client";

const state = (updatedAt: string): CustomizationState => ({
  schemaVersion: 1,
  recoveryRequired: false,
  diagnostics: [],
  updatedAt,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("CustomizationStore", () => {
  it.each(["rollback", "useFactory"] as const)(
    "keeps the stream authoritative when %s returns an older state",
    async (command) => {
      const pending = deferred<CustomizationState>();
      const client = {
        plugins: { [command]: vi.fn(() => pending.promise) },
      } as unknown as RendererClient;
      const { root, subject: store } = mountWithRendererClient(
        createStore(CustomizationStore),
        client,
      );
      const request = store[command]();
      const latest = state("2026-09-02T12:00:00.000Z");
      store.applyState(latest);

      pending.resolve(state("2026-09-02T11:00:00.000Z"));
      await request;

      expect(store.state).toBe(latest);
      root[Symbol.dispose]();
    },
  );
});
