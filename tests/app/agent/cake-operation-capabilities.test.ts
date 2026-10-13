import { afterEach, describe, expect, it, vi } from "vitest";
import { Schema } from "effect";
import { CakeOperationRegistry } from "../../../src/services/pi/runtime/cake-operation-registry";
import { projectCakeOperations } from "../../../src/layers/CakeOperations";
import * as projectSessionOperations from "../../../src/domain/project-sessions/cake-session-operations";
import { createConversationOperations } from "../../../src/domain/conversations/cake-conversation-operations";
import type { CakeOperationOptions } from "../../../src/contracts/agent/cake-operation-options";
import type { ProjectCakeOperations } from "../../../src/contracts/agent/cake-operation-api";

type CurrentSessionControl = NonNullable<CakeOperationOptions["currentSessionControl"]>;

const bridge: Parameters<ProjectCakeOperations>[0] = {
  host: { appendEntry: () => undefined },
  api: () => {
    throw new Error("Operation registration must not access the lazy runtime API");
  },
  sessionId: () => "session-1",
  publishSnapshot: async () => undefined,
  getAvailableOfType: async () => [],
};

function control(overrides: Partial<CurrentSessionControl> = {}): CurrentSessionControl {
  return {
    resolved: () => false,
    setResolved: async () => undefined,
    readPolicy: async () => ({ canFork: true, deferResolution: true }),
    resolveDeferredStandalone: async () => undefined,
    ...overrides,
  };
}

function operations(overrides: Partial<CakeOperationOptions> = {}) {
  return projectCakeOperations({ cwd: "/project", ...overrides })(bridge);
}

function commands(overrides: Partial<CakeOperationOptions> = {}) {
  return operations(overrides).map((operation) => operation.command);
}

afterEach(() => vi.restoreAllMocks());

describe("Project Session operation capabilities", () => {
  it("keeps local operations available without a current-session control", () => {
    const definitions = operations();
    expect(definitions.map((operation) => operation.command)).toEqual(
      expect.arrayContaining(["session.info", "session.rename", "session.usage", "context.status"]),
    );
    expect(definitions.every((operation) => operation.requires === undefined)).toBe(true);
  });

  it.each([
    {
      capability: "createSession",
      overrides: { createSession: async () => null },
      enabled: ["session.create"],
    },
    {
      capability: "createDraftSession",
      overrides: { createDraftSession: async () => null },
      enabled: ["session.create-draft"],
    },
    {
      capability: "forkSession",
      overrides: { forkSession: async () => null },
      enabled: ["session.fork"],
    },
    {
      capability: "createChildSession",
      overrides: { createChildSession: async () => null },
      enabled: ["sessions.create-child"],
    },
    {
      capability: "mergeSession",
      overrides: { mergeSession: async () => null },
      enabled: ["session.merge", "sessions.merge"],
    },
    {
      capability: "discardSession",
      overrides: { discardSession: async () => null },
      enabled: ["session.discard", "sessions.discard"],
    },
    {
      capability: "pendingMessages",
      overrides: { pendingMessages: async () => ({ items: [] }) },
      enabled: ["sessions.pending"],
    },
    {
      capability: "reorderPendingMessage",
      overrides: { reorderPendingMessage: async () => ({ items: [] }) },
      enabled: ["sessions.reorder"],
    },
  ] satisfies Array<{
    capability: keyof CurrentSessionControl;
    overrides: Partial<CurrentSessionControl>;
    enabled: string[];
  }>)(
    "uses the declared $capability without requiring an app gateway",
    ({ capability, overrides, enabled }) => {
      const baseline = commands({ currentSessionControl: control() });
      for (const command of enabled) expect(baseline).not.toContain(command);
      const definitions = operations({ currentSessionControl: control(overrides) });
      expect(
        definitions
          .filter((operation) => operation.requires === capability)
          .map((operation) => operation.command),
      ).toEqual(enabled);
      expect(definitions.map((operation) => operation.command)).not.toContain("app.state");
    },
  );

  it("gates app-backed operations, including generated definitions, on invokeAppControl", () => {
    const definitions = operations({
      currentSessionControl: control({ invokeAppControl: async () => null }),
    });
    const appBacked = [
      "app.state",
      "app.split",
      "app.user-selection",
      "settings.get",
      "settings.update",
      "project.settings.get",
      "session-labels.list",
      "notifications.send",
      "sessions.list",
      "sessions.open",
      "sessions.history",
      "sessions.cancel-queued",
      "sessions.send-batch",
      "sessions.schedule",
    ];
    const withoutGateway = commands({ currentSessionControl: control() });
    for (const command of appBacked) {
      expect(definitions.find((operation) => operation.command === command)?.requires).toBe(
        "invokeAppControl",
      );
      expect(withoutGateway).not.toContain(command);
    }
  });

  it("advertises the exact session navigation schema and user-owned permission in Cake help", () => {
    const definitions = operations({
      currentSessionControl: control({ invokeAppControl: async () => null }),
    });
    const navigation = definitions.find((operation) => operation.command === "sessions.open");
    expect(navigation).toBeDefined();
    if (!navigation) throw new Error("Expected navigation capability");
    expect(
      Schema.toStandardJSONSchemaV1(navigation.inputSchema)["~standard"].jsonSchema.input({
        target: "draft-07",
      }),
    ).toMatchObject({
      type: "object",
      properties: {
        sessionId: { type: "string", minLength: 1, maxLength: 256 },
        messageId: { type: "string", minLength: 1, maxLength: 256 },
      },
      required: ["sessionId"],
      additionalProperties: false,
    });
    const registry = new CakeOperationRegistry(definitions);
    expect(registry.topicHelp("sessions")).toContain("sessions.open —");
    expect(registry.operationHelp("sessions.open")).toContain("Settings → Agent");
    expect(registry.operationHelp("sessions.open")).toContain("cannot be changed by an agent");
    expect(registry.operationHelp("sessions.open")).toContain("Enabled by default");
  });

  it.each([undefined, true, false])(
    "honors canResolve=%s for the setResolved capability",
    (canResolve) => {
      const available = commands({
        currentSessionControl: control({
          canResolve: canResolve === undefined ? undefined : () => canResolve,
        }),
      });
      expect(available.includes("session.resolve")).toBe(canResolve !== false);
    },
  );

  it("uses capability metadata rather than command names or prefixes", () => {
    const create = projectSessionOperations.createProjectSessionOperations(bridge.api)[0];
    const info = createConversationOperations(bridge.api)[0];
    if (!create || !info) throw new Error("Expected real create and info definitions");
    vi.spyOn(projectSessionOperations, "createProjectSessionOperations").mockReturnValue([
      { ...create, command: "app.renamed-create" },
      { ...info, command: "sessions.local-info" },
    ]);
    const unavailable = commands();
    expect(unavailable).not.toContain("app.renamed-create");
    expect(unavailable).toContain("sessions.local-info");
    expect(
      commands({ currentSessionControl: control({ createSession: async () => null }) }),
    ).toContain("app.renamed-create");
  });

  it("still applies explicit grants and read-only auxiliary restrictions", () => {
    const currentSessionControl = control({ invokeAppControl: async () => null });
    expect(commands({ currentSessionControl, allowedCakeOperations: ["app.state"] })).toEqual([
      "app.state",
    ]);
    expect(commands({ allowedCakeOperations: ["app.state"] })).toEqual([]);
    expect(commands({ currentSessionControl, auxiliary: true })).toEqual([
      "session.info",
      "session.usage",
      "context.status",
    ]);
  });
});
