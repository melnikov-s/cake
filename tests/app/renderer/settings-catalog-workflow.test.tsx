/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { Effect, Fiber, Layer, ManagedRuntime, Schema, Stream } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultApplicationState,
  type ApplicationState as ApplicationValue,
} from "../../../src/contracts/application/application-data";
import { AgentSettingsInvocation } from "../../../src/contracts/application/agent-settings-schema";
import { settingsCatalog } from "../../../src/contracts/application/settings-catalog";
import type { CakeEvent } from "../../../src/contracts/application/cake-rpc-contract";
import type { JsonObject } from "../../../src/contracts/serialization/json-contract";
import * as application from "../../../src/domain/application/application";
import * as backendSettings from "../../../src/domain/application/agentSettings";
import { createCakeSettingsOperations } from "../../../src/domain/application/cake-settings-operations";
import { withChatContextLimit } from "../../../src/domain/cake-chats/cake-chat-context-limit-setting";
import { SettingsCakeChatSection } from "../../../src/renderer/components/settings-cake-chat-section";
import { CakeOperationRegistry } from "../../../src/services/pi/runtime/cake-operation-registry";
import { CakeSessionRuntimes } from "../../../src/services/pi/CakeSessionRuntimes";
import { makePiSettingsLayer } from "../../../src/services/pi/PiSettings";
import { mergePiExecutionSetting } from "../../../src/services/pi/live/PiSettingsLive";
import { ClientEvents } from "../../../src/services/clients/ClientEvents";
import { PiModels } from "../../../src/services/pi/PiModels";
import { McpSettings } from "../../../src/services/pi/McpSettings";
import { ProjectAccess } from "../../../src/services/projects/ProjectAccess";
import { WidgetPackages } from "../../../src/services/widgets/WidgetPackages";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import { ApplicationStorage } from "../../../src/services/storage/ApplicationStorage";
import { createRendererStoreFixture } from "./renderer-store-fixture";

afterEach(cleanup);

/** Real application state, Pi settings manager and renderer Settings Stores; only disk is faked. */
async function fixture() {
  let saved: ApplicationValue = defaultApplicationState();
  let document = "{}";
  const reloads: string[] = [];
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
  // Assigned once the renderer root exists; mirrors application-events' pi-settings-changed.
  let onEvent: (event: CakeEvent) => void = () => undefined;
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
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
      Layer.mock(ClientEvents, { sendTo: () => false, broadcast: (event) => onEvent(event) }),
      Layer.mock(CakeSessionRuntimes, {
        reloadAll: () => Effect.sync(() => void reloads.push("all")),
      }),
      // Not used by catalog settings; present because the settings dispatcher can reach them.
      Layer.mock(PiModels, {}),
      Layer.mock(ProjectAccess, {}),
      Layer.mock(McpSettings, {}),
      Layer.mock(WidgetPackages, { directory: "/backend/widget-packages" }),
    ),
  );
  await runtime.runPromise(Effect.flatMap(ApplicationState, (owner) => owner.initialize()));
  const root = createRendererStoreFixture({
    client: {
      workspaces: {
        setCakeChatPreferences: (preferences, options) =>
          runtime.runPromise(application.setCakeChatPreferences(preferences), options),
      },
    },
  });
  const settings = root.root.settingsStore;
  onEvent = (event) => {
    if (event.type === "pi-settings-changed") settings.providers.piSettings = event.settings;
  };
  // The window observes main-owned application state exactly as the real observer does.
  const observation = runtime.runFork(
    Effect.flatMap(ApplicationState, (owner) =>
      Stream.runForEach(owner.changes(), (projection) =>
        Effect.sync(() => settings.applyApplicationState(projection.revision, projection.state)),
      ),
    ),
  );
  const dispatch = (command: string, input: JsonObject) =>
    runtime.runPromise(
      Schema.decodeUnknownEffect(AgentSettingsInvocation)(
        { name: command, arguments: input },
        { onExcessProperty: "error" },
      ).pipe(
        Effect.flatMap((invocation) =>
          backendSettings.invoke(invocation, { kind: "cake-chat", workingDirectory: "/home" }),
        ),
      ),
    );
  const registry = new CakeOperationRegistry(createCakeSettingsOperations(dispatch));
  const call = async (command: string, input: JsonObject = {}) =>
    Schema.decodeUnknownSync(Schema.Struct({ result: Schema.Struct({ value: Schema.Unknown }) }))(
      (
        await registry.invoke(
          { command, input },
          { signal: new AbortController().signal, toolCallId: "catalog", runtime: {} },
        )
      ).structuredContent,
    ).result.value;
  return {
    registry,
    call,
    settings,
    manager,
    reloads,
    saved: () => saved,
    document: () => JSON.parse(document),
    async [Symbol.asyncDispose]() {
      root[Symbol.dispose]();
      await runtime.runPromise(Fiber.interrupt(observation));
      await runtime.dispose();
    },
  };
}

const ListResult = Schema.Struct({
  settings: Schema.Array(
    Schema.Struct({
      key: Schema.String,
      page: Schema.String,
      label: Schema.String,
      type: Schema.String,
      value: Schema.Unknown,
      default: Schema.Unknown,
      customized: Schema.Boolean,
    }),
  ),
  otherSettings: Schema.Array(Schema.Struct({ area: Schema.String })),
  unavailable: Schema.Array(Schema.Struct({ setting: Schema.String, reason: Schema.String })),
});

describe("settings catalog through the cake tool", () => {
  it("lists every catalog setting with value, type and default, plus where the rest live", async () => {
    await using h = await fixture();
    await h.call("settings.update", {
      key: "instructions.global",
      value: "Prefer tests. ".repeat(40),
    });
    const listed = Schema.decodeUnknownSync(ListResult)(await h.call("settings.list"));
    expect(listed.settings.map((setting) => setting.key)).toEqual(
      settingsCatalog.map((setting) => setting.key),
    );
    expect(listed.settings).toContainEqual({
      key: "cakeChat.contextLimitTokens",
      page: "Cake Chat",
      label: "Active context limit",
      type: "32000 | 64000 | 128000 | 200000 | 300000 | 500000 | 1000000",
      value: 300_000,
      default: 300_000,
      customized: false,
    });
    expect(listed.settings).toContainEqual(
      expect.objectContaining({
        key: "pi.autoCompact",
        page: "Agent",
        type: "boolean",
        value: true,
        default: true,
      }),
    );
    // Long prompt text is previewed so one list call stays bounded.
    const instructions = listed.settings.find((setting) => setting.key === "instructions.global");
    expect(instructions).toMatchObject({ customized: true, default: "" });
    expect(instructions?.value).toEqual(expect.stringContaining("[559 chars; read in full"));
    expect(listed.otherSettings.map((pointer) => pointer.area)).toEqual(
      expect.arrayContaining(["Provider accounts", "MCP servers", "Model presets"]),
    );
    expect(listed.unavailable.map((entry) => entry.setting).join("\n")).toContain("API keys");

    const filtered = Schema.decodeUnknownSync(ListResult)(
      await h.call("settings.list", { query: "context" }),
    );
    expect(filtered.settings.map((setting) => setting.key)).toContain(
      "cakeChat.contextLimitTokens",
    );
    expect(filtered.settings.every((setting) => setting.page !== "Network & privacy")).toBe(true);
  });

  it("gets one setting with its schema, default and effective result", async () => {
    await using h = await fixture();
    expect(await h.call("settings.get", { key: "cakeChat.contextLimitTokens" })).toMatchObject({
      key: "cakeChat.contextLimitTokens",
      description: expect.stringContaining("model window"),
      schema: {
        type: "number",
        enum: [32_000, 64_000, 128_000, 200_000, 300_000, 500_000, 1_000_000],
      },
      value: 300_000,
      default: 300_000,
      effective: { configuredLimitTokens: 300_000 },
    });
    expect(await h.call("settings.get", { key: "pi.transport" })).toMatchObject({
      type: '"sse" | "websocket" | "websocket-cached" | "auto"',
      value: "auto",
      default: "auto",
      effective: { value: "auto", reloadPending: false },
    });
  });

  it("raises the context limit live: store, renderer Settings UI and a later UI edit all agree", async () => {
    await using h = await fixture();
    render(<SettingsCakeChatSection settings={h.settings} />);
    const limit = screen.getByRole<HTMLSelectElement>("combobox", {
      name: "Cake Chat active context limit",
    });
    expect(limit.value).toBe("300000");

    expect(
      await h.call("settings.update", { key: "cakeChat.contextLimitTokens", value: 500_000 }),
    ).toEqual({
      key: "cakeChat.contextLimitTokens",
      label: "Active context limit",
      previous: 300_000,
      value: 500_000,
      effective: { configuredLimitTokens: 500_000, rule: expect.stringContaining("smaller") },
    });
    expect(h.saved().cakeChatPreferences?.contextLimitTokens).toBe(500_000);
    await waitFor(() => expect(limit.value).toBe("500000"));

    // A user's later Settings edit preserves the agent's change (no stale full-record overwrite).
    await userEvent
      .setup()
      .selectOptions(
        screen.getByRole("combobox", { name: "Cake Chat history-view budget" }),
        "80000",
      );
    await waitFor(() => expect(h.saved().cakeChatPreferences?.memoryViewBytes).toBe(80_000));
    expect(h.saved().cakeChatPreferences?.contextLimitTokens).toBe(500_000);
    expect(limit.value).toBe("500000");
  });

  it("updates Pi, model-choice, prompt and experimental settings through their own authorities", async () => {
    await using h = await fixture();
    expect(await h.call("settings.update", { key: "pi.autoCompact", value: false })).toMatchObject({
      previous: true,
      value: false,
      effective: { value: false },
    });
    expect(h.manager.getCompactionEnabled()).toBe(false);
    expect(h.reloads).toEqual(["all"]);
    expect(h.settings.providers.piSettings?.autoCompact).toBe(false);

    await h.call("settings.update", { key: "pi.codemodeInlineBudget", value: 500 });
    expect(h.document()).toMatchObject({ codemode: { inlineBudget: 500 } });
    await h.call("settings.update", {
      key: "pi.defaultModel",
      value: { provider: "fixture", modelId: "model-1" },
    });
    expect(await h.call("settings.get", { key: "pi.defaultModel" })).toMatchObject({
      value: { provider: "fixture", modelId: "model-1" },
    });

    await h.call("settings.update", {
      key: "cakeChat.summarizationModel",
      value: { source: "default" },
    });
    expect(h.saved().cakeChatPreferences?.summarizationModel).toEqual({ source: "default" });
    // Choosing the default source stores nothing, matching the Settings control.
    await h.call("settings.update", {
      key: "cakeChat.summarizationModel",
      value: { source: "utility" },
    });
    expect(h.saved().cakeChatPreferences).not.toHaveProperty("summarizationModel");

    await h.call("settings.update", { key: "prompts.worktreeCommit", value: "Commit first." });
    expect(h.saved().cakePrompts).toMatchObject({ worktreeCommit: "Commit first." });
    const reset = await h.call("settings.update", { key: "prompts.worktreeCommit", value: null });
    expect(reset).toMatchObject({ previous: "Commit first." });
    expect(h.saved().cakePrompts).not.toHaveProperty("worktreeCommit");

    await h.call("settings.update", { key: "experimental.dynamicWorkflows", value: true });
    expect(h.saved().experimentalFeatures).toEqual({ dynamicWorkflows: true });
    await h.call("settings.update", { key: "instructions.global", value: "  Be brief.  " });
    expect(await h.call("settings.get", { key: "instructions.global" })).toMatchObject({
      value: "Be brief.",
    });
  });

  it("rejects invalid values and unknown keys without changing anything", async () => {
    await using h = await fixture();
    const before = h.saved();
    for (const input of [
      // Not one of the limits offered in Settings, though within the stored range.
      { key: "cakeChat.contextLimitTokens", value: 400_000 },
      { key: "cakeChat.contextLimitTokens", value: "500000" },
      { key: "pi.codemodeInlineBudget", value: -1 },
      { key: "pi.transport", value: "carrier-pigeon" },
      { key: "cakeChat.summarizationModel", value: { source: "telepathy" } },
      { key: "models.defaultPreset", value: "00000000-0000-4000-8000-000000000001" },
      { key: "providers.openai.apiKey", value: "sk-never" },
    ])
      await expect(h.call("settings.update", input)).rejects.toThrow();
    await expect(
      h.call("settings.update", { key: "cakeChat.contextLimitTokens", value: 400_000 }),
    ).rejects.toThrow(/cakeChat\.contextLimitTokens/);
    expect(h.saved()).toBe(before);
    expect(h.reloads).toEqual([]);
  });

  it("never exposes credentials as setting keys or accepts them as values", async () => {
    await using h = await fixture();
    const listed = Schema.decodeUnknownSync(ListResult)(await h.call("settings.list"));
    for (const setting of listed.settings)
      expect(setting.key).not.toMatch(/api.?key|secret|password|credential|oauth|token(?!s$)/i);
    for (const key of ["speech.elevenLabsApiKey", "providers.anthropic.oauth", "mcp.env"])
      await expect(h.call("settings.get", { key })).rejects.toThrow();
    expect(h.registry.operationHelp("settings.update")).toContain("cakeChat.contextLimitTokens");
  });

  it("reports a permanent chat's own limit after the model-window minimum", async () => {
    await using h = await fixture();
    const [update] = withChatContextLimit(
      h.registry.definitions().filter((operation) => operation.command === "settings.update"),
      async () => ({
        systemTokens: 1,
        memoryTokens: 1,
        messageTokens: 1,
        totalTokens: 3,
        limitTokens: 183_616,
        configuredLimitTokens: 500_000,
        modelLimitTokens: 200_000,
      }),
    );
    if (!update) throw new Error("Expected settings.update");
    const result = await update.execute(
      { key: "cakeChat.contextLimitTokens", value: 500_000 },
      { signal: new AbortController().signal, toolCallId: "chat", runtime: {} },
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        previous: 300_000,
        value: 500_000,
        effective: {
          configuredLimitTokens: 500_000,
          thisChat: {
            limitTokens: 183_616,
            configuredLimitTokens: 500_000,
            modelLimitTokens: 200_000,
          },
        },
      },
    });
  });
});
