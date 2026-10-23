import { Effect, Layer, Ref } from "effect";
import { SubagentHandleId } from "../../../src/contracts/subagents/subagent-data";
import {
  SubagentStorage,
  type SubagentRecord,
  type SubagentHistory,
} from "../../../src/services/storage/SubagentStorage";

export const subagentHistoryFixture = (
  overrides: Partial<SubagentHistory> = {},
): SubagentHistory => ({
  handleId: SubagentHandleId.make("00000000-0000-4000-8000-000000000001"),
  privateSessionId: "10000000-0000-4000-8000-000000000001",
  parentSessionId: "session-1",
  parentWorkingDirectory: "/project",
  anchorPartId: "worker-start",
  workingDirectory: "/project",
  sessionDirectory: "/private-sessions",
  task: "Inspect the project",
  status: "complete",
  resolvedModel: {
    requested: "exact",
    source: "exact",
    provider: "test",
    modelId: "model",
    thinkingLevel: "off",
    fallbacks: [],
  },
  fastMode: false,
  ...overrides,
});

export const makeSubagentStorageTestLayer = (
  initial: readonly SubagentRecord[] = [],
  initialHistory: readonly SubagentHistory[] = [],
) =>
  Layer.effect(
    SubagentStorage,
    Effect.gen(function* () {
      const records = yield* Ref.make(initial);
      const history = yield* Ref.make(initialHistory);
      return SubagentStorage.of({
        history: {
          list: () => Ref.get(history),
          get: (handleId) =>
            Ref.get(history).pipe(
              Effect.map((items) => items.find((item) => item.handleId === handleId)),
            ),
          update: (record) =>
            Ref.update(history, (items) => [
              ...items.filter((item) => item.handleId !== record.handleId),
              record,
            ]),
          remove: (handleId) =>
            Ref.update(history, (items) => items.filter((item) => item.handleId !== handleId)),
        },
        list: () => Ref.get(records),
        get: (handleId) =>
          Ref.get(records).pipe(
            Effect.map((current) => current.find((record) => record.handleId === handleId)),
          ),
        update: (record) =>
          Ref.update(records, (current) => [
            ...current.filter((item) => item.handleId !== record.handleId),
            record,
          ]),
        remove: (handleId) =>
          Ref.update(records, (current) => current.filter((item) => item.handleId !== handleId)),
      });
    }),
  );
