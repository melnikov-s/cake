import { child, createStore, mount, Store } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import type { DesktopClient } from "../../../../src/renderer/desktop-client";
import { ProviderSettingsStore } from "../../../../src/renderer/stores/ProviderSettingsStore";
import { SessionOperationCoordinatorStore } from "../../../../src/renderer/stores/SessionOperationCoordinatorStore";

class ProviderSettingsHarnessStore extends Store<{
  client: Pick<DesktopClient, "setPiSetting" | "reloadPi" | "refreshModels" | "login" | "logout">;
}> {
  @child
  get operations() {
    return createStore(SessionOperationCoordinatorStore);
  }

  @child
  get settings() {
    return createStore(ProviderSettingsStore, {
      client: this.props.client,
      sessionContext: () => ({ sessionId: "session-1" }),
      operations: this.operations,
    });
  }
}

function createHarness() {
  const client = {
    setPiSetting: vi.fn(async () => undefined),
    reloadPi: vi.fn(async () => undefined),
    refreshModels: vi.fn(async () => undefined),
    login: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
  };
  const root = mount(createStore(ProviderSettingsHarnessStore, { client }));
  return { root, client, store: root.settings };
}

describe("ProviderSettingsStore", () => {
  it("ignores settings operations owned by sibling workflows", () => {
    const { root, store } = createHarness();
    const siblingOperationId = root.operations.start("settings");

    store.receive({ type: "operation-completed", operationId: siblingOperationId });

    expect(root.operations.includes(siblingOperationId)).toBe(true);
    root[Symbol.dispose]();
  });

  it("ignores repeated authentication while the provider already has an operation", async () => {
    const { root, client, store } = createHarness();

    await Promise.all([
      store.authenticate("openai", "oauth"),
      store.authenticate("openai", "oauth"),
    ]);

    expect(client.login).toHaveBeenCalledOnce();
    expect(store.providerOperation("openai")).toBe("login");
    root[Symbol.dispose]();
  });

  it("terminally removes owned coordinator operations on disposal", async () => {
    const operations = mount(createStore(SessionOperationCoordinatorStore));
    const client = {
      setPiSetting: vi.fn(async () => undefined),
      reloadPi: vi.fn(async () => undefined),
      refreshModels: vi.fn(async () => undefined),
      login: vi.fn(async () => undefined),
      logout: vi.fn(async () => undefined),
    };
    const store = mount(
      createStore(ProviderSettingsStore, {
        client,
        sessionContext: () => ({ sessionId: "session-1" }),
        operations,
      }),
    );
    await store.refreshModels();
    expect(operations.active("settings")).toHaveLength(1);

    store[Symbol.dispose]();

    expect(operations.active("settings")).toHaveLength(0);
    operations[Symbol.dispose]();
  });
});
