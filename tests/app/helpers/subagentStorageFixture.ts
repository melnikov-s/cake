import { Effect, Layer, Ref } from "effect";
import {
  SubagentStorage,
  type SubagentRecord,
} from "../../../src/services/storage/SubagentStorage";

export const makeSubagentStorageTestLayer = (initial: readonly SubagentRecord[] = []) =>
  Layer.effect(
    SubagentStorage,
    Effect.gen(function* () {
      const records = yield* Ref.make(initial);
      return SubagentStorage.of({
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
