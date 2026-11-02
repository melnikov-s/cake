import { describe, expect } from "vitest";
import { readFile, writeFile, mkdtemp, mkdir, rm, stat } from "node:fs/promises";
import { TaskInputStorage } from "../../../src/services/storage/TaskInputStorage";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeFileSystem, NodePath } from "@effect/platform-node-shared";
import { AutomationRecords } from "../../../src/services/automations/AutomationRecords";
import {
  AutomationStorage,
  makeAutomationStorageLive,
} from "../../../src/services/storage/AutomationStorage";
import { it } from "@effect/vitest";
import {
  Context,
  DateTime,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Option,
  Queue,
  Ref,
  Stream,
} from "effect";
import { ProjectSessionConfiguration } from "../../../src/services/project-sessions/ProjectSessionConfiguration";
import { CakeSessionRuntimes } from "../../../src/services/pi/CakeSessionRuntimes";
import { SessionArchiveStorage } from "../../../src/services/storage/SessionArchiveStorage";
import { makeSessionArchiveStorageLive } from "../../../src/services/storage/SessionArchiveStorageLive";
import {
  RuntimeRecoveryStorage,
  type RuntimeRecoveryInput,
} from "../../../src/services/storage/RuntimeRecoveryStorage";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import { defaultProjectSettings } from "../../../src/contracts/application/application-data";
import * as projects from "../../../src/domain/projects/projects";
import { TestClock } from "effect/testing";
import type { AutomationSchedule } from "../../../src/contracts/automations/automation-data";
import * as worker from "../../../src/domain/automations/automationWorker";
import { automationDefinition, automationFixture } from "../helpers/automationFixture";
import { automationSourceFixture } from "../helpers/automationSourceFixture";
import * as definitions from "../../../src/domain/automations/automationDefinitions";
import * as runs from "../../../src/domain/automations/automationRuns";
import * as sessionChats from "../../../src/domain/conversations/sessionChats";

const waitForSettlement = (
  f: Effect.Success<ReturnType<typeof automationFixture>>,
  sessionId: string,
) =>
  f.records.changes().pipe(
    Stream.filter((ledger) =>
      ledger.runs.some((run) => run.sessionId === sessionId && run.status._tag !== "running"),
    ),
    Stream.take(1),
    Stream.runDrain,
  );

describe("automation lifecycle and execution", () => {
  it.effect.each(["complete", "failed", "aborted"] as const)(
    "auto-resolution waits for accepted follow-ups before handling their %s outcome",
    (outcome) =>
      Effect.gen(function* () {
        const f = yield* automationFixture();
        const settled = yield* Queue.unbounded<string>();
        const sessions = CakeSessionRuntimes.of({
          ...f.sessions,
          acquire: (options) =>
            f.sessions.acquire({
              ...options,
              onTurnSettled: (event) =>
                (options.onTurnSettled?.(event) ?? Effect.void).pipe(
                  Effect.andThen(Queue.offer(settled, event.turnId)),
                ),
            }),
        });
        const context = Context.add(f.context, CakeSessionRuntimes, sessions);
        yield* Effect.gen(function* () {
          const a = yield* definitions.create({
            definition: automationDefinition({ completion: "auto-resolve" }),
            initialState: "active",
          });
          yield* runs.trigger(a.id);
          const first = yield* Queue.take(f.started);
          const handle = yield* runs.acquireSession(first.sessionId);
          yield* handle.followUp("Continue with one more task");
          const followUp = yield* Queue.take(f.started);
          expect(followUp.sessionId).toBe(first.sessionId);
          yield* f.complete(first.sessionId, first.turnId);
          expect(yield* Queue.take(settled)).toBe(first.turnId);
          expect((yield* Ref.get(f.resolved)).has(first.sessionId)).toBe(false);
          expect((yield* definitions.inspect(a.id)).activity.runningSessions).toBe(1);
          if (outcome === "complete") yield* f.complete(first.sessionId, followUp.turnId);
          else if (outcome === "failed") yield* f.fail(first.sessionId, followUp.turnId);
          else yield* handle.abort({ by: "user" });
          expect(yield* Queue.take(settled)).toBe(followUp.turnId);
          expect((yield* Ref.get(f.resolved)).has(first.sessionId)).toBe(outcome === "complete");
          expect((yield* runs.runForSession(first.sessionId)).status._tag).toBe("completed");
          expect(f.records.snapshot().runs).toHaveLength(1);
          expect((yield* definitions.inspect(a.id)).activity.runningSessions).toBe(0);
        }).pipe(Effect.provide(context));
      }),
  );
  it.effect.each(["cancel-run", "shared-stop"] as const)(
    "%s drains FIFO only after an executing Pi turn is stopped",
    (path) =>
      Effect.gen(function* () {
        const f = yield* automationFixture();
        yield* Effect.gen(function* () {
          const a = yield* definitions.create({
            definition: automationDefinition({ overlap: "queue" }),
            initialState: "active",
          });
          yield* runs.trigger(a.id);
          const first = yield* Queue.take(f.started);
          const firstRun = yield* runs.runForSession(first.sessionId);
          const queued = yield* runs.trigger(a.id);
          expect(queued._tag).toBe("queued");
          if (path === "cancel-run") yield* runs.cancelRun(firstRun.id);
          else
            yield* Effect.scoped(
              sessionChats.abort({ sessionId: first.sessionId, stop: { by: "user" } }),
            );
          expect((yield* runs.runForSession(first.sessionId)).status._tag).toBe("canceled");
          expect(
            f.records.snapshot().occurrences.find((item) => item.id === queued.occurrenceId)
              ?.disposition._tag,
          ).toBe("started");
          const next = yield* Queue.take(f.started);
          expect(next.sessionId).not.toBe(first.sessionId);
          expect((yield* definitions.inspect(a.id)).activity).toEqual({
            runningSessions: 1,
            queuedOccurrences: 0,
          });
          yield* f.complete(next.sessionId);
          yield* waitForSettlement(f, next.sessionId);
        }).pipe(Effect.provide(f.context));
      }),
  );
  it.effect.each(["auto-resolve", "keep-for-review"] as const)(
    "%s uses real in-place archive storage, restores without rerunning, and drains queued executions",
    (completion) =>
      Effect.gen(function* () {
        const f = yield* automationFixture();
        const configuration = {
          agentDirectory: "/agent",
          sessionDirectory: join(f.inputDirectory, "pi"),
          resolvedSessionDirectory: join(f.inputDirectory, "former-resolved"),
        };
        const archiveContext = yield* Layer.build(
          makeSessionArchiveStorageLive(join(f.inputDirectory, "archive"), {
            activeRoot: configuration.sessionDirectory,
            resolvedRoot: configuration.resolvedSessionDirectory,
          }).pipe(Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))),
        );
        const context = Context.add(
          Context.merge(f.context, archiveContext),
          ProjectSessionConfiguration,
          configuration,
        );
        yield* Effect.gen(function* () {
          // Pi execution is controlled, but these SDK-format originals and archive IO are real.
          const writeOriginal = Effect.fn("AutomationResolutionFixture.writeOriginal")(function* (
            sessionId: string,
            text: string,
          ) {
            const run = yield* runs.runForSession(sessionId);
            const file = join(
              run.sessionDirectory,
              `${run.startedAt.replace(/[:.]/g, "-")}_${sessionId}.jsonl`,
            );
            const timestamp = Date.parse(run.startedAt);
            const bytes =
              [
                {
                  type: "session",
                  version: 3,
                  id: sessionId,
                  timestamp: run.startedAt,
                  cwd: run.workingDirectory,
                },
                {
                  type: "message",
                  id: "user-1",
                  parentId: null,
                  timestamp: run.startedAt,
                  message: { role: "user", content: [{ type: "text", text }], timestamp },
                },
                {
                  type: "message",
                  id: "assistant-1",
                  parentId: "user-1",
                  timestamp: run.startedAt,
                  message: {
                    role: "assistant",
                    content: [{ type: "text", text: "Completed." }],
                    api: "openai-responses",
                    provider: "test",
                    model: "test",
                    stopReason: "stop",
                    timestamp,
                    usage: {
                      input: 0,
                      output: 0,
                      cacheRead: 0,
                      cacheWrite: 0,
                      totalTokens: 0,
                      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                    },
                  },
                },
              ]
                .map((entry) => JSON.stringify(entry))
                .join("\n") + "\n";
            yield* Effect.promise(async () => {
              await mkdir(run.sessionDirectory, { recursive: true });
              await writeFile(file, bytes);
            });
            return { run, file, bytes, inode: (yield* Effect.promise(() => stat(file))).ino };
          });
          const a = yield* definitions.create({
            definition: automationDefinition({ completion, overlap: "queue" }),
            initialState: "active",
          });
          yield* runs.trigger(a.id);
          const first = yield* Queue.take(f.started);
          const original = yield* writeOriginal(first.sessionId, first.text);
          expect((yield* runs.trigger(a.id))._tag).toBe("queued");
          yield* f.complete(first.sessionId);
          expect(yield* Queue.take(f.disposed)).toBe(first.sessionId);
          const location = {
            cwd: original.run.workingDirectory,
            activeRoot: original.run.sessionDirectory,
            resolvedRoot: original.run.sessionDirectory,
            direct: true,
          };
          const archive = yield* SessionArchiveStorage;
          expect((yield* archive.recordedResolvedIds(location)).has(first.sessionId)).toBe(
            completion === "auto-resolve",
          );
          const next = yield* Queue.take(f.started);
          yield* writeOriginal(next.sessionId, next.text);
          yield* runs.setResolved(first.sessionId, true);
          expect((yield* archive.recordedResolvedIds(location)).has(first.sessionId)).toBe(true);
          const resolvedCatalog = yield* (yield* runs.observe()).pipe(
            Stream.take(1),
            Stream.runCollect,
          );
          expect(resolvedCatalog[0]).toMatchObject({
            _tag: "Snapshot",
            snapshot: {
              unresolvedSessions: expect.not.arrayContaining([
                expect.objectContaining({
                  identity: expect.objectContaining({ sessionId: first.sessionId }),
                }),
              ]),
            },
          });
          yield* runs.setResolved(first.sessionId, false);
          expect((yield* archive.recordedResolvedIds(location)).has(first.sessionId)).toBe(false);
          const restoredCatalog = yield* (yield* runs.observe()).pipe(
            Stream.take(1),
            Stream.runCollect,
          );
          expect(restoredCatalog[0]).toMatchObject({
            _tag: "Snapshot",
            snapshot: {
              unresolvedSessions: expect.arrayContaining([
                expect.objectContaining({
                  identity: expect.objectContaining({ sessionId: first.sessionId }),
                }),
              ]),
            },
          });
          expect(f.captured).toHaveLength(2);
          expect((yield* runs.runForSession(first.sessionId)).status._tag).toBe("completed");
          expect(yield* Effect.promise(() => readFile(original.file, "utf8"))).toBe(original.bytes);
          expect((yield* Effect.promise(() => stat(original.file))).ino).toBe(original.inode);
          yield* f.complete(next.sessionId);
          expect(yield* Queue.take(f.disposed)).toBe(next.sessionId);
          expect(f.records.snapshot().runs).toHaveLength(2);
        }).pipe(Effect.provide(context));
      }),
  );
  it.effect(
    "pages global history across archived and active definitions with exact run links and captured-name filtering",
    () =>
      Effect.gen(function* () {
        const f = yield* automationFixture();
        yield* Effect.gen(function* () {
          const a = yield* definitions.create({
            definition: automationDefinition({ name: "Daily digest", overlap: "queue" }),
            initialState: "active",
          });
          const b = yield* definitions.create({
            definition: automationDefinition({
              name: "Project checks",
              context: { _tag: "Project", projectPath: "/projects/cake" },
            }),
            initialState: "active",
          });
          const first = yield* runs.trigger(a.id);
          const firstSession = yield* Queue.take(f.started);
          yield* TestClock.adjust("1 second");
          const queued = yield* runs.trigger(a.id);
          expect(queued._tag).toBe("queued");
          yield* TestClock.adjust("1 second");
          const project = yield* runs.trigger(b.id);
          const projectSession = yield* Queue.take(f.started);
          yield* TestClock.adjust("1 second");
          const skipped = yield* runs.trigger(b.id);
          expect(skipped._tag).toBe("skipped");
          yield* runs.archive({ automationId: a.id, runningSessions: "let-finish" });
          const latest = yield* definitions.history({ limit: 2 });
          expect(latest.total).toBe(4);
          expect(latest.nextOffset).toBe(2);
          expect(latest.occurrences.map((item) => item.id)).toEqual([
            skipped.occurrenceId,
            project.occurrenceId,
          ]);
          expect(latest.runs.map((item) => item.sessionId)).toEqual([projectSession.sessionId]);
          const older = yield* definitions.history({ offset: 2, limit: 2 });
          expect(older.total).toBe(4);
          expect(older.nextOffset).toBeNull();
          expect(older.occurrences.map((item) => item.id)).toEqual([
            queued.occurrenceId,
            first.occurrenceId,
          ]);
          expect(older.occurrences[0]?.disposition._tag).toBe("canceled");
          expect(older.runs.map((item) => item.sessionId)).toEqual([firstSession.sessionId]);
          expect(
            (yield* definitions.history({ query: "DAILY" })).occurrences.map(
              (item) => item.automationId,
            ),
          ).toEqual([a.id, a.id]);
          expect((yield* definitions.history({ automationId: b.id })).total).toBe(2);
          expect(
            (yield* definitions.history({ query: "Summarize what needs attention" })).total,
          ).toBe(0);
          yield* f.complete(firstSession.sessionId);
          yield* f.complete(projectSession.sessionId);
          yield* waitForSettlement(f, firstSession.sessionId);
          yield* waitForSettlement(f, projectSession.sessionId);
        }).pipe(Effect.provide(f.context));
      }),
  );
  it.effect(
    "vaults task attachments once, grants each execution, and preserves queued originals across edits",
    () =>
      Effect.gen(function* () {
        const f = yield* automationFixture();
        yield* Effect.gen(function* () {
          const selected = join(f.inputDirectory, "selected.txt");
          yield* Effect.promise(() => writeFile(selected, "ORIGINAL SELECTED CONTENT"));
          const base = automationDefinition({ overlap: "queue" });
          const a = yield* definitions.create({
            definition: {
              ...base,
              task: {
                ...base.task,
                attachments: [{ kind: "file", name: "selected.txt", path: selected }],
              },
            },
            initialState: "active",
          });
          const saved = a.definition.task.attachments[0];
          expect(saved?.kind).toBe("input");
          if (saved?.kind !== "input") throw new Error("Expected a vaulted input reference");
          expect(JSON.stringify(f.records.snapshot())).not.toContain("ORIGINAL SELECTED CONTENT");
          yield* runs.trigger(a.id);
          const first = yield* Queue.take(f.started);
          yield* Effect.promise(() => writeFile(selected, "EDITED AFTER SAVE"));
          expect((yield* runs.trigger(a.id))._tag).toBe("queued");
          const updated = yield* definitions.update({
            automationId: a.id,
            definition: {
              ...base,
              task: {
                ...base.task,
                prompt: "Updated task",
                attachments: [{ kind: "file", name: "selected.txt", path: selected }],
              },
            },
          });
          const firstFile = first.attachments[0];
          if (firstFile?.kind !== "file") throw new Error("Expected a resolved file attachment");
          expect(yield* Effect.promise(() => readFile(firstFile.path, "utf8"))).toBe(
            "ORIGINAL SELECTED CONTENT",
          );
          const inputs = yield* TaskInputStorage;
          expect((yield* inputs.list(first.sessionId, {})).references.map((ref) => ref.id)).toEqual(
            [saved.id],
          );
          yield* f.complete(first.sessionId);
          const queued = yield* Queue.take(f.started);
          const queuedFile = queued.attachments[0];
          if (queuedFile?.kind !== "file")
            throw new Error("Expected a resolved queued file attachment");
          expect(yield* Effect.promise(() => readFile(queuedFile.path, "utf8"))).toBe(
            "ORIGINAL SELECTED CONTENT",
          );
          expect(
            (yield* inputs.list(queued.sessionId, {})).references.map((ref) => ref.id),
          ).toEqual([saved.id]);
          yield* f.complete(queued.sessionId);
          yield* waitForSettlement(f, queued.sessionId);
          yield* runs.trigger(a.id);
          const future = yield* Queue.take(f.started);
          const futureFile = future.attachments[0];
          if (futureFile?.kind !== "file")
            throw new Error("Expected a resolved updated file attachment");
          expect(future.text).toBe("Updated task");
          expect(yield* Effect.promise(() => readFile(futureFile.path, "utf8"))).toBe(
            "EDITED AFTER SAVE",
          );
          expect((yield* inputs.list(future.sessionId, {})).references).toEqual(
            updated.definition.task.attachments,
          );
          yield* f.complete(future.sessionId);
          yield* waitForSettlement(f, future.sessionId);
        }).pipe(Effect.provide(f.context));
      }),
  );
  it.effect(
    "counts a continued historical session as running, holds overlap, and keeps its original run outcome",
    () =>
      Effect.gen(function* () {
        const f = yield* automationFixture();
        yield* Effect.gen(function* () {
          const a = yield* definitions.create({
            definition: automationDefinition({ overlap: "queue" }),
            initialState: "active",
          });
          yield* runs.trigger(a.id);
          const first = yield* Queue.take(f.started);
          yield* f.complete(first.sessionId);
          expect(yield* Queue.take(f.disposed)).toBe(first.sessionId);
          const original = yield* runs.runForSession(first.sessionId);
          yield* runs.setResolved(first.sessionId, true);
          const handle = yield* runs.acquireSession(first.sessionId);
          expect((yield* handle.prompt("Do not run while resolved").pipe(Effect.result))._tag).toBe(
            "Failure",
          );
          yield* runs.setResolved(first.sessionId, false);
          yield* handle.prompt("Continue with a follow-up");
          expect((yield* Queue.take(f.started)).sessionId).toBe(first.sessionId);
          expect((yield* definitions.inspect(a.id)).activity.runningSessions).toBe(1);
          expect((yield* runs.setResolved(first.sessionId, true).pipe(Effect.result))._tag).toBe(
            "Failure",
          );
          expect((yield* runs.trigger(a.id))._tag).toBe("queued");
          expect(f.records.snapshot().runs).toHaveLength(1);
          yield* f.complete(first.sessionId);
          const next = yield* Queue.take(f.started);
          expect(next.sessionId).not.toBe(first.sessionId);
          expect((yield* runs.runForSession(first.sessionId)).status).toEqual(original.status);
          yield* f.complete(next.sessionId);
          yield* waitForSettlement(f, next.sessionId);
        }).pipe(Effect.provide(f.context));
      }),
  );
  it.effect(
    "marks a projectless run read through the shared workspace command and refreshes its catalog without a ledger write",
    () =>
      Effect.gen(function* () {
        const f = yield* automationFixture();
        yield* Effect.gen(function* () {
          const a = yield* definitions.create({
            definition: automationDefinition(),
            initialState: "active",
          });
          yield* runs.trigger(a.id);
          const started = yield* Queue.take(f.started);
          yield* f.complete(started.sessionId);
          const application = yield* ApplicationState;
          yield* f.records.changes().pipe(
            Stream.filter(() =>
              application.snapshot().unreadSessionIds.includes(started.sessionId),
            ),
            Stream.take(1),
            Stream.runDrain,
          );
          const updates = yield* runs.observe();
          const initial = yield* updates.pipe(Stream.take(1), Stream.runHead);
          expect(
            Option.isSome(initial) &&
              initial.value._tag === "Snapshot" &&
              initial.value.snapshot.unresolvedSessions.some(
                (item) => item.identity.sessionId === started.sessionId && item.unread,
              ),
          ).toBe(true);
          const persisted = yield* Ref.get(f.persisted);
          const ready = yield* Deferred.make<void>();
          const cleared = yield* updates.pipe(
            Stream.tap(() => Deferred.succeed(ready, undefined)),
            Stream.filter(
              (update) =>
                update._tag === "Snapshot" &&
                update.snapshot.unresolvedSessions.some(
                  (item) => item.identity.sessionId === started.sessionId && !item.unread,
                ),
            ),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
          yield* Deferred.await(ready);
          yield* projects.setSessionUnread(0, { sessionId: started.sessionId, unread: false });
          yield* Fiber.join(cleared);
          expect(application.snapshot().unreadSessionIds).not.toContain(started.sessionId);
          expect(yield* Ref.get(f.persisted)).toBe(persisted);
        }).pipe(Effect.provide(f.context));
      }),
  );
  it.effect(
    "creates a definition with an independent memory identity and explicit execution settings",
    () =>
      Effect.gen(function* () {
        const f = yield* automationFixture();
        const a = yield* definitions
          .create({ definition: automationDefinition(), initialState: "active" })
          .pipe(Effect.provide(f.context));
        const b = yield* definitions
          .create({ definition: automationDefinition(), initialState: "paused" })
          .pipe(Effect.provide(f.context));
        expect(a.memoryId).not.toBe(b.memoryId);
        expect(a.definition).toEqual(automationDefinition());
        expect(b.state._tag).toBe("paused");
        expect((yield* Ref.get(f.persisted)).automations).toHaveLength(2);
      }),
  );
  it.effect(
    "starts a real AutomationSession identity from a manual trigger without a fake project",
    () =>
      Effect.gen(function* () {
        const f = yield* automationFixture();
        yield* Effect.gen(function* () {
          const automation = yield* definitions.create({
            definition: automationDefinition(),
            initialState: "active",
          });
          const result = yield* runs.trigger(automation.id);
          expect(result._tag).toBe("started");
          if (result._tag !== "started") return;
          const started = yield* Queue.take(f.started);
          expect(started.sessionId).toBe(result.sessionId);
          expect(started.options.cwd).toBe("/home/user");
          const handle = yield* f.sessions.acquireSession(result.sessionId);
          expect(handle.profile).toBe("AutomationSession");
          const run = yield* runs.lookupRun(result.runId);
          expect(run.context).toEqual({ _tag: "Global" });
          expect(f.records.snapshot().occurrences[0]?.disposition._tag).toBe("started");
          yield* f.complete(result.sessionId);
          yield* waitForSettlement(f, result.sessionId);
        }).pipe(Effect.provide(f.context));
      }),
  );
  it.effect(
    "loads global resources at home and project resources at the selected trusted project root",
    () =>
      Effect.gen(function* () {
        const f = yield* automationFixture();
        yield* Effect.gen(function* () {
          yield* (yield* ApplicationState).transact((current) =>
            Effect.succeed({
              ...current,
              globalCustomInstructions: "Global user guidance",
              projects: current.projects.map((project) => ({
                ...project,
                settings: {
                  ...defaultProjectSettings(),
                  customInstructions: "Project user guidance",
                  projectChatInstructions: "Project Chat only guidance",
                },
              })),
            }),
          );
          const automation = yield* definitions.create({
            definition: automationDefinition({
              context: { _tag: "Project", projectPath: "/projects/cake" },
            }),
            initialState: "active",
          });
          const result = yield* runs.trigger(automation.id);
          expect(result._tag).toBe("started");
          const started = yield* Queue.take(f.started);
          expect(started.options.cwd).toBe("/projects/cake");
          expect(started.options.trusted).toBe(true);
          expect(started.options.isolatedSystemPrompt).toBeUndefined();
          expect(started.options.agentDir).toBe("/agent");
          expect(started.options.additionalSystemPrompt).toContain("Global user guidance");
          expect(started.options.additionalSystemPrompt).toContain("Project user guidance");
          expect(started.options.additionalSystemPrompt).not.toContain(
            "Project Chat only guidance",
          );
          yield* f.complete(started.sessionId);
          yield* waitForSettlement(f, started.sessionId);
        }).pipe(Effect.provide(f.context));
      }),
  );
  it.effect(
    "does not create a worktree or session family merely by starting an automation run",
    () =>
      Effect.gen(function* () {
        const f = yield* automationFixture();
        yield* Effect.gen(function* () {
          const automation = yield* definitions.create({
            definition: automationDefinition(),
            initialState: "active",
          });
          yield* runs.trigger(automation.id);
          const started = yield* Queue.take(f.started);
          expect(started.options.worktreeLanding).toBeUndefined();
          expect(started.options.currentSessionControl?.createChildSession).toBeUndefined();
          expect(started.options.sessionDir).toContain(`/automations/${automation.id}`);
          yield* f.complete(started.sessionId);
          yield* waitForSettlement(f, started.sessionId);
        }).pipe(Effect.provide(f.context));
      }),
  );
  it.effect(
    "keeps configuration edits out of running sessions and already accepted queued work",
    () =>
      Effect.gen(function* () {
        const f = yield* automationFixture();
        yield* Effect.gen(function* () {
          const original = automationDefinition({ overlap: "queue" });
          const automation = yield* definitions.create({
            definition: original,
            initialState: "active",
          });
          yield* runs.trigger(automation.id);
          const first = yield* Queue.take(f.started);
          expect((yield* runs.trigger(automation.id))._tag).toBe("queued");
          yield* definitions.update({
            automationId: automation.id,
            definition: { ...original, task: { ...original.task, prompt: "A different task" } },
          });
          yield* f.complete(first.sessionId);
          const second = yield* Queue.take(f.started);
          expect(second.text).toBe(original.task.prompt);
          expect(first.text).toBe(original.task.prompt);
          yield* f.complete(second.sessionId);
          yield* waitForSettlement(f, second.sessionId);
        }).pipe(Effect.provide(f.context));
      }),
  );
  it.effect(
    "pauses new automatic admission, lets active sessions finish, and holds existing queued work",
    () =>
      Effect.gen(function* () {
        const f = yield* automationFixture();
        yield* Effect.gen(function* () {
          const automation = yield* definitions.create({
            definition: automationDefinition({ overlap: "queue" }),
            initialState: "active",
          });
          yield* runs.trigger(automation.id);
          const first = yield* Queue.take(f.started);
          yield* runs.trigger(automation.id);
          yield* definitions.changeState(automation.id, { _tag: "paused" });
          expect(
            (yield* runs.trigger(automation.id, {
              _tag: "Schedule",
              scheduledAt: "2030-01-01T09:00:00.000Z",
            }))._tag,
          ).toBe("skipped");
          expect(f.records.snapshot().runs[0]?.status._tag).toBe("running");
          yield* f.complete(first.sessionId);
          yield* waitForSettlement(f, first.sessionId);
          expect(
            f.records.snapshot().occurrences.filter((item) => item.disposition._tag === "queued"),
          ).toHaveLength(1);
          expect(f.captured).toHaveLength(1);
        }).pipe(Effect.provide(f.context));
      }),
  );
  it.effect(
    "resumes queued occurrences FIFO after activation without replaying skipped triggers",
    () =>
      Effect.gen(function* () {
        const f = yield* automationFixture();
        yield* Effect.gen(function* () {
          const automation = yield* definitions.create({
            definition: automationDefinition({ overlap: "queue" }),
            initialState: "active",
          });
          yield* runs.trigger(automation.id);
          const first = yield* Queue.take(f.started);
          const queued = yield* runs.trigger(automation.id);
          yield* definitions.changeState(automation.id, { _tag: "paused" });
          yield* f.complete(first.sessionId);
          yield* waitForSettlement(f, first.sessionId);
          yield* runs.activate(automation.id);
          const second = yield* Queue.take(f.started);
          expect(f.records.snapshot().runs[1]?.occurrenceId).toBe(queued.occurrenceId);
          yield* f.complete(second.sessionId);
          yield* waitForSettlement(f, second.sessionId);
          expect(f.captured).toHaveLength(2);
        }).pipe(Effect.provide(f.context));
      }),
  );
  it.effect(
    "archives future triggers and cancels queued work while honoring let-finish versus stop",
    () =>
      Effect.gen(function* () {
        const f = yield* automationFixture();
        yield* Effect.gen(function* () {
          for (const runningSessions of ["let-finish", "stop"] as const) {
            const a = yield* definitions.create({
              definition: automationDefinition({ overlap: "queue" }),
              initialState: "active",
            });
            yield* runs.trigger(a.id);
            const started = yield* Queue.take(f.started);
            yield* runs.trigger(a.id);
            yield* runs.archive({ automationId: a.id, runningSessions });
            expect(
              f.records
                .snapshot()
                .occurrences.filter(
                  (item) => item.automationId === a.id && item.disposition._tag === "canceled",
                ),
            ).toHaveLength(1);
            if (runningSessions === "let-finish") {
              expect((yield* runs.runForSession(started.sessionId)).status._tag).toBe("running");
              yield* f.complete(started.sessionId);
            }
            yield* waitForSettlement(f, started.sessionId);
            expect((yield* definitions.lookup(a.id)).state._tag).toBe("archived");
            expect((yield* runs.trigger(a.id))._tag).toBe("blocked");
          }
        }).pipe(Effect.provide(f.context));
      }),
  );
  it.effect("keeps a single failed run visible without suspending the entire automation", () =>
    Effect.gen(function* () {
      const f = yield* automationFixture();
      yield* Effect.gen(function* () {
        const a = yield* definitions.create({
          definition: automationDefinition({ completion: "auto-resolve" }),
          initialState: "active",
        });
        yield* runs.trigger(a.id);
        const started = yield* Queue.take(f.started);
        yield* f.fail(started.sessionId);
        yield* waitForSettlement(f, started.sessionId);
        expect((yield* definitions.lookup(a.id)).state._tag).toBe("active");
        expect((yield* runs.runForSession(started.sessionId)).status._tag).toBe("failed");
        expect((yield* Ref.get(f.resolved)).has(started.sessionId)).toBe(false);
      }).pipe(Effect.provide(f.context));
    }),
  );
  it.effect(
    "suspends an unavailable project automation with a reason and validates before activation",
    () =>
      Effect.gen(function* () {
        const f = yield* automationFixture();
        yield* Effect.gen(function* () {
          const a = yield* definitions.create({
            definition: automationDefinition({
              context: { _tag: "Project", projectPath: "/projects/cake" },
            }),
            initialState: "active",
          });
          f.setProjectAvailable(false);
          const result = yield* runs.trigger(a.id);
          expect(result._tag).toBe("blocked");
          const state = (yield* definitions.lookup(a.id)).state;
          expect(state._tag).toBe("suspended");
          if (state._tag === "suspended") expect(state.reason).toContain("missing");
          expect((yield* runs.activate(a.id).pipe(Effect.result))._tag).toBe("Failure");
          f.setProjectAvailable(true);
          yield* runs.activate(a.id);
          expect((yield* definitions.lookup(a.id)).state._tag).toBe("active");
        }).pipe(Effect.provide(f.context));
      }),
  );
  it.effect(
    "archives a one-time automation after its execution attempt and retains memory and history",
    () =>
      Effect.gen(function* () {
        const f = yield* automationFixture();
        yield* Effect.gen(function* () {
          const a = yield* definitions.create({
            definition: automationDefinition({
              trigger: {
                _tag: "Schedule",
                schedule: { _tag: "Once", at: "2030-01-01T09:00:00.000Z" },
              },
              overlap: "queue",
            }),
            initialState: "active",
          });
          yield* TestClock.setTime(
            DateTime.toEpochMillis(DateTime.makeUnsafe("2030-01-01T09:00:00.000Z")),
          );
          yield* worker.runSchedulePass();
          const started = yield* Queue.take(f.started);
          const queued = yield* runs.trigger(a.id);
          expect(queued._tag).toBe("queued");
          yield* f.complete(started.sessionId);
          yield* waitForSettlement(f, started.sessionId);
          expect((yield* definitions.lookup(a.id)).state._tag).toBe("archived");
          expect((yield* definitions.lookup(a.id)).memoryId).toBe(a.memoryId);
          expect(
            f.records.snapshot().occurrences.find((item) => item.id === queued.occurrenceId)
              ?.disposition._tag,
          ).toBe("canceled");
          expect((yield* definitions.history({ automationId: a.id })).runs[0]?.sessionId).toBe(
            started.sessionId,
          );
        }).pipe(Effect.provide(f.context));
      }),
  );
  it.effect(
    "auto-resolves successful sessions only when configured and retains failures for review",
    () =>
      Effect.gen(function* () {
        const f = yield* automationFixture();
        yield* Effect.gen(function* () {
          const automation = yield* definitions.create({
            definition: automationDefinition({ completion: "auto-resolve" }),
            initialState: "active",
          });
          yield* runs.trigger(automation.id);
          const started = yield* Queue.take(f.started);
          yield* f.complete(started.sessionId);
          yield* f.records.changes().pipe(
            Stream.mapEffect(() => Ref.get(f.resolved)),
            Stream.filter((ids) => ids.has(started.sessionId)),
            Stream.take(1),
            Stream.runDrain,
          );
          expect((yield* runs.runForSession(started.sessionId)).status._tag).toBe("completed");
          yield* runs.trigger(automation.id);
          const failed = yield* Queue.take(f.started);
          yield* f.fail(failed.sessionId);
          yield* waitForSettlement(f, failed.sessionId);
          expect((yield* Ref.get(f.resolved)).has(failed.sessionId)).toBe(false);
        }).pipe(Effect.provide(f.context));
      }),
  );
  it.effect("lets keep-for-review sessions remain unresolved after successful execution", () =>
    Effect.gen(function* () {
      const f = yield* automationFixture();
      yield* Effect.gen(function* () {
        const automation = yield* definitions.create({
          definition: automationDefinition(),
          initialState: "active",
        });
        yield* runs.trigger(automation.id);
        const started = yield* Queue.take(f.started);
        yield* f.complete(started.sessionId);
        yield* waitForSettlement(f, started.sessionId);
        expect((yield* Ref.get(f.resolved)).has(started.sessionId)).toBe(false);
      }).pipe(Effect.provide(f.context));
    }),
  );
  it.effect(
    "unresolves a historical session without rerunning or reactivating its automation",
    () =>
      Effect.gen(function* () {
        const f = yield* automationFixture();
        yield* Effect.gen(function* () {
          const automation = yield* definitions.create({
            definition: automationDefinition({ completion: "auto-resolve" }),
            initialState: "active",
          });
          yield* runs.trigger(automation.id);
          const started = yield* Queue.take(f.started);
          yield* f.complete(started.sessionId);
          expect(yield* Queue.take(f.disposed)).toBe(started.sessionId);
          expect((yield* Ref.get(f.resolved)).has(started.sessionId)).toBe(true);
          yield* definitions.changeState(automation.id, { _tag: "paused" });
          yield* runs.setResolved(started.sessionId, true);
          yield* runs.setResolved(started.sessionId, false);
          yield* worker.recover();
          expect(f.captured).toHaveLength(1);
          expect((yield* definitions.lookup(automation.id)).state._tag).toBe("paused");
          expect((yield* Ref.get(f.resolved)).has(started.sessionId)).toBe(false);
        }).pipe(Effect.provide(f.context));
      }),
  );
  it.effect(
    "cancels a run without pausing its automation and cancels queued work without creating a session",
    () =>
      Effect.gen(function* () {
        const f = yield* automationFixture();
        yield* Effect.gen(function* () {
          const a = yield* definitions.create({
            definition: automationDefinition({ overlap: "queue" }),
            initialState: "active",
          });
          const first = yield* runs.trigger(a.id);
          const started = yield* Queue.take(f.started);
          const queued = yield* runs.trigger(a.id);
          yield* runs.cancelQueued(queued.occurrenceId);
          if (first._tag === "started") yield* runs.cancelRun(first.runId);
          yield* waitForSettlement(f, started.sessionId);
          expect((yield* definitions.lookup(a.id)).state._tag).toBe("active");
          expect((yield* runs.runForSession(started.sessionId)).status._tag).toBe("canceled");
          expect(f.captured).toHaveLength(1);
        }).pipe(Effect.provide(f.context));
      }),
  );
});

describe("automation triggers and recovery", () => {
  it.effect.each(["completed", "failed", "canceled"] as const)(
    "recovers accepted historical follow-ups without replacing the original %s outcome and leaves held receipts for review",
    (originalOutcome) =>
      Effect.gen(function* () {
        const f = yield* automationFixture();
        const checkpoint = yield* Effect.gen(function* () {
          const a = yield* definitions.create({
            definition: automationDefinition(),
            initialState: "active",
          });
          yield* runs.trigger(a.id);
          const first = yield* Queue.take(f.started);
          if (originalOutcome === "completed") yield* f.complete(first.sessionId);
          else if (originalOutcome === "failed") yield* f.fail(first.sessionId);
          else yield* runs.cancelRun((yield* runs.runForSession(first.sessionId)).id);
          expect(yield* Queue.take(f.disposed)).toBe(first.sessionId);
          return f.records.snapshot();
        }).pipe(Effect.provide(f.context));
        const original = checkpoint.runs[0];
        if (!original) throw new Error("Expected the historical automation run");
        expect(original.status._tag).toBe(originalOutcome);
        for (const state of ["active", "blocked", "stopped"] as const) {
          const input: RuntimeRecoveryInput = {
            turnId: crypto.randomUUID(),
            text: "Accepted historical follow-up, not the saved automation task",
            delivery: "follow-up",
            attachments: [],
            markdown: false,
          };
          const receipt = {
            sessionId: original.sessionId,
            workingDirectory: original.workingDirectory,
            sessionDirectory: original.sessionDirectory,
            profile: "AutomationSession" as const,
            transcriptPersisted: true,
            inputs: [input],
            state,
            ...(state === "blocked" ? { issue: "An unfinished tool needs review" } : {}),
          };
          const restarted = yield* automationFixture({ ledger: checkpoint, recovery: [receipt] });
          yield* worker.recover().pipe(Effect.provide(restarted.context));
          expect(restarted.records.snapshot().runs[0]?.status).toEqual(original.status);
          if (state === "active") {
            expect(restarted.captured).toHaveLength(1);
            expect(restarted.captured[0]?.newSession).toBe(false);
            const resumed = yield* Queue.take(restarted.started);
            expect(resumed.sessionId).toBe(original.sessionId);
            expect(resumed.turnId).toBe(input.turnId);
            expect(resumed.text).toBe(input.text);
            expect(yield* Queue.take(restarted.recoveredInputs)).toEqual(input);
            expect(
              (yield* definitions
                .inspect(original.automationId)
                .pipe(Effect.provide(restarted.context))).activity.runningSessions,
            ).toBe(1);
            yield* restarted.complete(original.sessionId, input.turnId);
            expect(yield* Queue.take(restarted.disposed)).toBe(original.sessionId);
          } else {
            expect(restarted.captured).toHaveLength(0);
            expect(
              (yield* Context.get(restarted.context, RuntimeRecoveryStorage).get(
                original.sessionId,
              ))?.inputs,
            ).toEqual([input]);
            expect((yield* restarted.sessions.currentStatus(original))?.pending).toBe(true);
            expect(
              (yield* Context.get(restarted.context, RuntimeRecoveryStorage).get(
                original.sessionId,
              ))?.state,
            ).toBe(state);
            expect(
              (yield* definitions
                .inspect(original.automationId)
                .pipe(Effect.provide(restarted.context))).activity.runningSessions,
            ).toBe(0);
          }
          expect(restarted.records.snapshot().runs).toHaveLength(1);
          expect(restarted.records.snapshot().runs[0]?.status).toEqual(original.status);
        }
      }),
  );
  it.effect(
    "fires once, fixed-interval, and timezone-aware calendar schedules using backend time",
    () =>
      Effect.gen(function* () {
        const f = yield* automationFixture();
        yield* Effect.gen(function* () {
          const schedules: AutomationSchedule[] = [
            { _tag: "Once", at: "2030-01-01T09:00:00.000Z" },
            { _tag: "Interval", startsAt: "2030-01-01T09:00:00.000Z", everySeconds: 86_400 },
            {
              _tag: "Calendar",
              expression: "0 9 * * *",
              timeZone: "America/New_York",
              startsAt: "2030-01-01T09:00:00.000Z",
            },
          ];
          for (const schedule of schedules)
            yield* definitions.create({
              definition: automationDefinition({ trigger: { _tag: "Schedule", schedule } }),
              initialState: "active",
            });
          expect(f.records.snapshot().automations[2]?.nextScheduledAt).toBe(
            "2030-01-01T14:00:00.000Z",
          );
          yield* worker.runSchedulePass();
          expect(f.captured).toHaveLength(0);
          yield* TestClock.setTime(
            DateTime.toEpochMillis(DateTime.makeUnsafe("2030-01-01T14:00:00.000Z")),
          );
          yield* worker.runSchedulePass();
          expect(f.captured).toHaveLength(3);
          yield* worker.runSchedulePass();
          expect(f.captured).toHaveLength(3);
          for (let i = 0; i < 3; i++) {
            const started = yield* Queue.take(f.started);
            yield* f.complete(started.sessionId);
            yield* waitForSettlement(f, started.sessionId);
          }
          expect(f.records.snapshot().automations[0]?.state._tag).toBe("archived");
        }).pipe(Effect.provide(f.context));
      }),
  );
  it.effect("does not backfill every missed interval when the backend restarts", () =>
    Effect.gen(function* () {
      const f = yield* automationFixture();
      yield* Effect.gen(function* () {
        yield* definitions.create({ definition: automationDefinition(), initialState: "active" });
        yield* TestClock.setTime(
          DateTime.toEpochMillis(DateTime.makeUnsafe("2030-01-11T09:00:00.000Z")),
        );
        yield* worker.runSchedulePass();
        yield* worker.runSchedulePass();
        expect(f.captured).toHaveLength(1);
        expect(f.records.snapshot().automations[0]?.nextScheduledAt).toBe(
          "2030-01-12T09:00:00.000Z",
        );
        const started = yield* Queue.take(f.started);
        yield* f.complete(started.sessionId);
        yield* waitForSettlement(f, started.sessionId);
      }).pipe(Effect.provide(f.context));
    }),
  );
  it.effect("persists definitions, queued occurrences and session links across restart", () =>
    Effect.gen(function* () {
      const f = yield* automationFixture();
      yield* Effect.gen(function* () {
        const a = yield* definitions.create({
          definition: automationDefinition({ overlap: "queue" }),
          initialState: "active",
        });
        yield* runs.trigger(a.id);
        const first = yield* Queue.take(f.started);
        const queued = yield* runs.trigger(a.id);
        const checkpoint = f.records.snapshot();
        const directory = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(join(tmpdir(), "cake-automation-storage-"))),
          (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
        );
        const storage = makeAutomationStorageLive(directory).pipe(
          Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)),
        );
        yield* Effect.gen(function* () {
          yield* (yield* AutomationStorage).save(checkpoint);
        }).pipe(Effect.provide(storage));
        const restored = yield* Effect.gen(function* () {
          const records = yield* AutomationRecords;
          yield* records.initialize();
          return records.snapshot();
        }).pipe(Effect.provide(Layer.fresh(AutomationRecords.layer.pipe(Layer.provide(storage)))));
        expect(restored.automations).toEqual(checkpoint.automations);
        expect(restored.occurrences).toEqual(checkpoint.occurrences);
        expect(restored.runs).toEqual(checkpoint.runs);
        yield* runs.cancelQueued(queued.occurrenceId);
        yield* f.complete(first.sessionId);
        yield* waitForSettlement(f, first.sessionId);
      }).pipe(Effect.provide(f.context));
    }),
  );
  it.effect(
    "uses existing Pi recovery outcomes rather than blindly rerunning interrupted work",
    () =>
      Effect.gen(function* () {
        const f = yield* automationFixture();
        const checkpoint = yield* Effect.gen(function* () {
          const a = yield* definitions.create({
            definition: automationDefinition(),
            initialState: "active",
          });
          yield* runs.trigger(a.id);
          const started = yield* Queue.take(f.started);
          const saved = f.records.snapshot();
          yield* f.complete(started.sessionId);
          yield* waitForSettlement(f, started.sessionId);
          return saved;
        }).pipe(Effect.provide(f.context));
        const interrupted = checkpoint.runs[0];
        expect(interrupted).toBeDefined();
        if (!interrupted) return;
        for (const state of ["blocked", "complete"] as const) {
          const restarted = yield* automationFixture({
            ledger: checkpoint,
            recovery: [
              {
                sessionId: interrupted.sessionId,
                workingDirectory: interrupted.workingDirectory,
                sessionDirectory: interrupted.sessionDirectory,
                profile: "AutomationSession",
                transcriptPersisted: true,
                inputs: [],
                state,
                issue: "An unfinished tool needs review",
              },
            ],
          });
          yield* worker.recover().pipe(Effect.provide(restarted.context));
          expect(restarted.captured).toHaveLength(0);
          expect(restarted.records.snapshot().runs[0]?.status._tag).toBe(
            state === "blocked" ? "failed" : "completed",
          );
          expect(restarted.records.snapshot().automations[0]?.state._tag).toBe("active");
        }
      }),
  );
  it.effect(
    "emits response-completed only for a successful final reply, never tools or intermediate text",
    () =>
      Effect.gen(function* () {
        const f = yield* automationSourceFixture();
        const settled = f.options.onTurnSettled;
        expect(settled).toBeDefined();
        if (!settled) return;
        for (const stopReason of ["toolUse", "length", "error", "aborted"])
          yield* settled({
            sessionId: "source",
            turnId: "turn",
            outcome: "complete",
            result: {
              stopReason,
              entryId: `entry-${stopReason}`,
              text: "Not a successful final response",
            },
          });
        yield* settled({
          sessionId: "source",
          turnId: "turn",
          outcome: "failed",
          result: { stopReason: "stop", entryId: "failed", text: "A failed final response" },
        });
        expect(f.events).toHaveLength(0);
        yield* settled({
          sessionId: "source",
          turnId: "turn",
          outcome: "complete",
          result: { stopReason: "stop", entryId: "final", text: "The final response" },
        });
        expect(f.events).toHaveLength(1);
        expect(f.events[0]).toMatchObject({
          event: "assistant-response-completed",
          sourceSessionId: "source",
          sourceMessageId: "final",
          text: "The final response",
          sourceKind: "standalone-project-session",
        });
      }),
  );
  it.effect("emits user-message-received only for genuine user input, not internal notices", () =>
    Effect.gen(function* () {
      const f = yield* automationSourceFixture();
      const admit = f.options.admitTurn;
      expect(admit).toBeDefined();
      if (!admit) return;
      yield* admit(
        {
          turnId: "notice",
          text: "Notice",
          delivery: "prompt",
          internal: { _tag: "UpdateBatch", notices: [] },
        },
        Effect.void,
      );
      yield* admit(
        {
          turnId: "board",
          text: "Workboard",
          delivery: "prompt",
          internal: { _tag: "WorkboardDelivery", boardId: "board", sequences: [1] },
        },
        Effect.void,
      );
      expect(f.events).toHaveLength(0);
      yield* admit({ turnId: "human", text: "Do the task", delivery: "prompt" }, Effect.void);
      yield* admit(
        {
          turnId: "with-context",
          text: "Expanded context",
          delivery: "prompt",
          internal: {
            _tag: "UserWithReminders",
            text: "Expanded context",
            userText: "My own words",
            notices: [],
          },
        },
        Effect.void,
      );
      expect(f.events.map((event) => event.text)).toEqual(["Do the task", "My own words"]);
    }),
  );
  it.effect(
    "evaluates source events without requiring a renderer to observe the source session",
    () =>
      Effect.gen(function* () {
        const f = yield* automationFixture();
        yield* Effect.gen(function* () {
          yield* definitions.create({
            definition: automationDefinition({
              trigger: {
                _tag: "Event",
                filter: {
                  event: "assistant-response-completed",
                  scope: { _tag: "Project", projectPath: "/projects/cake" },
                  sessionKinds: ["family-child"],
                  sessionId: "child",
                  contentContains: "ready",
                },
              },
            }),
            initialState: "active",
          });
          const event = {
            eventId: "event",
            event: "assistant-response-completed" as const,
            occurredAt: "2030-01-01T09:00:00.000Z",
            projectPath: "/projects/cake",
            sourceSessionId: "child",
            sourceKind: "family-child" as const,
            sourceMessageId: "final",
            text: "ready",
          };
          yield* worker.acceptEvent({ ...event, sourceSessionId: "unrelated" });
          expect(f.captured).toHaveLength(0);
          yield* worker.acceptEvent(event);
          const started = yield* Queue.take(f.started);
          expect(f.records.snapshot().occurrences[0]?.source._tag).toBe("Event");
          yield* f.complete(started.sessionId);
          yield* waitForSettlement(f, started.sessionId);
        }).pipe(Effect.provide(f.context));
      }),
  );
});
