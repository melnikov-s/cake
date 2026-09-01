import { Schema } from "effect";
import type { StoreSnapshot } from "r-state-tree";
import { jsonValueSchema } from "../ipc/json-contract";

const storeChildSnapshotSchema: Schema.Codec<StoreSnapshot & { key?: string | number }> =
  Schema.suspend(() =>
    Schema.Struct({
      key: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
      state: Schema.Record(Schema.String, jsonValueSchema),
      children: Schema.Record(
        Schema.String,
        Schema.Union([
          storeChildSnapshotSchema,
          Schema.mutable(Schema.Array(storeChildSnapshotSchema)),
          Schema.Null,
        ]),
      ),
    }),
  );

export const storeSnapshotSchema: Schema.Codec<StoreSnapshot> = storeChildSnapshotSchema;
