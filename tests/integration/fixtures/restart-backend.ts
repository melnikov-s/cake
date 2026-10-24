import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schedule, Stream, Schema, SubscriptionRef } from "effect";
import * as subagents from "../../../src/domain/subagents/subagents";
import { makeSubagentParent } from "../../../src/domain/subagents/subagentControl";
import { acquireOptions as projectOptions } from "../../../src/domain/project-sessions/projectSessionRuntime";
import { acquireOptions as chatOptions } from "../../../src/domain/cake-chats/cakeChatRuntime";
import { CakeChatConfiguration } from "../../../src/services/pi-durable/CakeChatConfiguration";
import { cakeChatControlTools } from "../../../src/contracts/application/window-control-definitions";
import { TaskInputStorage } from "../../../src/services/storage/TaskInputStorage";
import { SubagentCoordinator } from "../../../src/services/subagents/SubagentCoordinator";
import { SubagentStorage } from "../../../src/services/storage/SubagentStorage";
import { SessionCoordination } from "../../../src/services/session-catalogs/SessionCoordination";
import { MessageListResult } from "../../../src/contracts/conversations/message-reference";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import { projectChatSessionId } from "../../../src/domain/cake-chats/cakeChatLocations";
import * as cakeChatTargets from "../../../src/domain/cake-chats/cakeChatTargets";
import { encodeCrossSessionMessage } from "../../../src/contracts/conversations/cross-session-message";
import { makeBackendLive } from "../../../src/backend/BackendLive";
import { resolveCakePaths } from "../../../src/config/CakePaths";
import { defaultApplicationState } from "../../../src/contracts/application/application-data";
import { acquireTarget } from "../../../src/domain/project-sessions/projectSessionOperations";
import * as recovery from "../../../src/domain/project-sessions/runtimeRecovery";
import {
  makeApplicationStorageLive,
  ApplicationStorage,
} from "../../../src/services/storage/ApplicationStorage";
import { RuntimeRecoveryStorage } from "../../../src/services/storage/RuntimeRecoveryStorage";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import { CakeSessionRuntimes } from "../../../src/services/pi/CakeSessionRuntimes";
import { BootstrapLive } from "../../../src/main/BootstrapLive";

const home = process.env.CAKE_HOME;
assert.ok(home);
const mode = process.argv[2];
const surface = process.argv[3];
const worker = surface?.startsWith("worker-");
const globalChat = surface === "global" || surface === "worker-global";
const reportText = encodeCrossSessionMessage("Carry out this assignment once", {
  version: 1,
  messageId: "20000000-0000-4000-8000-000000000002",
  threadId: "20000000-0000-4000-8000-000000000003",
  sequence: 1,
  expectsResponse: false,
  sender: { sessionId: "sender-session", title: "Sender", kind: "project-session" },
});
const paths = resolveCakePaths({ env: { CAKE_HOME: home }, piAgentDirectory: join(home, "pi") });
const project = join(home, "project");
const sessionId = globalChat
  ? CAKE_CHAT_SESSION_ID
  : surface === "project-chat"
    ? projectChatSessionId(project)
    : "20000000-0000-4000-8000-000000000001";
await mkdir(project, { recursive: true });
if (mode?.startsWith("start"))
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* (yield* ApplicationStorage).save({
        ...defaultApplicationState(),
        ...(worker
          ? {
              cakeChatPreferences: { memoryViewBytes: 128_000, instructions: "" },
              utilityModel: {
                provider: "restart-fixture",
                modelId: "fixture",
                thinkingLevel: "off" as const,
              },
            }
          : {}),
        projects: [
          {
            path: project,
            name: "Restart fixture",
            addedAt: "2026-01-01T00:00:00.000Z",
            lastOpenedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        trustedProjectPaths: [project],
      });
    }).pipe(
      Effect.provide(makeApplicationStorageLive(paths.state).pipe(Layer.provide(BootstrapLive))),
    ),
  );
const runtime = ManagedRuntime.make(
  makeBackendLive({ paths, homeDirectory: home }, () => Layer.empty),
);
const location = {
  projectPath: project,
  projectName: "Restart fixture",
  workingDirectory: project,
  sessionDirectory: paths.piSessions,
  resolvedSessionDirectory: paths.piResolvedSessions,
};
try {
  await runtime.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        if (mode === "health") {
          yield* ApplicationState;
          const issue = yield* Effect.gen(function* () {
            if (surface === "coordination") yield* (yield* SessionCoordination).checkStorage();
            else if (surface === "workers") yield* (yield* SubagentStorage).list();
            else yield* (yield* RuntimeRecoveryStorage).list();
          }).pipe(Effect.result);
          assert.equal(issue._tag, "Failure");
          if (issue._tag === "Failure")
            console.log(
              JSON.stringify({ marker: "backend-available", issue: issue.failure.message }),
            );
          return;
        }
        const handle =
          globalChat || surface === "project-chat"
            ? yield* cakeChatTargets.acquire(sessionId)
            : yield* acquireTarget(location, sessionId, mode?.startsWith("start") ?? false);
        if (mode?.startsWith("start")) {
          yield* handle.applyConfiguration({
            provider: "restart-fixture",
            modelId: "fixture",
            thinkingLevel: "off",
            fastMode: false,
          });
          if (worker) {
            yield* handle.prompt("Seed parent once");
            yield* handle.snapshot().pipe(
              Effect.flatMap((snapshot) =>
                snapshot.parts.some(
                  (part) =>
                    part.kind === "text" &&
                    part.role === "assistant" &&
                    part.text === "Parent ready",
                )
                  ? Effect.void
                  : Effect.fail("waiting for parent seed"),
              ),
              Effect.retry(Schedule.spaced("10 millis")),
              Effect.timeout("15 seconds"),
            );
            const options = globalChat
              ? yield* chatOptions({
                  configuration: yield* CakeChatConfiguration,
                  target: { sessionId, tools: cakeChatControlTools() },
                  newSession: false,
                })
              : yield* projectOptions({ location, sessionId, newSession: false });
            const parent = makeSubagentParent(
              options,
              sessionId,
              options.runtime.cwd,
              (effect, signal) => runtime.runPromise(effect, { signal }),
            );
            const references = yield* (yield* TaskInputStorage).isolate(sessionId, [
              { kind: "text", name: "private-evidence.txt", text: "PRIVATE_ATTACHMENT_EVIDENCE" },
            ]);
            const source = options.runtime.messageReferenceControl;
            assert.ok(source);
            const messages = Schema.decodeUnknownSync(MessageListResult)(
              yield* Effect.promise(() =>
                source.list({ sessionId, roles: ["user"] }, new AbortController().signal),
              ),
            );
            const ref = messages.messages[0]?.ref;
            assert.ok(ref);
            yield* subagents.start(
              {
                task: "Investigate this evidence once",
                model: {
                  prefer: "exact",
                  provider: "restart-fixture",
                  modelId: "fixture",
                  thinkingLevel: "off",
                },
                ...(globalChat ? { projectPath: project } : {}),
                inputRefs: references.map((item) => item.id),
                messageRefs: [ref],
              },
              parent,
            );
            if (mode === "start-busy-report") {
              const coordinator = yield* SubagentCoordinator;
              yield* SubscriptionRef.changes(coordinator.state).pipe(
                Stream.filter((state) =>
                  [...state.handles.values()].some((handle) =>
                    handle.parts.some(
                      (part) =>
                        typeof part === "object" &&
                        part !== null &&
                        "kind" in part &&
                        part.kind === "text" &&
                        "text" in part &&
                        String(part.text).includes("Working on private evidence"),
                    ),
                  ),
                ),
                Stream.runHead,
              );
              yield* handle.prompt("Keep the parent busy while the worker completes");
              yield* coordinator.storage.list().pipe(
                Effect.flatMap((records) =>
                  records.some(
                    (worker) =>
                      worker.status === "complete" && worker.completionDisposition === "notifying",
                  )
                    ? Effect.void
                    : Effect.fail("waiting for durable pending report"),
                ),
                Effect.retry(Schedule.spaced("10 millis")),
                Effect.timeout("15 seconds"),
              );
              console.log("restart-fixture-report-pending");
            }
            console.log("restart-fixture-accepted");
            yield* Effect.promise(
              () => new Promise<void>((resolve) => process.once("message", () => resolve())),
            );
            return;
          }
          yield* handle.prompt(
            mode === "start-report" ? reportText : "Carry out this assignment once",
          );
          if (mode === "start-queued" || mode === "start-stopped")
            yield* handle.followUp("Queued assignment once");
          console.log("restart-fixture-accepted");
          if (mode === "start-stopped") {
            yield* Effect.promise(
              () => new Promise<void>((resolve) => process.once("message", () => resolve())),
            );
            yield* handle.abort({ by: "user" });
            console.log("restart-fixture-stopped");
          }
          yield* Effect.promise(
            () => new Promise<void>((resolve) => process.once("message", () => resolve())),
          );
          return;
        }
        if (worker) {
          const coordinator = yield* SubagentCoordinator;
          const record = yield* coordinator.storage.list().pipe(
            Effect.flatMap((records) =>
              records[0]?.status === "complete" && records[0]?.completionDisposition === "notified"
                ? Effect.succeed(records[0])
                : Effect.fail("waiting for worker recovery"),
            ),
            Effect.retry(Schedule.spaced("10 millis")),
            Effect.timeout("15 seconds"),
          );
          // Inspecting the worker is explicit demand; terminal workers stay lazy at startup.
          yield* subagents.wait(sessionId, record.handleId);
          const restored = (yield* SubscriptionRef.get(coordinator.state)).handles.get(
            record.handleId,
          );
          assert.ok(restored?.piHandle);
          const reference = record.inputReferences[0];
          const ref = record.messageReferences[0];
          const attachmentAccess = restored.attachmentAccess;
          const messageAccess = restored.messageAccess;
          assert.ok(reference && ref && attachmentAccess && messageAccess);
          const attachment = yield* Effect.promise(() =>
            attachmentAccess.control.read(
              { reference: reference.id },
              new AbortController().signal,
            ),
          );
          const message = yield* Effect.promise(() =>
            messageAccess.control.read({ ref }, new AbortController().signal),
          );
          const denied = yield* Effect.result(
            Effect.tryPromise({
              try: () =>
                messageAccess.control.read(
                  { ref: ref + "-not-forwarded" },
                  new AbortController().signal,
                ),
              catch: (cause) => cause,
            }),
          );
          const snapshot = yield* restored.piHandle.snapshot();
          console.log(
            JSON.stringify({
              marker: "private-worker-result",
              handleId: record.handleId,
              privateSessionId: record.privateSessionId,
              status: record.status,
              disposition: record.completionDisposition,
              inputs: record.pendingInputs.length,
              users: snapshot.parts.filter((part) => part.kind === "text" && part.role === "user")
                .length,
              attachmentReadable: JSON.stringify(attachment).includes(
                "PRIVATE_ATTACHMENT_EVIDENCE",
              ),
              messageReadable: JSON.stringify(message).includes("Seed parent once"),
              unforwardedDenied: denied._tag === "Failure",
            }),
          );
          return;
        }
        if (mode === "inspect-duplicate") yield* handle.prompt(reportText);
        if (mode === "continue") yield* handle.prompt("Continue after stop");
        if (mode === "recover" || mode === "recover-queued" || mode === "continue") {
          yield* handle.updates.pipe(
            Stream.filter((update) => {
              const snapshot =
                update._tag === "Snapshot"
                  ? update.snapshot
                  : update.event.type === "snapshot-updated"
                    ? update.event.snapshot
                    : undefined;
              return Boolean(
                snapshot &&
                !snapshot.streaming &&
                snapshot.parts.some(
                  (part) =>
                    part.kind === "text" &&
                    part.role === "assistant" &&
                    part.text === "Recovered once",
                ),
              );
            }),
            Stream.runHead,
            Effect.timeout("15 seconds"),
          );
          // Repeated startup must neither fork another loop nor duplicate a completed answer.
          yield* recovery.initialize();
        }
        const storage = yield* RuntimeRecoveryStorage;
        const application = yield* ApplicationState;
        const records = yield* storage.list().pipe(
          Effect.flatMap((records) =>
            mode === "inspect-stopped" ||
            (records.find((item) => item.sessionId === sessionId)?.state === "complete" &&
              (globalChat ||
                surface === "project-chat" ||
                application.snapshot().unreadSessionIds.includes(sessionId)))
              ? Effect.succeed(records)
              : Effect.fail("waiting for durable settlement"),
          ),
          Effect.retry(Schedule.spaced("10 millis")),
          Effect.timeout("15 seconds"),
        );
        const record = records.find((item) => item.sessionId === sessionId);
        const status = yield* (yield* CakeSessionRuntimes).currentStatus({
          sessionId,
          workingDirectory: project,
          sessionDirectory: record?.sessionDirectory ?? paths.piSessions,
        });
        console.log(
          JSON.stringify({
            marker: "restart-fixture-result",
            state: record?.state,
            ...(record?.state === "blocked" ? { recoveryIssue: Boolean(record.issue) } : null),
            inputs: record?.inputs.length,
            streaming: status?.streaming,
            outcome: status?.latestTurnOutcome,
            unread: (yield* ApplicationState).snapshot().unreadSessionIds.includes(sessionId),
            recoveryNotice: (yield* handle.snapshot()).parts.some(
              (part) => part.kind === "notice" && part.id === "restart-recovery",
            ),
            users: (yield* handle.snapshot()).parts.filter(
              (part) => part.kind === "text" && part.role === "user" && !part.deliveryState,
            ).length,
          }),
        );
      }),
    ),
  );
} finally {
  await runtime.dispose();
}
