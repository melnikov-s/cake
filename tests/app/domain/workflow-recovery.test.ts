import { it } from "@effect/vitest";
import { describe, expect } from "vitest";
import {
  Deferred,
  Effect,
  FiberMap,
  FileSystem,
  Layer,
  Queue,
  Stream,
  SubscriptionRef,
} from "effect";
import { basename, dirname } from "node:path";
import { TestClock } from "effect/testing";
import { WorkflowError } from "../../../src/contracts/workflows/workflow-data";
import { NodePath } from "@effect/platform-node-shared";
import * as workflows from "../../../src/domain/workflows/workflows";
import * as lifecycle from "../../../src/domain/workflows/workflow-lifecycle";
import * as families from "../../../src/domain/session-families/sessionFamilies";
import { WorkflowRunStorage } from "../../../src/services/storage/WorkflowRunStorage";
import { makeWorkflowRunStorageLive } from "../../../src/services/storage/WorkflowRunStorageLive";
import { SessionFamilyStorage } from "../../../src/services/storage/SessionFamilyStorage";
import { WorkflowSupervisor } from "../../../src/services/workflows/WorkflowSupervisor";
import { ProjectSessionRuntimeHost } from "../../../src/services/pi/ProjectSessionRuntimeHost";
import { makeWorkflowDomainFixture } from "../helpers/workflowDomainFixture";
import { familyStorageHarness } from "../helpers/familyStorageHarness";
import { checkpoint, target } from "../helpers/workflowFixture";
import type { WorkflowRun } from "../../../src/contracts/workflows/workflow-data";

// Real atomic, schema-validated storage over controlled files. Each phase acquires
// a fresh supervisor/runtime/coordination graph, but keeps the persisted evidence.
const persistence = () => {
  const files = new Map<string, string>();
  const noop = FileSystem.makeNoop({});
  const fs = FileSystem.makeNoop({
    exists: (path) =>
      Effect.succeed(
        files.has(path) || [...files.keys()].some((file) => file.startsWith(`${path}/`)),
      ),
    readFileString: (path) =>
      files.has(path) ? Effect.succeed(files.get(path) ?? "") : noop.readFileString(path),
    readDirectory: (path) =>
      Effect.succeed(
        [...files.keys()].filter((file) => dirname(file) === path).map((file) => basename(file)),
      ),
    makeDirectory: () => Effect.void,
    chmod: () => Effect.void,
    writeFileString: (path, content) =>
      Effect.sync(() => {
        files.set(path, content);
      }),
    rename: (from, to) =>
      Effect.sync(() => {
        files.set(to, files.get(from) ?? "");
        files.delete(from);
      }),
    remove: (path) =>
      Effect.sync(() => {
        files.delete(path);
      }),
  });
  const layer = Layer.merge(
    makeWorkflowRunStorageLive("/state/workflows").pipe(
      Layer.provide(Layer.merge(NodePath.layer, Layer.succeed(FileSystem.FileSystem, fs))),
    ),
    familyStorageHarness(files).layer,
  );
  return { files, layer };
};
const assignment = (turnId = "launch") => ({
  turnId,
  sessionId: target.sessionId,
  senderSessionId: "parent",
  requestMessageId: turnId,
  threadId: turnId,
  reported: false,
});
const seed = (status: WorkflowRun["status"] = "complete") =>
  Effect.gen(function* () {
    const saved = checkpoint();
    yield* (yield* WorkflowRunStorage).save(
      {
        ...saved,
        completionTurnIds: ["launch"],
        run: {
          ...saved.run,
          status,
          ...(status === "complete" ? { result: "saved findings" } : {}),
        },
      },
      null,
    );
    yield* (yield* SessionFamilyStorage).recordTurn(assignment());
  });
const reconcileOrphans = Effect.gen(function* () {
  yield* workflows.reconcile();
  // Same workflow completion authority used by backend startup in addition to
  // pending Pi admissions (there are deliberately none in this cold fixture).
  yield* families.initialize("/sessions", "/resolved", lifecycle.holdsTurnCompletion);
});
const drain = Effect.gen(function* () {
  yield* FiberMap.awaitEmpty((yield* WorkflowSupervisor).reports);
});
const fixture = () =>
  makeWorkflowDomainFixture({ run: () => Effect.die("Recovery must not replay scripts") });

describe("Backend workflow checkpoint recovery", () => {
  it.effect(
    "completed checkpoint pending report is not falsely aborted cold; true orphan is aborted; delivers without listing",
    () =>
      Effect.gen(function* () {
        const p = persistence();
        yield* seed().pipe(Effect.provide(p.layer));
        const f = yield* fixture();
        yield* Effect.gen(function* () {
          const journal = yield* SessionFamilyStorage;
          yield* journal.recordTurn(assignment("orphan"));
          expect((yield* SubscriptionRef.get((yield* WorkflowSupervisor).state)).size).toBe(0);
          yield* reconcileOrphans;
          expect(
            (yield* journal.state()).turns.find((turn) => turn.turnId === "launch")?.outcome,
          ).toBeUndefined();
          expect(
            (yield* journal.state()).turns.find((turn) => turn.turnId === "orphan")?.outcome,
          ).toBe("aborted");
          yield* workflows.recoverReports();
          yield* workflows.recoverReports();
          yield* drain;
          expect(yield* Queue.take(f.reports)).toContain("saved findings");
          expect(yield* Queue.size(f.reports)).toBe(0);
          const completed = (yield* journal.state()).turns.find((turn) => turn.turnId === "launch");
          expect(completed?.outcome).toBe("complete");
          expect(completed?.report).toEqual({ outcome: "result", text: "saved findings" });
        }).pipe(Effect.provide(p.layer), Effect.provide(f.layer));
        const restarted = yield* fixture();
        yield* Effect.gen(function* () {
          yield* reconcileOrphans;
          yield* workflows.recoverReports();
          yield* drain;
          expect(yield* Queue.size(restarted.reports)).toBe(0);
        }).pipe(Effect.provide(p.layer), Effect.provide(restarted.layer));
      }),
  );

  it.effect(
    "retry after Pi admission but before the delivery checkpoint does not duplicate the report",
    () =>
      Effect.gen(function* () {
        const p = persistence();
        yield* seed().pipe(Effect.provide(p.layer));
        const f = yield* fixture();
        const failed = yield* Deferred.make<void>();
        yield* Effect.gen(function* () {
          yield* reconcileOrphans;
          const storage = yield* WorkflowRunStorage;
          let fail = true;
          yield* workflows.recoverReports().pipe(
            Effect.provideService(WorkflowRunStorage, {
              ...storage,
              save: (value, revision) => {
                if (value.completionDelivery === "delivered" && fail) {
                  fail = false;
                  return Deferred.succeed(failed, undefined).pipe(
                    Effect.andThen(
                      Effect.fail(
                        new WorkflowError({
                          operation: "save",
                          reason: "storage",
                          message: "Controlled checkpoint failure after admission",
                        }),
                      ),
                    ),
                  );
                }
                return storage.save(value, revision);
              },
            }),
          );
          yield* Deferred.await(failed);
          yield* TestClock.adjust("1 second");
          yield* drain;
          expect(yield* Queue.take(f.reports)).toContain("saved findings");
          expect(yield* Queue.size(f.reports)).toBe(0);
          expect((yield* (yield* SessionFamilyStorage).state()).turns[0]?.outcome).toBe("complete");
        }).pipe(Effect.provide(p.layer), Effect.provide(f.layer));
      }),
  );

  it.effect(
    "restart after durable delivery but before assignment settlement does not duplicate the report",
    () =>
      Effect.gen(function* () {
        const p = persistence();
        yield* seed().pipe(Effect.provide(p.layer));
        const first = yield* fixture();
        first.executing.push("launch");
        yield* Effect.gen(function* () {
          yield* reconcileOrphans;
          yield* workflows.recoverReports();
          const supervisor = yield* WorkflowSupervisor;
          yield* SubscriptionRef.changes(supervisor.state).pipe(
            Stream.filter(
              (state) => state.get(target.runId)?.checkpoint.completionDelivery === "delivered",
            ),
            Stream.runHead,
          );
          expect(yield* Queue.take(first.reports)).toContain("saved findings");
          expect((yield* (yield* SessionFamilyStorage).state()).turns[0]?.outcome).toBeUndefined();
          // Closing this backend scope interrupts the retry waiting for launch settlement.
        }).pipe(Effect.provide(p.layer), Effect.provide(first.layer));
        const second = yield* fixture();
        yield* Effect.gen(function* () {
          yield* reconcileOrphans;
          expect((yield* (yield* SessionFamilyStorage).state()).turns[0]?.outcome).toBeUndefined();
          yield* workflows.recoverReports();
          yield* drain;
          expect(yield* Queue.size(second.reports)).toBe(0);
          expect((yield* (yield* SessionFamilyStorage).state()).turns[0]?.report?.text).toBe(
            "saved findings",
          );
        }).pipe(Effect.provide(p.layer), Effect.provide(second.layer));
      }),
  );

  it.effect(
    "interrupted recovery before owner acquisition retries only the pending report on next startup",
    () =>
      Effect.gen(function* () {
        const p = persistence();
        yield* seed().pipe(Effect.provide(p.layer));
        const reached = yield* Deferred.make<void>();
        const first = yield* fixture();
        yield* Effect.gen(function* () {
          const host = yield* ProjectSessionRuntimeHost;
          yield* Effect.gen(function* () {
            yield* reconcileOrphans;
            yield* workflows.recoverReports();
            yield* Deferred.await(reached);
          }).pipe(
            Effect.provideService(ProjectSessionRuntimeHost, {
              ...host,
              runtimeIntegrations: () =>
                Deferred.succeed(reached, undefined).pipe(Effect.andThen(Effect.never)),
            }),
          );
        }).pipe(Effect.provide(p.layer), Effect.provide(first.layer));
        const second = yield* fixture();
        yield* Effect.gen(function* () {
          yield* reconcileOrphans;
          yield* workflows.recoverReports();
          yield* drain;
          expect(yield* Queue.take(second.reports)).toContain("saved findings");
          expect(yield* Queue.size(second.reports)).toBe(0);
        }).pipe(Effect.provide(p.layer), Effect.provide(second.layer));
      }),
  );

  it.effect.each(["error", "stopped", "paused", "running", "stopping"] as const)(
    "preserves truthful %s results without resuming cold workflow execution",
    (status) =>
      Effect.gen(function* () {
        const p = persistence();
        yield* seed(status).pipe(Effect.provide(p.layer));
        const f = yield* fixture();
        yield* Effect.gen(function* () {
          yield* reconcileOrphans;
          const expected = ["running", "paused", "stopping"].includes(status)
            ? "interrupted"
            : status;
          expect((yield* workflows.inspect(target)).status).toBe(expected);
          expect(yield* lifecycle.holdsCompletion(target.sessionId, "launch")).toBe(true);
          yield* workflows.recoverReports();
          yield* drain;
          expect(yield* Queue.take(f.reports)).toContain(` ${expected}.`);
          const turn = (yield* (yield* SessionFamilyStorage).state()).turns[0];
          expect(turn?.outcome).toBe("failed");
          expect(turn?.report?.outcome).toBe("failed");
          expect(yield* Queue.size(f.programs)).toBe(0);
        }).pipe(Effect.provide(p.layer), Effect.provide(f.layer));
      }),
  );

  it.effect.each(["complete", "paused"] as const)(
    "listing a cold %s checkpoint is read-only",
    (status) =>
      Effect.gen(function* () {
        const p = persistence();
        yield* seed(status).pipe(Effect.provide(p.layer));
        const before = new Map(p.files);
        const f = yield* fixture();
        yield* Effect.gen(function* () {
          for (let pass = 0; pass < 2; pass++) {
            expect((yield* workflows.list(target))[0]?.status).toBe(status);
            expect((yield* SubscriptionRef.get((yield* WorkflowSupervisor).state)).size).toBe(0);
            expect(yield* FiberMap.size((yield* WorkflowSupervisor).reports)).toBe(0);
          }
          expect(p.files).toEqual(before);
          expect(yield* Queue.size(f.reports)).toBe(0);
        }).pipe(Effect.provide(p.layer), Effect.provide(f.layer));
      }),
  );
});
