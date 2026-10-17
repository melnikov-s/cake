/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultApplicationState } from "../../../src/contracts/application/application-data";
import type {
  ModelOption,
  ModelPreset,
} from "../../../src/contracts/conversations/session-contract";
import type { Client } from "../../../src/renderer/client/Client";
import { ChatConfigurationSelector } from "../../../src/renderer/components/chat-configuration-selector";
import { ModelPresetSettings } from "../../../src/renderer/components/model-preset-settings";
import { SettingsPage } from "../../../src/renderer/components/settings-page";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import { configurationModel, configurationSnapshot } from "./chat-configuration-workflow-fixture";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import type { TestClientOverrides } from "./test-client";

const model = configurationModel({
  authenticated: false,
  authTypes: ["api_key"],
  available: true,
});
const preset: ModelPreset = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Saved choice",
  provider: model.provider,
  modelId: model.id,
  thinkingLevel: "high",
  fastMode: false,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function renderCatalog(client: TestClientOverrides, runtimeModels?: readonly ModelOption[]) {
  const fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: "/project", name: "Project" })],
    sessions: runtimeModels
      ? [sessionSummary({ sessionId: "runtime", projectPath: "/project" })]
      : [],
    client,
  });
  fixture.root.settingsStore.applyApplicationState(0, {
    ...defaultApplicationState(),
    modelPresets: [preset],
  });
  const first = fixture.root.sessionRegistry.pendingSessions.prepareStaged("/project", "first");
  const pickers = [first];
  const runtime = runtimeModels
    ? fixture.root.sessionRegistry.load("runtime", "/project")
    : undefined;
  if (runtimeModels)
    applyConversationUpdate(fixture.models.projectConversation("runtime", "/project"), {
      _tag: "Snapshot",
      revision: 1,
      snapshot: configurationSnapshot("runtime", runtimeModels),
    });
  // The real bootstraps load the window catalog, independently of settings hydration.
  await fixture.root.modelCatalogStore.ensureLoaded();
  fixture.root.settingsStore.selectPage("providers");
  const contents = () => (
    <>
      <SettingsPage settings={fixture.root.settingsStore} />
      <section aria-label="Preset editor">
        <ModelPresetSettings settings={fixture.root.settingsStore.modelPresets} />
      </section>
      {pickers.map((session, index) => (
        <section key={session.sessionId} aria-label={`Deferred picker ${index + 1}`}>
          <ChatConfigurationSelector
            configuration={session.conversationSessionStore.configurationStore}
          />
        </section>
      ))}
      {runtime && (
        <section aria-label="Runtime picker">
          <ChatConfigurationSelector
            configuration={runtime.conversationSessionStore.configurationStore}
          />
        </section>
      )}
    </>
  );
  const view = render(contents());
  let disposed = false;
  return {
    root: fixture.root,
    user: userEvent.setup(),
    addPicker() {
      pickers.push(
        fixture.root.sessionRegistry.pendingSessions.prepareStaged("/project", "second"),
      );
      view.rerender(contents());
    },
    [Symbol.dispose]() {
      if (disposed) return;
      disposed = true;
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}
const picker = (name: string) =>
  within(screen.getByRole("region", { name })).getByRole("button", { name: "Model configuration" });
const editor = () => within(screen.getByRole("region", { name: "Preset editor" }));
afterEach(cleanup);

describe("Window model catalog workflows", () => {
  it("provider login/logout/refresh updates the preset editor and existing/new deferred pickers without restart", async () => {
    let authenticated = false;
    let name = model.name;
    const list = vi.fn<Client["models"]["list"]>(async () => [
      {
        ...model,
        name,
        authenticated,
        authSource: authenticated ? "stored" : undefined,
      },
    ]);
    using fixture = await renderCatalog({
      models: {
        list,
        login: async () => {
          authenticated = true;
        },
        logout: async () => {
          authenticated = false;
        },
        refresh: async () => {
          name = "Refreshed GPT";
        },
      },
    });
    expect(editor().getByText("Authentication required")).toBeDefined();
    await fixture.user.click(picker("Deferred picker 1"));
    expect(screen.queryByRole("button", { name: "GPT-5 gpt-5" })).toBeNull();
    await fixture.user.click(picker("Deferred picker 1"));
    await fixture.user.click(editor().getByRole("button", { name: "Edit" }));
    await fixture.user.click(screen.getByRole("button", { name: "Add API key" }));
    await screen.findByText("Connected", { exact: true });
    expect(editor().queryByText("Authentication required")).toBeNull();
    expect(editor().getByRole("textbox", { name: "Name" })).toHaveProperty("value", preset.name);
    fixture.addPicker();

    for (const region of ["Deferred picker 1", "Deferred picker 2"]) {
      await fixture.user.click(picker(region));
      expect(screen.getByRole("button", { name: "GPT-5 gpt-5" })).toBeDefined();
      await fixture.user.click(picker(region));
    }
    await fixture.user.click(screen.getByRole("button", { name: "Refresh models" }));
    await waitFor(() =>
      expect(editor().getByRole("button", { name: "Preset model" }).textContent).toContain(
        "Refreshed GPT",
      ),
    );
    await fixture.user.click(screen.getByRole("button", { name: "Preset model" }));
    await fixture.user.click(screen.getByRole("button", { name: "Change model" }));
    expect(screen.getByRole("button", { name: "Refreshed GPT gpt-5" })).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "Preset model" }));
    for (const region of ["Deferred picker 1", "Deferred picker 2"]) {
      await fixture.user.click(picker(region));
      expect(screen.getByRole("button", { name: "Refreshed GPT gpt-5" })).toBeDefined();
      await fixture.user.click(picker(region));
    }
    await fixture.user.click(screen.getByRole("button", { name: "Disconnect" }));
    await screen.findByText("Not connected", { exact: true });
    expect(editor().getByText("Authentication required")).toBeDefined();
    for (const region of ["Deferred picker 1", "Deferred picker 2"]) {
      await fixture.user.click(picker(region));
      expect(screen.queryByRole("button", { name: "Refreshed GPT gpt-5" })).toBeNull();
      await fixture.user.click(picker(region));
    }
    expect(list).toHaveBeenCalledTimes(4); // initial, login, refresh, logout; never per-picker copies
  });

  it.each(["refresh", "list", "failure"] as const)(
    "concurrent refresh cannot publish stale data (%s finishes late)",
    async (phase) => {
      const oldRefresh = deferred<void>();
      const oldList = deferred<readonly ModelOption[]>();
      const signals: AbortSignal[] = [];
      const list = vi
        .fn<Client["models"]["list"]>()
        .mockResolvedValueOnce([model])
        .mockImplementationOnce((options) => {
          signals.push(options!.signal!);
          return phase === "refresh"
            ? Promise.resolve([
                { ...model, name: "Newest", authenticated: true, authSource: "stored" },
              ])
            : oldList.promise;
        })
        .mockResolvedValue([
          { ...model, name: "Newest", authenticated: true, authSource: "stored" },
        ]);
      using fixture = await renderCatalog({
        models: {
          list,
          refresh: (options) => {
            signals.push(options!.signal!);
            return phase === "refresh" ? oldRefresh.promise : Promise.resolve();
          },
          login: async () => undefined,
        },
      });
      await fixture.user.click(screen.getByRole("button", { name: "Refresh models" }));
      if (phase !== "refresh") await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
      await fixture.user.click(screen.getByRole("button", { name: "Add API key" }));
      await screen.findByText("Connected", { exact: true });
      expect(signals[0]!.aborted).toBe(true);
      await act(async () => {
        if (phase === "refresh") oldRefresh.resolve();
        else if (phase === "failure") oldList.reject(new Error("Stale failure"));
        else oldList.resolve([{ ...model, name: "Stale name" }]);
      });
      expect(editor().queryByText("Authentication required")).toBeNull();
      expect(screen.queryByText("Stale failure")).toBeNull();
      await fixture.user.click(picker("Deferred picker 1"));
      expect(screen.getByRole("button", { name: "Newest gpt-5" })).toBeDefined();
      expect(screen.queryByRole("button", { name: "Stale name gpt-5" })).toBeNull();
      expect(list).toHaveBeenCalledTimes(phase === "refresh" ? 2 : 3);
      expect(screen.getByRole("button", { name: "Refresh models" })).toHaveProperty(
        "disabled",
        false,
      );
    },
  );

  it("catalog replacement removes stale selected-model labels without losing deferred configuration", async () => {
    let models: readonly ModelOption[] = [{ ...model, authenticated: true }];
    using fixture = await renderCatalog({
      models: {
        list: async () => models,
        refresh: async () => {
          models = [];
        },
      },
    });
    await fixture.user.click(picker("Deferred picker 1"));
    await fixture.user.click(screen.getByRole("button", { name: "GPT-5 gpt-5" }));
    await fixture.user.click(screen.getByRole("button", { name: "Apply" }));
    expect(picker("Deferred picker 1").textContent).toContain("GPT-5");
    await fixture.user.click(screen.getByRole("button", { name: "Refresh models" }));
    await waitFor(() => expect(picker("Deferred picker 1").textContent).toContain("gpt-5"));
    expect(picker("Deferred picker 1").textContent).not.toContain("GPT-5");
    expect(editor().getByText("Model unavailable")).toBeDefined();
    await fixture.user.click(picker("Deferred picker 1"));
    await fixture.user.click(screen.getByRole("button", { name: "Change model" }));
    expect(screen.queryByRole("button", { name: "GPT-5 gpt-5" })).toBeNull();
  });

  it("session-specific capability distinctions survive a shared catalog refresh", async () => {
    using fixture = await renderCatalog(
      {
        models: {
          list: async () => [
            {
              ...model,
              authenticated: true,
              availableThinkingLevels: ["off", "max"],
              fastMode: true,
            },
          ],
          refresh: async () => undefined,
        },
      },
      [
        {
          ...model,
          authenticated: true,
          availableThinkingLevels: ["off", "high"],
          fastMode: false,
        },
      ],
    );
    await fixture.user.click(screen.getByRole("button", { name: "Refresh models" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Refresh models" })).toHaveProperty(
        "disabled",
        false,
      ),
    );
    await fixture.user.click(picker("Runtime picker"));
    expect(screen.getByRole("button", { name: "High" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Max" })).toBeNull();
    expect(screen.queryByRole("switch", { name: "Fast mode" })).toBeNull();
    await fixture.user.click(picker("Runtime picker"));
    await fixture.user.click(picker("Deferred picker 1"));
    await fixture.user.click(screen.getByRole("button", { name: "GPT-5 gpt-5" }));
    expect(screen.getByRole("button", { name: "Max" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "High" })).toBeNull();
    expect(screen.getByRole("switch", { name: "Fast mode" })).toBeDefined();
  });

  // Resource disposal has no user-facing control; test the real window owner after unmount.
  it.each(["refresh", "list"] as const)(
    "disposal cancels owned loading during %s and rejects late publication",
    async (phase) => {
      const loading = deferred<void>();
      const models = deferred<readonly ModelOption[]>();
      const signals: AbortSignal[] = [];
      const list = vi
        .fn<Client["models"]["list"]>()
        .mockResolvedValueOnce([model])
        .mockImplementation((options) => {
          signals.push(options!.signal!);
          return models.promise;
        });
      using fixture = await renderCatalog({
        models: {
          list,
          refresh: (options) => {
            signals.push(options!.signal!);
            return phase === "refresh" ? loading.promise : Promise.resolve();
          },
        },
        nonChatModels: {
          list: async (options) => {
            signals.push(options!.signal!);
            return [];
          },
        },
      });
      await fixture.user.click(screen.getByRole("button", { name: "Refresh models" }));
      if (phase === "list") await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
      const catalog = fixture.root.modelCatalogStore;
      fixture[Symbol.dispose]();
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      await act(async () => {
        loading.resolve();
        models.resolve([{ ...model, name: "Late result" }]);
      });
      expect(catalog.models[0]?.name).toBe(model.name);
      expect(list).toHaveBeenCalledTimes(phase === "refresh" ? 1 : 2);
    },
  );
});
