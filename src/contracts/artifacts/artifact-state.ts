import { Schema } from "effect";
import { ArtifactLineageId } from "./artifact-lineage";

/** A single current JSON value, independent of immutable artifact revisions. */
const ArtifactStateVersion = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThan(Number.MAX_SAFE_INTEGER),
);
const ArtifactStateValue = Schema.Json.check(
  Schema.makeFilter(
    (value) =>
      new TextEncoder().encode(JSON.stringify(value)).byteLength <= 16_777_216 ||
      "Artifact state exceeds 16 MiB",
  ),
);
export const ArtifactState = Schema.Struct({
  lineageId: ArtifactLineageId,
  version: ArtifactStateVersion,
  value: ArtifactStateValue,
});
export type ArtifactState = typeof ArtifactState.Type;
export const ArtifactStagedState = Schema.Struct({
  expectedVersion: ArtifactStateVersion,
  value: ArtifactStateValue,
});
export type ArtifactStagedState = typeof ArtifactStagedState.Type;
export const ArtifactStateReplacement = Schema.Struct({
  lineageId: ArtifactLineageId,
  expectedVersion: ArtifactStateVersion,
  value: ArtifactStateValue,
});
export type ArtifactStateReplacement = typeof ArtifactStateReplacement.Type;
const ArtifactStateEdit = Schema.Union([
  Schema.Struct({
    op: Schema.Literal("set"),
    path: Schema.String.check(Schema.isMaxLength(4096)),
    value: ArtifactStateValue,
  }),
  Schema.Struct({
    op: Schema.Literal("remove"),
    path: Schema.String.check(Schema.isMaxLength(4096)),
  }),
]);
export const ArtifactStateUpdate = Schema.Struct({
  lineageId: ArtifactLineageId,
  expectedVersion: ArtifactStateVersion,
  edits: Schema.Array(ArtifactStateEdit).check(Schema.isMinLength(1), Schema.isMaxLength(1000)),
});
export type ArtifactStateUpdate = typeof ArtifactStateUpdate.Type;
export class ArtifactStateError extends Schema.TaggedError<ArtifactStateError>()(
  "ArtifactStateError",
  {
    message: Schema.String,
  },
) {}
export class ArtifactStateConflict extends Schema.TaggedError<ArtifactStateConflict>()(
  "ArtifactStateConflict",
  {
    lineageId: ArtifactLineageId,
    expectedVersion: ArtifactStateVersion,
    actualVersion: ArtifactStateVersion,
  },
) {}

const isStateObject = Schema.is(Schema.Record(Schema.String, Schema.Json));

/** JSON-pointer edits are applied sequentially to a detached value; failure changes nothing. */
export function editArtifactState(
  value: typeof ArtifactStateValue.Type,
  edits: ArtifactStateUpdate["edits"],
): typeof ArtifactStateValue.Type {
  let result = Schema.decodeUnknownSync(Schema.fromJsonString(ArtifactStateValue))(
    JSON.stringify(value),
  );
  for (const edit of edits) {
    if (edit.path === "") {
      if (edit.op === "remove")
        throw new Error("Cannot remove the state root; replace with null instead");
      result = Schema.decodeUnknownSync(Schema.fromJsonString(ArtifactStateValue))(
        JSON.stringify(edit.value),
      );
      continue;
    }
    if (!edit.path.startsWith("/") || /~(?![01])/u.test(edit.path))
      throw new Error("Invalid JSON pointer");
    const keys = edit.path
      .slice(1)
      .split("/")
      .map((key) => key.replaceAll("~1", "/").replaceAll("~0", "~"));
    let parent = result;
    for (const key of keys.slice(0, -1)) {
      if (Array.isArray(parent)) {
        const child = parent[Number(key)];
        if (!Object.hasOwn(parent, key) || child === undefined)
          throw new Error(`Missing JSON pointer parent: ${edit.path}`);
        parent = child;
      } else {
        if (!isStateObject(parent) || !Object.hasOwn(parent, key))
          throw new Error(`Missing JSON pointer parent: ${edit.path}`);
        const child = parent[key];
        if (child === undefined) throw new Error(`Missing JSON pointer parent: ${edit.path}`);
        parent = child;
      }
    }
    const key = keys.at(-1)!;
    if (Array.isArray(parent)) {
      const index =
        key === "-" && edit.op === "set"
          ? parent.length
          : /^(0|[1-9][0-9]*)$/u.test(key)
            ? Number(key)
            : -1;
      if (index < 0 || index > parent.length || (edit.op === "remove" && index === parent.length))
        throw new Error(`Invalid array index: ${edit.path}`);
      if (edit.op === "remove") parent.splice(index, 1);
      else parent[index] = edit.value;
    } else {
      if (!isStateObject(parent))
        throw new Error(`Non-container JSON pointer parent: ${edit.path}`);
      if (edit.op === "remove") {
        if (!Object.hasOwn(parent, key)) throw new Error(`Missing JSON pointer: ${edit.path}`);
        Reflect.deleteProperty(parent, key);
      } else
        Object.defineProperty(parent, key, {
          value: edit.value,
          enumerable: true,
          configurable: true,
          writable: true,
        });
    }
  }
  return Schema.decodeUnknownSync(ArtifactStateValue)(result);
}
