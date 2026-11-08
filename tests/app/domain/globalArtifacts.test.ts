import { AgentControlTestLive } from "../helpers/agentControlTestLayer";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeChildProcessSpawner, NodeFileSystem, NodePath } from "@effect/platform-node-shared";
import { it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";
import { runSchedulePass } from "../../../src/domain/automations/automationWorker";
import { ArtifactRuntimeHostLive } from "../../../src/layers/ArtifactRuntimeHostLive";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import { modelPresetPromptsTestLayer } from "../helpers/modelPresetPrompts";
import { defaultApplicationState } from "../../../src/contracts/application/application-data";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import { unusedEndpointServices } from "../ipc/rpc-endpoint-test-backend";
import { makeHeadlessProjectSessionRuntimeMechanismTestLayer } from "./projectSessionRuntimeTestLayer";
import { afterEach, describe, expect } from "vitest";
import {
  decodeArtifactLineageId,
  decodeArtifactRevisionNumber,
} from "../../../src/contracts/artifacts/artifact-lineage";
import type { ArtifactRuntimeDescriptor } from "../../../src/contracts/artifacts/artifact-runtime-descriptor";
import type { JsonValue } from "../../../src/contracts/serialization/json-contract";
import * as workflows from "../../../src/domain/artifacts/artifactWorkflows";
import * as artifacts from "../../../src/domain/artifacts/globalArtifacts";
import { ArtifactRuntime } from "../../../src/services/artifact-runtime/ArtifactRuntime";
import { ArtifactRuntimeLive } from "../../../src/services/artifact-runtime/ArtifactRuntimeLive";
import { ArtifactViewsLive } from "../../../src/services/artifacts/ArtifactViews";
import { AutomationRecords } from "../../../src/services/automations/AutomationRecords";
import {
  ClientConnections,
  ClientConnectionsLive,
} from "../../../src/services/clients/ClientConnections";
import { ClientEvents } from "../../../src/services/clients/ClientEvents";
import { RendererRequestCoordinator } from "../../../src/services/renderer-requests/RendererRequestCoordinator";
import { ArtifactStorage } from "../../../src/services/storage/ArtifactStorage";
import { makeArtifactStorageLive } from "../../../src/services/storage/ArtifactStorageLive";
import {
  AutomationStorage,
  type AutomationLedger,
} from "../../../src/services/storage/AutomationStorage";
import { SessionFamilyStorage } from "../../../src/services/storage/SessionFamilyStorage";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const lineageId = decodeArtifactLineageId("pr-dashboard");
const documentId = decodeArtifactLineageId("ordinary-doc");
const revision = decodeArtifactRevisionNumber;
const source = `
return { tools: {
  refresh: async ({ repo }) => {
    const response = await cake("network.request", { url: "https://example.test/prs/" + repo });
    if (response.status !== 200) throw new Error("PR refresh failed: HTTP " + response.status);
    const dashboard = JSON.parse(response.body);
    await data.write(dashboard);
    return { count: dashboard.prs.length };
  },
  readiness: async () => {
    const stored = await data.read();
    const prs = stored?.prs ?? [];
    return { version: "first", ready: prs.filter(pr => pr.checks === "passing" && pr.reviews > 0).map(pr => pr.id),
      blocked: prs.filter(pr => pr.checks !== "passing" || pr.reviews === 0).map(pr => pr.id) };
  },
  sendToChat: async ({ sessionId }) => {
    const stored = await data.read();
    await cake("chat.prompt", { sessionId, text: JSON.stringify(stored) });
    return { sent: true };
  },
} };`;
const runtime: ArtifactRuntimeDescriptor = {
  source,
  tools: [
    {
      name: "refresh",
      description: "Refresh pull requests",
      inputSchema: {
        type: "object",
        required: ["repo"],
        properties: { repo: { type: "string" } },
        additionalProperties: false,
      },
      outputSchema: { type: "object", required: ["count"] },
    },
    {
      name: "readiness",
      description: "Find ready and blocked pull requests",
      inputSchema: { type: "object", additionalProperties: false },
      outputSchema: { type: "object", required: ["version", "ready", "blocked"] },
    },
    {
      name: "sendToChat",
      description: "Send data to a selected chat",
      inputSchema: {
        type: "object",
        required: ["sessionId"],
        properties: { sessionId: { type: "string" } },
        additionalProperties: false,
      },
      outputSchema: { type: "object", required: ["sent"] },
    },
  ],
};

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "cake-global-artifact-workflow-"));
  directories.push(root);
  const storage = makeArtifactStorageLive(root).pipe(
    Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)),
  );
  let ledger: AutomationLedger = {
    automations: [],
    occurrences: [],
    runs: [],
    artifactSchedules: [],
    pausedArtifactIds: [],
  };
  const records = AutomationRecords.layer.pipe(
    Layer.provide(
      Layer.succeed(AutomationStorage, {
        load: () => Effect.succeed(ledger),
        save: (next) =>
          Effect.sync(() => {
            ledger = next;
          }),
      }),
    ),
  );
  const events: string[] = [];
  const clients = Layer.mock(ClientEvents, {
    sendTo: () => false,
    broadcast: (event) => {
      events.push(event.type);
    },
  });
  const execution = ArtifactRuntimeLive.pipe(Layer.provide(Layer.merge(storage, clients)));
  const views = ArtifactViewsLive.pipe(Layer.provide(ClientConnectionsLive));
  const families = Layer.mock(SessionFamilyStorage, {
    withMemberLock: (_id, effect) => effect,
    familyForMember: () => Effect.succeed(undefined),
  });
  let callingWindow: number | undefined;
  const coordinator = Layer.mock(RendererRequestCoordinator, {
    connectionForSession: () => Effect.succeed(callingWindow),
  });
  const commands: Array<{ command: string; input: JsonValue; callingSessionId?: string }> = [];
  const layer = Layer.mergeAll(
    storage,
    records,
    clients,
    execution,
    views,
    ClientConnectionsLive,
    families,
    coordinator,
  );
  const initialize = (bindFakeHost = true) =>
    Effect.gen(function* () {
      yield* (yield* AutomationRecords).initialize();
      const connectionId = (yield* ClientConnections).desktop(17);
      callingWindow = connectionId;
      if (bindFakeHost)
        yield* (yield* ArtifactRuntime).setHost({
          invokeCommand: (request) =>
            Effect.sync((): JsonValue => {
              commands.push(request);
              if (request.command === "network.request")
                return {
                  ok: true,
                  command: "network.request",
                  status: 200,
                  headers: {},
                  encoding: "utf8",
                  body: JSON.stringify({
                    prs: [
                      { id: 12, checks: "passing", reviews: 2 },
                      { id: 13, checks: "failing", reviews: 1 },
                      { id: 14, checks: "passing", reviews: 0 },
                    ],
                  }),
                };
              return { ok: true };
            }),
        });
      yield* workflows.create({
        sessionId: "creator",
        lineageId,
        global: true,
        workingDirectory: "/project",
        snapshot: {
          protocol: "cake.artifact/v1",
          id: lineageId,
          sessionId: "creator",
          revision: 1,
          kind: "widget",
          title: "Pull requests",
          description: "Pull request readiness dashboard",
          fallback: { markdown: "PR dashboard" },
          payload: {
            language: "html",
            source: "<div>PR dashboard</div>",
            brief: "PR dashboard",
            browser: { digest: "b".repeat(64) },
            runtime,
          },
        },
      });
      yield* workflows.create({
        sessionId: "creator",
        lineageId: documentId,
        workingDirectory: "/project",
        snapshot: {
          protocol: "cake.artifact/v1",
          id: documentId,
          sessionId: "creator",
          revision: 1,
          kind: "markdown",
          payload: { markdown: "Ordinary documentation" },
          fallback: { markdown: "Ordinary documentation" },
        },
      });
      return connectionId;
    });
  return {
    layer,
    initialize: initialize(),
    initializeWithoutHost: initialize(false),
    commands,
    events,
    persisted: () => ledger,
  };
};
const view = (number: number) => ({
  lineageId,
  revision: revision(number),
  surface: "pane" as const,
});
const refresh = () =>
  artifacts.callTool({ lineageId, name: "refresh", input: { repo: "cake" } }, "creator");
const configure = () =>
  artifacts.invokeGlobalArtifactCommand(
    "artifacts.schedules.configure",
    {
      lineageId,
      name: "refresh-prs",
      handler: "refresh",
      input: { repo: "cake" },
      schedule: { _tag: "Interval", startsAt: "2030-01-01T00:01:00.000Z", everySeconds: 60 },
    },
    "creator",
  );

describe("global artifact domain workflow", () => {
  it.live(
    "runs a closed-view semantic tool through the canonical Cake bridge into a real subprocess without caller or window",
    () =>
      Effect.gen(function* () {
        const f = yield* Effect.promise(fixture);
        const context = yield* Layer.build(
          Layer.mergeAll(
            unusedEndpointServices,
            AgentControlTestLive,
            makeHeadlessProjectSessionRuntimeMechanismTestLayer(),
            Layer.mock(ApplicationState, { snapshot: defaultApplicationState }),
            modelPresetPromptsTestLayer,
            f.layer,
            NodeChildProcessSpawner.layer.pipe(
              Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)),
            ),
          ),
        );
        yield* Effect.gen(function* () {
          yield* f.initializeWithoutHost;
          yield* Layer.build(ArtifactRuntimeHostLive);
          yield* artifacts.publishRuntime(
            {
              lineageId,
              expectedRevision: revision(1),
              runtime: {
                source: `return { tools: { cli: input => cake("shell.run", input) } };`,
                tools: [
                  {
                    name: "cli",
                    description: "Run a local CLI",
                    inputSchema: { type: "object" },
                    outputSchema: true,
                  },
                ],
              },
            },
            "creator",
          );
          expect(
            yield* artifacts.callTool({
              lineageId,
              name: "cli",
              input: {
                command: "printf 'closed view' | tr ' ' '-'; printf 'diagnostic' >&2; exit 9",
                cwd: tmpdir(),
              },
            }),
          ).toEqual({
            stdout: "closed-view",
            stderr: "diagnostic",
            exitCode: 9,
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
          });
          const timedOut = yield* artifacts.callTool({
            lineageId,
            name: "cli",
            input: {
              command: "printf '%s\\n' \"$$\"; exec sleep 60",
              cwd: tmpdir(),
              timeoutSeconds: 0.5,
            },
          });
          expect(timedOut).toMatchObject({ timedOut: true, exitCode: null });
          const { stdout } = yield* Schema.decodeUnknownEffect(
            Schema.Struct({ stdout: Schema.String }),
          )(timedOut);
          const pid = Number(stdout.trim());
          expect(pid).toBeGreaterThan(0);
          expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
        }).pipe(Effect.provide(context));
      }),
  );
  it.effect(
    "uses the canonical runtime host and real network command envelope with only HTTP faked",
    () =>
      Effect.gen(function* () {
        const f = yield* Effect.promise(fixture);
        const requests: string[] = [];
        let responseStatus = 200;
        const context = yield* Layer.build(
          Layer.mergeAll(
            unusedEndpointServices,
            AgentControlTestLive,
            makeHeadlessProjectSessionRuntimeMechanismTestLayer(),
            Layer.mock(ApplicationState, { snapshot: defaultApplicationState }),
            modelPresetPromptsTestLayer,
            f.layer,
            Layer.succeed(
              HttpClient.HttpClient,
              HttpClient.make((request) => {
                requests.push(request.url);
                return Effect.succeed(
                  HttpClientResponse.fromWeb(
                    request,
                    new Response(
                      JSON.stringify({
                        prs: [
                          { id: 12, checks: "passing", reviews: 2 },
                          { id: 13, checks: "failing", reviews: 1 },
                        ],
                      }),
                      { status: responseStatus, headers: { "content-type": "application/json" } },
                    ),
                  ),
                );
              }),
            ),
          ),
        );
        yield* Effect.gen(function* () {
          yield* f.initializeWithoutHost;
          yield* Layer.build(ArtifactRuntimeHostLive);
          expect(
            yield* artifacts.callTool({ lineageId, name: "refresh", input: { repo: "cake" } }),
          ).toEqual({ count: 2 });
          expect(yield* artifacts.callTool({ lineageId, name: "readiness", input: {} })).toEqual({
            version: "first",
            ready: [12],
            blocked: [13],
          });
          expect(requests).toEqual(["https://example.test/prs/cake"]);
          responseStatus = 418;
          const rejected = yield* artifacts
            .callTool({ lineageId, name: "refresh", input: { repo: "cake" } })
            .pipe(Effect.result);
          expect(rejected._tag).toBe("Failure");
          if (rejected._tag === "Failure") expect(rejected.failure.message).toContain("HTTP 418");
          expect((yield* (yield* ArtifactStorage).readState(lineageId)).version).toBe(1);
          expect(f.commands).toEqual([]);
        }).pipe(Effect.provide(context));
      }),
  );

  it.effect(
    "rejects canonical same-runtime execution/control before mutations while external and cross-artifact calls still work",
    () =>
      Effect.gen(function* () {
        const f = yield* Effect.promise(fixture);
        const context = yield* Layer.build(
          Layer.mergeAll(
            unusedEndpointServices,
            AgentControlTestLive,
            makeHeadlessProjectSessionRuntimeMechanismTestLayer(),
            Layer.mock(ApplicationState, { snapshot: defaultApplicationState }),
            modelPresetPromptsTestLayer,
            f.layer,
          ),
        );
        yield* Effect.gen(function* () {
          yield* f.initializeWithoutHost;
          yield* Layer.build(ArtifactRuntimeHostLive);
          const selfRuntime: ArtifactRuntimeDescriptor = {
            source: `return {tools:{ forward: ({command,input}) => cake(command,input), ping: () => ({ready:true}) }};`,
            tools: [
              {
                name: "forward",
                description: "Exercise the canonical Cake bridge",
                inputSchema: { type: "object", required: ["command", "input"] },
                outputSchema: true,
              },
              {
                name: "ping",
                description: "Read readiness",
                inputSchema: { type: "object" },
                outputSchema: { type: "object", required: ["ready"] },
              },
            ],
          };
          yield* artifacts.publishRuntime(
            { lineageId, expectedRevision: revision(1), runtime: selfRuntime },
            "creator",
          );
          yield* artifacts.invokeGlobalArtifactCommand("artifacts.schedules.configure", {
            lineageId,
            name: "keep",
            handler: "ping",
            input: {},
            schedule: { _tag: "Interval", startsAt: "2030-01-01T00:01:00.000Z", everySeconds: 60 },
          });
          const before = f.persisted().artifactSchedules;
          const operations: Array<{ command: string; input: JsonValue }> = [
            ...["pause", "resume", "start", "restart"].map((action) => ({
              command: `artifacts.runtime.${action}`,
              input: { lineageId },
            })),
            { command: "artifacts.delete", input: { lineageId } },
            { command: "artifacts.call", input: { lineageId, name: "ping", input: {} } },
            {
              command: "artifacts.command",
              input: {
                lineageId: documentId,
                command: "artifacts.runtime.pause",
                input: { lineageId },
              },
            },
            {
              command: "artifacts.runtime.publish",
              input: {
                lineageId,
                expectedRevision: 2,
                runtime: { source: "return {tools:{}};", tools: [] },
              },
            },
            {
              command: "artifacts.restore",
              input: { lineageId, sourceRevision: 1, expectedRevision: 2 },
            },
            {
              command: "artifacts.replace",
              input: { lineageId, expectedRevision: 2, instructions: "Change the view" },
            },
          ];
          for (const operation of operations) {
            const result = yield* artifacts
              .callTool({ lineageId, name: "forward", input: operation }, CAKE_CHAT_SESSION_ID)
              .pipe(Effect.result);
            expect(result._tag).toBe("Failure");
            if (result._tag === "Failure")
              expect(result.failure.message).toContain(
                "cannot synchronously execute or control its own runtime",
              );
          }
          expect((yield* artifacts.executionStatus(lineageId)).backgroundPaused).toBe(false);
          expect(f.persisted().artifactSchedules).toEqual(before);
          expect((yield* (yield* ArtifactStorage).read(lineageId))?.metadata.revision).toBe(2);
          expect(yield* artifacts.callTool({ lineageId, name: "ping", input: {} })).toEqual({
            ready: true,
          });
          expect(
            yield* artifacts.callTool({
              lineageId,
              name: "forward",
              input: { command: "artifacts.tools", input: { lineageId } },
            }),
          ).toMatchObject({ lineageId, tools: selfRuntime.tools });
          expect(
            yield* artifacts.callTool({
              lineageId,
              name: "forward",
              input: { command: "artifacts.inspect", input: { lineageId: documentId } },
            }),
          ).toMatchObject({ artifact: { id: documentId }, execution: { executable: false } });
          const other = decodeArtifactLineageId("other-runtime");
          const published = yield* (yield* ArtifactStorage).read(lineageId);
          if (!published) return yield* Effect.fail(new Error("Missing runtime test fixture"));
          yield* workflows.create({
            sessionId: "creator",
            lineageId: other,
            global: true,
            workingDirectory: "/project",
            snapshot: { ...published.snapshot, id: other, revision: 1 },
          });
          expect(
            yield* artifacts.callTool({
              lineageId,
              name: "forward",
              input: {
                command: "artifacts.call",
                input: { lineageId: other, name: "ping", input: {} },
              },
            }),
          ).toEqual({ ready: true });
          yield* artifacts.invokeGlobalArtifactCommand("artifacts.schedules.configure", {
            lineageId,
            name: "self-pause",
            handler: "forward",
            input: { command: "artifacts.runtime.pause", input: { lineageId } },
            schedule: { _tag: "Once", at: "2030-01-01T00:01:00.000Z" },
          });
          yield* TestClock.setTime(new Date("2030-01-01T00:01:00.000Z").getTime());
          yield* runSchedulePass((schedule) =>
            artifacts.callTool({
              lineageId: schedule.lineageId,
              name: schedule.handler,
              input: schedule.input,
            }),
          );
          expect(
            f.persisted().artifactSchedules.find((schedule) => schedule.name === "self-pause"),
          ).toMatchObject({
            lastOutcome: "failed",
            lastError: expect.stringContaining(
              "cannot synchronously execute or control its own runtime",
            ),
          });
          expect((yield* artifacts.executionStatus(lineageId)).backgroundPaused).toBe(false);
          yield* artifacts.controlRuntime(lineageId, "pause");
          expect((yield* artifacts.executionStatus(lineageId)).backgroundPaused).toBe(true);
        }).pipe(Effect.provide(context));
      }),
  );

  it.effect(
    "discovers a global PR tool surface and refreshes, evaluates and sends data after closing its view",
    () =>
      Effect.gen(function* () {
        const f = yield* Effect.promise(fixture);
        yield* Effect.gen(function* () {
          const connectionId = yield* f.initialize;
          expect(
            yield* artifacts.invokeGlobalArtifactCommand("artifacts.globals", {}, "creator"),
          ).toMatchObject({
            artifacts: [
              { id: lineageId, global: true, description: "Pull request readiness dashboard" },
            ],
            total: 1,
          });
          expect(
            yield* artifacts.invokeGlobalArtifactCommand(
              "artifacts.tools",
              { lineageId },
              "creator",
            ),
          ).toMatchObject({ tools: runtime.tools });
          expect(
            yield* artifacts.invokeGlobalArtifactCommand(
              "artifacts.tools",
              { lineageId: documentId },
              "creator",
            ),
          ).toMatchObject({ tools: [] });
          expect((yield* artifacts.executionStatus(documentId)).executable).toBe(false);
          expect((yield* (yield* ArtifactRuntime).status(documentId)).running).toBe(false);
          expect((yield* (yield* ArtifactRuntime).status(lineageId)).running).toBe(false);
          yield* artifacts.reportViewing(connectionId, {
            navigation: null,
            visible: [view(1)],
            active: view(1),
          });
          expect(
            yield* artifacts.invokeGlobalArtifactCommand("artifacts.viewing", {}, "creator"),
          ).toMatchObject({
            callingWindow: connectionId,
            windows: [{ connectionId, visible: [view(1)], active: view(1) }],
          });
          yield* artifacts.reportViewing(connectionId, { navigation: null, visible: [] });
          expect((yield* (yield* ArtifactRuntime).status(lineageId)).running).toBe(true);
          expect(yield* refresh()).toEqual({ count: 3 });
          expect(
            yield* artifacts.callTool({ lineageId, name: "readiness", input: {} }, "creator"),
          ).toEqual({ version: "first", ready: [12], blocked: [13, 14] });
          expect(
            yield* artifacts.callTool(
              { lineageId, name: "sendToChat", input: { sessionId: "chosen-chat" } },
              "creator",
            ),
          ).toEqual({ sent: true });
          expect(f.commands.map((request) => request.command)).toEqual([
            "network.request",
            "chat.prompt",
          ]);
          expect(f.commands[1]).toMatchObject({
            input: { sessionId: "chosen-chat" },
            callingSessionId: "creator",
          });
          expect((yield* (yield* ArtifactStorage).readState(lineageId)).value).toMatchObject({
            prs: [{ id: 12 }, { id: 13 }, { id: 14 }],
          });
        }).pipe(Effect.provide(f.layer));
      }),
  );

  it.effect(
    "delivers initial and changed navigation to mounted runtime views per genuine connection without leaking UI scope to background calls",
    () =>
      Effect.gen(function* () {
        const f = yield* Effect.promise(fixture);
        yield* Effect.gen(function* () {
          const connectionId = yield* f.initialize;
          const otherConnection = (yield* ClientConnections).desktop(18);
          yield* artifacts.publishRuntime(
            {
              lineageId,
              expectedRevision: revision(1),
              runtime: {
                source: `let contexts = []; return { tools: { contexts: async () => { await cake("network.request", {url:"https://example.test/prs/background"}); return contexts; } }, lifecycle: { context: async (event) => { contexts.push(event); } } };`,
                tools: [
                  {
                    name: "contexts",
                    description: "Read observed contexts",
                    inputSchema: { type: "object" },
                    outputSchema: { type: "array" },
                  },
                ],
              },
            },
            "creator",
          );
          const a = {
            windowId: "renderer-a",
            project: { path: "/a", name: "A" },
            session: { sessionId: "a1", kind: "project-session" as const },
          };
          const b = { windowId: "renderer-b", project: { path: "/b", name: "B" }, session: null };
          yield* artifacts.reportViewing(connectionId, { navigation: a, visible: [view(2)] });
          // Repeated publication of identical facts is not another navigation event.
          yield* artifacts.reportViewing(connectionId, { navigation: a, visible: [view(2)] });
          yield* artifacts.reportViewing(otherConnection, { navigation: b, visible: [view(2)] });
          const changed = { ...a, session: { sessionId: "a2", kind: "project-session" as const } };
          yield* artifacts.reportViewing(connectionId, { navigation: changed, visible: [view(2)] });
          const contexts = yield* artifacts.callTool({ lineageId, name: "contexts", input: {} });
          expect(contexts).toEqual([
            expect.objectContaining({
              name: "context",
              windowConnectionId: connectionId,
              viewId: `${connectionId}:${lineageId}@r2:pane`,
              navigation: a,
            }),
            expect.objectContaining({
              name: "context",
              windowConnectionId: otherConnection,
              navigation: b,
            }),
            expect.objectContaining({
              name: "context",
              windowConnectionId: connectionId,
              navigation: changed,
            }),
          ]);
          expect(f.commands.at(-1)).not.toHaveProperty("windowConnectionId");
          expect(f.commands.at(-1)).not.toHaveProperty("callingSessionId");
          expect(
            yield* artifacts.invokeGlobalArtifactCommand("artifacts.viewing", {}),
          ).toMatchObject({
            windows: [
              { connectionId, navigation: changed },
              { connectionId: otherConnection, navigation: b },
            ],
          });
          yield* artifacts.reportViewing(connectionId, { navigation: changed, visible: [] });
          yield* artifacts.reportViewing(connectionId, { navigation: a, visible: [] });
          expect(
            yield* artifacts.callTool({ lineageId, name: "contexts", input: {} }),
          ).toHaveLength(3);
          yield* artifacts.reportViewing(connectionId, { navigation: a, visible: [view(2)] });
          expect(
            yield* artifacts.callTool({ lineageId, name: "contexts", input: {} }),
          ).toHaveLength(4);
        }).pipe(Effect.provide(f.layer));
      }),
  );

  it.effect(
    "keeps historical views inert after publication and does not resume paused schedules when reopening",
    () =>
      Effect.gen(function* () {
        const f = yield* Effect.promise(fixture);
        yield* Effect.gen(function* () {
          const connectionId = yield* f.initialize;
          yield* artifacts.reportViewing(connectionId, { navigation: null, visible: [view(1)] });
          yield* refresh();
          yield* artifacts.reportViewing(connectionId, { navigation: null, visible: [] });
          yield* artifacts.publishRuntime(
            {
              lineageId,
              expectedRevision: decodeArtifactRevisionNumber(1),
              runtime: {
                ...runtime,
                source: source.replace('version: "first"', 'version: "second"'),
              },
            },
            "creator",
          );
          expect(
            yield* artifacts.callTool({ lineageId, name: "readiness", input: {} }, "creator"),
          ).toEqual({ version: "second", ready: [12], blocked: [13, 14] });
          yield* configure();
          expect(
            (yield* artifacts.controlRuntime(lineageId, "pause", "creator")).backgroundPaused,
          ).toBe(true);
          yield* artifacts.reportViewing(connectionId, {
            navigation: null,
            visible: [view(1)],
            active: view(1),
          });
          expect((yield* (yield* ArtifactRuntime).status(lineageId)).running).toBe(false);
          yield* artifacts.reportViewing(connectionId, {
            navigation: null,
            visible: [view(2)],
            active: view(2),
          });
          const reopened = yield* artifacts.executionStatus(lineageId);
          expect(reopened).toMatchObject({
            running: true,
            revision: 2,
            backgroundPaused: true,
            schedules: [{ paused: true }],
          });
          expect(f.persisted().artifactSchedules[0]?.paused).toBe(true);
          expect((yield* (yield* ArtifactStorage).readState(lineageId)).value).toMatchObject({
            prs: [{ id: 12 }, { id: 13 }, { id: 14 }],
          });
          expect(
            (yield* artifacts.controlRuntime(lineageId, "resume", "creator")).backgroundPaused,
          ).toBe(false);
        }).pipe(Effect.provide(f.layer));
      }),
  );

  it.effect("keeps committed publication and restore successful when runtime reload fails", () =>
    Effect.gen(function* () {
      const f = yield* Effect.promise(fixture);
      yield* Effect.gen(function* () {
        const connectionId = yield* f.initialize;
        yield* artifacts.reportViewing(connectionId, { navigation: null, visible: [view(1)] });
        yield* refresh();
        const original = yield* workflows.readExactRevision(lineageId, revision(1));
        if (original.snapshot.kind !== "widget") throw new Error("Expected widget fixture");
        const failedSource = "throw new Error('reload failed')";
        const published = yield* workflows.publish({
          sessionId: "creator",
          lineageId,
          expectedLatestRevision: 1,
          workingDirectory: "/project",
          snapshot: {
            ...original.snapshot,
            revision: 2,
            payload: {
              ...original.snapshot.payload,
              runtime: { ...runtime, source: failedSource },
            },
          },
        });
        expect(published.metadata.revision).toBe(2);
        expect((yield* (yield* ArtifactStorage).read(lineageId))?.metadata.revision).toBe(2);
        expect(yield* (yield* ArtifactRuntime).status(lineageId)).toMatchObject({
          running: false,
          lastError: expect.stringContaining("reload failed"),
        });
        yield* workflows.restore({
          sessionId: "creator",
          lineageId,
          expectedLatestRevision: 2,
          sourceRevision: revision(1),
          workingDirectory: "/project",
        });
        yield* artifacts.controlRuntime(lineageId, "start", "creator");
        const restored = yield* workflows.restore({
          sessionId: "creator",
          lineageId,
          expectedLatestRevision: 3,
          sourceRevision: revision(2),
          workingDirectory: "/project",
        });
        expect(restored.metadata.revision).toBe(4);
        expect((yield* (yield* ArtifactStorage).read(lineageId))?.metadata.revision).toBe(4);
        expect(yield* (yield* ArtifactRuntime).status(lineageId)).toMatchObject({
          running: false,
          lastError: expect.stringContaining("reload failed"),
        });
        expect((yield* (yield* ArtifactStorage).readState(lineageId)).value).toMatchObject({
          prs: [{ id: 12 }, { id: 13 }, { id: 14 }],
        });
      }).pipe(Effect.provide(f.layer));
    }),
  );

  it.effect("deletion stops execution and removes schedules, paused state, links and data", () =>
    Effect.gen(function* () {
      const f = yield* Effect.promise(fixture);
      yield* Effect.gen(function* () {
        yield* f.initialize;
        yield* refresh();
        yield* configure();
        yield* artifacts.controlRuntime(lineageId, "pause", "creator");
        yield* artifacts.controlRuntime(lineageId, "start", "creator");
        expect((yield* (yield* ArtifactRuntime).status(lineageId)).running).toBe(true);
        yield* artifacts.deleteArtifact(lineageId);
        expect((yield* (yield* ArtifactRuntime).status(lineageId)).running).toBe(false);
        const storage = yield* ArtifactStorage;
        expect(yield* storage.read(lineageId)).toBeUndefined();
        expect((yield* storage.catalog()).links.map((link) => link.lineageId)).toEqual([
          documentId,
        ]);
        expect((yield* storage.readState(lineageId).pipe(Effect.result))._tag).toBe("Failure");
        expect(f.persisted().artifactSchedules).toEqual([]);
        expect(f.persisted().pausedArtifactIds).toEqual([]);
        expect(f.events).toContain("artifact-catalog-invalidated");
      }).pipe(Effect.provide(f.layer));
    }),
  );
});
