import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Context, Deferred, Effect, Fiber, Layer, Queue, Schema, Stream } from "effect";
import { parseCrossSessionMessage } from "../../../src/contracts/conversations/cross-session-message";
import { SessionFamilyStorage } from "../../../src/services/storage/SessionFamilyStorage";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { automationDefinition, automationFixture } from "../helpers/automationFixture";
import { automationHandlers } from "../../../src/ipc/server/AutomationHandlers";
import * as definitions from "../../../src/domain/automations/automationDefinitions";
import * as runs from "../../../src/domain/automations/automationRuns";
import * as controls from "../../../src/domain/automations/automationControl";
import { createAutomationOperations } from "../../../src/domain/automations/cake-automation-operations";
import { CakeOperationRegistry } from "../../../src/services/pi/runtime/cake-operation-registry";
import { projectCakeOperations } from "../../../src/layers/CakeOperations";
import { makePiCallbackExecutor } from "../../../src/services/pi/PiCallbackAdapter";
import { makeOptMemoryLive } from "../../../src/services/opt-memory/OptMemoryLive";
import { OptMemory } from "../../../src/services/opt-memory/OptMemory";
import { TaskInputStorage } from "../../../src/services/storage/TaskInputStorage";
import { toJsonValue } from "../../../src/utils/to-json-value";
import { AttachmentUploads } from "../../../src/services/filesystem/AttachmentUploads";
import { RendererConnection } from "../../../src/ipc/protocol/RendererConnectionMiddleware";
import { AutomationTriggerResult } from "../../../src/contracts/automations/automation-control";
import type { JsonObject } from "../../../src/contracts/serialization/json-contract";

const execution = {
  signal: new AbortController().signal,
  toolCallId: "automation-tool-test",
  runtime: {},
};
const TriggerReceipt = Schema.Struct({
  ok: Schema.Literal(true),
  command: Schema.String,
  result: AutomationTriggerResult,
});
const registryFor = (
  f: Effect.Success<ReturnType<typeof automationFixture>>,
  caller = "ordinary-session",
) => {
  const run = makePiCallbackExecutor(f.context);
  return new CakeOperationRegistry(
    createAutomationOperations(
      (command, input, signal) => run(controls.invoke(command, input, caller), { signal }),
      false,
      false,
    ),
  );
};
const invoke = (registry: CakeOperationRegistry, command: string, input: JsonObject) =>
  Effect.tryPromise({
    try: () => registry.invoke({ command, input }, execution),
    catch: (error) => error,
  }).pipe(
    Effect.map((receipt) => ({
      ...receipt,
      details: Schema.decodeUnknownSync(
        Schema.Struct({ protocol: Schema.Literal("cake.operation/v1"), result: Schema.Json }),
      )(receipt.details).result,
    })),
  );
const finish = (f: Effect.Success<ReturnType<typeof automationFixture>>, sessionId: string) =>
  f.complete(sessionId).pipe(
    Effect.andThen(
      f.records.changes().pipe(
        Stream.filter((ledger) =>
          ledger.runs.some((run) => run.sessionId === sessionId && run.status._tag !== "running"),
        ),
        Stream.take(1),
        Stream.runDrain,
      ),
    ),
  );

describe("automation Cake tools parity", () => {
  it.effect("forwards only caller-owned task input references into a saved automation", () =>
    Effect.gen(function* () {
      const f = yield* automationFixture();
      yield* Effect.gen(function* () {
        const inputs = yield* TaskInputStorage;
        const owner = crypto.randomUUID();
        const references = yield* inputs.isolate(owner, [
          { kind: "text", name: "private.txt", text: "EXPLICITLY FORWARDED ORIGINAL" },
        ]);
        const base = automationDefinition();
        const command = toJsonValue({
          definition: { ...base, task: { ...base.task, attachments: references } },
          initialState: "active",
        });
        expect(
          (yield* controls
            .invoke("automations.create", command, crypto.randomUUID())
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(f.records.snapshot().automations).toHaveLength(0);
        const result = yield* controls.invoke("automations.create", command, owner);
        expect(JSON.stringify(result)).not.toContain("EXPLICITLY FORWARDED ORIGINAL");
        const saved = f.records.snapshot().automations[0];
        if (!saved) throw new Error("Expected the saved automation");
        expect(saved.definition.task.attachments).toEqual(references);
        yield* runs.trigger(saved.id);
        const started = yield* Queue.take(f.started);
        expect((yield* inputs.list(started.sessionId, {})).references).toEqual(references);
        yield* finish(f, started.sessionId);
      }).pipe(Effect.provide(f.context));
    }),
  );
  it.effect(
    "lets a global automation launch an independent Project Session with explicit automation provenance",
    () =>
      Effect.gen(function* () {
        const f = yield* automationFixture();
        yield* Effect.gen(function* () {
          const a = yield* definitions.create({
            definition: automationDefinition(),
            initialState: "active",
          });
          yield* runs.trigger(a.id);
          const automated = yield* Queue.take(f.started);
          const gateway = f.captured[0]?.automationControl;
          expect(gateway).toBeDefined();
          if (!gateway) return;
          const operations = projectCakeOperations(automated.options)({
            host: { appendEntry: () => undefined },
            api: () => {
              throw new Error("Registration must not read the lazy runtime API");
            },
            sessionId: () => automated.sessionId,
            publishSnapshot: async () => undefined,
            getAvailableOfType: async () => [],
          });
          const names = operations.map((item) => item.command);
          expect(names).toEqual(
            expect.arrayContaining([
              "projects.list",
              "projects.info",
              "session.info",
              "session.set-model",
              "models.list",
              "memory.write",
              "sessions.create",
            ]),
          );
          expect(names).not.toContain("artifacts.create");
          expect(names).not.toContain("settings.update");
          const registry = new CakeOperationRegistry(operations);
          expect((yield* invoke(registry, "projects.list", {})).details).toMatchObject({
            projects: [{ path: "/projects/cake" }],
          });
          expect(
            (yield* invoke(registry, "projects.info", { path: "/projects/cake" })).details,
          ).toMatchObject({ project: { path: "/projects/cake" } });
          const result = yield* invoke(registry, "sessions.create", {
            workspacePath: "/projects/cake",
            name: "Review",
            initialPrompt: "Review the proposed change.",
          });
          const receipt = Schema.decodeUnknownSync(
            Schema.Struct({
              ok: Schema.Literal(true),
              sessionId: Schema.String,
              status: Schema.Literal("started"),
            }),
          )(result.details);
          const project = yield* Queue.take(f.started);
          expect(project.sessionId).toBe(receipt.sessionId);
          expect(project.options.cwd).toBe("/projects/cake");
          expect(parseCrossSessionMessage(project.text)?.metadata.sender).toMatchObject({
            kind: "automation-session",
            sessionId: automated.sessionId,
            title: a.definition.name,
          });
          expect(parseCrossSessionMessage(project.text)?.metadata.expectsResponse).toBe(false);
          expect(
            yield* (yield* SessionFamilyStorage).familyForMember(project.sessionId),
          ).toBeUndefined();
          expect(f.records.snapshot().runs).toHaveLength(1);
          const handle = yield* f.sessions.acquireSession(project.sessionId);
          expect(handle.profile).toBe("ProjectSession");
          const ready = yield* Deferred.make<void>();
          const settled = yield* handle.updates.pipe(
            Stream.tap(() => Deferred.succeed(ready, undefined)),
            Stream.filter(
              (update) => update._tag === "Event" && update.event.type === "turn-settled",
            ),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
          yield* Deferred.await(ready);
          yield* f.complete(project.sessionId);
          yield* Fiber.join(settled);
          yield* finish(f, automated.sessionId);
        }).pipe(Effect.provide(f.context));
      }),
  );
  it.effect(
    "uses the same backend operations for UI and agent creation, configuration and lifecycle controls",
    () =>
      Effect.gen(function* () {
        const f = yield* automationFixture();
        const registry = registryFor(f);
        const admittedOwners: number[] = [];
        const definition = automationDefinition();
        yield* Effect.gen(function* () {
          const automation = yield* automationHandlers["automations.create"]({
            definition: {
              ...definition,
              task: {
                ...definition.task,
                attachments: [{ kind: "text", name: "UI input", text: "User-selected attachment" }],
              },
            },
            initialState: "paused",
          });
          yield* automationHandlers["automations.update"]({
            automationId: automation.id,
            definition: { ...automation.definition, name: "UI-edited brief" },
          });
          expect(admittedOwners).toEqual([7, 7]);
          yield* invoke(registry, "automations.activate", { automationId: automation.id });
          expect(
            (yield* automationHandlers["automations.inspect"]({ automationId: automation.id }))
              .automation.state._tag,
          ).toBe("active");
          yield* invoke(registry, "automations.update", {
            automationId: automation.id,
            changes: { name: "Updated brief" },
          });
          expect((yield* definitions.lookup(automation.id)).definition.task).toEqual(
            automation.definition.task,
          );
          expect((yield* definitions.lookup(automation.id)).definition.name).toBe("Updated brief");
          yield* invoke(registry, "automations.pause", { automationId: automation.id });
          expect((yield* definitions.lookup(automation.id)).state._tag).toBe("paused");
          const receipt = Schema.decodeUnknownSync(TriggerReceipt)(
            (yield* invoke(registry, "automations.trigger", { automationId: automation.id }))
              .details,
          );
          expect(receipt.result._tag).toBe("started");
          const started = yield* Queue.take(f.started);
          yield* finish(f, started.sessionId);
          yield* invoke(registry, "automations.archive", {
            automationId: automation.id,
            runningSessions: "let-finish",
          });
          expect((yield* definitions.lookup(automation.id)).state._tag).toBe("archived");
          expect(f.records.snapshot().occurrences[0]?.source).toMatchObject({
            _tag: "Manual",
            requestedBySessionId: "ordinary-session",
          });
        }).pipe(
          Effect.provide(f.context),
          Effect.provideService(RendererConnection, {
            connectionId: 7,
            correlationId: "automation-ui-test",
          }),
          Effect.provide(
            Layer.mock(AttachmentUploads, {
              admit: (owner, attachments) => {
                admittedOwners.push(owner);
                return Effect.succeed(attachments);
              },
            }),
          ),
        );
      }),
  );

  it.effect(
    "returns started with a session ID, queued, skipped or blocked rather than a generic success",
    () =>
      Effect.gen(function* () {
        const f = yield* automationFixture();
        const registry = registryFor(f);
        yield* Effect.gen(function* () {
          const automation = yield* definitions.create({
            definition: automationDefinition(),
            initialState: "active",
          });
          const fire = () =>
            invoke(registry, "automations.trigger", { automationId: automation.id }).pipe(
              Effect.map(
                (result) => Schema.decodeUnknownSync(TriggerReceipt)(result.details).result,
              ),
            );
          const first = yield* fire();
          expect(first).toMatchObject({
            _tag: "started",
            sessionId: expect.any(String),
            runId: expect.any(String),
          });
          const started = yield* Queue.take(f.started);
          const skipped = yield* fire();
          expect(skipped).toMatchObject({ _tag: "skipped", reason: expect.any(String) });
          yield* definitions.update({
            automationId: automation.id,
            definition: { ...automation.definition, overlap: "queue" },
          });
          expect((yield* fire())._tag).toBe("queued");
          yield* finish(f, started.sessionId);
          const queued = yield* Queue.take(f.started);
          yield* finish(f, queued.sessionId);
          yield* runs.archive({ automationId: automation.id, runningSessions: "let-finish" });
          expect(yield* fire()).toMatchObject({ _tag: "blocked", reason: expect.any(String) });
        }).pipe(Effect.provide(f.context));
      }),
  );

  it.effect(
    "lists bounded metadata before exact configuration and independently bounded history reads",
    () =>
      Effect.gen(function* () {
        const f = yield* automationFixture();
        const registry = registryFor(f);
        yield* Effect.gen(function* () {
          const secret = "PRIVATE TASK BODY ".repeat(1_000);
          const attachment = "PRIVATE ATTACHMENT BODY ".repeat(1_000);
          const base = automationDefinition();
          const a = yield* definitions.create({
            definition: {
              ...base,
              task: {
                ...base.task,
                prompt: secret,
                attachments: [{ kind: "text", name: "notes.txt", text: attachment }],
              },
            },
            initialState: "active",
          });
          const other = yield* definitions.create({
            definition: automationDefinition({ name: "Second" }),
            initialState: "active",
          });
          const listReceipt = yield* invoke(registry, "automations.list", { limit: 1 });
          const listed = listReceipt.details;
          expect(listReceipt.text).toContain("2 automations; next=1");
          expect(listReceipt.text).toContain("id\tstate\trunning\tqueued\tcontext\tnext\tname");
          expect(listed).toMatchObject({ total: 2, nextOffset: 1 });
          expect(JSON.stringify(listed)).not.toContain("PRIVATE TASK BODY");
          const inspected = (yield* invoke(registry, "automations.inspect", { automationId: a.id }))
            .details;
          expect(JSON.stringify(inspected)).not.toContain("PRIVATE TASK BODY");
          expect(JSON.stringify(inspected)).not.toContain("PRIVATE ATTACHMENT BODY");
          expect(inspected).toMatchObject({
            automation: {
              definition: {
                task: {
                  promptCharacters: secret.length,
                  attachments: [{ kind: "input", name: "notes.txt" }],
                },
              },
            },
          });
          const page = (yield* invoke(registry, "automations.read-task", {
            automationId: a.id,
            maxChars: 19,
          })).details;
          expect(page).toMatchObject({
            text: secret.slice(0, 19),
            totalChars: secret.length,
            nextOffset: 19,
          });
          yield* runs.trigger(a.id);
          const started = yield* Queue.take(f.started);
          yield* finish(f, started.sessionId);
          const historyReceipt = yield* invoke(registry, "automations.history", {
            automationId: a.id,
            limit: 1,
          });
          const history = historyReceipt.details;
          expect(historyReceipt.text).toContain("1 occurrences");
          expect(historyReceipt.text).toContain(started.sessionId);
          expect(history).toMatchObject({ total: 1, nextOffset: null });
          expect(JSON.stringify(history)).not.toContain("PRIVATE TASK BODY");
          expect(JSON.stringify(history)).not.toContain("PRIVATE ATTACHMENT BODY");
          yield* runs.trigger(other.id);
          const secondRun = yield* Queue.take(f.started);
          yield* finish(f, secondRun.sessionId);
          const global = yield* invoke(registry, "automations.history", { limit: 2 });
          expect(global.details).toMatchObject({ total: 2, nextOffset: null });
          expect(global.text).toContain("id\tautomation\ttrigger");
          expect(global.text).toContain(a.id);
          expect(global.text).toContain(other.id);
          expect(JSON.stringify(global.details)).not.toContain("PRIVATE TASK BODY");
          expect(JSON.stringify(global.details)).not.toContain("PRIVATE ATTACHMENT BODY");
          expect(
            (yield* invoke(registry, "automations.history", { limit: 1 })).details,
          ).toMatchObject({ total: 2, nextOffset: 1 });
          expect(
            (yield* invoke(registry, "automations.history", { offset: 1, limit: 1 })).details,
          ).toMatchObject({ total: 2, nextOffset: null });
          expect(
            (yield* invoke(registry, "automations.history", { query: "Second" })).details,
          ).toMatchObject({ total: 1 });
          expect(
            (yield* invoke(registry, "automations.history", { query: "PRIVATE TASK BODY" }))
              .details,
          ).toMatchObject({ total: 0 });
        }).pipe(Effect.provide(f.context));
      }),
  );

  it.effect(
    "derives the caller's memory identity and write provenance instead of trusting supplied session IDs",
    () =>
      Effect.gen(function* () {
        const f = yield* automationFixture();
        const directory = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(join(tmpdir(), "cake-automation-tools-"))),
          (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
        );
        const memoryContext = yield* Layer.build(
          makeOptMemoryLive(directory, { summarize: async () => "A note summary" }),
        );
        const context = Context.merge(f.context, memoryContext);
        yield* Effect.gen(function* () {
          const a = yield* definitions.create({
            definition: automationDefinition({ overlap: "parallel" }),
            initialState: "active",
          });
          const other = yield* definitions.create({
            definition: automationDefinition(),
            initialState: "active",
          });
          yield* runs.trigger(a.id);
          const started = yield* Queue.take(f.started);
          const gateway = f.captured[0]?.automationControl;
          expect(gateway).toBeDefined();
          if (!gateway) return;
          const registry = new CakeOperationRegistry(
            createAutomationOperations(gateway, true, false),
          );
          const written = yield* invoke(registry, "memory.write", {
            text: "Remember this deployment choice.",
          });
          expect(written.details).toMatchObject({
            ok: true,
            result: { sourceId: expect.any(String) },
          });
          const invalid = yield* invoke(registry, "memory.write", {
            text: "Wrong owner",
            memoryId: other.memoryId,
            sourceSessionId: "forged",
          }).pipe(Effect.result);
          expect(invalid._tag).toBe("Failure");
          const memory = yield* OptMemory;
          const shared = yield* memory.read({ memoryId: a.memoryId });
          expect(shared.sourceCount).toBe(1);
          expect(shared.lines[0]?.text).toContain(started.sessionId);
          expect((yield* memory.read({ memoryId: other.memoryId })).sourceCount).toBe(0);
          yield* runs.trigger(a.id);
          const second = yield* Queue.take(f.started);
          const secondGateway = f.captured[1]?.automationControl;
          expect(secondGateway).toBeDefined();
          if (secondGateway) {
            const secondRegistry = new CakeOperationRegistry(
              createAutomationOperations(secondGateway, true, false),
            );
            const refreshed = yield* invoke(secondRegistry, "memory.read", {});
            expect(JSON.stringify(refreshed.details)).toContain("Remember this deployment choice.");
            const original = yield* invoke(secondRegistry, "memory.zoom", {
              range: { id: 0, n: 1 },
            });
            expect(original.details).toMatchObject({
              result: { _tag: "Original", text: "Remember this deployment choice." },
            });
          }
          yield* finish(f, started.sessionId);
          yield* finish(f, second.sessionId);
        }).pipe(Effect.provide(context));
      }),
  );
});
