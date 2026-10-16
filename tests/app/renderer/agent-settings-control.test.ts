import type { CakeEvent } from "../../../src/contracts/application/cake-rpc-contract";
import { ClientEvents } from "../../../src/services/clients/ClientEvents";
import type { AgentControlSource } from "../../../src/renderer/app-control/app-control-data";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ModelType, ModelTypeMap } from "@earendil-works/pi-ai";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import { applySnapshot, toSnapshot, createStore, mount } from "r-state-tree";
import { DesktopConnectionStore } from "../../../src/renderer/stores/DesktopConnectionStore";
import type { DesktopSharingState } from "../../../src/contracts/desktop/desktop-sharing-data";
import { createTestClient } from "./test-client";
import { speechOutputSettings } from "../../helpers/speech-output";
import {
  defaultApplicationState,
  type ApplicationState as ApplicationValue,
} from "../../../src/contracts/application/application-data";
import * as application from "../../../src/domain/application/application";
import { isBackendAgentSetting } from "../../../src/contracts/application/agent-settings-tools";
import * as backendSettings from "../../../src/domain/application/agentSettings";
import { PiModels } from "../../../src/services/pi/PiModels";
import { WidgetPackages } from "../../../src/services/widgets/WidgetPackages";
import { defaultCakePrompts } from "../../../src/contracts/application/cake-prompt-defaults";
import * as presets from "../../../src/domain/model-presets/modelPresets";
import { updateNonChatModelPreference } from "../../../src/domain/model-preferences/non-chat-model-preferences";
import { loadMcpSettings, mutateMcpSettings } from "../../../src/domain/mcp/mcp-settings";
import {
  MCP_STORED_SECRET,
  McpSettingsSnapshot,
} from "../../../src/contracts/pi/mcp-settings-data";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import { ApplicationStorage } from "../../../src/services/storage/ApplicationStorage";
import { makeMcpSettingsLayer } from "../../../src/services/pi/McpSettings";
import { PiSettings, makePiSettingsLayer } from "../../../src/services/pi/PiSettings";
import { mergePiExecutionSetting } from "../../../src/services/pi/live/PiSettingsLive";
import { CakeSessionRuntimes } from "../../../src/services/pi/CakeSessionRuntimes";
import { ProjectAccess } from "../../../src/services/projects/ProjectAccess";
import { CakeOperationRegistry } from "../../../src/services/pi/runtime/cake-operation-registry";
import { createCakeSettingsOperations } from "../../../src/domain/application/cake-settings-operations";
import { createCakeWidgetPackageOperations } from "../../../src/domain/application/cake-widget-package-operations";
import { createGlobalControlOperations } from "../../../src/domain/application/cake-global-control-operations";
import { createCakeNonChatModelOperations } from "../../../src/domain/model-preferences/cake-non-chat-model-operations";
import {
  listAppControlTools,
  listSessionAssistantControlTools,
} from "../../../src/renderer/app-control/AppControlBridge";
import {
  AgentSettingsInvocation,
  agentSettingsOperations,
} from "../../../src/contracts/application/agent-settings-schema";
import type { Client } from "../../../src/renderer/client/Client";
import {
  jsonObjectSchema,
  type JsonObject,
} from "../../../src/contracts/serialization/json-contract";
import { TurnId } from "../../../src/contracts/conversations/conversation-data";
import { slashCommandSchema } from "../../../src/contracts/conversations/session-contract";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";

async function fixture(trusted = true) {
  let saved: ApplicationValue = {
    ...defaultApplicationState(),
    trustedProjectPaths: trusted ? ["/project"] : [],
  };
  let document = "{}";
  const files = new Map<string, string>();
  const reads: string[] = [];
  const reloads: string[] = [];
  const piEvents: CakeEvent[] = [];
  const manager = SettingsManager.fromStorage(
    {
      withLock(scope, update) {
        if (scope !== "global") {
          update(undefined);
          return;
        }
        const next = update(document);
        if (next !== undefined) document = next;
      },
    },
    { projectTrusted: true },
  );
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      Layer.mock(ClientEvents, {
        sendTo: () => false,
        broadcast: (event) => {
          piEvents.push(event);
        },
      }),
      ApplicationState.layer.pipe(
        Layer.provide(
          Layer.succeed(
            ApplicationStorage,
            ApplicationStorage.of({
              load: () => Effect.succeed({ state: saved, source: "current" }),
              save: (value) =>
                Effect.sync(() => {
                  saved = value;
                }),
            }),
          ),
        ),
      ),
      makePiSettingsLayer(manager, (update) =>
        Effect.sync(() => {
          document = JSON.stringify(mergePiExecutionSetting(JSON.parse(document), update));
        }),
      ),
      makeMcpSettingsLayer("/backend/agent", {
        read: (path) => {
          reads.push(path);
          return files.get(path) ?? "";
        },
        write: (path, value) => {
          files.set(path, value);
        },
      }),
      Layer.mock(ProjectAccess, { isAllowed: (path) => Effect.succeed(path === "/project") }),
      Layer.mock(CakeSessionRuntimes, {
        reloadAll: () =>
          Effect.sync(() => {
            reloads.push("all");
          }),
        reloadWorkingDirectory: (path) =>
          Effect.sync(() => {
            reloads.push(path);
          }),
      }),
    ),
  );
  await runtime.runPromise(Effect.flatMap(ApplicationState, (owner) => owner.initialize()));
  let revision = 0;
  const publish = async (state: ApplicationValue) => {
    root.root.settingsStore.applyApplicationState(++revision, state);
    return state;
  };
  const execute = <A, E>(
    effect: Effect.Effect<A, E, ApplicationState>,
    options?: { signal?: AbortSignal },
  ) => runtime.runPromise(effect, options);
  const packageSnapshot = {
    directory: "/backend/widget-packages",
    packages: [{ name: "d3", version: "7.9.0" }],
  };
  const widgetInstall = vi.fn<Client["widgetPackages"]["install"]>(async () => packageSnapshot);
  const widgetRemove = vi.fn<Client["widgetPackages"]["remove"]>(async () => ({
    ...packageSnapshot,
    packages: [],
  }));
  const login = vi.fn<Client["models"]["login"]>(async () => {});
  const logout = vi.fn<Client["models"]["logout"]>(async () => {});
  const nativePrompt = vi.fn<Client["sessionChats"]["prompt"]>(async () =>
    TurnId.make("00000000-0000-4000-8000-000000000001"),
  );
  const root = createRendererStoreFixture({
    projects: [projectRecord({ path: "/project" })],
    sessions: [
      sessionSummary({ sessionId: "calling", projectPath: "/project" }),
      sessionSummary({
        sessionId: "other",
        projectPath: "/project",
        workingDirectory: "/elsewhere",
      }),
    ],
    client: {
      widgetPackages: {
        list: async () => packageSnapshot,
        install: widgetInstall,
        remove: widgetRemove,
      },
      application: {
        getState: () => execute(Effect.flatMap(ApplicationState, (owner) => owner.current())),
      },
      piSettings: {
        get: (options) =>
          runtime.runPromise(
            Effect.flatMap(PiSettings, (settings) => settings.load()),
            options,
          ),
        update: (input, options) =>
          runtime.runPromise(
            Effect.flatMap(PiSettings, (settings) => settings.update(input)),
            options,
          ),
        reload: (options) =>
          runtime.runPromise(
            Effect.flatMap(PiSettings, (settings) => settings.load()),
            options,
          ),
      },
      mcpSettings: {
        get: (input, options) => runtime.runPromise(loadMcpSettings(input), options),
        mutate: (input, options) => runtime.runPromise(mutateMcpSettings(input), options),
      },
      nonChatModels: {
        list: async () => [],
        updatePreference: async (input, options) => {
          const value = await execute(updateNonChatModelPreference(input), options);
          await publish(saved);
          return value;
        },
      },
      models: { list: async () => [], refresh: async () => {}, login, logout },
      sessionChats: { prompt: nativePrompt },
      modelPresets: {
        list: (options) => execute(presets.list(), options),
        create: async (input, options) => {
          const value = await execute(presets.create(input), options);
          await publish(saved);
          return value;
        },
        update: async (input, options) => {
          const value = await execute(presets.update(input), options);
          await publish(saved);
          return value;
        },
        reorder: (input, options) => execute(presets.reorder(input), options),
        remove: (id, options) => execute(presets.remove(id), options),
        setDefault: (id, options) => execute(presets.setDefault(id), options),
      },
      workspaces: {
        setUtilityModel: async (model, options) =>
          publish(await execute(application.setUtilityModel(model), options)),
        setGlobalCustomInstructions: async (value, options) =>
          publish(await execute(application.setGlobalCustomInstructions(value), options)),
        setCakePrompts: async (value, options) =>
          publish(await execute(application.setCakePrompts(value), options)),
      },
      projectWorkflow: {
        mutateGlobal: async (input, options) =>
          (await execute(application.mutateGlobalSessionLabels(input.mutation), options))
            .globalSessionLabels,
      },
    },
  });
  await publish(saved);
  const source = {
    kind: "project-session" as const,
    sessionId: "calling",
    title: "Calling",
    projectPath: "/project",
    workingDirectory: "/project",
  };
  const dispatch = vi.fn(
    (
      command: string,
      input: JsonObject,
      signal: AbortSignal,
      caller: AgentControlSource = source,
    ) => {
      signal.throwIfAborted();
      if (!isBackendAgentSetting(command))
        return root.root.applicationControlStore.invoke(
          { name: command, arguments: input },
          caller,
        );
      return runtime
        .runPromise(
          Schema.decodeUnknownEffect(AgentSettingsInvocation)(
            { name: command, arguments: input },
            { onExcessProperty: "error" },
          ).pipe(
            Effect.flatMap((invocation) => backendSettings.invoke(invocation, caller)),
            Effect.provideService(
              PiModels,
              PiModels.of({
                list: () => Effect.succeed([]),
                listNonChat: () => Effect.succeed([]),
                refreshCatalog: () => Effect.void,
                login: () => Effect.die("Interactive login must stay renderer-owned"),
                logout: (provider) =>
                  Effect.tryPromise({
                    try: (signal) => logout({ provider }, { signal }),
                    catch: () => new Error("logout failed"),
                  }).pipe(Effect.orDie),
                resolve: (selection) => Effect.succeed(selection),
                complete: () => Effect.die("Unexpected completion"),
              }),
            ),
            Effect.provideService(
              WidgetPackages,
              WidgetPackages.of({
                directory: packageSnapshot.directory,
                list: () => Effect.succeed(packageSnapshot),
                install: (specifier) =>
                  Effect.tryPromise({
                    try: (signal) => widgetInstall({ specifier, userApproved: true }, { signal }),
                    catch: () => new Error("install failed"),
                  }).pipe(Effect.orDie),
                remove: (name) =>
                  Effect.tryPromise({
                    try: (signal) => widgetRemove({ name }, { signal }),
                    catch: () => new Error("remove failed"),
                  }).pipe(Effect.orDie),
              }),
            ),
          ),
          { signal },
        )
        .then(async (result) => {
          await publish(saved);
          return result;
        });
    },
  );
  const registry = new CakeOperationRegistry([
    ...createCakeSettingsOperations(dispatch),
    ...createCakeWidgetPackageOperations(dispatch),
  ]);
  const call = (command: string, input: JsonObject = {}, signal = new AbortController().signal) =>
    registry.invoke({ command, input }, { signal, toolCallId: "settings-test", runtime: {} });
  return {
    root,
    runtime,
    files,
    reads,
    reloads,
    piEvents,
    registry,
    dispatch,
    call,
    login,
    logout,
    nativePrompt,
    widgetInstall,
    widgetRemove,
    manager,
    saved: () => saved,
    document: () => JSON.parse(document),
    async dispose() {
      root[Symbol.dispose]();
      await runtime.dispose();
    },
  };
}

function value(result: Awaited<ReturnType<CakeOperationRegistry["invoke"]>>) {
  return Schema.decodeUnknownSync(
    Schema.Struct({ result: Schema.Struct({ value: Schema.Unknown }) }),
  )(result.structuredContent).result.value;
}

describe("Agent Settings through the real application-control/Client/domain boundary", () => {
  it("lists, installs only approved widget dependencies, and removes through the shared package Client", async () => {
    const h = await fixture();
    try {
      expect(value(await h.call("settings.widgets.list"))).toMatchObject({
        directory: "/backend/widget-packages",
        packages: [{ name: "d3" }],
      });
      await expect(h.call("settings.widgets.install", { specifier: "d3" })).rejects.toThrow();
      expect(h.widgetInstall).not.toHaveBeenCalled();
      await h.call("settings.widgets.install", { specifier: "d3", userApproved: true });
      expect(h.widgetInstall).toHaveBeenCalledWith(
        { specifier: "d3", userApproved: true },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(value(await h.call("settings.widgets.remove", { name: "d3" }))).toMatchObject({
        packages: [],
      });
      expect(h.widgetRemove).toHaveBeenCalledWith(
        { name: "d3" },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    } finally {
      await h.dispose();
    }
  });
  it("discloses all Settings scopes and exact help; shared input schemas reject malformed and unknown fields before dispatch", async () => {
    const h = await fixture();
    try {
      expect(h.registry.help()).toContain("settings —");
      const cakeChat = new CakeOperationRegistry(
        createGlobalControlOperations(
          {
            tools: listAppControlTools(),
            invoke: (invocation, signal) =>
              h.dispatch(
                invocation.name,
                Schema.decodeUnknownSync(jsonObjectSchema)(invocation.arguments),
                signal,
              ),
          },
          () => ({ provider: "fixture", modelId: "chat", thinkingLevel: "off", fastMode: false }),
        ),
      );
      expect(cakeChat.operationHelp("settings.models.set-non-chat")).toContain("preference");
      expect(
        (
          await cakeChat.invoke(
            { command: "settings.models.get" },
            { signal: new AbortController().signal, toolCallId: "cake-chat", runtime: {} },
          )
        ).structuredContent,
      ).toMatchObject({
        command: "settings.models.get",
        result: { ok: true, value: { nonChatPreferences: {} } },
      });
      h.dispatch.mockClear();
      expect(h.registry.operationHelp("settings.pi.update")).toContain("codemodeInlineBudget");
      expect(h.registry.operationHelp("settings.mcp.update")).toContain("callbackPort");
      expect(h.registry.operationHelp("settings.providers.login")).toContain("user interaction");
      expect(
        listAppControlTools().filter((tool) =>
          agentSettingsOperations.some((op) => op.command === tool.command),
        ),
      ).toHaveLength(agentSettingsOperations.length);
      expect(listSessionAssistantControlTools()).toEqual(
        expect.arrayContaining(listAppControlTools()),
      );
      for (const [command, input] of [
        ["settings.pi.update", { key: "codemodeInlineBudget", value: -1 }],
        ["settings.pi.update", { key: "unknown", value: true }],
        ["settings.mcp.get", { scope: "project", projectPath: "/arbitrary" }],
        ["settings.mcp.get", { scope: "backend", revealSecrets: true }],
        [
          "settings.mcp.update",
          {
            scope: "backend",
            revision: "x",
            name: "docs",
            action: "save",
            config: { command: "server", timeout: -1 },
          },
        ],
        ["settings.models.set-non-chat", { type: "chat", preference: null }],
        [
          "settings.providers.login",
          { provider: "fixture", authType: "token", apiKey: "never-store-in-transcript" },
        ],
      ] as const)
        await expect(h.call(command, input)).rejects.toThrow();
      expect(h.dispatch).not.toHaveBeenCalled();
      await expect(
        h.root.root.applicationControlStore.invoke({
          name: "settings.mcp.get",
          arguments: { scope: "backend", revealSecrets: true },
        }),
      ).rejects.toThrow();
    } finally {
      await h.dispose();
    }
  });

  it("publishes authoritative Pi settings after backend update/reload for observing windows", async () => {
    const h = await fixture();
    try {
      await h.call("settings.pi.update", { key: "autoCompact", value: false });
      const current = value(await h.call("settings.pi.get"));
      expect(h.piEvents).toEqual([{ type: "pi-settings-changed", settings: current }]);
      await h.call("settings.pi.reload");
      expect(h.piEvents).toEqual([
        { type: "pi-settings-changed", settings: current },
        { type: "pi-settings-changed", settings: current },
      ]);
      expect(h.reloads).toEqual(["all", "all"]);
    } finally {
      await h.dispose();
    }
  });

  it("persists codemode/tool-search/native settings, presets, utility, instructions and every automation prompt through their existing authorities", async () => {
    const h = await fixture();
    try {
      await h.call("settings.pi.update", {
        key: "defaultTools",
        value: ["+codemode", "+tool_search"],
      });
      await h.call("settings.pi.update", { key: "codemodeInlineBudget", value: 0 });
      await h.call("settings.pi.update", { key: "shellPath", value: "/bin/fixture" });
      expect(h.manager.getDefaultTools()).toContain("codemode");
      expect(h.manager.getDefaultTools()).toContain("tool_search");
      expect(h.document()).toMatchObject({
        defaultTools: ["+codemode", "+tool_search"],
        codemode: { inlineBudget: 0 },
        shellPath: "/bin/fixture",
      });
      await h.call("settings.pi.update", { key: "defaultTools", value: null });
      expect(h.document()).toHaveProperty("defaultTools", ["+codemode"]);
      const created = Schema.decodeUnknownSync(
        Schema.Struct({ presets: Schema.Array(Schema.Struct({ id: Schema.String })) }),
      )(
        value(
          await h.call("settings.presets.create", {
            name: "Fixture",
            provider: "fixture",
            modelId: "chat",
            thinkingLevel: "off",
            fastMode: false,
          }),
        ),
      );
      await h.call("settings.presets.set-default", { id: created.presets[0]!.id });
      await h.call("settings.presets.reorder", { ids: [created.presets[0]!.id] });
      expect(h.saved().defaultModelPresetId).toBe(created.presets[0]!.id);
      await h.call("settings.presets.update", {
        ...h.saved().modelPresets[0]!,
        name: "Updated fixture",
        fastMode: true,
      });
      expect(h.saved().modelPresets[0]).toMatchObject({ name: "Updated fixture", fastMode: true });
      await h.call("settings.presets.remove", { id: created.presets[0]!.id });
      expect(h.saved().modelPresets).toEqual([]);
      expect(h.saved().defaultModelPresetId).toBeUndefined();
      const labelId = "00000000-0000-4000-8000-000000000020";
      await h.call("settings.labels.update", {
        mutation: { _tag: "AddLabel", label: { id: labelId, name: "Fixture", color: "blue" } },
      });
      await h.call("settings.labels.update", {
        mutation: { _tag: "UpdateLabel", labelId, name: "Renamed fixture", color: "mint" },
      });
      await h.call("settings.labels.update", {
        mutation: { _tag: "MoveLabel", labelId, index: 0 },
      });
      expect(
        Schema.decodeUnknownSync(Schema.Array(Schema.Unknown))(
          value(await h.call("settings.labels.get")),
        )[0],
      ).toMatchObject({ id: labelId, name: "Renamed fixture", color: "mint" });
      await h.call("settings.labels.update", { mutation: { _tag: "DeleteLabel", labelId } });
      expect(h.saved().globalSessionLabels.some((label) => label.id === labelId)).toBe(false);
      await h.call("settings.models.set-utility", {
        model: { provider: "fixture", modelId: "utility", thinkingLevel: "off" },
      });
      expect(h.saved().utilityModel?.modelId).toBe("utility");
      await h.call("settings.models.set-utility", { model: null });
      expect(h.saved().utilityModel).toBeUndefined();
      await h.call("settings.instructions.update", {
        instructions: "  Personal fixture instructions  ",
      });
      expect(h.saved().globalCustomInstructions).toBe("Personal fixture instructions");
      for (const key of Object.keys(defaultCakePrompts())) {
        await h.call("settings.prompts.update", { key, value: "Customized fixture prompt" });
        expect(h.saved().cakePrompts).toHaveProperty(key, "Customized fixture prompt");
        await h.call("settings.prompts.update", { key, value: null });
        expect(h.saved().cakePrompts).toEqual({});
        expect(value(await h.call("settings.instructions.get"))).toMatchObject({
          prompts: defaultCakePrompts(),
        });
      }
      expect(h.login).not.toHaveBeenCalled();
    } finally {
      await h.dispose();
    }
  });

  it("keeps MCP scope bound to the caller, masks and preserves secrets, rejects stale revisions, and reloads only the committed scope", async () => {
    const h = await fixture();
    try {
      h.files.set(
        "/backend/agent/mcp.json",
        JSON.stringify({
          mcpServers: {
            docs: {
              url: "https://user:password@example.test/mcp?token=url-secret",
              headers: { Authorization: "header-secret" },
              custom: { keep: true },
            },
          },
        }),
      );
      const backend = Schema.decodeUnknownSync(McpSettingsSnapshot)(
        value(await h.call("settings.mcp.get", { scope: "backend" })),
      );
      expect(JSON.stringify(backend)).not.toContain("header-secret");
      expect(JSON.stringify(backend)).not.toContain("url-secret");
      expect(backend.entries[0]?.config.url).toBe(MCP_STORED_SECRET);
      await h.call("settings.mcp.update", {
        scope: "backend",
        revision: backend.revision,
        name: "docs",
        action: "save",
        config: { ...backend.entries[0]!.config, description: "changed" },
      });
      expect(h.files.get("/backend/agent/mcp.json")).toContain("header-secret");
      expect(
        JSON.parse(h.files.get("/backend/agent/mcp.json") ?? "{}").mcpServers.docs.custom,
      ).toEqual({ keep: true });
      expect(h.reloads).toEqual(["all"]);
      await expect(
        h.call("settings.mcp.update", {
          scope: "backend",
          revision: backend.revision,
          name: "docs",
          action: "disable",
        }),
      ).rejects.toThrow("changed");
      const project = Schema.decodeUnknownSync(McpSettingsSnapshot)(
        value(await h.call("settings.mcp.get", { scope: "project" })),
      );
      await h.call("settings.mcp.update", {
        scope: "project",
        revision: project.revision,
        name: "docs",
        action: "save",
        config: { command: "fixture-server", args: ["--secret", "new-user-value"] },
      });
      expect(h.reloads).toEqual(["all", "/project"]);
      expect(h.files.has("/project/.pi/mcp.json")).toBe(true);
      expect(h.reads).not.toContain("/elsewhere/.pi/mcp.json");
      const latest = Schema.decodeUnknownSync(McpSettingsSnapshot)(
        value(await h.call("settings.mcp.get", { scope: "project" })),
      );
      expect(latest.entries[0]?.overridden).toBe(true);
      expect(latest.entries[1]?.config.args).toEqual([MCP_STORED_SECRET, MCP_STORED_SECRET]);
      await expect(
        h.dispatch("settings.mcp.get", { scope: "project" }, new AbortController().signal, {
          kind: "cake-chat",
          sessionId: "cake",
          title: "Cake",
        }),
      ).rejects.toThrow("calling Project Session");
    } finally {
      await h.dispose();
    }
    const untrusted = await fixture(false);
    try {
      await expect(untrusted.call("settings.mcp.get", { scope: "project" })).rejects.toThrow(
        "trust",
      );
      expect(untrusted.reads).toEqual([]);
    } finally {
      await untrusted.dispose();
    }
  });

  it("persists independent non-chat preferences consumed by the native selector, with explicit overrides and no substitution", async () => {
    const h = await fixture();
    try {
      await h.call("settings.models.set-non-chat", {
        type: "image",
        preference: { provider: "fixture", modelId: "image-a" },
      });
      await h.call("settings.models.set-non-chat", {
        type: "classifier",
        preference: { provider: "fixture", modelId: "classifier-a" },
      });
      const available: { [Type in ModelType]: readonly ModelTypeMap[Type][] } = {
        chat: [],
        classifier: [],
        image: ["image-a", "image-b"].map((id) => ({
          type: "image",
          provider: "fixture",
          id,
          name: id,
          api: "fixture",
          baseUrl: "https://fixture.invalid",
          input: ["text"],
          output: ["image"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        })),
      };
      const getAvailableOfType: ModelRuntime["getAvailableOfType"] = async <Type extends ModelType>(
        type: Type,
      ) => available[type];
      const native = new CakeOperationRegistry(
        createCakeNonChatModelOperations(() => h.saved().nonChatModelPreferences ?? {}, {
          getAvailableOfType,
        }),
      );
      const select = (input: JsonObject) =>
        native.invoke(
          { command: "models.select-non-chat", input },
          { signal: new AbortController().signal, toolCallId: "native", runtime: {} },
        );
      expect((await select({ type: "image" })).structuredContent).toMatchObject({
        result: { source: "preference", model: { id: "image-a" } },
      });
      expect(
        (await select({ type: "image", requested: { provider: "fixture", modelId: "image-b" } }))
          .structuredContent,
      ).toMatchObject({ result: { source: "requested", model: { id: "image-b" } } });
      await h.call("settings.models.set-non-chat", {
        type: "image",
        preference: { provider: "fixture", modelId: "missing" },
      });
      await expect(select({ type: "image" })).rejects.toThrow("unavailable");
      await h.call("settings.models.set-non-chat", { type: "image", preference: null });
      expect(h.saved().nonChatModelPreferences?.classifier?.modelId).toBe("classifier-a");
      expect((await select({ type: "image" })).structuredContent).toMatchObject({
        result: { source: "agent", model: null },
      });
    } finally {
      await h.dispose();
    }
  });

  it("launches only the real native MCP command in an explicitly targeted trusted idle session, not the focused or executing one", async () => {
    const h = await fixture();
    try {
      const session = h.root.root.sessionRegistry.load("calling", "/project");
      session.model.observedSnapshotRevision = 1;
      await expect(
        h.call("settings.mcp.native", { name: "docs", action: "login" }),
      ).rejects.toThrow("unavailable");
      applySnapshot(session.model, {
        ...toSnapshot(session.model),
        commands: [
          Schema.decodeUnknownSync(slashCommandSchema)({
            name: "mcp",
            source: "builtin",
            sourceInfo: {
              path: "builtin:mcp",
              source: "Pi",
              scope: "temporary",
              origin: "top-level",
            },
          }),
        ],
      });
      session.model.streaming = true;
      await expect(
        h.call("settings.mcp.native", { name: "docs", action: "login" }),
      ).rejects.toThrow("idle Project Session");
      expect(h.nativePrompt).not.toHaveBeenCalled();
      session.model.streaming = false;
      const result = await h.root.root.applicationControlStore.invoke(
        {
          name: "settings.mcp.native",
          arguments: { name: "docs", action: "login", sessionId: "calling" },
        },
        { kind: "cake-chat", sessionId: "cake", title: "Cake Chat" },
      );
      expect(result).toMatchObject({
        ok: true,
        value: {
          submitted: true,
          sessionId: "calling",
          authorization: "interactive-not-confirmed",
        },
      });
      expect(h.nativePrompt).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "calling", text: "/mcp login docs" }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    } finally {
      await h.dispose();
    }
  });

  it("targets native settings at the originating desktop and reuses its single-flight sharing and dictation controls", async () => {
    const select = vi.fn<Client["desktopHost"]["select"]>(async () => true);
    const release = vi.fn<Client["dictation"]["release"]>(async () => {});
    const setModelPath = vi.fn<Client["dictation"]["setModelPath"]>(async () => {});
    const setVoice = vi.fn<Client["speechOutput"]["setVoice"]>(async () => {});
    const listVoices = vi.fn<Client["speechOutput"]["listVoices"]>(async () => [
      { id: "voice", name: "Saved voice" },
    ]);
    let completeSharing: (state: DesktopSharingState) => void = () => {};
    const sharingPending = new Promise<DesktopSharingState>((resolve) => {
      completeSharing = resolve;
    });
    let sharingStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      sharingStarted = resolve;
    });
    const configure = vi.fn<Client["desktopSharing"]["configure"]>(async () => {
      sharingStarted();
      return sharingPending;
    });
    const boundary = {
      desktopHost: { current: async () => ({ kind: "local" as const }), select },
      desktopSharing: { configure },
      dictation: { release, setModelPath },
      speechOutput: { setVoice, listVoices },
    };
    const client = createTestClient(boundary);
    const connection = mount(
      createStore(DesktopConnectionStore, {
        host: { kind: "local" },
        client: () => client,
        connect: async () => {},
      }),
    );
    const origin = createRendererStoreFixture({ client: boundary, desktopConnection: connection });
    const otherWindow = createRendererStoreFixture();
    const call = (name: string, argumentsValue: JsonObject = {}) =>
      origin.root.applicationControlStore.invoke({ name, arguments: argumentsValue });
    try {
      expect(await call("settings.desktop.get")).toMatchObject({
        value: { host: { kind: "local" }, connected: true, sharing: null },
      });
      await expect(
        otherWindow.root.applicationControlStore.invoke({
          name: "settings.desktop.select-host",
          arguments: { kind: "local" },
        }),
      ).rejects.toThrow("originating Cake desktop");
      await call("settings.desktop.select-host", {
        kind: "remote",
        url: "http://example.test:4317/",
      });
      expect(select).toHaveBeenCalledWith(
        { kind: "remote", url: "ws://example.test:4317/rpc" },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      const sharing = origin.root.settingsStore.desktopSharing;
      sharing.apply({ status: "disabled", bind: "127.0.0.1", port: 4317 });
      const enable = call("settings.desktop.sharing", {
        enabled: true,
        bind: "127.0.0.1",
        port: 4317,
      });
      await started;
      expect(sharing.busy).toBe(true);
      await expect(
        call("settings.desktop.sharing", {
          enabled: false,
          bind: "127.0.0.1",
          port: 4317,
        }),
      ).rejects.toThrow("already changing");
      expect(configure).toHaveBeenCalledTimes(1);
      completeSharing({ status: "serving", bind: "127.0.0.1", port: 4317 });
      expect(await enable).toMatchObject({ value: { status: "serving" } });
      expect(sharing.busy).toBe(false);
      sharing.apply({ status: "serving", bind: "127.0.0.1", port: 4317 });
      await expect(
        call("settings.desktop.sharing", {
          enabled: true,
          bind: "127.0.0.1",
          port: 4400,
        }),
      ).rejects.toThrow("Disable desktop sharing");
      await expect(
        call("settings.dictation.update", { action: "enable", enabled: true }),
      ).rejects.toThrow("supported desktop");
      await call("settings.dictation.update", {
        action: "model-path",
        path: "/validated-native-model",
      });
      expect(release).toHaveBeenCalledTimes(1);
      expect(setModelPath).toHaveBeenCalledWith(
        "/validated-native-model",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      origin.root.speechSettingsStore.applySettings({
        ...speechOutputSettings(),
        keyConfigured: true,
        modelId: "eleven_flash_v2_5",
        speed: 1.1,
        voices: [{ id: "voice", name: "Saved voice" }],
      });
      expect(await call("settings.speech.get")).toMatchObject({
        value: { speed: 1.1, voices: [{ id: "voice", name: "Saved voice" }] },
      });
      expect(listVoices).not.toHaveBeenCalled();
      await call("settings.speech.set-voice", { voiceId: "voice" });
      expect(setVoice).toHaveBeenCalledWith(
        "voice",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      await expect(call("settings.speech.set-voice", { voiceId: "unknown" })).rejects.toThrow(
        "Choose a voice ID",
      );
      expect(setVoice).toHaveBeenCalledTimes(1);
      expect(await call("settings.speech.refresh-voices")).toMatchObject({
        value: [{ id: "voice", name: "Saved voice" }],
      });
      await expect(
        otherWindow.root.applicationControlStore.invoke({
          name: "settings.speech.get",
          arguments: {},
        }),
      ).rejects.toThrow("originating Cake desktop");
      origin.root.dictationStore.devices = [{ id: "origin-microphone", label: "Origin" }];
      await call("settings.dictation.update", {
        action: "microphone",
        deviceId: "origin-microphone",
      });
      expect(origin.root.dictationStore.deviceId).toBe("origin-microphone");
      expect(otherWindow.root.dictationStore.deviceId).toBe("");
      await expect(
        call("settings.dictation.update", { action: "microphone", deviceId: "unknown" }),
      ).rejects.toThrow("listed device");
    } finally {
      completeSharing({ status: "disabled", bind: "127.0.0.1", port: 4317 });
      origin[Symbol.dispose]();
      otherWindow[Symbol.dispose]();
      connection[Symbol.dispose]();
    }
  });

  it("launches the existing interactive provider flow, never reports cancelled authorization, and aborts before dispatch", async () => {
    const h = await fixture();
    try {
      let finish: (error?: Error) => void = () => {};
      const pending = new Promise<void>((resolve, reject) => {
        finish = (error) => (error ? reject(error) : resolve());
      });
      let started: () => void = () => {};
      const interactionStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      h.login.mockImplementationOnce(async () => {
        started();
        return pending;
      });
      let settled = false;
      const attempt = h
        .call("settings.providers.login", { provider: "fixture", authType: "oauth" })
        .finally(() => {
          settled = true;
        });
      await interactionStarted;
      expect(h.login).toHaveBeenCalledWith(
        { provider: "fixture", authType: "oauth" },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(settled).toBe(false);
      finish(new Error("Authentication cancelled"));
      await expect(attempt).rejects.toThrow("cancelled");
      const controller = new AbortController();
      controller.abort();
      const calls = h.dispatch.mock.calls.length;
      await expect(
        h.call("settings.pi.update", { key: "autoCompact", value: false }, controller.signal),
      ).rejects.toThrow();
      expect(h.dispatch).toHaveBeenCalledTimes(calls);
      await expect(h.call("settings.desktop.get")).rejects.toThrow("originating Cake desktop");
      await expect(h.call("settings.dictation.get")).rejects.toThrow("originating Cake desktop");
      expect(() =>
        Schema.decodeUnknownSync(AgentSettingsInvocation)(
          {
            name: "settings.providers.login",
            arguments: { provider: "fixture", authType: "oauth", credential: "secret" },
          },
          { onExcessProperty: "error" },
        ),
      ).toThrow();
    } finally {
      await h.dispose();
    }
  });
});
