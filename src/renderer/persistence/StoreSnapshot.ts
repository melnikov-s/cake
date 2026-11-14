import { Schema } from "effect";
import type { StoreSnapshot } from "r-state-tree";
import { jsonValueSchema } from "../../contracts/serialization/json-contract";

const storeChildSnapshotSchema: Schema.Codec<StoreSnapshot & { key?: string | number }> =
  Schema.suspend(() =>
    Schema.Struct({
      key: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
      state: Schema.optionalKey(Schema.Record(Schema.String, jsonValueSchema)),
      children: Schema.optionalKey(
        Schema.Record(
          Schema.String,
          Schema.Union([
            storeChildSnapshotSchema,
            Schema.mutable(Schema.Array(Schema.NullOr(storeChildSnapshotSchema))),
            Schema.Null,
          ]),
        ),
      ),
    }),
  );

export const storeSnapshotSchema: Schema.Codec<StoreSnapshot> = storeChildSnapshotSchema;
