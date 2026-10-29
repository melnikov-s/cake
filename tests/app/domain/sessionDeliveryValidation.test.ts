import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, Layer, Schema, Stream } from "effect";
import { describe, expect } from "vitest";
import { defaultApplicationState } from "../../../src/contracts/application/application-data";
import { BackendAgentInvocation } from "../../../src/contracts/application/backend-agent-control";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import { SessionSendBatchInput } from "../../../src/contracts/conversations/session-send-batch";
import { forwardTaskInputControl } from "../../../src/domain/cake-chats/taskInputControls";
import * as agentMessaging from "../../../src/domain/application/agentSessionMessaging";
import { acquireOptions } from "../../../src/domain/project-sessions/projectSessionRuntime";
import { createSessionFamilyOperations } from "../../../src/domain/session-families/cake-session-family-operations";
import { routeCoordinatorMessage } from "../../../src/domain/session-families/sessionFamilies";
import {
  FamilyMessageInput,
  route,
} from "../../../src/domain/session-families/sessionFamilyMessaging";
import { CakeSessionRuntimes } from "../../../src/services/pi/CakeSessionRuntimes";
import { ProjectTodoReports } from "../../../src/services/projects/ProjectTodoReports";
import { SessionCatalogChanges } from "../../../src/services/session-catalogs/SessionCatalogChanges";
import { SessionCoordination } from "../../../src/services/session-catalogs/SessionCoordination";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import { SessionArchiveStorage } from "../../../src/services/storage/SessionArchiveStorage";
import { SessionFamilyStorage } from "../../../src/services/storage/SessionFamilyStorage";
import { TaskInputStorage } from "../../../src/services/storage/TaskInputStorage";
import { ManagedWorktrees } from "../../../src/services/worktrees/ManagedWorktrees";
import { familyStorageHarness } from "../helpers/familyStorageHarness";
import { coordinationStorageHarness } from "../helpers/coordinationStorageHarness";
import { WorkflowTestLive } from "../helpers/workflowFixture";
import { makeProjectSessionRuntimeMechanismTestLayer } from "./projectSessionRuntimeTestLayer";

const location = {
  projectPath: "/project",
  projectName: "Project",
  workingDirectory: "/project",
  sessionDirectory: "/cake/sessions",
  resolvedSessionDirectory: "/cake/resolved",
};
const familyId = "4c41e44b-df48-4dfb-a891-d77748851586";
const messageId = "0b1bf3dd-458b-4025-8c39-c4f4e2febc0e";
const text = "Fixed the queue race and verified the regression tests.";
const invalidOptions = [
  { delivery: "fyi", resultDelivery: "reply" },
  { delivery: "fyi", inputRefs: ["input-id"] },
  { delivery: "fyi", resultDelivery: "notification", inputRefs: ["input-id"] },
  { delivery: "fyi", resultDelivery: "ignore", inputRefs: ["input-id"] },
  { delivery: "fyi", resultDelivery: "reply", inputRefs: ["input-id"] },
] as const;
const errorMessage = /A passive FYI cannot request continuation or forward attachments/;

const operations = createSessionFamilyOperations(() => {
  throw new Error("Schema tests must not execute controls");
});
const operationSchema = (command: string) => {
  const operation = operations.find((item) => item.command === command);
  assert.ok(operation);
  return operation.inputSchema;
};

describe("delivery receiving contracts", () => {
  it.each(invalidOptions)("rejects invalid single-message options %j", (options) => {
    const input = { sessionId: "target", text, ...options };
    expect(() => Schema.decodeUnknownSync(FamilyMessageInput)(input)).toThrow(errorMessage);
    expect(() =>
      Schema.decodeUnknownSync(BackendAgentInvocation)({ name: "sessions.send", arguments: input }),
    ).toThrow(errorMessage);
    expect(() => Schema.decodeUnknownSync(operationSchema("sessions.send"))(input)).toThrow(
      errorMessage,
    );
  });

  it("rejects FYI continuation at reply and batch ingress", () => {
    const input = { text, delivery: "fyi", resultDelivery: "reply" };
    expect(() =>
      Schema.decodeUnknownSync(BackendAgentInvocation)({
        name: "sessions.reply",
        arguments: input,
      }),
    ).toThrow(errorMessage);
    expect(() => Schema.decodeUnknownSync(operationSchema("sessions.reply"))(input)).toThrow(
      errorMessage,
    );
    expect(() =>
      Schema.decodeUnknownSync(SessionSendBatchInput)({ ...input, sessionIds: ["target"] }),
    ).toThrow(errorMessage);
  });

  it.each([
    { delivery: "fyi" },
    { delivery: "fyi", resultDelivery: "notification" },
    { delivery: "fyi", resultDelivery: "ignore", inputRefs: [] },
    { resultDelivery: "reply", inputRefs: ["input-id"] },
    { delivery: "prompt", resultDelivery: "reply", inputRefs: ["input-id"] },
    { delivery: "steer", resultDelivery: "notification", inputRefs: ["input-id"] },
    { delivery: "queue", resultDelivery: "ignore", inputRefs: ["input-id"] },
  ])("preserves valid options %j", (options) => {
    const input = {
      sessionId: "target",
      text,
      messageRefs: ["cake://session/source?message=evidence"],
      ...options,
    };
    expect(Schema.decodeUnknownSync(FamilyMessageInput)(input)).toEqual(input);
    expect(
      Schema.decodeUnknownSync(BackendAgentInvocation)({ name: "sessions.send", arguments: input }),
    ).toEqual({ name: "sessions.send", arguments: input });
    expect(Schema.decodeUnknownSync(operationSchema("sessions.send"))(input)).toEqual(input);
    const batchOptions = {
      ...(options.delivery === undefined ? {} : { delivery: options.delivery }),
      ...(options.resultDelivery === undefined ? {} : { resultDelivery: options.resultDelivery }),
    };
    expect(
      Schema.decodeUnknownSync(SessionSendBatchInput)({
        sessionIds: ["target"],
        text,
        ...batchOptions,
      }),
    ).toEqual({ sessionIds: ["target"], text, ...batchOptions });
  });
});

const fixture = () => {
  const storage = familyStorageHarness();
  const coordination = coordinationStorageHarness();
  const mutations: string[] = [];
  const unexpected = (operation: string) =>
    Effect.sync(() => {
      mutations.push(operation);
      throw new Error(`Unexpected ${operation}`);
    });
  const layer = Layer.mergeAll(
    WorkflowTestLive,
    makeProjectSessionRuntimeMechanismTestLayer(),
    storage.layer,
    SessionCoordination.layer.pipe(Layer.provide(coordination.layer)),
    Layer.mock(ApplicationState, { snapshot: defaultApplicationState }),
    Layer.mock(CakeSessionRuntimes, {
      executingTurnIds: () => Effect.succeed(["turn"]),
      acquire: () => unexpected("project acquisition/dispatch"),
      acquireSession: () => unexpected("chat acquisition/dispatch"),
    }),
    Layer.mock(TaskInputStorage, {
      authorizeForward: () => unexpected("authorizeForward"),
      grant: () => unexpected("grant"),
      protectRecipient: () => unexpected("protectRecipient"),
    }),
    Layer.mock(ProjectTodoReports, {
      offer: () => unexpected("to-do report"),
    }),
    Layer.mock(SessionCatalogChanges, {
      publish: () => unexpected("catalog publish"),
    }),
    Layer.mock(SessionArchiveStorage, {
      locate: () => Effect.succeed("active" as const),
      resolvedProjects: () => Stream.empty,
    }),
    Layer.mock(ManagedWorktrees, { records: () => Effect.succeed([]) }),
  );
  return { layer, mutations, files: storage.files, coordinationFiles: coordination.files };
};

const setupPendingReport = Effect.fn("DeliveryValidationTest.setupPendingReport")(function* (
  destination: "family" | "coordinator",
) {
  const storage = yield* SessionFamilyStorage;
  if (destination === "family")
    yield* storage.addChild({
      familyId,
      parentSessionId: "root",
      parentWorkingDirectory: "/project",
      childSessionId: "child",
      childWorkingDirectory: "/project",
      requestId: "create-child",
      projectPath: "/project",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  yield* storage.recordTurn({
    sessionId: "child",
    senderSessionId: destination === "family" ? "root" : CAKE_CHAT_SESSION_ID,
    turnId: "turn",
    requestMessageId: messageId,
    threadId: familyId,
    reported: false,
  });
});

for (const destination of ["family", "coordinator"] as const) {
  for (const ingress of ["runtime", "domain"] as const) {
    it.effect.each(invalidOptions)(
      `${destination} ${ingress} rejects pending terminal report %j without any side effects`,
      (options) => {
        const f = fixture();
        return Effect.gen(function* () {
          yield* setupPendingReport(destination);
          const storage = yield* SessionFamilyStorage;
          const before = structuredClone(yield* storage.state());
          const input = { text, outcome: "completed" as const, ...options };
          const runtime = yield* acquireOptions({
            location,
            sessionId: "child",
            newSession: false,
          });
          const send = runtime.runtime.currentSessionControl?.routeFamilyMessage;
          assert.ok(send);
          const filesBefore = new Map(f.files);
          if (ingress === "runtime") {
            const error = yield* Effect.tryPromise({
              try: () => send("sessions.reply", input, new AbortController().signal),
              catch: (cause) => cause,
            }).pipe(Effect.flip);
            assert.match(String(error), errorMessage);
          } else {
            const error =
              destination === "family"
                ? yield* route({ sessionId: "child", location }, "sessions.reply", input).pipe(
                    Effect.flip,
                  )
                : yield* routeCoordinatorMessage("child", "sessions.reply", input, location).pipe(
                    Effect.flip,
                  );
            assert.equal(
              error._tag,
              destination === "family" ? "ProjectSessionError" : "SessionFamilyStorageError",
            );
            assert.match(error.message, errorMessage);
          }
          assert.deepEqual(yield* storage.state(), before);
          assert.deepEqual(f.files, filesBefore);
          assert.deepEqual(f.mutations, []);
        }).pipe(Effect.provide(f.layer));
      },
    );
  }

  it.effect.each(["notification", "ignore"] as const)(
    `${destination} retains valid FYI terminal reporting with %s`,
    (resultDelivery) => {
      const f = fixture();
      const offers: string[] = [];
      return Effect.gen(function* () {
        yield* setupPendingReport(destination);
        const input = {
          text,
          outcome: "completed" as const,
          delivery: "fyi" as const,
          resultDelivery,
          inputRefs: [],
        };
        const receipt =
          destination === "family"
            ? yield* route({ sessionId: "child", location }, "sessions.reply", input)
            : yield* routeCoordinatorMessage("child", "sessions.reply", input, location);
        assert.deepEqual(receipt, {
          ok: true,
          command: "sessions.reply",
          status: "report-recorded",
          expectsResponse: false,
        });
        const [turn] = (yield* (yield* SessionFamilyStorage).state()).turns;
        assert.deepEqual(turn?.report, { outcome: "completed", text });
        assert.equal(turn?.reported, false);
        assert.deepEqual(offers, [text]);
        assert.deepEqual(f.mutations, []);
      }).pipe(
        Effect.provideService(ProjectTodoReports, {
          offer: (report) =>
            Effect.sync(() => {
              offers.push(report.text);
            }),
          reports: () => Stream.empty,
        }),
        Effect.provide(f.layer),
      );
    },
  );
}

it.effect.each(invalidOptions)("rejects %j before shared attachment forwarding", (options) => {
  const f = fixture();
  return Effect.gen(function* () {
    for (const name of ["sessions.send", "sessions.reply"]) {
      const error = yield* forwardTaskInputControl("sender", {
        name,
        arguments: { sessionId: "target", text, ...options },
      }).pipe(Effect.flip);
      assert.match(error.message, errorMessage);
    }
    assert.deepEqual(f.mutations, []);
  }).pipe(Effect.provide(f.layer));
});

it.effect.each(invalidOptions)(
  "rejects ordinary messaging %j before thread mutation",
  (options) => {
    const f = fixture();
    return Effect.gen(function* () {
      const before = new Map(f.coordinationFiles);
      const error = yield* agentMessaging
        .invoke(
          { name: "sessions.send", arguments: { sessionId: "target", text, ...options } },
          { kind: "project-session", sessionId: "sender", title: "Sender" },
        )
        .pipe(Effect.flip);
      assert.equal(error._tag, "SchemaError");
      assert.match(error.message, errorMessage);
      assert.deepEqual(f.coordinationFiles, before);
      assert.deepEqual(f.mutations, []);
    }).pipe(Effect.provide(f.layer));
  },
);
