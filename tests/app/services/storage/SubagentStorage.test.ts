import { it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { expect } from "vitest";
import {
  makeSubagentStorageLive,
  SubagentRecord,
  SubagentStorage,
} from "../../../../src/services/storage/SubagentStorage";
import { coordinationStorageHarness } from "../../helpers/coordinationStorageHarness";
import { recoveryRecordFileName } from "../../../../src/services/storage/internal/recoveryRecordFiles";
const recordPath = (id: string) => `state/private-workers/${recoveryRecordFileName(id)}`;

const record = (suffix: string): SubagentRecord =>
  Schema.decodeUnknownSync(SubagentRecord)({
    handleId: `00000000-0000-4000-8000-${suffix}`,
    privateSessionId: `10000000-0000-4000-8000-${suffix}`,
    parentSessionId: "parent",
    parentProfile: "CakeChatSession",
    parentWorkingDirectory: "/home",
    parentSessionDirectory: "/chat",
    anchorPartId: "tool-start",
    workingDirectory: "/project",
    projectPath: "/project",
    task: "Inspect once",
    allowMutations: false,
    resolvedModel: {
      requested: "exact",
      source: "exact",
      provider: "test",
      modelId: "fixture",
      thinkingLevel: "off",
      fallbacks: [],
    },
    fastMode: false,
    tools: ["read", "bash"],
    inputReferences: [],
    messageReferences: ["cake://session/parent?message=source"],
    notifyOnCompletion: true,
    completionId: "completion",
    completionDisposition: "pending",
    status: "queued",
    pendingInputs: [
      {
        turnId: "admission",
        text: "Inspect once",
        delivery: "prompt",
        attachments: [],
        markdown: false,
      },
    ],
  });

it.effect(
  "retains exact identities and unfinished admissions through a new storage acquisition",
  () =>
    Effect.gen(function* () {
      const harness = coordinationStorageHarness();
      const layer = makeSubagentStorageLive("state").pipe(Layer.provide(harness.platform));
      const original = record("000000000001");
      yield* Effect.flatMap(SubagentStorage, (storage) => storage.update(original)).pipe(
        Effect.provide(layer),
      );
      const restored = yield* Effect.flatMap(SubagentStorage, (storage) => storage.list()).pipe(
        Effect.provide(layer),
      );
      expect(restored).toEqual([original]);
      const document = JSON.parse(harness.files.get(recordPath(original.handleId)) ?? "null");
      expect(document.version).toBe(1);
      expect(Object.keys(document.data)).not.toContain("parts");
    }),
);

it.effect(
  "serializes independent worker updates and persists explicit close without losing siblings",
  () =>
    Effect.gen(function* () {
      const harness = coordinationStorageHarness();
      const first = record("000000000001");
      const second = record("000000000002");
      yield* Effect.gen(function* () {
        const storage = yield* SubagentStorage;
        yield* Effect.all([storage.update(first), storage.update(second)], {
          concurrency: "unbounded",
        });
        expect(yield* storage.list()).toHaveLength(2);
        yield* storage.remove(first.handleId);
        expect(yield* storage.list()).toEqual([second]);
      }).pipe(
        Effect.provide(makeSubagentStorageLive("state").pipe(Layer.provide(harness.platform))),
      );
    }),
);

it.effect("rejects malformed worker metadata rather than treating corruption as no work", () =>
  Effect.gen(function* () {
    const harness = coordinationStorageHarness(
      new Map([
        [recordPath(record("000000000001").handleId), '{"version":1,"data":{"task":"lost"}}'],
      ]),
    );
    const result = yield* Effect.result(
      Effect.flatMap(SubagentStorage, (storage) => storage.list()),
    ).pipe(Effect.provide(makeSubagentStorageLive("state").pipe(Layer.provide(harness.platform))));
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure.operation).toBe("storage.decode");
  }),
);
