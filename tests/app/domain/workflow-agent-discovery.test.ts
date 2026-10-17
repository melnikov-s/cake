import { it } from "@effect/vitest";
import { describe, expect } from "vitest";
import { Effect, Layer, Ref, Schema } from "effect";
import * as control from "../../../src/domain/workflows/workflow-control";
import { WorkflowRunId, type SavedWorkflow } from "../../../src/contracts/workflows/workflow-data";
import { WorkflowScripts } from "../../../src/services/pi/WorkflowScripts";
import { RendererRequestCoordinator } from "../../../src/services/renderer-requests/RendererRequestCoordinator";
import { makeWorkflowDomainFixture } from "../helpers/workflowDomainFixture";
import { checkpoint } from "../helpers/workflowFixture";
import type { JsonObject } from "../../../src/contracts/serialization/json-contract";

const coordinator = Layer.mock(RendererRequestCoordinator, {});
const owner = { sessionId: "session-1" };
const invoke = (command: string, input: JsonObject = {}) =>
  control.invoke(
    command,
    { ...owner, ...input },
    { _tag: "ProjectSession", ...owner },
    new AbortController().signal,
  );
const pageSchema = Schema.Struct({
  items: Schema.Array(Schema.Unknown),
  total: Schema.Int,
  offset: Schema.Int,
  nextOffset: Schema.NullOr(Schema.Int),
});

describe("Agent workflow discovery", () => {
  it.effect("bounds run identity discovery, filters before paging and retains exact inspect", () =>
    Effect.gen(function* () {
      const f = yield* makeWorkflowDomainFixture({ run: () => Effect.succeed(undefined) });
      const records = Array.from({ length: 61 }, (_, index) => {
        const record = checkpoint();
        return {
          ...record,
          completionDelivery: "delivered" as const,
          run: {
            ...record.run,
            id: WorkflowRunId.make(
              `00000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, "0")}`,
            ),
            program: {
              ...record.run.program,
              meta: {
                name: `run-${index}`,
                description: "Large description".repeat(100),
                phases: ["one", "two"],
              },
            },
            status: index % 2 ? ("stopped" as const) : ("complete" as const),
            result: { large: "result".repeat(1000) },
          },
        };
      });
      const firstRecord = records[0];
      const lastRecord = records[60];
      if (!firstRecord || !lastRecord) throw new Error("Missing test records");
      yield* Ref.set(f.records, new Map(records.map((record) => [record.run.id, record])));
      yield* Effect.gen(function* () {
        yield* f.registerOwner;
        const first = Schema.decodeUnknownSync(pageSchema)(yield* invoke("workflows.list"));
        expect(first).toMatchObject({ total: 61, offset: 0, nextOffset: 20 });
        expect(first.items).toHaveLength(20);
        expect(first.items[0]).toEqual({
          id: firstRecord.run.id,
          name: "run-0",
          status: "complete",
        });
        const maximum = Schema.decodeUnknownSync(pageSchema)(
          yield* invoke("workflows.list", { limit: 50 }),
        );
        expect(maximum.items).toHaveLength(50);
        expect(maximum.nextOffset).toBe(50);
        const last = yield* invoke("workflows.list", { offset: 60 });
        expect(last).toMatchObject({ items: [{ id: lastRecord.run.id }], nextOffset: null });
        expect(
          yield* invoke("workflows.list", {
            status: "complete",
            query: "run",
            offset: 1,
            limit: 1,
          }),
        ).toMatchObject({ total: 31, items: [{ name: "run-2" }], nextOffset: 2 });
        expect(yield* invoke("workflows.list", { status: "paused" })).toMatchObject({
          total: 0,
          items: [],
          nextOffset: null,
        });
        expect(yield* invoke("workflows.inspect", { runId: firstRecord.run.id })).toMatchObject({
          program: firstRecord.run.program,
          result: firstRecord.run.result,
        });
        for (const limit of [0, 51, 1.5])
          expect((yield* Effect.result(invoke("workflows.list", { limit })))._tag).toBe("Failure");
      }).pipe(Effect.provide(coordinator), Effect.provide(f.layer));
    }),
  );

  it.effect(
    "bounds saved script discovery without metadata/source and reads an exact saved path",
    () =>
      Effect.gen(function* () {
        const f = yield* makeWorkflowDomainFixture({ run: () => Effect.succeed(undefined) });
        const scripts: SavedWorkflow[] = Array.from({ length: 61 }, (_, index) => ({
          meta: {
            name: `script-${index}`,
            description: "Large description".repeat(100),
            phases: ["one", "two"],
          },
          path: `/project/.cake/workflows/script-${index}.js`,
          location: index % 2 ? "personal" : "project",
        }));
        const firstScript = scripts[0];
        const lastScript = scripts[60];
        if (!firstScript || !lastScript) throw new Error("Missing test scripts");
        const program = checkpoint().run.program;
        yield* Effect.gen(function* () {
          yield* f.registerOwner;
          const first = Schema.decodeUnknownSync(pageSchema)(yield* invoke("workflows.saved"));
          expect(first).toMatchObject({ total: 61, offset: 0, nextOffset: 20 });
          expect(first.items).toHaveLength(20);
          expect(first.items[0]).toEqual({
            name: "script-0",
            path: firstScript.path,
            location: "project",
          });
          const maximum = Schema.decodeUnknownSync(pageSchema)(
            yield* invoke("workflows.saved", { limit: 50 }),
          );
          expect(maximum.items).toHaveLength(50);
          expect(yield* invoke("workflows.saved", { offset: 60 })).toMatchObject({
            items: [{ path: lastScript.path }],
            nextOffset: null,
          });
          expect(
            yield* invoke("workflows.saved", {
              query: "script",
              location: "project",
              offset: 1,
              limit: 1,
            }),
          ).toMatchObject({ total: 31, items: [{ name: "script-2" }], nextOffset: 2 });
          expect(yield* invoke("workflows.saved", { query: "missing" })).toMatchObject({
            items: [],
            nextOffset: null,
          });
          expect(
            yield* invoke("workflows.inspect-saved", { scriptPath: firstScript.path }),
          ).toEqual(program);
          for (const limit of [0, 51, 1.5])
            expect((yield* Effect.result(invoke("workflows.saved", { limit })))._tag).toBe(
              "Failure",
            );
        }).pipe(
          Effect.provideService(
            WorkflowScripts,
            WorkflowScripts.of({
              list: () => Effect.succeed(scripts),
              read: (_location, path) =>
                path === firstScript.path
                  ? Effect.succeed(program)
                  : Effect.die("Wrong script path"),
              save: () => Effect.die("Unexpected save"),
            }),
          ),
          Effect.provide(coordinator),
          Effect.provide(f.layer),
        );
      }),
  );
});
